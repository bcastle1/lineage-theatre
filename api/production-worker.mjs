import { timingSafeEqual } from 'node:crypto';
import { digest, json, readBody, readRecord, limitAction, userPath } from './_lib/auth.mjs';
import { payments } from './_lib/payments.mjs';
import { falProductionAdapter } from './_lib/fal-production.mjs';
import { productionQueuePath } from './_lib/production-queue.mjs';
import { falReviewedDelivery } from './_lib/fal-reviewed-delivery.mjs';
import { productionAuthorizationDiagnostic } from './_lib/production-authorization-diagnostics.mjs';
import { paidFilmCorrections } from './_lib/paid-film-correction.mjs';
import { productionJobPath } from './_lib/film-production.mjs';
import { createFilmVisualReviewService } from './_lib/film-visual-review.mjs';
import { accessStatusForUser, isOwner } from './_lib/access.mjs';
import { requireFinishedFilmPayment } from './_lib/production-media.mjs';

// The isolated media worker receives short-lived payment grants, never the
// merchant's QuickBooks credentials. Every grant still runs the live invoice,
// allocation, recorded-reversal, owner, manifest and full-film budget checks.
export function createProductionWorkerHandler({ env = process.env, paymentService = payments,
  adapter = falProductionAdapter, read = readRecord, limiter = limitAction, now = Date.now, delivery = falReviewedDelivery,
  corrections = paidFilmCorrections, visualReviewFactory = createFilmVisualReviewService } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { code: 'METHOD_NOT_ALLOWED' }); }
    const secret = env.LINEAGE_WORKER_SECRET, header = req.headers?.authorization;
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) return json(res, 503, { code: 'WORKER_UNAVAILABLE' });
    if (typeof header !== 'string' || header.length > 128
      || !timingSafeEqual(Buffer.from(digest(header)), Buffer.from(digest(`Bearer ${secret}`))))
      return json(res, 401, { code: 'WORKER_AUTH_REQUIRED' });
    try {
      // Six bounded JPEG samples (five current, one preceding) fit below this
      // cap. The review service checks exact positions and count per contract.
      const body = await readBody(req, 2_100_000);
      if (body?.action === 'review-film-visuals') {
        if (Object.keys(body).sort().join(',') !== 'action,email,frames,manifestHash,preparedId,shotId'
          || typeof body.email !== 'string' || body.email !== body.email.toLowerCase().trim() || body.email.length > 254
          || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(body.email)
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.preparedId || '')
          || !/^[a-f0-9]{64}$/.test(body.manifestHash || '') || !/^shot-\d{3}$/.test(body.shotId || '')
          || !Array.isArray(body.frames) || body.frames.length < 3 || body.frames.length > 6)
          return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
        const path = productionJobPath(body.email, body.preparedId), job = (await read(path))?.value;
        let paymentPermission = null, pinnedLease = null, pinnedGrant = null;
        const authorize = async () => {
          const current = (await read(path))?.value, actor = (await read(userPath(body.email)))?.value;
          if (!current || current.id !== body.preparedId || current.ownerHash !== digest(body.email) || current.manifestHash !== body.manifestHash
            || digest(JSON.stringify(current.manifest)) !== body.manifestHash || current.status !== 'awaiting-assembly'
            || current.manifest?.visualContinuity?.version !== 1 || current.provider?.model !== 'kling'
            || digest(JSON.stringify(current.shots)) !== digest(JSON.stringify(job?.shots))
            || digest(JSON.stringify(current.provider)) !== digest(JSON.stringify(job.provider)) || current.mode !== job.mode
            || digest(JSON.stringify(current.authorization || null)) !== digest(JSON.stringify(job.authorization || null))
            || accessStatusForUser(actor) !== 'approved' || actor.email !== body.email || actor.mustChangePassword) return false;
          try { await requireFinishedFilmPayment({ job: current, email: body.email, actor, read, now }); }
          catch { return false; }
          if (current.mode === 'operator-test') {
            const grant = (await read(`production/operator-canaries/${current.ownerHash}/${current.id}/grant.json`))?.value;
            const lease = (await read(`production/operator-canaries/${current.ownerHash}/${current.id}/finishing-lease.json`))?.value;
            const grantHash = digest(JSON.stringify(grant || null));
            const valid = isOwner(actor) && grant?.version === 1 && grant.kind === 'fictional-kling-quality-canary-v1'
              && grant.ownerHash === current.ownerHash && grant.preparedId === current.id
              && grant.manifestHash === body.manifestHash && grant.recipe === current.provider.recipe
              && grant.fictionalOnly === true && grant.funding === 'existing-merchant-provider-credit'
              && grant.maximumCostCents === 300 && grant.maximumVideoRequests === 3 && grant.maximumReferenceRequests === 2
              && Date.parse(grant.expiresAt) > now() && typeof lease?.token === 'string' && lease.token.length > 0
              && lease.manifestHash === body.manifestHash && lease.expiresAt > now()
              && (!pinnedLease || lease.token === pinnedLease) && (!pinnedGrant || pinnedGrant === grantHash);
            if (valid) { pinnedLease = lease.token; pinnedGrant = grantHash; }
            return valid;
          }
          const ticket = (await read(productionQueuePath(body.email, body.preparedId)))?.value;
          if (ticket?.state !== 'pending' || ticket.email !== body.email || ticket.manifestHash !== body.manifestHash
            || ticket.id !== body.preparedId || !(ticket.lease?.expiresAt > now())
            || typeof ticket.lease.token !== 'string' || !ticket.lease.token
            || pinnedLease && pinnedLease !== digest(`${ticket.orderId}:${ticket.lease.token}`)) return false;
          pinnedLease = digest(`${ticket.orderId}:${ticket.lease.token}`);
          if (!paymentPermission || Date.parse(paymentPermission.expiresAt) <= now()) {
            const permission = await paymentService.authorizeProduction({ email: body.email, preparedId: body.preparedId,
              manifestHash: body.manifestHash, orderId: ticket.orderId });
            if (permission?.allowed !== true || permission.manifestHash !== body.manifestHash
              || !Number.isFinite(Date.parse(permission.expiresAt)) || Date.parse(permission.expiresAt) <= now()) return false;
            paymentPermission = permission;
          }
          return true;
        };
        if (!await authorize()) return json(res, 409, { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
        if (!await limiter(`production-worker:visual-review:${body.preparedId}`, 240, 60_000)) return json(res, 429, { code: 'WORKER_RATE_LIMITED' });
        const review = visualReviewFactory({ read, key: () => env.OPENAI_API_KEY, authorize, now });
        return json(res, 200, await review({ email: body.email, id: body.preparedId, job, shotId: body.shotId, frames: body.frames }));
      }
      if (body?.action === 'authorize-failed-shot-recovery') {
        const fields = ['action', 'email', 'preparedId', 'manifestHash', 'correctionId', 'recoveryId',
          'originalIdentity', 'originalRequestId', 'replacementIdentity', 'model', 'recipe'];
        if (Object.keys(body).sort().join(',') !== fields.sort().join(',')
          || body.model !== 'kling' || body.model !== adapter.model || body.recipe !== adapter.modelVersion || !adapter.available
          || typeof body.email !== 'string' || body.email !== body.email.toLowerCase().trim() || body.email.length > 254
          || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(body.email)
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.preparedId || '')
          || !['manifestHash', 'correctionId', 'recoveryId', 'originalIdentity', 'replacementIdentity'].every(key => /^[a-f0-9]{64}$/.test(body[key] || ''))
          || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.originalRequestId || ''))
          return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
        if (!await limiter('production-worker:failed-shot-recovery', 20, 60_000)) return json(res, 429, { code: 'WORKER_RATE_LIMITED' });
        const { action, model, recipe, ...input } = body;
        return json(res, 200, await corrections.authorizeFailedShotRecovery(input));
      }
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
      if (!body || Object.keys(body).sort().join(',') !== 'email,manifestHash,model,orderId,preparedId,recipe'
        || body.model !== adapter.model || typeof body.recipe !== 'string' || !adapter.available
        || typeof body.email !== 'string' || body.email !== body.email.toLowerCase().trim()
        || !/^[a-f0-9]{64}$/.test(body.orderId || '') || !/^[a-f0-9]{64}$/.test(body.manifestHash || ''))
        return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
      const ticket = (await read(productionQueuePath(body.email, body.preparedId)))?.value;
      if (ticket?.state !== 'pending' || ticket.email !== body.email || ticket.id !== body.preparedId
        || ticket.orderId !== body.orderId || ticket.manifestHash !== body.manifestHash || !(ticket.lease?.expiresAt > now()))
        return json(res, 409, { code: 'WORKER_QUEUE_REQUIRED' });
      if (typeof adapter.recipeForManifest === 'function') {
        const job = (await read(productionJobPath(body.email, body.preparedId)))?.value;
        if (!job || job.id !== body.preparedId || job.ownerHash !== digest(body.email) || job.manifestHash !== body.manifestHash
          || digest(JSON.stringify(job.manifest)) !== body.manifestHash
          || body.recipe !== adapter.recipeForManifest(job.manifest)
          || job.provider && (job.provider.model !== body.model || job.provider.recipe !== body.recipe))
          return json(res, 409, { code: 'WORKER_PLAN_REQUIRED' });
      } else if (body.recipe !== adapter.modelVersion) return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
      if (!await limiter('production-worker:authorize', 120, 60_000)) return json(res, 429, { code: 'WORKER_RATE_LIMITED' });
      const { email, preparedId, manifestHash, orderId } = body;
      return json(res, 200, await paymentService.authorizeProduction({ email, preparedId, manifestHash, orderId }));
    } catch (error) {
      if (['VISUAL_REVIEW_UNCERTAIN', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED', 'VISUAL_REVIEW_UNAVAILABLE', 'VISUAL_REVIEW_RATE_LIMITED'].includes(error?.code))
        return json(res, error.code === 'VISUAL_REVIEW_RATE_LIMITED' ? 429 : error.code === 'VISUAL_REVIEW_UNAVAILABLE' ? 503 : 409, { code: error.code });
      console.warn('PRODUCTION_AUTHORIZATION_UNAVAILABLE', productionAuthorizationDiagnostic(error));
      return json(res, 503, { code: 'PRODUCTION_AUTHORIZATION_UNAVAILABLE' });
    }
  };
}
export default createProductionWorkerHandler();
