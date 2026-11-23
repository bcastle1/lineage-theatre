import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { falPlan, falShotInput, SEEDANCE_RECIPE_VERSION } from './fal-production.mjs';
import { FAL_MODELS, falRequestPath, falRequestUrl } from './fal-client.mjs';
import { partialBillingEvidencePath } from './partial-film-correction.mjs';
import { verifyNarrationPredecessorFailure, NARRATION_SUCCESSOR_KIND, narrationSuccessorId } from './narration-successor.mjs';

export const CONTEXT_SUCCESSOR_KIND = 'seedance-single-scene-context-successor-v1';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => digest(JSON.stringify(value));
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const inactive = (lease, now) => !lease || Number.isFinite(lease.expiresAt) && lease.expiresAt <= now();
const jobPath = (email, id) => `production/jobs/${digest(email)}/${id}.json`;
const queuePath = (email, id) => `production/queue/${digest(email)}/${id}.json`;
const intentPathFor = parentId => `production/correction-successor-intents/${parentId}.json`;
const legacyId = orderId => digest(`merchant-funded-correction-v1:${orderId}`);
export class ContextSuccessorError extends Error {
  constructor() { super('The approved scene instructions need verification before production can continue.');
    this.name = 'ContextSuccessorError'; this.code = 'CONTEXT_SUCCESSOR_UNVERIFIED'; this.status = 409; }
}
const check = value => { if (!value) throw new ContextSuccessorError(); };
export const contextSuccessorPath = parentId => { check(HASH.test(parentId || '')); return `production/correction-successors/${parentId}.json`; };
export const contextSuccessorId = (parentId, manifestHash) => {
  check(HASH.test(parentId || '') && HASH.test(manifestHash || ''));
  return digest(`seedance-context-successor-v1:${parentId}:${manifestHash}`);
};
export function contextSuccessorPreparedId(email, parentPreparedId, manifestHash) {
  check(typeof email === 'string' && UUID.test(parentPreparedId || '') && HASH.test(manifestHash || ''));
  const id = digest(`seedance-context-successor-v1:${email}:${parentPreparedId}:${manifestHash}`).slice(0, 32);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
export function buildContextSuccessorManifest(parent, { shotId, filmContext, historicalBoundaries } = {}) {
  check([filmContext, historicalBoundaries].every(text => typeof text === 'string' && text.trim() && text.length <= 2000 && !/[<>\x00-\x1f\x7f]/.test(text)));
  const plan = falPlan(parent, 'seedance'), index = parent.shots.findIndex(row => row.id === shotId), shot = parent.shots[index];
  check(plan.shots.length === 4 && parent.screenplay.scenes.length === 4 && plan.shots.every(row => row.endpoint === FAL_MODELS.seedanceText)
    && shot && parent.shots.filter(row => row.sceneIndex === shot.sceneIndex).length === 1
    && parent.shots.every(row => !Object.hasOwn(row, 'providerContext')));
  const manifest = structuredClone(parent);
  // Only this shot's two provider context lines change. Historical source,
  // screenplay, narration, visual direction and edit windows stay immutable.
  manifest.shots[index].providerContext = { version: 1, filmContext, historicalBoundaries };
  falPlan(manifest, 'seedance');
  return { manifest, manifestHash: hash(manifest) };
}

function billing(value, parent, receipt, now) {
  check(exact(value, ['version', 'kind', 'basis', 'account', 'operationIdentity', 'requestId', 'recordHash', 'costNanoUsd',
    'quantity', 'evidenceSha256', 'observedAt', 'approvedBy']) && value.version === 1
    && value.kind === 'owner-reviewed-request-zero-charge-v1' && value.basis === 'provider-request-billing-row'
    && value.account === parent.grant.partial.billingAccount && value.operationIdentity === receipt.identity
    && value.requestId === receipt.requestId && value.recordHash === hash(receipt) && value.costNanoUsd === 0 && value.quantity === 0
    && HASH.test(value.evidenceSha256 || '') && value.approvedBy === parent.grant.customerEmail
    && time(value.observedAt) && Date.parse(value.observedAt) >= Date.parse(receipt.checkedAt) && Date.parse(value.observedAt) <= now());
}
async function parentContext(email, parentId, read, now) {
  const { readPaidFilmCorrection } = await import('./paid-film-correction.mjs');
  const saved = (await read(`production/corrections/${parentId}.json`))?.value;
  check(saved?.partial?.version === 2 && saved.partial.kind === NARRATION_SUCCESSOR_KIND
    && parentId === narrationSuccessorId(legacyId(saved.originalOrderId), saved.manifestHash));
  const context = await readPaidFilmCorrection({ email, correctionId: parentId, read, now });
  check(!context.retry && context.job.status === 'failed' && inactive(context.job.lease, now));
  const selected = context.job.shots.find(row => row.id === context.grant.partial.shotId);
  const identity = digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${selected?.requestKey}`);
  const queue = await read(queuePath(email, context.job.id));
  const failed = await read(falRequestPath(identity)), receipt = failed?.value;
  check(context.job.authorization?.correctionId === parentId && context.job.authorization.originalOrderId === context.order.id
    && context.job.authorization.manifestHash === context.job.manifestHash && context.job.authorization.environment === 'production'
    && context.job.authorization.budgetCents === context.grant.quote.maximumCostCents
    && context.job.authorization.quoteReference === context.grant.quote.quoteReference && context.job.shots.length === 4);
  for (const proof of context.grant.partial.reused) {
    const shot = context.job.shots.find(row => row.id === proof.shotId);
    check(shot?.status === 'completed' && shot.providerJobId === `fal-${digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${shot.requestKey}`)}`
      && shot.output?.sha256 === proof.mediaSha256 && shot.output.sizeBytes === proof.sizeBytes
      && shot.output.contentType === 'video/mp4' && shot.output.durationSeconds === proof.generatedSeconds
      && digest(shot.output.url) === proof.sourceUrlHash);
  }
  check(queue?.etag && queue.value.state === 'attention' && inactive(queue.value.lease, now)
    && queue.value.email === email && queue.value.id === context.job.id && queue.value.orderId === parentId
    && queue.value.manifestHash === context.job.manifestHash && failed?.etag && receipt.identity === identity
    && receipt.endpoint === FAL_MODELS.seedanceText && receipt.inputHash === context.grant.partial.newInputHash
    && receipt.state === 'failed' && receipt.failureCode === 'FAL_RENDER_FAILED' && !receipt.result && time(receipt.checkedAt)
    && selected?.status === 'failed' && selected.providerJobId === `fal-${identity}`);
  falRequestUrl(receipt.statusUrl, receipt.endpoint, receipt.requestId, 'status');
  falRequestUrl(receipt.responseUrl, receipt.endpoint, receipt.requestId, 'result');
  return { ...context, queue, failed, recheck: async () => {
    const [, currentQueue, currentFailed] = await Promise.all([context.recheck(), read(queuePath(email, context.job.id)), read(falRequestPath(identity))]);
    check(currentQueue?.etag === queue.etag && currentFailed?.etag === failed.etag);
  } };
}
function plan(parent, target, filmContext, historicalBoundaries, maximumNewCostCents, evidence, proof, now) {
  const original = parent.grant.partial, changed = buildContextSuccessorManifest(parent.job.manifest, { shotId: original.shotId, filmContext, historicalBoundaries });
  check(target.manifestHash === changed.manifestHash && hash(target.manifest) === changed.manifestHash
    && target.id === contextSuccessorPreparedId(parent.grant.customerEmail, parent.job.id, changed.manifestHash)
    && target.filmId === parent.job.filmId && target.ownerHash === parent.job.ownerHash && target.mode === 'customer'
    && target.shots?.length === 4 && target.shots.every((row, i) => row.id === target.manifest.shots[i].id
      && row.requestKey === digest(`${target.id}:${target.manifestHash}:${row.id}`))
    && Number.isSafeInteger(maximumNewCostCents) && maximumNewCostCents > 0 && maximumNewCostCents <= original.maximumNewCostCents);
  billing(evidence, parent, parent.failed.value, now);
  check(proof?.version === 1 && proof.requestId === parent.failed.value.requestId && proof.status === 'COMPLETED'
    && proof.resultHttpStatus === 422 && proof.failureType === 'content_policy_violation'
    && HASH.test(proof.statusBodySha256 || '') && HASH.test(proof.resultBodySha256 || '') && time(proof.verifiedAt)
    && Date.parse(proof.verifiedAt) >= Date.parse(parent.failed.value.checkedAt) && Date.parse(proof.verifiedAt) <= now());
  for (const reused of original.reused) {
    const shot = falPlan(target.manifest, 'seedance').shots.find(row => row.id === reused.shotId);
    check(hash(falShotInput(target.manifest, shot, 'seedance', {})) === reused.inputHash && shot.seconds === reused.generatedSeconds);
  }
  const shot = falPlan(target.manifest, 'seedance').shots.find(row => row.id === original.shotId);
  check(shot.seconds === original.generatedSeconds);
  return { version: 3, kind: CONTEXT_SUCCESSOR_KIND, fundingKind: 'original-reservation',
    billingAccount: original.billingAccount, shotId: original.shotId, filmContext, historicalBoundaries, narration: original.narration, visual: original.visual,
    sourcePreparedId: original.sourcePreparedId, sourceManifestHash: original.sourceManifestHash,
    manifestHash: target.manifestHash, newInputHash: hash(falShotInput(target.manifest, shot, 'seedance', {})),
    generatedSeconds: shot.seconds, maximumNewCostCents, reused: structuredClone(original.reused),
    priorCostNanoUsd: original.priorCostNanoUsd, originalReservation: structuredClone(original.originalReservation),
    parentCorrectionId: parent.grant.id, parentPreparedId: parent.job.id, parentManifestHash: parent.job.manifestHash,
    parentGrantHash: hash(parent.grant), parentJobHash: hash(parent.job), parentQueueHash: hash(parent.queue.value),
    failedOperationIdentity: parent.failed.value.identity,
    failedRequestId: parent.failed.value.requestId, failedRecordHash: hash(parent.failed.value),
    billingEvidenceHash: hash(evidence), providerProof: proof };
}

export async function validateContextSuccessor({ grant, target, order, read = readRecord, now = Date.now }) {
  const p = grant.partial;
  check(p?.version === 3 && p.kind === CONTEXT_SUCCESSOR_KIND && p.parentCorrectionId === narrationSuccessorId(legacyId(order.id), p.parentManifestHash)
    && grant.id === contextSuccessorId(p.parentCorrectionId, grant.manifestHash));
  const parent = await parentContext(grant.customerEmail, p.parentCorrectionId, read, now);
  const [evidence, link, intent, forbiddenChild] = await Promise.all([read(partialBillingEvidencePath(p.billingEvidenceHash)),
    read(contextSuccessorPath(p.parentCorrectionId)), read(intentPathFor(p.parentCorrectionId)), read(contextSuccessorPath(grant.id))]);
  check(intent?.etag && hash(intent.value) === hash({ version: 1, parentCorrectionId: p.parentCorrectionId,
    correctionId: grant.id, preparedId: target.id, manifestHash: target.manifestHash, shotId: p.shotId, filmContext: p.filmContext, historicalBoundaries: p.historicalBoundaries,
    failedOperationIdentity: p.failedOperationIdentity, failedRequestId: p.failedRequestId, failedRecordHash: p.failedRecordHash,
    billingEvidenceHash: p.billingEvidenceHash, maximumNewCostCents: p.maximumNewCostCents, reason: grant.reason,
    approvedBy: grant.approvedBy, providerProof: p.providerProof, approvedAt: grant.approvedAt }));
  check(evidence?.etag && link?.etag && hash(link.value) === hash({ version: 1, parentCorrectionId: p.parentCorrectionId,
    correctionId: grant.id, preparedId: target.id, manifestHash: target.manifestHash, grantHash: hash(grant) })
    && !forbiddenChild && target.partialCorrection?.version === 1
    && target.partialCorrection.correctionId === grant.id && target.partialCorrection.planHash === hash(p)
    && target.contextSuccessor?.version === 1 && target.contextSuccessor.parentCorrectionId === p.parentCorrectionId && !target.narrationSuccessor
    && !target.partialCorrectionRetry && grant.originalOrderId === parent.grant.originalOrderId
    && grant.originalPreparedId === parent.grant.originalPreparedId && grant.originalManifestHash === parent.grant.originalManifestHash
    && grant.sourceOrderHash === parent.grant.sourceOrderHash && grant.maximumCostCents === parent.grant.maximumCostCents);
  check(hash(plan(parent, target, p.filmContext, p.historicalBoundaries, p.maximumNewCostCents, evidence.value, p.providerProof, now)) === hash(p)
    && grant.quote.partialPlanHash === hash(p) && grant.quote.maximumCostCents <= grant.maximumCostCents
    && grant.quote.providerCostCents <= p.maximumNewCostCents && Date.parse(p.providerProof.verifiedAt) <= Date.parse(grant.approvedAt));
  return { recheck: async () => {
    const [, currentLink, currentIntent, currentEvidence, child] = await Promise.all([parent.recheck(),
      read(contextSuccessorPath(p.parentCorrectionId)), read(intentPathFor(p.parentCorrectionId)),
      read(partialBillingEvidencePath(p.billingEvidenceHash)), read(contextSuccessorPath(grant.id))]);
    check(currentLink?.etag === link.etag && currentIntent?.etag === intent.etag && currentEvidence?.etag === evidence.etag && !child);
  } };
}

export function createContextSuccessor({ read = readRecord, write = writeRecord, now = Date.now, env = process.env,
  price, authorizeParent, verifyFailure = receipt => verifyNarrationPredecessorFailure(receipt, { now }) } = {}) {
  async function immutable(path, value) {
    try { await write(path, value); } catch { /* Exact readback only; never overwrite another approved version. */ }
    const saved = await read(path); check(saved?.etag && hash(saved.value) === hash(value)); return saved;
  }
  return { approve: async ({ actor, parentCorrectionId, preparedId, manifestHash, shotId, filmContext, historicalBoundaries, failedOperationIdentity,
    failedRequestId, failedRecordHash, billingEvidence, maximumNewCostCents, reason, confirmed } = {}) => {
    const owner = actor?.email && await read(userPath(actor.email));
    check(isOwner(actor) && !actor.mustChangePassword && owner?.etag && isOwner(owner.value) && !owner.value.mustChangePassword
      && owner.value.email === actor.email && confirmed === true && typeof reason === 'string' && reason.trim().length >= 10
      && reason.length <= 500 && !/[<>\x00-\x1f\x7f]/.test(reason));
    const parent = await parentContext(actor.email, parentCorrectionId, read, now), p = parent.grant.partial;
    check(p.billingAccount === env.FAL_BILLING_ACCOUNT && p.shotId === shotId && parent.failed.value.identity === failedOperationIdentity
      && parent.failed.value.requestId === failedRequestId && hash(parent.failed.value) === failedRecordHash);
    const built = buildContextSuccessorManifest(parent.job.manifest, { shotId, filmContext, historicalBoundaries });
    check(built.manifestHash === manifestHash && preparedId === contextSuccessorPreparedId(actor.email, parent.job.id, manifestHash));
    const correctionId = contextSuccessorId(parentCorrectionId, manifestHash), path = `production/corrections/${correctionId}.json`;
    const matches = grant => grant?.partial?.parentCorrectionId === parentCorrectionId && grant.preparedId === preparedId
      && grant.manifestHash === manifestHash && grant.partial.filmContext === filmContext && grant.partial.historicalBoundaries === historicalBoundaries && grant.reason === reason
      && grant.partial.maximumNewCostCents === maximumNewCostCents && grant.partial.billingEvidenceHash === hash(billingEvidence);
    const saved = await read(path);
    if (saved) {
      const { readPaidFilmCorrection } = await import('./paid-film-correction.mjs');
      const context = await readPaidFilmCorrection({ email: actor.email, correctionId, read, now }); check(matches(context.grant));
      const authorization = await authorizeParent(parent, maximumNewCostCents); await authorization.recheck(); await context.recheck();
      return summary(context.grant);
    }
    const link = await read(contextSuccessorPath(parentCorrectionId));
    if (link) check(link.value.correctionId === correctionId && link.value.preparedId === preparedId && link.value.manifestHash === manifestHash);
    const health = (await read('production/worker-health.json'))?.value;
    check(health?.ready === true && health.sceneContextSuccessorVersion === 1 && health.model === 'seedance'
      && health.recipe === SEEDANCE_RECIPE_VERSION && time(health.checkedAt) && Date.parse(health.checkedAt) <= now()
      && now() - Date.parse(health.checkedAt) <= 180_000);
    const freshProof = await verifyFailure(parent.failed.value);
    const authorization = await authorizeParent(parent, maximumNewCostCents); await authorization.recheck();
    const identity = { id: preparedId, ownerHash: digest(actor.email), filmId: parent.job.filmId, manifestHash, manifest: built.manifest,
      mode: 'customer', shots: built.manifest.shots.map(shot => ({ id: shot.id, status: 'prepared', requestKey: digest(`${preparedId}:${manifestHash}:${shot.id}`) })) };
    // Invalid billing or scope must not consume the one-successor intent.
    plan(parent, identity, filmContext, historicalBoundaries, maximumNewCostCents, billingEvidence, freshProof, now);
    const intentPath = intentPathFor(parentCorrectionId);
    const proposal = { version: 1, parentCorrectionId, correctionId, preparedId, manifestHash, shotId, filmContext, historicalBoundaries,
      failedOperationIdentity, failedRequestId, failedRecordHash, billingEvidenceHash: hash(billingEvidence), maximumNewCostCents,
      reason, approvedBy: actor.email };
    // Freeze the exact approval and proof before creating the target. A lost
    // write or a competing identical approval must adopt the winning intent.
    let intent = await read(intentPath);
    if (!intent) {
      try { await write(intentPath, { ...proposal, providerProof: freshProof, approvedAt: new Date(now()).toISOString() }); } catch { /* Exact durable winner below. */ }
      intent = await read(intentPath);
    }
    check(intent?.etag && hash(Object.fromEntries(Object.keys(proposal).map(key => [key, intent.value[key]]))) === hash(proposal));
    const proof = intent.value.providerProof, at = intent.value.approvedAt;
    check(time(at) && Date.parse(at) <= now());
    const draft = { ...identity, provider: { id: 'fal', model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION }, status: 'prepared',
      createdAt: at, updatedAt: at, preparationConsentAt: at, revision: 1 };
    let grant = (await read(`production/correction-claims/${correctionId}.json`))?.value;
    const partial = grant ? grant.partial : plan(parent, draft, filmContext, historicalBoundaries, maximumNewCostCents, billingEvidence, proof, now);
    if (grant) check(matches(grant) && hash(plan(parent, draft, filmContext, historicalBoundaries, maximumNewCostCents, billingEvidence, partial.providerProof, now)) === hash(partial));
    draft.partialCorrection = { version: 1, correctionId, planHash: hash(partial) };
    draft.contextSuccessor = { version: 1, parentCorrectionId };
    const old = await read(jobPath(actor.email, preparedId));
    if (old) check(hash(old.value) === hash(draft));
    else await immutable(jobPath(actor.email, preparedId), draft);
    const target = await read(jobPath(actor.email, preparedId));
    if (!grant) grant = { version: 1, kind: 'merchant-funded-correction', status: 'authorized', id: correctionId,
      originalOrderId: parent.grant.originalOrderId, originalPreparedId: parent.grant.originalPreparedId,
      originalManifestHash: parent.grant.originalManifestHash, sourceOrderHash: parent.grant.sourceOrderHash,
      customerEmail: actor.email, preparedId, manifestHash, filmId: draft.filmId, screenplayHash: hash(draft.manifest.screenplay),
      sourcesHash: hash(draft.manifest.sources), model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION, environment: 'production',
      maximumCostCents: parent.grant.maximumCostCents, customerChargeCents: 0, partial,
      quote: await price({ email: actor.email, job: target.value, partial, maximumCostCents: parent.grant.maximumCostCents }),
      approvedBy: actor.email, approvedAt: at, reason };
    await authorization.recheck();
    check((await read(jobPath(actor.email, preparedId)))?.etag === target.etag && (await read(userPath(actor.email)))?.etag === owner.etag);
    await immutable(partialBillingEvidencePath(partial.billingEvidenceHash), billingEvidence);
    const claimPath = `production/correction-claims/${correctionId}.json`;
    try { await write(claimPath, grant); } catch { /* Adopt the exact approved winner, including its frozen quote. */ }
    const winner = await read(claimPath);
    check(winner?.etag && matches(winner.value) && hash({ ...winner.value, quote: null }) === hash({ ...grant, quote: null })
      && winner.value.quote?.partialPlanHash === hash(partial) && winner.value.quote.maximumCostCents <= grant.maximumCostCents
      && winner.value.quote.providerCostCents <= maximumNewCostCents);
    grant = winner.value;
    await immutable(contextSuccessorPath(parentCorrectionId), { version: 1, parentCorrectionId, correctionId, preparedId, manifestHash, grantHash: hash(grant) });
    await immutable(`production/correction-targets/${digest(actor.email)}/${preparedId}.json`, { version: 1, correctionId, preparedId, manifestHash, grantHash: hash(grant) });
    await authorization.recheck();
    check((await read(jobPath(actor.email, preparedId)))?.etag === target.etag);
    await immutable(path, grant);
    const { readPaidFilmCorrection } = await import('./paid-film-correction.mjs');
    const context = await readPaidFilmCorrection({ email: actor.email, correctionId, read, now }); await context.recheck();
    return summary(grant);
  } };
}
function summary(grant) {
  return { correctionId: grant.id, parentCorrectionId: grant.partial.parentCorrectionId, originalOrderId: grant.originalOrderId,
    preparedId: grant.preparedId, manifestHash: grant.manifestHash, maximumCostCents: grant.maximumCostCents,
    maximumNewCostCents: grant.partial.maximumNewCostCents, status: 'authorized', customerChargeCents: 0 };
}
