import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { requireFinishedFilmPayment } from './production-media.mjs';
import { readVisualEvidenceRecovery } from './film-visual-evidence-recovery.mjs';
import { list } from '@vercel/blob';
import { parsedAssemblyOverlays } from './film-overlays.mjs';
import { stageVisualSceneContext, verifiedStageVisualDecision, visualReferenceContext } from './film-visual-review.mjs';

export const VISUAL_EDITORIAL_POLICY = 'visual-editorial-recovery-v4';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => digest(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = value => { if (!value) throw Object.assign(Error('The editorial action revision requires verification.'), { code: 'VISUAL_REVIEW_INVALID' }); };
const jobPath = job => `production/jobs/${job.ownerHash}/${job.id}.json`;
const queuePath = job => `production/queue/${job.ownerHash}/${job.id}.json`;
const outputs = job => job.shots.map(shot => ({ shotId: shot.id, outputHash: hash(shot.output) }));
export const visualEditorialRecoveryPath = job => {
  need(HASH.test(job?.ownerHash || '') && UUID.test(job?.id || ''));
  return `production/visual-review-recoveries/${job.ownerHash}/${job.id}/${VISUAL_EDITORIAL_POLICY}.json`;
};
const priorPath = grant => `production/visual-reviews/${grant.ownerHash}/${grant.preparedId}/${grant.priorBindingHash}.json`;
const jobFields = ['finishingFailure', 'revision', 'updatedAt'];
const queueFields = ['state', 'attempts', 'updatedAt', 'nextAttemptAt', 'lastResult', 'lastFailure', 'lease'];
const fields = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function restore(value, saved, keys) {
  const original = structuredClone(value);
  for (const key of keys) { if (Object.hasOwn(saved, key)) original[key] = saved[key]; else delete original[key]; }
  delete original.visualEditorialRecovery; delete original.visualEditorialRecoveryHash;
  return original;
}
function validJob(job) {
  need(job?.mode === 'customer' && ['awaiting-assembly', 'completed'].includes(job.status)
    && HASH.test(job.ownerHash || '') && UUID.test(job.id || '') && hash(job.manifest) === job.manifestHash
    && job.manifest?.version === 1 && job.provider?.id === 'fal' && job.provider.model === 'seedance'
    && job.manifest.productionPlan?.provider === 'seedance' && job.manifest.visualContinuity?.version === 1
    && job.shots?.length === 4 && job.manifest.shots?.length === 4
    && job.shots.every((shot, i) => shot.id === job.manifest.shots[i].id && shot.status === 'completed' && shot.output));
}
export function revisedEditorialVisual(job, grant) {
  const shot = job.manifest.shots.find(value => value.id === grant.shotId);
  need(shot && typeof grant.originalAction === 'string' && typeof grant.revisedAction === 'string'
    && [grant.originalAction, grant.revisedAction].every(text => text.trim() === text && text.length > 0 && text.length <= 1000 && !/[\x00-\x1f\x7f]/.test(text))
    && grant.originalAction !== grant.revisedAction && shot.visual.split(grant.originalAction).length === 2);
  const visual = shot.visual.replace(grant.originalAction, grant.revisedAction);
  need(same(parsedAssemblyOverlays(visual).map(({ text, style }) => ({ text, style })),
    parsedAssemblyOverlays(shot.visual).map(({ text, style }) => ({ text, style }))));
  return visual;
}
async function validateGrant(job, grant, read) {
  validJob(job);
  need(grant && HASH.test(grant.priorBindingHash || '') && typeof grant.shotId === 'string');
  const [evidenceGrant, priorRecord, claimRecord] = await Promise.all([readVisualEvidenceRecovery(job, { read }), read(priorPath(grant)),
    read(`production/visual-review-bindings/${job.ownerHash}/${job.id}/expanded-visual-evidence-v3/${digest(grant.shotId)}.json`)]);
  need(grant?.version === 1 && grant.policy === VISUAL_EDITORIAL_POLICY && grant.ownerHash === job.ownerHash
    && grant.preparedId === job.id && grant.manifestHash === job.manifestHash && grant.recoveryGrantHash === hash(evidenceGrant)
    && [grant.priorBindingHash, grant.priorReceiptHash, grant.jobHash, grant.queueHash, grant.requestHash].every(v => HASH.test(v || ''))
    && same(grant.shots, outputs(job)) && grant.approvedBy && digest(grant.approvedBy) === job.ownerHash
    && Number.isFinite(Date.parse(grant.approvedAt)) && grant.priorJobControl && grant.priorQueueControl
    && Object.keys(grant.priorJobControl).every(key => jobFields.includes(key))
    && Object.keys(grant.priorQueueControl).every(key => queueFields.includes(key)));
  const expected = { email: grant.approvedBy, id: grant.preparedId, manifestHash: grant.manifestHash,
    jobHash: grant.jobHash, queueHash: grant.queueHash, priorBindingHash: grant.priorBindingHash, priorReceiptHash: grant.priorReceiptHash,
    originalAction: grant.originalAction, revisedAction: grant.revisedAction };
  need(grant.requestPlan && Object.keys(grant.requestPlan).sort().join(',') === Object.keys(expected).sort().join(',')
    && Object.entries(expected).every(([key, value]) => grant.requestPlan[key] === value) && hash(grant.requestPlan) === grant.requestHash);
  const prior = priorRecord?.value, binding = prior?.binding;
  const index = job.manifest.shots.findIndex(shot => shot.id === grant.shotId), shot = job.manifest.shots[index];
  const count = 9;
  need(index === 0 && shot && grant.shotId === evidenceGrant.shotId && prior?.version === 3 && prior.state === 'reviewed' && prior.attempts === 1
    && prior.model === 'gpt-6.2-astra' && prior.bindingHash === grant.priorBindingHash && hash(prior) === grant.priorReceiptHash
    && binding?.version === 3 && binding.policy === 'expanded-visual-evidence-v3' && hash(binding) === grant.priorBindingHash
    && binding.manifestHash === job.manifestHash && binding.shotId === shot.id
    && binding.outputHash === outputs(job)[index].outputHash && binding.outputHash === grant.sourceOutputHash
    && binding.priorBindingHash === evidenceGrant.priorBindingHash && binding.priorReceiptHash === evidenceGrant.priorReceiptHash
    && binding.grantHash === hash(evidenceGrant) && binding.stageContextHash === hash(stageVisualSceneContext(job, shot))
    && binding.referenceContextHash === hash(visualReferenceContext(job, shot))
    && same(binding.sampleTimes, [.05, .15, .25, .35, .5, .65, .75, .85, .95].map(fraction => Math.round(shot.targetDurationMs * fraction)))
    && same(binding.frameHashes, grant.priorFrameHashes) && binding.frameHashes.length === count
    && binding.frameHashes.every(v => HASH.test(v || ''))
    && binding.precedingOutputHash === null);
  const decision = verifiedStageVisualDecision(prior.decision, count, true);
  need(!decision.passed && ['appearance', 'wardrobe', 'imageIntegrity', 'cast'].every(key => decision[key] === 'consistent')
    && decision.sceneAction === 'unverifiable' && same(decision.findings, ['insufficient-visible-evidence']));
  const claim = claimRecord?.value;
  need(same(claim, { version: 1, policy: 'expanded-visual-evidence-v3', grantHash: hash(evidenceGrant),
    manifestHash: job.manifestHash, shotId: shot.id, bindingHash: grant.priorBindingHash }));
  const stopped = grant.priorJobControl.finishingFailure;
  need(stopped?.version === 1 && stopped.manifestHash === job.manifestHash && stopped.state === 'attention'
    && stopped.stage === 'visual-review' && ['VISUAL_CONTINUITY_MISMATCH', 'VISUAL_EVIDENCE_INSUFFICIENT'].includes(stopped.reason)
    && grant.priorQueueControl.state === 'attention' && grant.priorQueueControl.lastResult === 'REVIEW_REQUIRED'
    && same(grant.priorQueueControl.lastFailure, { stage: stopped.stage, reason: stopped.reason }));
  need(grant.effectiveVisual === revisedEditorialVisual(job, grant));
  return grant;
}

export async function readVisualEditorialRecovery(job, { read = readRecord } = {}) {
  const [record, savedRecord] = await Promise.all([read(jobPath(job)), job.visualEditorialRecovery ? read(visualEditorialRecoveryPath(job)) : null]);
  const current = record?.value;
  if (!job.visualEditorialRecovery) { need(!current?.visualEditorialRecovery); return null; }
  const saved = savedRecord?.value;
  need(current && same(current.visualEditorialRecovery, job.visualEditorialRecovery) && same(saved, job.visualEditorialRecovery)
    && current.manifestHash === job.manifestHash && same(outputs(current), outputs(job)));
  validJob(current);
  return validateGrant(job, saved, read);
}

export function createVisualEditorialRecovery({ read = readRecord, write = writeRecord, listBlobs = list, now = Date.now,
  paymentCheck = requireFinishedFilmPayment,
  authorize = async ({ recoveryPlan, ...input }) => ({ ...(await (await import('./payments.mjs')).payments.authorizeProduction(input)), recoveryRequestHash: hash(recoveryPlan) }) } = {}) {
  async function listed(prefix) {
    const paths = [], seen = new Set(); let cursor;
    do {
      const page = await listBlobs({ prefix, limit: 16 - paths.length, ...(cursor ? { cursor } : {}) });
      need(page && Array.isArray(page.blobs) && typeof page.hasMore === 'boolean');
      for (const blob of page.blobs) { need(typeof blob.pathname === 'string' && blob.pathname.startsWith(prefix) && !paths.includes(blob.pathname)); paths.push(blob.pathname); }
      need(paths.length <= 16 && (!page.hasMore || paths.length < 16 && page.blobs.length > 0 && typeof page.cursor === 'string' && page.cursor && !seen.has(page.cursor)));
      if (page.hasMore) seen.add(page.cursor); cursor = page.hasMore ? page.cursor : null;
    } while (cursor);
    return paths.sort();
  }
  async function initialClaims(job, grant) {
    const suffix = `${job.ownerHash}/${job.id}/`, receiptPrefix = `production/visual-reviews/${suffix}`;
    const bindingPrefix = `production/visual-review-bindings/${suffix}`;
    const [receipts, claims, reservations] = await Promise.all([listed(receiptPrefix), listed(bindingPrefix),
      listed(`production/operator-canaries/${suffix}visual-review-claims/`)]);
    need(same(receipts, [job.visualReviewRecovery.priorBindingHash, job.visualEvidenceRecovery.priorBindingHash, grant.priorBindingHash]
      .map(value => `${receiptPrefix}${value}.json`).sort())
      && same(claims, ['pre-assembly-overlays-v2', 'expanded-visual-evidence-v3'].map(policy => `${bindingPrefix}${policy}/${digest(grant.shotId)}.json`).sort())
      && reservations.length === 0);
  }
  async function context(input) {
    need(input && Object.keys(input).sort().join(',') === 'email,id,jobHash,manifestHash,originalAction,priorBindingHash,priorReceiptHash,queueHash,revisedAction'
      && typeof input.email === 'string' && input.email === input.email.trim().toLowerCase() && input.email.length <= 254
      && /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(input.email) && UUID.test(input.id || '')
      && [input.jobHash, input.manifestHash, input.priorBindingHash, input.priorReceiptHash, input.queueHash].every(v => HASH.test(v || '')));
    const identity = { ownerHash: digest(input.email), id: input.id };
    const [stored, ticket, account, saved, previous] = await Promise.all([read(jobPath(identity)), read(queuePath(identity)),
      read(userPath(input.email)), read(visualEditorialRecoveryPath(identity)), read(priorPath({ ownerHash: identity.ownerHash, preparedId: input.id, priorBindingHash: input.priorBindingHash }))]);
    const job = stored?.value, actor = account?.value;
    validJob(job);
    need(stored.etag && ticket?.etag && isOwner(actor) && actor.email === input.email && !actor.mustChangePassword
      && job.ownerHash === identity.ownerHash && job.manifestHash === input.manifestHash
      && ticket.value.version === 1 && ticket.value.email === input.email && ticket.value.id === input.id
      && ticket.value.manifestHash === input.manifestHash && HASH.test(ticket.value.orderId || ''));
    await paymentCheck({ job, email: input.email, actor, read, now });
    const evidenceGrant = await readVisualEvidenceRecovery(job, { read });
    const grant = saved?.value || { version: 1, policy: VISUAL_EDITORIAL_POLICY, ownerHash: job.ownerHash, preparedId: job.id,
      manifestHash: job.manifestHash, shotId: previous?.value?.binding?.shotId, recoveryGrantHash: hash(evidenceGrant),
      priorBindingHash: input.priorBindingHash, priorReceiptHash: input.priorReceiptHash,
      sourceOutputHash: previous?.value?.binding?.outputHash, priorFrameHashes: previous?.value?.binding?.frameHashes,
      shots: outputs(job), requestHash: hash(input), requestPlan: structuredClone(input), jobHash: input.jobHash, queueHash: input.queueHash,
      originalAction: input.originalAction, revisedAction: input.revisedAction,
      effectiveVisual: revisedEditorialVisual(job, { shotId: previous?.value?.binding?.shotId, originalAction: input.originalAction, revisedAction: input.revisedAction }),
      approvedAt: new Date(now()).toISOString(), approvedBy: input.email,
      priorJobControl: fields(job, jobFields), priorQueueControl: fields(ticket.value, queueFields) };
    need(grant.requestHash === hash(input) && Date.parse(grant.approvedAt) <= now());
    await validateGrant(job, grant, read);
    if (ticket.value.visualEditorialRecoveryHash) {
      need(saved?.etag && ticket.value.visualEditorialRecoveryHash === hash(grant) && same(job.visualEditorialRecovery, grant));
      await readVisualEditorialRecovery(job, { read });
      return { job, stored, ticket, grant, saved, already: true };
    }
    need(job.status === 'awaiting-assembly' && !job.media && ticket.value.state === 'attention'
      && !(job.lease?.expiresAt > now()) && !(ticket.value.lease?.expiresAt > now())
      && hash(ticket.value) === input.queueHash && hash(restore(job, grant.priorJobControl, jobFields)) === input.jobHash);
    if (job.visualEditorialRecovery) need(saved?.etag && same(job.visualEditorialRecovery, grant)
      && same(job, retryJob(restore(job, grant.priorJobControl, jobFields), grant)));
    else need(hash(job) === input.jobHash);
    await initialClaims(job, grant);
    return { job, stored, ticket, grant, saved, already: false };
  }
  const retryJob = (job, grant) => ({ ...job, visualEditorialRecovery: grant, revision: (job.revision || 0) + 1,
    updatedAt: grant.approvedAt, finishingFailure: { ...job.finishingFailure, state: 'retrying' } });
  async function exactWrite(path, value, etag) {
    try { await write(path, value, etag); } catch { need(same((await read(path))?.value, value)); }
    need(same((await read(path))?.value, value));
  }
  return async (input, { apply = false } = {}) => {
    let ctx = await context(input);
    const summary = { policy: VISUAL_EDITORIAL_POLICY, preparedId: input.id, manifestHash: input.manifestHash,
      shotId: ctx.grant.shotId, preservedClips: 4, maximumNewVideoRequests: 0, additionalReviewAllowance: 1,
      initialExpandedReviews: 3, originalAction: ctx.grant.originalAction, revisedAction: ctx.grant.revisedAction };
    if (ctx.already) return { ...summary, status: 'already-resumed', changed: false, queueState: ctx.ticket.value.state };
    if (!apply) return { ...summary, status: 'planned', changed: false };
    const permission = async () => {
      const value = await authorize({ email: input.email, preparedId: input.id, manifestHash: input.manifestHash,
        orderId: ctx.ticket.value.orderId, recoveryPlan: input });
      need(value?.allowed === true && value.environment === 'production' && value.manifestHash === input.manifestHash
        && value.recoveryRequestHash === hash(input) && Date.parse(value.expiresAt) > now());
      return value;
    };
    let allowed = await permission();
    if (!ctx.saved) await exactWrite(visualEditorialRecoveryPath(ctx.job), ctx.grant);
    ctx = await context(input);
    if (!ctx.job.visualEditorialRecovery) await exactWrite(jobPath(ctx.job), retryJob(ctx.job, ctx.grant), ctx.stored.etag);
    ctx = await context(input);
    if (ctx.already) return { ...summary, status: 'already-resumed', changed: false, queueState: ctx.ticket.value.state };
    await readVisualEditorialRecovery(ctx.job, { read });
    if (Date.parse(allowed.expiresAt) - now() <= 5000) { allowed = await permission(); ctx = await context(input); }
    need(Date.parse(allowed.expiresAt) > now());
    if (ctx.already) return { ...summary, status: 'already-resumed', changed: false, queueState: ctx.ticket.value.state };
    const { lease, ...ticket } = ctx.ticket.value;
    await exactWrite(queuePath(ctx.job), { ...ticket, state: 'pending', attempts: 0, updatedAt: ctx.grant.approvedAt,
      nextAttemptAt: now(), lastResult: 'RESUMED', lastFailure: null, visualEditorialRecoveryHash: hash(ctx.grant) }, ctx.ticket.etag);
    return { ...summary, status: 'resumed', changed: true, queueState: 'pending' };
  };
}
