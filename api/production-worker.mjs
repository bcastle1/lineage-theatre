import { timingSafeEqual } from 'node:crypto';
import { digest, json, readBody, readRecord, limitAction, userPath } from './_lib/auth.mjs';
import { payments } from './_lib/payments.mjs';
import { falProductionAdapter, SEEDANCE_RECIPE_VERSION, FAL_RECIPE_VERSION } from './_lib/fal-production.mjs';
import { productionQueuePath } from './_lib/production-queue.mjs';
import { falReviewedDelivery } from './_lib/fal-reviewed-delivery.mjs';
import { productionAuthorizationDiagnostic } from './_lib/production-authorization-diagnostics.mjs';
import { productionJobPath } from './_lib/film-production.mjs';
import { createFilmVisualReviewService, visualReviewBinding, visualReceiptPath } from './_lib/film-visual-review.mjs';
import { createStartFrameReviewService } from './_lib/film-start-frame-review.mjs';
import { accessStatusForUser, isOwner } from './_lib/access.mjs';
import { requireFinishedFilmPayment } from './_lib/production-media.mjs';
import { verifySeedanceCanaryGrant } from './_lib/seedance-operator-canary.mjs';
import { authorizeFilmProduction, createFilmPreRenderService, readPreRenderGrant, PRERENDER_FLOW } from './_lib/film-prerender.mjs';

// The isolated media worker receives short-lived payment grants, never the
// merchant's QuickBooks credentials. Every grant still runs the live invoice,
// allocation, recorded-reversal, owner, manifest and full-film budget checks.
export function createProductionWorkerHandler({ env = process.env, paymentService = payments,
  adapter = falProductionAdapter, read = readRecord, limiter = limitAction, now = Date.now, delivery = falReviewedDelivery,
  visualReviewFactory = createFilmVisualReviewService,
  startFrameReviewFactory = createStartFrameReviewService,
  preRenderService = createFilmPreRenderService({ read, now, env }) } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { code: 'METHOD_NOT_ALLOWED' }); }
    const secret = env.LINEAGE_WORKER_SECRET, header = req.headers?.authorization;
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) return json(res, 503, { code: 'WORKER_UNAVAILABLE' });
    if (typeof header !== 'string' || header.length > 128
      || !timingSafeEqual(Buffer.from(digest(header)), Buffer.from(digest(`Bearer ${secret}`))))
      return json(res, 401, { code: 'WORKER_AUTH_REQUIRED' });
    try {
      const body = await readBody(req, 1_500_000);
      if (['review-film-visuals', 'review-start-frame'].includes(body?.action)) {
        const startFrame = body.action === 'review-start-frame';
        const protocol = body.workerProtocol === 2;
        const keys = Object.keys(body).filter(key => key !== 'workerProtocol').sort().join(',');
        if ('workerProtocol' in body && !protocol) return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
        if (keys !== (startFrame
          ? 'action,email,manifestHash,preparedId,referenceIdentity,shotId' : 'action,email,frames,manifestHash,preparedId,shotId')
          || typeof body.email !== 'string' || body.email !== body.email.toLowerCase().trim() || body.email.length > 254
          || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(body.email)
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.preparedId || '')
          || !/^[a-f0-9]{64}$/.test(body.manifestHash || '') || !/^shot-\d{3}$/.test(body.shotId || '')
          || (startFrame ? !/^[a-f0-9]{64}$/.test(body.referenceIdentity || '')
            : !Array.isArray(body.frames) || body.frames.length < 3 || body.frames.length > 4))
          return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
        const path = productionJobPath(body.email, body.preparedId), job = (await read(path))?.value;
        let paymentPermission = null, pinnedLease = null, pinnedGrant = null, pinnedReviewClaim = null;
        const authorize = async () => {
          const current = (await read(path))?.value, actor = (await read(userPath(body.email)))?.value;
          if (!current || current.id !== body.preparedId || current.ownerHash !== digest(body.email) || current.manifestHash !== body.manifestHash
            || digest(JSON.stringify(current.manifest)) !== body.manifestHash
            || (startFrame ? !['processing', 'uncertain'].includes(current.status) : current.status !== 'awaiting-assembly')
            || current.manifest?.visualContinuity?.version !== 1 || current.provider?.id !== 'fal'
            || !(current.provider.model === 'kling' && current.provider.recipe === FAL_RECIPE_VERSION
              || protocol && !startFrame && current.provider.model === 'seedance' && current.provider.recipe === SEEDANCE_RECIPE_VERSION
              && current.manifest.productionPlan?.provider === 'seedance' && current.manifest.productionPlan.version === 1)
            || digest(JSON.stringify(current.shots)) !== digest(JSON.stringify(job?.shots))
            || digest(JSON.stringify(current.provider)) !== digest(JSON.stringify(job.provider)) || current.mode !== job.mode
            || digest(JSON.stringify(current.authorization || null)) !== digest(JSON.stringify(job.authorization || null))
            || accessStatusForUser(actor) !== 'approved' || actor.email !== body.email || actor.mustChangePassword) return false;
          if (startFrame && (current.manifest.productionPlan?.characterBindingVersion !== 3
            || !['submitting', 'queued', 'processing', 'uncertain'].includes(current.shots.find(s => s.id === body.shotId)?.status)
            || !(current.lease?.expiresAt > now()) || typeof current.lease.token !== 'string' || !current.lease.token)) return false;
          const preRenderTicket = current.mode === 'customer' ? (await read(productionQueuePath(body.email, body.preparedId)))?.value : null;
          const preRendering = preRenderTicket?.authorizationKind === PRERENDER_FLOW;
          if (preRendering) {
            try {
              const grant = await readPreRenderGrant({ email: body.email, id: body.preparedId, job: current, read });
              const hash = digest(JSON.stringify(grant));
              if (!grant || grant.id !== preRenderTicket.preRenderGrantId || current.authorization?.environment !== 'production'
                || current.authorization.manifestHash !== body.manifestHash || current.authorization.budgetCents !== grant.maximumCostCents
                || current.authorization.quoteReference !== grant.quoteReference || pinnedGrant && pinnedGrant !== hash) return false;
              pinnedGrant = hash;
            } catch { return false; }
          } else {
            try { await requireFinishedFilmPayment({ job: current, email: body.email, actor, read, now }); }
            catch { return false; }
          }
          if (current.mode === 'operator-test') {
            const grant = (await read(`production/operator-canaries/${current.ownerHash}/${current.id}/grant.json`))?.value;
            const lease = startFrame ? { ...current.lease, manifestHash: current.manifestHash }
              : (await read(`production/operator-canaries/${current.ownerHash}/${current.id}/finishing-lease.json`))?.value;
            const grantHash = digest(JSON.stringify(grant || null));
            const bindingVersion = current.manifest.productionPlan?.characterBindingVersion;
            // The fixed fictional manifest was verified above. Version 2 adds
            // one separately priced view per character; historical grants keep
            // their original two-reference ceiling and cannot fund this plan.
            const boundedCanary = bindingVersion === 3
              ? current.manifestHash === '601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f'
                && grant?.characterBindingVersion === 3 && grant.maximumCostCents === 450 && grant.maximumReferenceRequests === 7
              : bindingVersion === 2
              ? current.manifestHash === '242696e7d84c765468f5e33717b32480326da65488f0d7ff8573b2938ad70358'
                && grant?.characterBindingVersion === 2 && grant.maximumCostCents === 360 && grant.maximumReferenceRequests === 4
              : [undefined, 1].includes(bindingVersion) && grant?.maximumCostCents === 300 && grant.maximumReferenceRequests === 2;
            const validKling = current.provider.model === 'kling' && current.provider.recipe === FAL_RECIPE_VERSION
              && grant?.version === 1 && grant.kind === 'fictional-kling-quality-canary-v1'
              && grant.ownerHash === current.ownerHash && grant.preparedId === current.id
              && grant.manifestHash === body.manifestHash && grant.recipe === current.provider.recipe
              && grant.fictionalOnly === true && grant.funding === 'existing-merchant-provider-credit'
              && boundedCanary && grant.maximumVideoRequests === 3 && Date.parse(grant.expiresAt) > now();
            let validSeedance = false;
            if (protocol && !startFrame && current.provider.model === 'seedance' && current.provider.recipe === SEEDANCE_RECIPE_VERSION) {
              try {
                verifySeedanceCanaryGrant(grant, { email: body.email, ownerHash: current.ownerHash, id: current.id, now: now() });
                validSeedance = current.authorization?.environment === 'production'
                  && current.authorization.manifestHash === body.manifestHash
                  && current.authorization.quoteReference === grant.quoteReference
                  && current.authorization.budgetCents === grant.maximumCostCents;
                const claim = (await read(`production/operator-canaries/${current.ownerHash}/${current.id}/visual-review-claims/${digest(body.shotId)}.json`))?.value;
                const inputHash = digest(JSON.stringify({ email: body.email, preparedId: body.preparedId,
                  manifestHash: body.manifestHash, shotId: body.shotId, frames: body.frames }));
                const claimHash = digest(JSON.stringify(claim || null));
                validSeedance = validSeedance && claim?.version === 1 && claim.state === 'claimed'
                  && claim.ownerHash === current.ownerHash && claim.preparedId === current.id
                  && claim.manifestHash === body.manifestHash && claim.shotId === body.shotId && claim.inputHash === inputHash
                  && typeof claim.token === 'string' && claim.token.length > 0
                  && Number.isFinite(Date.parse(claim.claimedAt)) && Date.parse(claim.claimedAt) <= now()
                  && Date.parse(claim.claimedAt) >= Date.parse(grant.approvedAt)
                  && (!pinnedReviewClaim || pinnedReviewClaim === claimHash);
                if (validSeedance) pinnedReviewClaim = claimHash;
              } catch { /* A different or expanded studio allowance cannot authorize inference. */ }
            }
            const valid = isOwner(actor) && (validKling || validSeedance)
              && typeof lease?.token === 'string' && lease.token.length > 0
              && lease.manifestHash === body.manifestHash && lease.expiresAt > now()
              && (!pinnedLease || lease.token === pinnedLease) && (!pinnedGrant || pinnedGrant === grantHash)
              && (!startFrame || current.authorization?.manifestHash === body.manifestHash
                && current.authorization.quoteReference === grant.quoteReference && current.authorization.budgetCents === grant.maximumCostCents);
            if (valid) { pinnedLease = lease.token; pinnedGrant = grantHash; }
            return valid;
          }
          const ticket = (await read(productionQueuePath(body.email, body.preparedId)))?.value;
          if (ticket?.state !== 'pending' || ticket.email !== body.email || ticket.manifestHash !== body.manifestHash
            || ticket.id !== body.preparedId || !(ticket.lease?.expiresAt > now())
            || typeof ticket.lease.token !== 'string' || !ticket.lease.token
            || pinnedLease && pinnedLease !== digest(`${ticket.orderId}:${ticket.lease.token}:${startFrame ? current.lease.token : ''}`)) return false;
          pinnedLease = digest(`${ticket.orderId}:${ticket.lease.token}:${startFrame ? current.lease.token : ''}`);
          if (preRendering || !paymentPermission || Date.parse(paymentPermission.expiresAt) <= now()) {
            const permission = await authorizeFilmProduction({ email: body.email, preparedId: body.preparedId,
              manifestHash: body.manifestHash, orderId: ticket.orderId }, { paymentService, preRenderService, read, spending: false });
            if (permission?.allowed !== true || permission.manifestHash !== body.manifestHash
              || !Number.isFinite(Date.parse(permission.expiresAt)) || Date.parse(permission.expiresAt) <= now()) return false;
            paymentPermission = permission;
          }
          return true;
        };
        if (!await authorize()) return json(res, 409, { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
        if (job.mode === 'operator-test' && job.provider.model === 'seedance') {
          const { bindingHash } = visualReviewBinding(job, body.shotId, body.frames);
          const previous = await read(visualReceiptPath(job.ownerHash, job.id, bindingHash));
          // One attempt per exact shot. An uncertain or rate-limited response
          // consumes this canary's review allowance; it never permits a retry.
          if (previous && previous.value?.state !== 'reviewed') return json(res, 409, { code: 'VISUAL_REVIEW_UNCERTAIN' });
        }
        if (!await limiter(`production-worker:visual-review:${body.preparedId}`, 240, 60_000)) return json(res, 429, { code: 'WORKER_RATE_LIMITED' });
        const review = (startFrame ? startFrameReviewFactory : visualReviewFactory)({ read, key: () => env.OPENAI_API_KEY, authorize, now });
        return json(res, 200, await review(startFrame
          ? { email: body.email, productionId: body.preparedId, manifestHash: body.manifestHash, shotId: body.shotId, referenceIdentity: body.referenceIdentity }
          : { email: body.email, id: body.preparedId, job, shotId: body.shotId, frames: body.frames }));
      }
      if (body?.action === 'authorize-failed-shot-recovery')
        return json(res, 410, { code: 'LEGACY_GENERATION_RETIRED' });
      if (body?.action === 'deliver-reviewed-film') {
        if (Object.keys(body).some(key => !['action', 'artifactSha256', 'orderId', 'previousArtifactSha256', 'model'].includes(key))
          || !/^[a-f0-9]{64}$/.test(body.orderId || '') || !/^[a-f0-9]{64}$/.test(body.artifactSha256 || '')
          || ('model' in body && !['seedance', 'wan'].includes(body.model))
          || ('previousArtifactSha256' in body && !/^[a-f0-9]{64}$/.test(body.previousArtifactSha256 || '')))
          return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
        if (!await limiter('production-worker:delivery', 10, 60_000)) return json(res, 429, { code: 'WORKER_RATE_LIMITED' });
        return json(res, 200, await delivery.deliver({ orderId: body.orderId, artifactSha256: body.artifactSha256,
          ...('model' in body ? { model: body.model } : {}),
          ...('previousArtifactSha256' in body ? { previousArtifactSha256: body.previousArtifactSha256 } : {}) }));
      }
      if (!body || !['email,manifestHash,model,orderId,preparedId,recipe,workerProtocol',
        'email,manifestHash,model,orderId,partialCorrectionVersion,preparedId,recipe,workerProtocol',
        'email,manifestHash,model,orderId,partialCorrectionRetryVersion,partialCorrectionVersion,preparedId,recipe,workerProtocol'].includes(Object.keys(body).sort().join(','))
        || ('partialCorrectionVersion' in body && body.partialCorrectionVersion !== 1)
        || ('partialCorrectionRetryVersion' in body && body.partialCorrectionRetryVersion !== 1)
        || body.workerProtocol !== 2 || body.model !== 'seedance' || body.recipe !== SEEDANCE_RECIPE_VERSION
        || body.model !== adapter.model || body.recipe !== adapter.modelVersion || !adapter.available
        || typeof body.email !== 'string' || body.email !== body.email.toLowerCase().trim()
        || !/^[a-f0-9]{64}$/.test(body.orderId || '') || !/^[a-f0-9]{64}$/.test(body.manifestHash || ''))
        return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
      const ticket = (await read(productionQueuePath(body.email, body.preparedId)))?.value;
      if (ticket?.state !== 'pending' || ticket.email !== body.email || ticket.id !== body.preparedId
        || ticket.orderId !== body.orderId || ticket.manifestHash !== body.manifestHash || !(ticket.lease?.expiresAt > now()))
        return json(res, 409, { code: 'WORKER_QUEUE_REQUIRED' });
      const job = (await read(productionJobPath(body.email, body.preparedId)))?.value;
      if (job?.partialCorrection && body.partialCorrectionVersion !== 1)
        return json(res, 409, { code: 'WORKER_PARTIAL_CORRECTION_REQUIRED' });
      if (job?.partialCorrectionRetry && body.partialCorrectionRetryVersion !== 1)
        return json(res, 409, { code: 'WORKER_PARTIAL_RETRY_REQUIRED' });
      if (job?.id !== body.preparedId || job.ownerHash !== digest(body.email) || job.manifestHash !== body.manifestHash
        || !job.manifest || digest(JSON.stringify(job.manifest)) !== job.manifestHash
        || job.manifest.productionPlan?.provider !== 'seedance' || job.manifest.productionPlan.version !== 1
        || job.provider?.id !== 'fal' || job.provider.model !== body.model || job.provider.recipe !== body.recipe)
        return json(res, 409, { code: 'WORKER_MODEL_MISMATCH' });
      if (!await limiter('production-worker:authorize', 120, 60_000)) return json(res, 429, { code: 'WORKER_RATE_LIMITED' });
      const { email, preparedId, manifestHash, orderId } = body;
      return json(res, 200, await authorizeFilmProduction({ email, preparedId, manifestHash, orderId }, { paymentService, preRenderService, read }));
    } catch (error) {
      if (['VISUAL_REVIEW_UNCERTAIN', 'VISUAL_REVIEW_REQUIRED', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED', 'VISUAL_REVIEW_UNAVAILABLE', 'VISUAL_REVIEW_RATE_LIMITED'].includes(error?.code))
        return json(res, error.code === 'VISUAL_REVIEW_RATE_LIMITED' ? 429 : error.code === 'VISUAL_REVIEW_UNAVAILABLE' ? 503 : 409, { code: error.code });
      console.warn('PRODUCTION_AUTHORIZATION_UNAVAILABLE', productionAuthorizationDiagnostic(error));
      return json(res, 503, { code: 'PRODUCTION_AUTHORIZATION_UNAVAILABLE' });
    }
  };
}
export default createProductionWorkerHandler();
