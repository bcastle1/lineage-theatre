import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { requireFinishedFilmPayment } from './production-media.mjs';
import { parsedAssemblyOverlays } from './film-overlays.mjs';
import { validateFilmTextCorrections } from './film-text-correction.mjs';
import { list } from '@vercel/blob';

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

const PRECLAIM_POLICY = 'visual-review-preclaim-resume-v1';
const resumeJobFields = ['finishingFailure', 'revision', 'updatedAt'];
const resumeQueueFields = ['state', 'attempts', 'updatedAt', 'nextAttemptAt', 'lastResult', 'lastFailure', 'lease'];
const hash = value => digest(JSON.stringify(value));
const savedFields = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function restoreFields(value, fields, keys) {
  const restored = structuredClone(value);
  for (const key of keys) {
    if (Object.hasOwn(fields, key)) restored[key] = fields[key];
    else delete restored[key];
  }
  delete restored.visualReviewPreclaimResumeHash;
  return restored;
}
export const visualReviewPreclaimResumePath = job => {
  need(HASH.test(job?.ownerHash || '') && UUID.test(job?.id || ''));
  return `production/visual-review-recoveries/${job.ownerHash}/${job.id}/preclaim-resume-v1.json`;
};

// This is a single technical continuation before any recovered review claim.
// It cannot clear, replace or buy another model attempt. The prior failed job
// is identified by its complete hash; only control fields are copied here.
export function createPreclaimVisualReviewResume({ read = readRecord, write = writeRecord, listBlobs = list, now = Date.now,
  paymentCheck = requireFinishedFilmPayment,
  authorize = async ({ recoveryPlan, ...input }) => ({ ...(await (await import('./payments.mjs')).payments.authorizeProduction(input)),
    recoveryRequestHash: hash(recoveryPlan) }) } = {}) {
  async function listed(prefix) {
    const paths = [], cursors = new Set(); let cursor;
    do {
      const page = await listBlobs({ prefix, limit: 32 - paths.length, ...(cursor ? { cursor } : {}) });
      need(page && Array.isArray(page.blobs) && typeof page.hasMore === 'boolean');
      for (const blob of page.blobs) {
        need(typeof blob?.pathname === 'string' && blob.pathname.startsWith(prefix) && !paths.includes(blob.pathname));
        paths.push(blob.pathname);
      }
      need(paths.length <= 32 && (!page.hasMore || paths.length < 32 && page.blobs.length > 0
        && typeof page.cursor === 'string' && page.cursor.length > 0 && !cursors.has(page.cursor)));
      if (page.hasMore) cursors.add(page.cursor);
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor);
    return paths.sort();
  }
  async function noClaims(job, grant) {
    const suffix = `${job.ownerHash}/${job.id}/`;
    const bindingPrefix = `production/visual-review-bindings/${suffix}`;
    const receiptPrefix = `production/visual-reviews/${suffix}`;
    const reservedPrefix = `production/operator-canaries/${suffix}visual-review-claims/`;
    const [bindings, receipts, reservations, direct] = await Promise.all([
      listed(bindingPrefix), listed(receiptPrefix), listed(reservedPrefix),
      Promise.all(job.shots.map(shot => read(`${bindingPrefix}${VISUAL_RECOVERY_POLICY}/${digest(shot.id)}.json`))),
    ]);
    need(bindings.length === 0 && reservations.length === 0 && direct.every(record => !record)
      && same(receipts, [priorPath(grant)]));
  }
  function receiptMatches(receipt, input) {
    need(receipt?.version === 1 && receipt.policy === PRECLAIM_POLICY && receipt.ownerHash === digest(input.email)
      && receipt.preparedId === input.id && receipt.manifestHash === input.manifestHash
      && receipt.recoveryGrantHash === input.recoveryGrantHash && receipt.requestHash === hash(input)
      && receipt.jobHash === input.jobHash && receipt.queueHash === input.queueHash
      && receipt.approvedBy === input.email && Number.isFinite(Date.parse(receipt.approvedAt))
      && Date.parse(receipt.approvedAt) <= now()
      && receipt.priorJobControl && receipt.priorQueueControl
      && Object.keys(receipt.priorJobControl).every(key => resumeJobFields.includes(key))
      && Object.keys(receipt.priorQueueControl).every(key => resumeQueueFields.includes(key)));
  }
  function retryJob(prior, receipt) {
    return { ...prior, visualReviewPreclaimResumeHash: hash(receipt), revision: (prior.revision || 0) + 1,
      updatedAt: receipt.approvedAt, finishingFailure: { ...prior.finishingFailure, state: 'retrying' } };
  }
  function retryQueue(prior, receipt) {
    const { lease, ...ticket } = prior;
    return { ...ticket, state: 'pending', attempts: 0, updatedAt: receipt.approvedAt,
      nextAttemptAt: Date.parse(receipt.approvedAt), lastResult: 'RESUMED', lastFailure: null,
      visualReviewPreclaimResumeHash: hash(receipt) };
  }
  async function context(input) {
    need(input && Object.keys(input).sort().join(',') === 'email,id,jobHash,manifestHash,queueHash,recoveryGrantHash'
      && typeof input.email === 'string' && input.email === input.email.trim().toLowerCase()
      && /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(input.email) && input.email.length <= 254
      && UUID.test(input.id || '') && [input.manifestHash, input.recoveryGrantHash, input.jobHash, input.queueHash]
        .every(value => typeof value === 'string' && HASH.test(value)));
    const identity = { ownerHash: digest(input.email), id: input.id };
    const [stored, ticket, account, saved] = await Promise.all([read(jobPath(identity)), read(queuePath(identity)),
      read(userPath(input.email)), read(visualReviewPreclaimResumePath(identity))]);
    const job = stored?.value, actor = account?.value;
    validJob(job);
    need(stored.etag && ticket?.etag && isOwner(actor) && actor.email === input.email && !actor.mustChangePassword
      && job.ownerHash === identity.ownerHash && job.manifestHash === input.manifestHash && job.shots.length === 4
      && ticket.value.version === 1 && ticket.value.email === input.email && ticket.value.id === input.id
      && ticket.value.manifestHash === input.manifestHash && HASH.test(ticket.value.orderId || ''));
    const grant = await readVisualReviewRecovery(job, { read });
    need(grant && hash(grant) === input.recoveryGrantHash && ticket.value.visualReviewRecoveryHash === input.recoveryGrantHash);
    await paymentCheck({ job, email: input.email, actor, read, now });
    const receipt = saved?.value;
    if (saved) { need(saved.etag); receiptMatches(receipt, input); }
    if (ticket.value.visualReviewPreclaimResumeHash) {
      need(receipt && ticket.value.visualReviewPreclaimResumeHash === hash(receipt)
        && job.visualReviewPreclaimResumeHash === hash(receipt));
      return { job, stored, ticket, grant, receipt, actor, already: true };
    }
    need(job.status === 'awaiting-assembly' && !job.media && ticket.value.state === 'attention'
      && !(job.lease?.expiresAt > now()) && !(ticket.value.lease?.expiresAt > now()));
    const priorJob = receipt ? restoreFields(job, receipt.priorJobControl, resumeJobFields) : job;
    const priorQueue = receipt ? restoreFields(ticket.value, receipt.priorQueueControl, resumeQueueFields) : ticket.value;
    need(hash(priorJob) === input.jobHash && hash(priorQueue) === input.queueHash
      && (!job.visualReviewPreclaimResumeHash ? hash(job) === input.jobHash
        : receipt && same(job, retryJob(priorJob, receipt)))
      && hash(ticket.value) === input.queueHash
      && priorJob.finishingFailure?.version === 1 && priorJob.finishingFailure.manifestHash === input.manifestHash
      && priorJob.finishingFailure.state === 'attention' && priorJob.finishingFailure.stage === 'visual-review'
      && priorJob.finishingFailure.reason === 'VISUAL_REVIEW_REQUIRED'
      && Number.isFinite(Date.parse(priorJob.finishingFailure.recordedAt))
      && Date.parse(priorJob.finishingFailure.recordedAt) >= Date.parse(grant.approvedAt)
      && Date.parse(priorJob.finishingFailure.recordedAt) <= now()
      && priorQueue.lastResult === 'REVIEW_REQUIRED'
      && same(priorQueue.lastFailure, { stage: 'visual-review', reason: 'VISUAL_REVIEW_REQUIRED' }));
    await noClaims(job, grant);
    return { job, stored, ticket, grant, receipt, actor, priorJob, priorQueue, already: false };
  }
  async function exactWrite(path, value, etag) {
    try { await write(path, value, etag); }
    catch { need(same((await read(path))?.value, value)); }
    need(same((await read(path))?.value, value));
  }
  return async (input, { apply = false } = {}) => {
    let ctx = await context(input);
    const summary = { version: 1, policy: PRECLAIM_POLICY, preparedId: input.id, manifestHash: input.manifestHash,
      recoveryGrantHash: input.recoveryGrantHash, preservedClips: 4, maximumNewVideoRequests: 0, additionalReviewAllowance: 0 };
    if (ctx.already) return { ...summary, status: 'already-resumed', changed: false, queueState: ctx.ticket.value.state };
    if (!apply) return { ...summary, status: 'planned', changed: false };
    const freshPermission = async () => {
      const value = await authorize({ email: input.email, preparedId: input.id, manifestHash: input.manifestHash,
        orderId: ctx.ticket.value.orderId, recoveryPlan: input });
      need(value?.allowed === true && value.environment === 'production' && value.manifestHash === input.manifestHash
        && value.recoveryRequestHash === hash(input) && Date.parse(value.expiresAt) > now());
      return value;
    };
    let permission = await freshPermission();
    const path = visualReviewPreclaimResumePath(ctx.job);
    if (!ctx.receipt) {
      const candidate = { version: 1, policy: PRECLAIM_POLICY, ownerHash: ctx.job.ownerHash, preparedId: input.id,
        manifestHash: input.manifestHash, recoveryGrantHash: input.recoveryGrantHash, requestHash: hash(input),
        jobHash: input.jobHash, queueHash: input.queueHash, approvedAt: new Date(now()).toISOString(), approvedBy: input.email,
        priorJobControl: savedFields(ctx.priorJob, resumeJobFields), priorQueueControl: savedFields(ctx.priorQueue, resumeQueueFields) };
      try { await write(path, candidate); } catch { /* Exact-input winner is validated below; never overwrite it. */ }
      const saved = await read(path); need(saved?.etag); receiptMatches(saved.value, input);
    }
    ctx = await context(input);
    if (ctx.already) return { ...summary, status: 'already-resumed', changed: false, queueState: ctx.ticket.value.state };
    need(ctx.receipt);
    if (!ctx.job.visualReviewPreclaimResumeHash) await exactWrite(jobPath(ctx.job), retryJob(ctx.priorJob, ctx.receipt), ctx.stored.etag);
    ctx = await context(input);
    if (ctx.already) return { ...summary, status: 'already-resumed', changed: false, queueState: ctx.ticket.value.state };
    need(ctx.job.visualReviewPreclaimResumeHash === hash(ctx.receipt));
    if (Date.parse(permission.expiresAt) - now() <= 5000) {
      permission = await freshPermission();
      ctx = await context(input);
      if (ctx.already) return { ...summary, status: 'already-resumed', changed: false, queueState: ctx.ticket.value.state };
    }
    need(Date.parse(permission.expiresAt) > now());
    await exactWrite(queuePath(ctx.job), retryQueue(ctx.priorQueue, ctx.receipt), ctx.ticket.etag);
    return { ...summary, status: 'resumed', changed: true, queueState: 'pending' };
  };
}
