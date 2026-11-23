import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { falPlan, falShotInput, SEEDANCE_RECIPE_VERSION } from './fal-production.mjs';
import { FAL_MODELS, falRequestPath, falRequestUrl } from './fal-client.mjs';
import { partialBillingEvidencePath } from './partial-film-correction.mjs';

export const NARRATION_SUCCESSOR_KIND = 'seedance-single-scene-narration-successor-v1';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => digest(JSON.stringify(value));
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const inactive = (lease, now) => !lease || Number.isFinite(lease.expiresAt) && lease.expiresAt <= now();
const jobPath = (email, id) => `production/jobs/${digest(email)}/${id}.json`;
const queuePath = (email, id) => `production/queue/${digest(email)}/${id}.json`;
const intentPathFor = parentId => `production/correction-successor-intents/${parentId}.json`;
const legacyId = orderId => digest(`merchant-funded-correction-v1:${orderId}`);
export class NarrationSuccessorError extends Error {
  constructor() { super('The approved narration revision needs verification before production can continue.');
    this.name = 'NarrationSuccessorError'; this.code = 'NARRATION_SUCCESSOR_UNVERIFIED'; this.status = 409; }
}
const check = value => { if (!value) throw new NarrationSuccessorError(); };
export const narrationSuccessorPath = parentId => { check(HASH.test(parentId || '')); return `production/correction-successors/${parentId}.json`; };
export const narrationSuccessorId = (parentId, manifestHash) => {
  check(HASH.test(parentId || '') && HASH.test(manifestHash || ''));
  return digest(`seedance-narration-successor-v1:${parentId}:${manifestHash}`);
};
async function readContextLink(grantId, read) {
  const link = await read(narrationSuccessorPath(grantId));
  if (link) {
    const { contextSuccessorId } = await import('./context-successor.mjs');
    check(link.etag && exact(link.value, ['version', 'parentCorrectionId', 'correctionId', 'preparedId', 'manifestHash', 'grantHash'])
      && link.value.version === 1 && link.value.parentCorrectionId === grantId
      && link.value.correctionId === contextSuccessorId(grantId, link.value.manifestHash)
      && UUID.test(link.value.preparedId || '') && HASH.test(link.value.grantHash || ''));
  }
  return link;
}
export function narrationSuccessorPreparedId(email, parentPreparedId, manifestHash) {
  check(typeof email === 'string' && UUID.test(parentPreparedId || '') && HASH.test(manifestHash || ''));
  const id = digest(`seedance-narration-successor-v1:${email}:${parentPreparedId}:${manifestHash}`).slice(0, 32);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
export function buildNarrationSuccessorManifest(parent, { shotId, narration } = {}) {
  check(typeof narration === 'string' && narration.trim() && narration.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(narration));
  const plan = falPlan(parent, 'seedance'), index = parent.shots.findIndex(row => row.id === shotId), shot = parent.shots[index];
  check(plan.shots.length === 4 && parent.screenplay.scenes.length === 4 && plan.shots.every(row => row.endpoint === FAL_MODELS.seedanceText)
    && shot && parent.shots.filter(row => row.sceneIndex === shot.sceneIndex).length === 1
    && parent.screenplay.scenes[shot.sceneIndex].narration === shot.narration && narration !== shot.narration);
  const manifest = structuredClone(parent);
  // Preserve the approved edit windows; replanning by word weight would alter
  // the other scenes and invalidate footage already paid for and retained.
  manifest.shots[index].narration = narration;
  manifest.screenplay.scenes[shot.sceneIndex].narration = narration;
  falPlan(manifest, 'seedance');
  return { manifest, manifestHash: hash(manifest) };
}

async function bounded(response, maximum) {
  check(response.body); const reader = response.body.getReader(), chunks = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; check(length <= maximum); chunks.push(next.value); }
    const bytes = Buffer.concat(chunks); let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new NarrationSuccessorError(); }
    return { value, sha256: digest(bytes) };
  } finally { await reader.cancel().catch(() => {}); }
}
// Confirm the prior result, not a claim about which words caused moderation.
export async function verifyNarrationPredecessorFailure(receipt, { key = () => process.env.FAL_KEY, fetchImpl = fetch, now = Date.now } = {}) {
  const secret = typeof key === 'function' ? key() : key; check(typeof secret === 'string' && secret);
  const options = { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Key ${secret}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) };
  const statusResponse = await fetchImpl(falRequestUrl(receipt.statusUrl, receipt.endpoint, receipt.requestId, 'status'), options);
  if (statusResponse.status !== 200) { await statusResponse.body?.cancel(); throw new NarrationSuccessorError(); }
  const status = await bounded(statusResponse, 64 * 1024);
  check(status.value.status === 'COMPLETED' && status.value.request_id === receipt.requestId && !status.value.error && !status.value.error_type);
  const response = await fetchImpl(falRequestUrl(receipt.responseUrl, receipt.endpoint, receipt.requestId, 'result'), options);
  if (response.status !== 422) { await response.body?.cancel(); throw new NarrationSuccessorError(); }
  const result = await bounded(response, 2_000_000), detail = result.value.detail;
  check(Array.isArray(detail) && detail.length === 1 && detail[0]?.type === 'content_policy_violation'
    && Array.isArray(detail[0].loc) && detail[0].loc.length === 1 && detail[0].loc[0] === 'body'
    && !result.value.video && !result.value.images);
  return { version: 1, requestId: receipt.requestId, status: 'COMPLETED', resultHttpStatus: 422, failureType: 'content_policy_violation',
    statusBodySha256: status.sha256, resultBodySha256: result.sha256, verifiedAt: new Date(now()).toISOString() };
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
  check(saved?.partial?.version === 1 && saved.partial.kind === 'seedance-single-scene-correction-v1'
    && parentId === legacyId(saved.originalOrderId));
  const context = await readPaidFilmCorrection({ email, correctionId: parentId, read, now });
  check(context?.retry && !context.retry.pending && context.job.status === 'failed' && inactive(context.job.lease, now));
  const queue = await read(queuePath(email, context.job.id)), retry = context.retry.grant;
  const failed = await read(falRequestPath(retry.operationIdentity)), receipt = failed?.value;
  check(queue?.etag && queue.value.state === 'attention' && inactive(queue.value.lease, now)
    && queue.value.email === email && queue.value.id === context.job.id && queue.value.orderId === parentId
    && queue.value.manifestHash === context.job.manifestHash && failed?.etag && receipt.identity === retry.operationIdentity
    && receipt.endpoint === FAL_MODELS.seedanceText && receipt.inputHash === context.grant.partial.newInputHash
    && receipt.state === 'failed' && receipt.failureCode === 'FAL_RENDER_FAILED' && !receipt.result && time(receipt.checkedAt)
    && context.job.shots.find(row => row.id === context.grant.partial.shotId)?.status === 'failed');
  falRequestUrl(receipt.statusUrl, receipt.endpoint, receipt.requestId, 'status');
  falRequestUrl(receipt.responseUrl, receipt.endpoint, receipt.requestId, 'result');
  return { ...context, queue, failed, recheck: async () => {
    const [, currentQueue, currentFailed] = await Promise.all([context.recheck(), read(queuePath(email, context.job.id)),
      read(falRequestPath(retry.operationIdentity))]);
    check(currentQueue?.etag === queue.etag && currentFailed?.etag === failed.etag);
  } };
}
function plan(parent, target, narration, maximumNewCostCents, evidence, proof, now) {
  const original = parent.grant.partial, changed = buildNarrationSuccessorManifest(parent.job.manifest, { shotId: original.shotId, narration });
  check(target.manifestHash === changed.manifestHash && hash(target.manifest) === changed.manifestHash
    && target.id === narrationSuccessorPreparedId(parent.grant.customerEmail, parent.job.id, changed.manifestHash)
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
  return { version: 2, kind: NARRATION_SUCCESSOR_KIND, fundingKind: 'original-reservation',
    billingAccount: original.billingAccount, shotId: original.shotId, narration, visual: original.visual,
    sourcePreparedId: original.sourcePreparedId, sourceManifestHash: original.sourceManifestHash,
    manifestHash: target.manifestHash, newInputHash: hash(falShotInput(target.manifest, shot, 'seedance', {})),
    generatedSeconds: shot.seconds, maximumNewCostCents, reused: structuredClone(original.reused),
    priorCostNanoUsd: original.priorCostNanoUsd, originalReservation: structuredClone(original.originalReservation),
    parentCorrectionId: parent.grant.id, parentPreparedId: parent.job.id, parentManifestHash: parent.job.manifestHash,
    parentGrantHash: hash(parent.grant), parentJobHash: hash(parent.job), parentQueueHash: hash(parent.queue.value),
    parentRetryHash: hash(parent.retry.grant), failedOperationIdentity: parent.failed.value.identity,
    failedRequestId: parent.failed.value.requestId, failedRecordHash: hash(parent.failed.value),
    billingEvidenceHash: hash(evidence), providerProof: proof };
}

export async function validateNarrationSuccessor({ grant, target, order, read = readRecord, now = Date.now }) {
  const p = grant.partial;
  check(p?.version === 2 && p.kind === NARRATION_SUCCESSOR_KIND && p.parentCorrectionId === legacyId(order.id)
    && grant.id === narrationSuccessorId(p.parentCorrectionId, grant.manifestHash));
  const parent = await parentContext(grant.customerEmail, p.parentCorrectionId, read, now);
  const [evidence, link, intent] = await Promise.all([read(partialBillingEvidencePath(p.billingEvidenceHash)),
    read(narrationSuccessorPath(p.parentCorrectionId)), read(intentPathFor(p.parentCorrectionId))]);
  // Only the separately reviewed context revision may follow this narration
  // version. Its complete chain is validated by the child and funding reader;
  // the parent must also remain readable during child publication.
  const childLink = await readContextLink(grant.id, read);
  check(intent?.etag && hash(intent.value) === hash({ version: 1, parentCorrectionId: p.parentCorrectionId,
    correctionId: grant.id, preparedId: target.id, manifestHash: target.manifestHash, shotId: p.shotId, narration: p.narration,
    failedOperationIdentity: p.failedOperationIdentity, failedRequestId: p.failedRequestId, failedRecordHash: p.failedRecordHash,
    billingEvidenceHash: p.billingEvidenceHash, maximumNewCostCents: p.maximumNewCostCents, reason: grant.reason,
    approvedBy: grant.approvedBy, providerProof: p.providerProof, approvedAt: grant.approvedAt }));
  check(evidence?.etag && link?.etag && hash(link.value) === hash({ version: 1, parentCorrectionId: p.parentCorrectionId,
    correctionId: grant.id, preparedId: target.id, manifestHash: target.manifestHash, grantHash: hash(grant) })
    && target.partialCorrection?.version === 1
    && target.partialCorrection.correctionId === grant.id && target.partialCorrection.planHash === hash(p)
    && target.narrationSuccessor?.version === 1 && target.narrationSuccessor.parentCorrectionId === p.parentCorrectionId
    && !target.partialCorrectionRetry && grant.originalOrderId === parent.grant.originalOrderId
    && grant.originalPreparedId === parent.grant.originalPreparedId && grant.originalManifestHash === parent.grant.originalManifestHash
    && grant.sourceOrderHash === parent.grant.sourceOrderHash && grant.maximumCostCents === parent.grant.maximumCostCents);
  check(hash(plan(parent, target, p.narration, p.maximumNewCostCents, evidence.value, p.providerProof, now)) === hash(p)
    && grant.quote.partialPlanHash === hash(p) && grant.quote.maximumCostCents <= grant.maximumCostCents
    && grant.quote.providerCostCents <= p.maximumNewCostCents && Date.parse(p.providerProof.verifiedAt) <= Date.parse(grant.approvedAt));
  return { recheck: async () => {
    const [, currentChild, currentLink, currentIntent, currentEvidence] = await Promise.all([parent.recheck(), readContextLink(grant.id, read),
      read(narrationSuccessorPath(p.parentCorrectionId)), read(intentPathFor(p.parentCorrectionId)), read(partialBillingEvidencePath(p.billingEvidenceHash))]);
    check(currentLink?.etag === link.etag && currentIntent?.etag === intent.etag && currentEvidence?.etag === evidence.etag
      && (!childLink || currentChild?.etag === childLink.etag));
  } };
}

// The original funding entry resolves at most one reviewed successor. An
// incomplete or inconsistent link keeps that original commitment held.
export async function readCorrectionFulfillment({ email, orderId, read = readRecord, now = Date.now }) {
  const { readPaidFilmCorrection } = await import('./paid-film-correction.mjs');
  const parentId = legacyId(orderId), link = await read(narrationSuccessorPath(parentId));
  if (!link) {
    const parent = await readPaidFilmCorrection({ email, correctionId: parentId, read, now });
    if (!parent) return null;
    return { ...parent, recheck: async () => { await parent.recheck(); check(!(await read(narrationSuccessorPath(parentId)))); } };
  }
  check(link.etag && link.value?.version === 1 && link.value.parentCorrectionId === parentId
    && HASH.test(link.value.correctionId || '') && link.value.correctionId === narrationSuccessorId(parentId, link.value.manifestHash));
  const child = await readPaidFilmCorrection({ email, correctionId: link.value.correctionId, read, now });
  check(child?.grant.partial?.kind === NARRATION_SUCCESSOR_KIND && child.grant.originalOrderId === orderId
    && child.grant.preparedId === link.value.preparedId && hash(child.grant) === link.value.grantHash);
  const nextPath = narrationSuccessorPath(child.grant.id), next = await read(nextPath);
  if (!next) return { ...child, recheck: async () => {
    await child.recheck(); check((await read(narrationSuccessorPath(parentId)))?.etag === link.etag && !(await read(nextPath)));
  } };
  const { contextSuccessorId, CONTEXT_SUCCESSOR_KIND } = await import('./context-successor.mjs');
  check(next.etag && next.value?.version === 1 && next.value.parentCorrectionId === child.grant.id
    && next.value.correctionId === contextSuccessorId(child.grant.id, next.value.manifestHash));
  const terminal = await readPaidFilmCorrection({ email, correctionId: next.value.correctionId, read, now });
  check(terminal?.grant.partial?.version === 3 && terminal.grant.partial.kind === CONTEXT_SUCCESSOR_KIND
    && terminal.grant.originalOrderId === orderId && terminal.grant.preparedId === next.value.preparedId
    && hash(terminal.grant) === next.value.grantHash && !(await read(narrationSuccessorPath(terminal.grant.id))));
  return { ...terminal, recheck: async () => {
    await terminal.recheck(); await child.recheck();
    check((await read(narrationSuccessorPath(parentId)))?.etag === link.etag && (await read(nextPath))?.etag === next.etag
      && !(await read(narrationSuccessorPath(terminal.grant.id))));
  } };
}

export function createNarrationSuccessor({ read = readRecord, write = writeRecord, now = Date.now, env = process.env,
  price, authorizeParent, verifyFailure = receipt => verifyNarrationPredecessorFailure(receipt, { now }) } = {}) {
  async function immutable(path, value) {
    try { await write(path, value); } catch { /* Exact readback only; never overwrite another approved version. */ }
    const saved = await read(path); check(saved?.etag && hash(saved.value) === hash(value)); return saved;
  }
  return { approve: async ({ actor, parentCorrectionId, preparedId, manifestHash, shotId, narration, failedOperationIdentity,
    failedRequestId, failedRecordHash, billingEvidence, maximumNewCostCents, reason, confirmed } = {}) => {
    const owner = actor?.email && await read(userPath(actor.email));
    check(isOwner(actor) && !actor.mustChangePassword && owner?.etag && isOwner(owner.value) && !owner.value.mustChangePassword
      && owner.value.email === actor.email && confirmed === true && typeof reason === 'string' && reason.trim().length >= 10
      && reason.length <= 500 && !/[<>\x00-\x1f\x7f]/.test(reason));
    const parent = await parentContext(actor.email, parentCorrectionId, read, now), p = parent.grant.partial;
    check(p.billingAccount === env.FAL_BILLING_ACCOUNT && p.shotId === shotId && parent.failed.value.identity === failedOperationIdentity
      && parent.failed.value.requestId === failedRequestId && hash(parent.failed.value) === failedRecordHash);
    const built = buildNarrationSuccessorManifest(parent.job.manifest, { shotId, narration });
    check(built.manifestHash === manifestHash && preparedId === narrationSuccessorPreparedId(actor.email, parent.job.id, manifestHash));
    const correctionId = narrationSuccessorId(parentCorrectionId, manifestHash), path = `production/corrections/${correctionId}.json`;
    const matches = grant => grant?.partial?.parentCorrectionId === parentCorrectionId && grant.preparedId === preparedId
      && grant.manifestHash === manifestHash && grant.partial.narration === narration && grant.reason === reason
      && grant.partial.maximumNewCostCents === maximumNewCostCents && grant.partial.billingEvidenceHash === hash(billingEvidence);
    const saved = await read(path);
    if (saved) {
      const { readPaidFilmCorrection } = await import('./paid-film-correction.mjs');
      const context = await readPaidFilmCorrection({ email: actor.email, correctionId, read, now }); check(matches(context.grant));
      const authorization = await authorizeParent(parent, maximumNewCostCents); await authorization.recheck(); await context.recheck();
      return summary(context.grant);
    }
    const link = await read(narrationSuccessorPath(parentCorrectionId));
    if (link) check(link.value.correctionId === correctionId && link.value.preparedId === preparedId && link.value.manifestHash === manifestHash);
    const health = (await read('production/worker-health.json'))?.value;
    check(health?.ready === true && health.narrationSuccessorVersion === 1 && health.model === 'seedance'
      && health.recipe === SEEDANCE_RECIPE_VERSION && time(health.checkedAt) && Date.parse(health.checkedAt) <= now()
      && now() - Date.parse(health.checkedAt) <= 180_000);
    const freshProof = await verifyFailure(parent.failed.value);
    const authorization = await authorizeParent(parent, maximumNewCostCents); await authorization.recheck();
    const identity = { id: preparedId, ownerHash: digest(actor.email), filmId: parent.job.filmId, manifestHash, manifest: built.manifest,
      mode: 'customer', shots: built.manifest.shots.map(shot => ({ id: shot.id, status: 'prepared', requestKey: digest(`${preparedId}:${manifestHash}:${shot.id}`) })) };
    // Invalid billing or scope must not consume the one-successor intent.
    plan(parent, identity, narration, maximumNewCostCents, billingEvidence, freshProof, now);
    const intentPath = intentPathFor(parentCorrectionId);
    const proposal = { version: 1, parentCorrectionId, correctionId, preparedId, manifestHash, shotId, narration,
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
    const partial = grant ? grant.partial : plan(parent, draft, narration, maximumNewCostCents, billingEvidence, proof, now);
    if (grant) check(matches(grant) && hash(plan(parent, draft, narration, maximumNewCostCents, billingEvidence, partial.providerProof, now)) === hash(partial));
    draft.partialCorrection = { version: 1, correctionId, planHash: hash(partial) };
    draft.narrationSuccessor = { version: 1, parentCorrectionId };
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
    await immutable(narrationSuccessorPath(parentCorrectionId), { version: 1, parentCorrectionId, correctionId, preparedId, manifestHash, grantHash: hash(grant) });
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
