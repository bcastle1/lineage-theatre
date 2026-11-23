import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { FAL_MODELS, falRequestPath, falRequestUrl, falDownstreamFailure } from './fal-client.mjs';
import { falShotInput, SEEDANCE_RECIPE_VERSION } from './fal-production.mjs';

export const PARTIAL_RETRY_KIND = 'seedance-partial-terminal500-retry-v1';
const HASH = /^[a-f0-9]{64}$/, REQUEST = /^[A-Za-z0-9_-]{8,100}$/;
const hash = value => digest(JSON.stringify(value));
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export class PartialCorrectionRetryError extends Error {
  constructor() { super('This single scene retry needs verification before production can continue.');
    this.name = 'PartialCorrectionRetryError'; this.code = 'PARTIAL_RETRY_UNVERIFIED'; this.status = 409; }
}
const fail = () => new PartialCorrectionRetryError();
const check = value => { if (!value) throw fail(); };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const inactive = (lease, now) => !lease || Number.isFinite(lease.expiresAt) && lease.expiresAt <= now();
export const partialRetryId = (correctionId, identity, requestId) => {
  check(HASH.test(correctionId || '') && HASH.test(identity || '') && REQUEST.test(requestId || ''));
  return digest(`${PARTIAL_RETRY_KIND}:${correctionId}:${identity}:${requestId}`);
};
export const partialRetryPath = correctionId => { check(HASH.test(correctionId || '')); return `production/correction-retries/${correctionId}.json`; };
const claimPath = correctionId => `production/correction-retry-claims/${correctionId}.json`;
const jobPath = (email, id) => `production/jobs/${digest(email)}/${id}.json`;
const queuePath = (email, id) => `production/queue/${digest(email)}/${id}.json`;
const operationFor = shot => digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${shot.requestKey}`);

function failedReceipt(receipt, identity, inputHash) {
  check(receipt?.identity === identity && receipt.endpoint === FAL_MODELS.seedanceText && receipt.inputHash === inputHash
    && receipt.state === 'failed' && receipt.failureCode === 'FAL_DOWNSTREAM_SERVICE_FAILED'
    && REQUEST.test(receipt.requestId || '') && !receipt.result && time(receipt.checkedAt));
  falRequestUrl(receipt.statusUrl, receipt.endpoint, receipt.requestId, 'status');
  falRequestUrl(receipt.responseUrl, receipt.endpoint, receipt.requestId, 'result');
}
function billingEvidence(value, { email, account, receipt, now }) {
  check(exact(value, ['version', 'kind', 'basis', 'policyUrl', 'account', 'operationIdentity', 'requestId', 'recordHash',
    'costNanoUsd', 'evidenceSha256', 'observedAt', 'approvedBy']) && value.version === 1
    && value.kind === 'owner-reviewed-zero-charge-v1' && value.basis === 'provider-terminal500-nonbilling-policy'
    && value.policyUrl === 'https://fal.ai/docs/documentation/model-apis/pricing'
    && typeof account === 'string' && /^[\w.-]{1,100}$/.test(account) && value.account === account
    && value.operationIdentity === receipt.identity && value.requestId === receipt.requestId && value.recordHash === hash(receipt)
    && value.costNanoUsd === 0 && HASH.test(value.evidenceSha256 || '') && value.approvedBy === email
    && time(value.observedAt) && Date.parse(value.observedAt) >= Date.parse(receipt.checkedAt) && Date.parse(value.observedAt) <= now());
}

async function bounded(response, maximum) {
  check(response.body); const reader = response.body.getReader(), chunks = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength; check(length <= maximum); chunks.push(next.value); }
    const bytes = Buffer.concat(chunks);
    try { return { value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes) }; } catch { throw fail(); }
  } finally { await reader.cancel().catch(() => {}); }
}
// GET-only confirmation. Persist only fixed evidence and raw-response hashes;
// provider errors can echo the private screenplay and must never be logged.
export async function verifyPartialRetryFailure(receipt, { key = () => process.env.FAL_KEY, fetchImpl = fetch, now = Date.now } = {}) {
  const secret = typeof key === 'function' ? key() : key; check(typeof secret === 'string' && secret);
  const options = { method: 'GET', headers: { Authorization: `Key ${secret}`, Accept: 'application/json' },
    redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000) };
  const statusResponse = await fetchImpl(falRequestUrl(receipt.statusUrl, receipt.endpoint, receipt.requestId, 'status'), options);
  if (statusResponse.status !== 200) { await statusResponse.body?.cancel(); throw fail(); }
  const status = await bounded(statusResponse, 64 * 1024);
  check(status.value.status === 'COMPLETED' && status.value.request_id === receipt.requestId && !status.value.error && !status.value.error_type);
  const response = await fetchImpl(falRequestUrl(receipt.responseUrl, receipt.endpoint, receipt.requestId, 'result'), options);
  if (response.status !== 500) { await response.body?.cancel(); throw fail(); }
  const result = await bounded(response, 2_000_000); check(falDownstreamFailure(result.value));
  return { version: 1, requestId: receipt.requestId, status: 'COMPLETED', resultHttpStatus: 500,
    statusBodySha256: status.sha256, resultBodySha256: result.sha256, verifiedAt: new Date(now()).toISOString() };
}

function retained(job, grant) {
  check(job.authorization?.correctionId === grant.id && job.authorization.originalOrderId === grant.originalOrderId
    && job.authorization.manifestHash === grant.manifestHash && job.authorization.environment === 'production'
    && job.authorization.quoteReference === grant.quote.quoteReference && job.authorization.budgetCents === grant.quote.maximumCostCents);
  const p = grant.partial, rows = job.shots.filter(shot => shot.id !== p.shotId);
  check(rows.length === 3 && job.shots.length === 4);
  for (const shot of rows) {
    const proof = p.reused.find(row => row.shotId === shot.id);
    check(proof && shot.status === 'completed' && shot.providerJobId === `fal-${operationFor(shot)}`
      && shot.output?.sha256 === proof.mediaSha256 && shot.output.sizeBytes === proof.sizeBytes
      && shot.output.contentType === 'video/mp4' && shot.output.durationSeconds === proof.generatedSeconds
      && digest(shot.output.url) === proof.sourceUrlHash);
  }
  return rows;
}

// Payment/funding validators and the renderer share this read-only binding.
// A published journal without its job transition is resumable but cannot spend.
export async function readPartialCorrectionRetry({ grant, job, order }, { read = readRecord, now = Date.now } = {}) {
  const record = await read(partialRetryPath(grant.id)), retry = record?.value;
  if (!record) { check(!job.partialCorrectionRetry); return null; }
  const claim = await read(claimPath(grant.id)), p = grant.partial;
  check(record.etag && claim?.etag && hash(claim.value) === hash(retry) && p
    && retry?.version === 1 && retry.kind === PARTIAL_RETRY_KIND && retry.status === 'authorized'
    && retry.correctionId === grant.id && retry.sourceGrantHash === hash(grant) && retry.customerEmail === grant.customerEmail
    && retry.preparedId === job.id && retry.manifestHash === job.manifestHash && retry.shotId === p.shotId
    && retry.model === 'seedance' && retry.recipe === SEEDANCE_RECIPE_VERSION && retry.approvedBy === grant.customerEmail
    && retry.originalOrderId === order.id && retry.customerChargeCents === 0 && retry.maximumRequests === 1
    && retry.id === partialRetryId(grant.id, retry.failedOperationIdentity, retry.failedRequestId)
    && retry.operationIdentity === digest(`${retry.id}:replacement-v1`) && retry.inputHash === p.newInputHash
    && hash(retry.originalReservation) === hash(p.originalReservation) && retry.billingAccount === p.billingAccount
    && Number.isSafeInteger(retry.maximumNewCostCents) && retry.maximumNewCostCents > 0 && retry.maximumNewCostCents <= p.maximumNewCostCents
    && time(retry.approvedAt) && Date.parse(retry.approvedAt) <= now() && typeof retry.reason === 'string'
    && retry.reason.trim().length >= 10 && retry.reason.length <= 500 && !/[<>\x00-\x1f\x7f]/.test(retry.reason));
  const shot = job.shots.find(row => row.id === p.shotId), failed = await read(falRequestPath(retry.failedOperationIdentity));
  check(shot && retry.failedOperationIdentity === operationFor(shot) && retry.failedShot?.id === shot.id
    && retry.failedShot.requestKey === shot.requestKey && retry.failedShot.status === 'failed'
    && retry.failedShot.providerJobId === `fal-${retry.failedOperationIdentity}`
    && failed?.etag && hash(failed.value) === retry.failedRecordHash && retry.failedRequestId === failed.value.requestId);
  failedReceipt(failed.value, retry.failedOperationIdentity, p.newInputHash);
  billingEvidence(retry.billingEvidence, { email: grant.customerEmail, account: p.billingAccount, receipt: failed.value, now });
  const proof = retry.providerProof;
  check(proof?.version === 1 && proof.requestId === failed.value.requestId && proof.status === 'COMPLETED' && proof.resultHttpStatus === 500
    && HASH.test(proof.statusBodySha256 || '') && HASH.test(proof.resultBodySha256 || '') && time(proof.verifiedAt)
    && Date.parse(proof.verifiedAt) >= Date.parse(failed.value.checkedAt) && Date.parse(proof.verifiedAt) <= Date.parse(retry.approvedAt)
    && hash(retained(job, grant)) === retry.retainedShotsHash && HASH.test(retry.failedJobHash || '') && HASH.test(retry.failedQueueHash || ''));
  const pending = !job.partialCorrectionRetry;
  if (pending) check(job.status === 'failed' && hash(job) === retry.failedJobHash);
  else check(job.partialCorrectionRetry.version === 1 && job.partialCorrectionRetry.id === retry.id
    && job.partialCorrectionRetry.grantHash === hash(retry) && ['processing', 'uncertain', 'failed', 'awaiting-assembly', 'completed'].includes(job.status)
    && (!shot.providerJobId || shot.providerJobId === `fal-${retry.operationIdentity}`));
  check(!(await read(`production/fal/choices/${retry.failedOperationIdentity}.json`))
    && !(await read(`production/fal/choices/${retry.operationIdentity}.json`)));
  const replacement = (await read(falRequestPath(retry.operationIdentity)))?.value;
  if (replacement) check(!pending && replacement.identity === retry.operationIdentity
    && replacement.endpoint === FAL_MODELS.seedanceText && replacement.inputHash === retry.inputHash);
  return { grant: retry, pending, recheck: async () => {
    const current = await Promise.all([read(partialRetryPath(grant.id)), read(claimPath(grant.id)), read(falRequestPath(retry.failedOperationIdentity))]);
    check(current.every((value, i) => value?.etag === [record, claim, failed][i].etag));
    check(!(await read(`production/fal/choices/${retry.failedOperationIdentity}.json`))
      && !(await read(`production/fal/choices/${retry.operationIdentity}.json`)));
  } };
}

export function createPartialCorrectionRetry({ read = readRecord, write = writeRecord, now = Date.now, env = process.env,
  correctionContext, verifyAuthorization, verifyFailure = receipt => verifyPartialRetryFailure(receipt, { now }) } = {}) {
  async function immutable(path, value) {
    try { await write(path, value); } catch { /* Reconcile only the exact durable value after a lost response. */ }
    const saved = await read(path); check(saved?.etag && hash(saved.value) === hash(value)); return saved;
  }
  return { approve: async ({ actor, correctionId, preparedId, manifestHash, shotId, failedOperationIdentity,
    failedRequestId, failedRecordHash, billingEvidence: evidence, maximumNewCostCents, reason, confirmed } = {}) => {
    const owner = actor?.email && await read(userPath(actor.email));
    check(isOwner(actor) && !actor.mustChangePassword && owner?.etag && isOwner(owner.value) && !owner.value.mustChangePassword
      && owner.value.email === actor.email && confirmed === true && typeof reason === 'string' && reason.trim().length >= 10
      && reason.length <= 500 && !/[<>\x00-\x1f\x7f]/.test(reason));
    let context = await correctionContext({ email: actor.email, correctionId });
    const { grant, job } = context, p = grant.partial;
    check(p?.version === 1 && !job.narrationSuccessor && job.id === preparedId && job.manifestHash === manifestHash && p.shotId === shotId
      && p.billingAccount === env.FAL_BILLING_ACCOUNT && Number.isSafeInteger(maximumNewCostCents)
      && maximumNewCostCents > 0 && maximumNewCostCents <= p.maximumNewCostCents);
    retained(job, grant);
    const shot = job.shots.find(row => row.id === shotId), inputHash = hash(falShotInput(job.manifest,
      job.manifest.shots.find(row => row.id === shotId), 'seedance', {}));
    check(shot && failedOperationIdentity === operationFor(shot) && inputHash === p.newInputHash && HASH.test(failedRecordHash || ''));
    const failed = await read(falRequestPath(failedOperationIdentity));
    check(failed?.etag && hash(failed.value) === failedRecordHash && failed.value.requestId === failedRequestId);
    failedReceipt(failed.value, failedOperationIdentity, inputHash);
    billingEvidence(evidence, { email: actor.email, account: p.billingAccount, receipt: failed.value, now });
    const id = partialRetryId(correctionId, failedOperationIdentity, failedRequestId), path = partialRetryPath(correctionId);
    let retry = (await read(path))?.value || (await read(claimPath(correctionId)))?.value;
    const matches = value => value.id === id && value.correctionId === correctionId && value.preparedId === preparedId
      && value.manifestHash === manifestHash && value.shotId === shotId && value.failedOperationIdentity === failedOperationIdentity
      && value.failedRequestId === failedRequestId && value.failedRecordHash === failedRecordHash
      && hash(value.billingEvidence) === hash(evidence) && value.maximumNewCostCents === maximumNewCostCents && value.reason === reason;
    if (retry) check(matches(retry));
    if (job.partialCorrectionRetry) {
      check(context.retry && !context.retry.pending && context.retry.grant.id === id);
      await verifyAuthorization(context, maximumNewCostCents);
      return summary(context.retry.grant);
    }
    const queue = await read(queuePath(actor.email, preparedId)), health = (await read('production/worker-health.json'))?.value;
    check(job.status === 'failed' && shot.status === 'failed' && shot.providerJobId === `fal-${failedOperationIdentity}` && !job.media
      && inactive(job.lease, now) && queue?.etag && queue.value.state === 'attention' && inactive(queue.value.lease, now)
      && queue.value.email === actor.email && queue.value.id === preparedId && queue.value.manifestHash === manifestHash && queue.value.orderId === correctionId
      && health?.ready === true && health.partialCorrectionRetryVersion === 1 && health.partialCorrectionVersion === 1
      && health.model === 'seedance' && health.recipe === SEEDANCE_RECIPE_VERSION && time(health.checkedAt)
      && Date.parse(health.checkedAt) <= now() && now() - Date.parse(health.checkedAt) <= 180_000);
    const retainedShotsHash = hash(retained(job, grant));
    check(!(await read(falRequestPath(digest(`${id}:replacement-v1`)))));
    const providerProof = await verifyFailure(failed.value);
    if (!retry) retry = { version: 1, kind: PARTIAL_RETRY_KIND, status: 'authorized', id, correctionId,
      customerEmail: actor.email, originalOrderId: grant.originalOrderId, preparedId, manifestHash, shotId, inputHash,
      model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION, sourceGrantHash: hash(grant), billingAccount: p.billingAccount,
      originalReservation: structuredClone(p.originalReservation), failedOperationIdentity, failedRequestId, failedRecordHash,
      failedShot: structuredClone(shot), failedJobHash: hash(job), failedQueueHash: hash(queue.value), retainedShotsHash,
      operationIdentity: digest(`${id}:replacement-v1`), maximumRequests: 1, maximumNewCostCents, customerChargeCents: 0,
      billingEvidence: structuredClone(evidence), providerProof, approvedBy: actor.email, approvedAt: new Date(now()).toISOString(), reason };
    check(retry.failedJobHash === hash(job) && retry.failedQueueHash === hash(queue.value) && retry.retainedShotsHash === retainedShotsHash);
    try {
    const authorization = await verifyAuthorization(context, maximumNewCostCents);
    try { await immutable(claimPath(correctionId), retry); }
    catch {
      // Concurrent approvals can have different proof timestamps. Adopt only
      // the exact-input winner; its frozen evidence and identity remain fixed.
      const winner = (await read(claimPath(correctionId)))?.value;
      check(winner && matches(winner) && winner.failedJobHash === retry.failedJobHash
        && winner.failedQueueHash === retry.failedQueueHash && winner.retainedShotsHash === retainedShotsHash);
      retry = winner;
    }
    await authorization.recheck();
    check((await read(queuePath(actor.email, preparedId)))?.etag === queue.etag && (await read(userPath(actor.email)))?.etag === owner.etag
      && (await read(falRequestPath(failedOperationIdentity)))?.etag === failed.etag);
    await immutable(path, retry);
    context = await correctionContext({ email: actor.email, correctionId });
    check(context.retry?.grant.id === retry.id);
    if (!context.retry.pending) { await verifyAuthorization(context, maximumNewCostCents); return summary(context.retry.grant); }
    check(hash(context.job) === retry.failedJobHash);
    const ready = await verifyAuthorization(context, maximumNewCostCents); await ready.recheck();
    const current = await read(jobPath(actor.email, preparedId)), currentQueue = await read(queuePath(actor.email, preparedId));
    check(current?.etag && hash(current.value) === retry.failedJobHash && currentQueue?.etag === queue.etag);
    const next = structuredClone(current.value);
    next.shots = next.shots.map(value => value.id === shotId ? { id: value.id, requestKey: value.requestKey, status: 'prepared' } : value);
    delete next.lease; next.status = 'processing'; next.timingDisrupted = true; next.updatedAt = retry.approvedAt; next.revision++;
    next.partialCorrectionRetry = { version: 1, id: retry.id, grantHash: hash(retry) };
    try { await write(jobPath(actor.email, preparedId), next, current.etag); } catch { /* Never reset a competing worker's progress. */ }
    const saved = (await read(jobPath(actor.email, preparedId)))?.value;
    check(saved?.partialCorrectionRetry?.id === id && saved.partialCorrectionRetry.grantHash === hash(retry)
      && hash(retained(saved, grant)) === retainedShotsHash);
    return summary(retry);
    } catch (error) {
      // Another exact approval may have completed the CAS transition while
      // this request was rechecking its older snapshot. Reconcile only a
      // fully validated, already-resumed winner; never reset it a second time.
      const resumed = await correctionContext({ email: actor.email, correctionId });
      if (!resumed.retry || resumed.retry.pending || !matches(resumed.retry.grant)
        || resumed.job.partialCorrectionRetry?.id !== id) throw error;
      await verifyAuthorization(resumed, maximumNewCostCents);
      return summary(resumed.retry.grant);
    }
  } };
}
function summary(retry) {
  return { id: retry.id, status: 'authorized', correctionId: retry.correctionId, preparedId: retry.preparedId,
    manifestHash: retry.manifestHash, shotId: retry.shotId, failedRequestId: retry.failedRequestId,
    maximumNewCostCents: retry.maximumNewCostCents, customerChargeCents: 0 };
}
