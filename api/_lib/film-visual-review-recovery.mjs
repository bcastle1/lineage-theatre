import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { requireFinishedFilmPayment } from './production-media.mjs';
import { parsedAssemblyOverlays } from './film-overlays.mjs';
import { validateFilmTextCorrections } from './film-text-correction.mjs';

export const VISUAL_RECOVERY_POLICY = 'pre-assembly-overlays-v2';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = () => Object.assign(Error('The saved visual recovery requires verification.'), { code: 'VISUAL_REVIEW_INVALID' });
const need = value => { if (!value) throw fail(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jobPath = job => `production/jobs/${job.ownerHash}/${job.id}.json`;
const queuePath = job => `production/queue/${job.ownerHash}/${job.id}.json`;
const priorPath = grant => `production/visual-reviews/${grant.ownerHash}/${grant.preparedId}/${grant.priorBindingHash}.json`;
export const visualReviewRecoveryPath = job => {
  need(HASH.test(job?.ownerHash || '') && UUID.test(job?.id || ''));
  return `production/visual-review-recoveries/${job.ownerHash}/${job.id}/${VISUAL_RECOVERY_POLICY}.json`;
};
const outputs = job => job.shots.map(shot => ({ shotId: shot.id, outputHash: digest(JSON.stringify(shot.output)) }));
function validJob(job) {
  need(job?.manifest?.version === 1 && HASH.test(job.ownerHash || '') && UUID.test(job.id || '')
    && job.mode === 'customer' && ['awaiting-assembly', 'completed'].includes(job.status)
    && job.provider?.id === 'fal' && job.provider.model === 'seedance'
    && job.manifest?.productionPlan?.provider === 'seedance' && job.manifest.visualContinuity?.version === 1
    && HASH.test(job.manifestHash || '') && digest(JSON.stringify(job.manifest)) === job.manifestHash
    && Array.isArray(job.shots) && job.shots.length === job.manifest.shots.length && job.shots.length > 0
    && job.shots.every((shot, index) => shot.id === job.manifest.shots[index].id && shot.status === 'completed' && shot.output));
}
function validateGrant(job, grant, prior) {
  validJob(job);
  need(grant?.version === 1 && grant.policy === VISUAL_RECOVERY_POLICY && grant.ownerHash === job.ownerHash
    && grant.preparedId === job.id && grant.sourceManifestHash === job.manifestHash
    && HASH.test(grant.priorBindingHash || '') && HASH.test(grant.priorReceiptHash || '')
    && same(grant.shots, outputs(job)) && Number.isFinite(Date.parse(grant.approvedAt))
    && digest(grant.approvedBy || '') === job.ownerHash && grant.priorFailure?.state === 'attention'
    && grant.priorFailure.stage === 'visual-review' && grant.priorFailure.reason === 'VISUAL_CONTINUITY_MISMATCH');
  const index = job.manifest.shots.findIndex(shot => shot.id === grant.shotId), shot = job.manifest.shots[index];
  const binding = prior?.binding, decision = prior?.decision;
  need(shot && parsedAssemblyOverlays(shot.visual).length > 0 && prior.version === 1 && prior.state === 'reviewed'
    && prior.model === 'gpt-6.2-astra' && prior.bindingHash === grant.priorBindingHash
    && digest(JSON.stringify(prior)) === grant.priorReceiptHash
    && binding?.version === 1 && digest(JSON.stringify(binding)) === grant.priorBindingHash
    && binding.manifestHash === job.manifestHash && binding.shotId === shot.id
    && binding.outputHash === grant.sourceOutputHash && binding.outputHash === outputs(job)[index].outputHash
    && same(binding.frameHashes, grant.sourceFrameHashes) && Array.isArray(binding.frameHashes)
    && binding.frameHashes.length === (index > 0 && job.manifest.shots[index - 1].sceneIndex === shot.sceneIndex ? 4 : 3)
    && binding.frameHashes.every(hash => HASH.test(hash))
    && binding.precedingOutputHash === (index > 0 && job.manifest.shots[index - 1].sceneIndex === shot.sceneIndex
      ? outputs(job)[index - 1].outputHash : null)
    && decision.sceneAction === 'mismatch' && ['appearance', 'wardrobe', 'imageIntegrity', 'cast'].every(key => decision[key] === 'consistent')
    && same(decision.findings, ['wrong-action-or-setting']));
  validateFilmTextCorrections(job, grant.textCorrections);
  return grant;
}

// A recovery never turns the earlier decision into a pass. Every use rechecks
// its immutable grant, original rejection and the current exact source clips.
export async function readVisualReviewRecovery(job, { read = readRecord } = {}) {
  if (!job?.visualReviewRecovery) {
    const current = await read(jobPath(job));
    need(!current?.value?.visualReviewRecovery);
    return null;
  }
  const marker = job.visualReviewRecovery;
  need(marker.ownerHash === job.ownerHash && marker.preparedId === job.id && HASH.test(marker.priorBindingHash || ''));
  const [current, saved, prior] = await Promise.all([read(jobPath(job)), read(visualReviewRecoveryPath(job)), read(priorPath(marker))]);
  need(current?.value && same(current.value.visualReviewRecovery, marker) && same(saved?.value, marker)
    && current.value.manifestHash === job.manifestHash && same(outputs(current.value), outputs(job)));
  validateGrant(current.value, marker, prior?.value);
  return validateGrant(job, marker, prior?.value);
}

export function createVisualReviewRecovery({ read = readRecord, write = writeRecord, now = Date.now,
  paymentCheck = requireFinishedFilmPayment,
  authorize = async ({ recoveryPlan, ...input }) => ({ ...(await (await import('./payments.mjs')).payments.authorizeProduction(input)),
    recoveryRequestHash: digest(JSON.stringify(recoveryPlan)) }) } = {}) {
  async function context(input) {
    const { email, id, manifestHash, bindingHash, receiptHash, shots } = input;
    need(typeof email === 'string' && email === email.trim().toLowerCase() && UUID.test(id || '')
      && [manifestHash, bindingHash, receiptHash].every(value => HASH.test(value || '')));
    const identity = { ownerHash: digest(email), id };
    const [stored, ticket, account, previous] = await Promise.all([read(jobPath(identity)), read(queuePath(identity)),
      read(userPath(email)), read(priorPath({ ownerHash: identity.ownerHash, preparedId: id, priorBindingHash: bindingHash }))]);
    const job = stored?.value, actor = account?.value;
    validJob(job);
    validateFilmTextCorrections(job, input.textCorrections);
    need(isOwner(actor) && actor.email === email && !actor.mustChangePassword && job.ownerHash === identity.ownerHash
      && job.manifestHash === manifestHash && same(shots, outputs(job)) && ticket?.value.email === email
      && ticket.value.id === id && ticket.value.manifestHash === manifestHash && HASH.test(ticket.value.orderId || '')
      && digest(JSON.stringify(previous?.value)) === receiptHash);
    await paymentCheck({ job, email, actor, read, now });
    return { job, stored, ticket, actor, prior: previous.value };
  }
  async function writeExact(path, value, etag) {
    try { await write(path, value, etag); }
    catch { const saved = await read(path); need(same(saved?.value, value)); }
    need(same((await read(path))?.value, value));
  }
  return async (input, { apply = false } = {}) => {
    let ctx = await context(input);
    const path = visualReviewRecoveryPath(ctx.job), existing = await read(path);
    const grant = existing?.value || { version: 1, policy: VISUAL_RECOVERY_POLICY, ownerHash: ctx.job.ownerHash,
      preparedId: ctx.job.id, sourceManifestHash: ctx.job.manifestHash, shotId: ctx.prior.binding.shotId,
      priorBindingHash: input.bindingHash, priorReceiptHash: input.receiptHash,
      sourceOutputHash: ctx.prior.binding.outputHash, sourceFrameHashes: ctx.prior.binding.frameHashes,
      shots: outputs(ctx.job), approvedAt: new Date(now()).toISOString(), approvedBy: input.email,
      priorFailure: ctx.job.finishingFailure, ...(input.textCorrections ? { textCorrections: input.textCorrections } : {}) };
    validateGrant(ctx.job, grant, ctx.prior);
    need(grant.priorBindingHash === input.bindingHash && grant.priorReceiptHash === input.receiptHash
      && Date.parse(grant.approvedAt) <= now() && same(grant.textCorrections, input.textCorrections));
    const grantHash = digest(JSON.stringify(grant));
    const summary = { version: 1, policy: VISUAL_RECOVERY_POLICY, preparedId: input.id, manifestHash: input.manifestHash,
      grantHash, preservedClips: grant.shots.length, maximumNewVideoRequests: 0, maximumReviewsPerClip: 1,
      previousRejectionRetained: true };
    if (ctx.ticket.value.visualReviewRecoveryHash) {
      need(ctx.ticket.value.visualReviewRecoveryHash === grantHash);
      await readVisualReviewRecovery(ctx.job, { read });
      return { ...summary, status: 'already-resumed', queueState: ctx.ticket.value.state, changed: false };
    }
    need(ctx.job.status === 'awaiting-assembly' && !ctx.job.media && ctx.ticket.value.state === 'attention'
      && !(ctx.ticket.value.lease?.expiresAt > now()) && !(ctx.job.lease?.expiresAt > now()));
    if (ctx.job.visualReviewRecovery) {
      need(same(ctx.job.visualReviewRecovery, grant));
      await readVisualReviewRecovery(ctx.job, { read });
    } else need(same(ctx.job.finishingFailure, grant.priorFailure));
    if (!apply) return { ...summary, status: 'planned', changed: false };
    const freshPermission = async () => {
      const result = await authorize({ email: input.email, preparedId: input.id, manifestHash: input.manifestHash,
        orderId: ctx.ticket.value.orderId, recoveryPlan: input });
      need(result?.allowed === true && result.manifestHash === input.manifestHash
        && result.environment === 'production' && Date.parse(result.expiresAt) > now()
        && result.recoveryRequestHash === digest(JSON.stringify(input)));
      return result;
    };
    let permission = await freshPermission();
    if (!existing) await writeExact(path, grant);
    // Recheck live owner/payment/source state after the durable approval and
    // immediately before each conditional update. A changed job cannot resume.
    ctx = await context(input);
    if (!ctx.job.visualReviewRecovery) {
      need(ctx.job.status === 'awaiting-assembly' && !ctx.job.media && same(ctx.job.finishingFailure, grant.priorFailure)
        && !(ctx.job.lease?.expiresAt > now()) && !(ctx.ticket.value.lease?.expiresAt > now()) && ctx.ticket.value.state === 'attention');
      await writeExact(jobPath(ctx.job), { ...ctx.job, visualReviewRecovery: grant,
        revision: (ctx.job.revision || 0) + 1, updatedAt: new Date(now()).toISOString(),
        finishingFailure: { ...ctx.job.finishingFailure, state: 'retrying' } }, ctx.stored.etag);
    }
    ctx = await context(input);
    await readVisualReviewRecovery(ctx.job, { read });
    if (ctx.ticket.value.visualReviewRecoveryHash) {
      need(ctx.ticket.value.visualReviewRecoveryHash === grantHash);
      return { ...summary, status: 'already-resumed', queueState: ctx.ticket.value.state, changed: false };
    }
    need(ctx.job.status === 'awaiting-assembly' && !ctx.job.media && ctx.ticket.value.state === 'attention'
      && !(ctx.ticket.value.lease?.expiresAt > now()) && !(ctx.job.lease?.expiresAt > now()));
    // The worker repeats live authorization before inference and delivery.
    // Expiry while reconciling approval writes cannot release this queue.
    if (Date.parse(permission.expiresAt) - now() <= 5000) permission = await freshPermission();
    need(Date.parse(permission.expiresAt) > now());
    const { lease, ...ticket } = ctx.ticket.value;
    await writeExact(queuePath(ctx.job), { ...ticket, state: 'pending', attempts: 0, nextAttemptAt: now(),
      lastResult: 'RESUMED', lastFailure: null, visualReviewRecoveryHash: grantHash }, ctx.ticket.etag);
    return { ...summary, status: 'resumed', queueState: 'pending', changed: true };
  };
}
