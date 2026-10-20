import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { OWNER_EMAIL, isOwner } from './access.mjs';
import { readPaidFilmCorrection } from './paid-film-correction.mjs';
import { createFalClient, falRequestPath, falRequestUrl, falMediaUrl, FAL_MODELS } from './fal-client.mjs';
import { falPlan, FAL_RECIPE_VERSION } from './fal-production.mjs';
import { productionPhotoData } from './production-photo-reference.mjs';
import { klingReferenceData } from './fal-reference.mjs';

const HASH = /^[a-f0-9]{64}$/, REQUEST = /^[A-Za-z0-9_-]{8,100}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => digest(JSON.stringify(value));
const fail = () => Object.assign(new Error('The exact failed-shot recovery needs verification.'), { code: 'KLING_RECOVERY_UNVERIFIED' });
const requireValue = value => { if (!value) throw fail(); };
const freshTime = (value, now) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now();
export const failedShotRecoveryId = (identity, requestId) => digest(`kling-prompt-recovery-v1:${identity}:${requestId}`);
export function failedShotRecoveryPath(id) { requireValue(HASH.test(id || '')); return `production/fal/failed-shot-recoveries/${id}.json`; }
export function parseRecoveryBilling(bytes, expectedHash, expectedAccount) {
  requireValue(bytes.length <= 64 * 1024 && HASH.test(expectedHash || '') && digest(bytes) === expectedHash);
  const source = JSON.parse(bytes.toString('utf8'));
  requireValue(typeof expectedAccount === 'string' && /^[\w.-]{1,100}$/.test(expectedAccount) && source.account === expectedAccount
    && source.endpoint === FAL_MODELS.kling && Array.isArray(source.rows) && source.rows.length === 12);
  const rows = source.rows.map(row => {
    requireValue(typeof row === 'string' && row.length <= 500);
    const id = row.match(/^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/), amounts = row.match(/(\d+\.\d{2})\$(\d+\.\d{2})\$(\d+\.\d{2})$/);
    requireValue(id && amounts && amounts[2] === '0.14');
    return { requestId: id[1], quantity: Number(amounts[1]), amountCents: Math.round(Number(amounts[3]) * 100) };
  });
  requireValue(new Set(rows.map(row => row.requestId)).size === 12 && rows.every(row => Number.isSafeInteger(row.amountCents) && row.amountCents >= 0
    && Number.isFinite(row.quantity) && row.quantity >= 0 && row.quantity <= 15 && Math.round(row.quantity * 14) === row.amountCents));
  return { sha256: expectedHash, observedAt: source.observedAt, rows };
}
async function boundedResponse(response) {
  requireValue(response.body); const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; requireValue(size <= 64 * 1024); chunks.push(next.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
export function promptLengthRejection(body) {
  const message = value => typeof value === 'string' && value.length <= 2000 && /size must be between\s*0\s*and\s*2500/i.test(value);
  if (Array.isArray(body?.detail)) return body.detail.length > 0 && body.detail.every(item =>
    Array.isArray(item?.loc) && (item.loc.includes('prompt') && message(item.msg)
      || item.loc.length === 1 && item.loc[0] === 'body' && item.type === 'input_value_error'
        && item.msg === 'prompt: size must be between 0 and 2500'));
  return [body?.detail, body?.error, body?.message].some(value => typeof value === 'string' && /\bprompt\b/i.test(value) && message(value));
}
export async function verifyPromptRejectedReceipt(receipt, { key = () => process.env.FAL_KLING_KEY, fetchImpl = fetch } = {}) {
  requireValue(receipt?.state === 'failed' && receipt.failureCode === 'FAL_RENDER_FAILED' && receipt.endpoint === FAL_MODELS.kling && REQUEST.test(receipt.requestId || ''));
  const secret = typeof key === 'function' ? key() : key; requireValue(typeof secret === 'string' && secret);
  const options = { method: 'GET', headers: { Authorization: `Key ${secret}`, Accept: 'application/json' }, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000) };
  const statusResponse = await fetchImpl(falRequestUrl(receipt.statusUrl, receipt.endpoint, receipt.requestId, 'status'), options);
  if (!statusResponse.ok) { await statusResponse.body?.cancel(); throw Object.assign(fail(), { httpStatus: statusResponse.status }); }
  const status = await boundedResponse(statusResponse);
  requireValue(status.status === 'COMPLETED' && (!status.request_id || status.request_id === receipt.requestId));
  const resultResponse = await fetchImpl(falRequestUrl(receipt.responseUrl, receipt.endpoint, receipt.requestId, 'result'), options);
  if (resultResponse.status !== 422) { await resultResponse.body?.cancel(); throw Object.assign(fail(), { httpStatus: resultResponse.status }); }
  requireValue(promptLengthRejection(await boundedResponse(resultResponse)));
  return true;
}
async function remoteAuthorize(input) {
  const secret = process.env.LINEAGE_WORKER_SECRET; requireValue(HASH.test(secret || ''));
  const response = await fetch('https://lineagetheater.com/api/production-worker', { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'authorize-failed-shot-recovery', ...input,
      model: 'kling', recipe: FAL_RECIPE_VERSION }), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(fail(), { httpStatus: response.status }); }
  return boundedResponse(response);
}

// Operator-only repair of provider-confirmed, unbilled prompt rejections. It
// never changes the screenplay, original request identities or payment records.
export function createFailedShotRecovery({ read = readRecord, write = writeRecord, now = Date.now,
  client = createFalClient({ key: () => process.env.FAL_KLING_KEY, read, write, now }),
  correctionContext = input => readPaidFilmCorrection({ ...input, read, now }), authorize = remoteAuthorize,
  verifyRejected = receipt => verifyPromptRejectedReceipt(receipt), fetchImpl = fetch,
  buildInput = async (job, shot, plan) => {
    const refs = {};
    for (const character of plan.characters.filter(character => shot.characterIds.includes(character.id))) {
      if (character.referencePhotoId !== undefined) refs[character.id] = await productionPhotoData(job.manifest, character, { read });
      else { const receipt = await client.get(digest(`${FAL_RECIPE_VERSION}:cast:${job.id}:${job.manifestHash}:${character.id}`));
        requireValue(receipt?.state === 'completed' && receipt.endpoint === FAL_MODELS.reference && receipt.result?.images?.length === 1);
        refs[character.id] = falMediaUrl(receipt.result.images[0].url); }
    }
    const { falRecoveryShotInput } = await import('./fal-production.mjs');
    const input = falRecoveryShotInput(job.manifest, shot, refs);
    input.image_urls = await Promise.all(input.image_urls.map(value => klingReferenceData(value, { fetchImpl })));
    return input;
  } } = {}) {
  async function immutable(path, value) {
    const old = await read(path);
    if (!old) { try { await write(path, value); } catch { /* Exact readback only; never overwrite another claim. */ } }
    const saved = await read(path); requireValue(saved?.etag && hash(saved.value) === hash(value)); return saved;
  }
  async function context(input, allowFinished = false) {
    requireValue(input?.email === OWNER_EMAIL && UUID.test(input.preparedId || '') && HASH.test(input.manifestHash || '') && HASH.test(input.correctionId || '')
      && Array.isArray(input.failedRequests) && input.failedRequests.length >= 1 && input.failedRequests.length <= 2
      && input.failedRequests.every(row => Number.isInteger(row.shotIndex) && row.shotIndex >= 1 && row.shotIndex <= 12 && REQUEST.test(row.requestId || ''))
      && new Set(input.failedRequests.map(row => row.shotIndex)).size === input.failedRequests.length
      && HASH.test(input.rejectionEvidenceSha256 || '') && HASH.test(input.billing?.sha256 || '') && freshTime(input.billing.observedAt, now));
    const ownerHash = digest(input.email), jobPath = `production/jobs/${ownerHash}/${input.preparedId}.json`, queuePath = `production/queue/${ownerHash}/${input.preparedId}.json`;
    const [owner, jobRecord, queueRecord] = await Promise.all([read(userPath(input.email)), read(jobPath), read(queuePath)]);
    const job = jobRecord?.value, queue = queueRecord?.value;
    requireValue(owner?.etag && isOwner(owner.value) && !owner.value.mustChangePassword && owner.value.email === input.email
      && jobRecord?.etag && job?.id === input.preparedId && job.mode === 'customer' && job.ownerHash === ownerHash
      && job.manifestHash === input.manifestHash && hash(job.manifest) === input.manifestHash && job.manifest.targetDurationSeconds === 120
      && job.provider?.id === 'fal' && job.provider.model === 'kling' && job.provider.recipe === FAL_RECIPE_VERSION
      && job.authorization?.correctionId === input.correctionId && job.authorization.manifestHash === input.manifestHash
      && queueRecord?.etag && queue?.id === job.id && queue.email === input.email && queue.orderId === input.correctionId && queue.manifestHash === input.manifestHash);
    const finished = allowFinished && ['awaiting-assembly', 'completed'].includes(job.status);
    requireValue(finished || ['failed', 'processing', 'uncertain'].includes(job.status) && queue.state === 'attention' && !(queue.lease?.expiresAt > now()) && !(job.lease?.expiresAt > now()));
    const correction = await correctionContext({ email: input.email, job, correctionId: input.correctionId });
    requireValue(correction?.grant?.preparedId === job.id && correction.grant.manifestHash === job.manifestHash && correction.grant.maximumCostCents <= 1980
      && correction.grant.quote.maximumCostCents === job.authorization.budgetCents);
    const plan = falPlan(job.manifest, 'kling'); requireValue(plan.shots.length === 12 && job.shots.length === 12);
    const originals = [];
    for (const [index, shot] of job.shots.entries()) {
      requireValue(shot.id === plan.shots[index].id && HASH.test(shot.requestKey || ''));
      const identity = digest(`${FAL_RECIPE_VERSION}:kling:${shot.requestKey}`), record = await read(falRequestPath(identity)), receipt = record?.value;
      requireValue(record?.etag && receipt?.identity === identity && receipt.endpoint === FAL_MODELS.kling && REQUEST.test(receipt.requestId || '') && HASH.test(receipt.inputHash || ''));
      const row = input.billing.rows?.filter(row => row.requestId === receipt.requestId); requireValue(row?.length === 1 && Number.isSafeInteger(row[0].amountCents) && row[0].amountCents >= 0);
      originals.push({ identity, record, receipt, billing: row[0], shot, index });
    }
    requireValue(input.billing.rows.length === 12 && new Set(originals.map(row => row.receipt.requestId)).size === 12);
    const selected = input.failedRequests.map(wanted => { const row = originals[wanted.shotIndex - 1];
      requireValue(row.receipt.requestId === wanted.requestId && ['failed', 'queued', 'processing'].includes(row.receipt.state)
        && (row.receipt.state !== 'failed' || row.receipt.failureCode === 'FAL_RENDER_FAILED')
        && row.billing.amountCents === 0 && row.billing.quantity === 0 && (finished || row.shot.status !== 'completed')); return row; });
    requireValue(originals.filter(row => !selected.includes(row)).every(row => row.billing.quantity === plan.shots[row.index].seconds
      && row.billing.amountCents === plan.shots[row.index].seconds * 14));
    const priorSpendCents = originals.reduce((sum, row) => sum + row.billing.amountCents, 0) + plan.referenceCount * 30;
    const totalReplacementMaximumCents = selected.reduce((sum, row) => sum + plan.shots[row.index].seconds * 15, 0);
    requireValue(priorSpendCents + totalReplacementMaximumCents <= correction.grant.quote.maximumCostCents && correction.grant.quote.maximumCostCents <= correction.grant.maximumCostCents);
    return { input, owner, ownerHash, jobPath, queuePath, jobRecord, queueRecord, job, queue, correction, plan, originals, selected, priorSpendCents, totalReplacementMaximumCents, finished };
  }
  async function recheck(c) {
    await c.correction.recheck();
    const rows = await Promise.all([read(c.jobPath), read(c.queuePath), read(userPath(c.input.email))]);
    requireValue(rows.every((row, i) => row?.etag === [c.jobRecord, c.queueRecord, c.owner][i].etag));
  }
  async function output(receipt, seconds) {
    requireValue(receipt?.state === 'completed' && receipt.endpoint === FAL_MODELS.kling);
    const url = falMediaUrl(receipt.result?.video?.url), response = await fetchImpl(url, { method: 'HEAD', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20_000) });
    const sizeBytes = Number(response.headers.get('content-length')), contentType = response.headers.get('content-type')?.split(';')[0];
    requireValue(response.ok && contentType === 'video/mp4' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 16 && sizeBytes <= 250 * 1024 * 1024);
    return { url, contentType, sizeBytes, durationSeconds: seconds };
  }
  async function run(input, { execute = false } = {}) {
    let stage = 'context';
    try {
    input = structuredClone(input);
    let c = await context(input, true);
    if (c.finished) {
      // Recover a successful job write followed by a lost queue-write reply.
      if (execute && c.queue.state === 'attention' && !(c.queue.lease?.expiresAt > now()) && c.job.status === 'awaiting-assembly') {
        requireValue(c.job.recovery?.kind === 'kling-failed-shot-recovery-v1' && c.job.recovery.billingEvidenceSha256 === input.billing.sha256
          && hash(c.job.recovery.recoveryIds) === hash(c.selected.map(row => failedShotRecoveryId(row.identity, row.receipt.requestId)))
          && c.job.shots.every(shot => shot.status === 'completed'));
        const { lease, ...old } = c.queue; await recheck(c);
        await write(c.queuePath, { ...old, state: 'pending', attempts: 0, nextAttemptAt: now(), lastResult: 'RECOVERY_VERIFIED', lastFailure: null }, c.queueRecord.etag);
      }
      return { status: c.job.status, resumed: c.queue.state !== 'attention' || execute, generationSubmitted: false };
    }
    if (execute) {
      stage = 'reconcile';
      // The provider may have finished while the failed parent job stopped its
      // normal polling. Reconcile only these exact, existing request IDs first.
      for (const row of c.selected) if (row.receipt.state !== 'failed') {
        const receipt = await client.poll(row.identity);
        requireValue(receipt?.requestId === row.receipt.requestId && receipt.state === 'failed' && receipt.failureCode === 'FAL_RENDER_FAILED');
      }
      c = await context(input);
    }
    const planned = [];
    for (const row of c.selected) {
      stage = 'input-validation';
      const recoveryId = failedShotRecoveryId(row.identity, row.receipt.requestId), replacementIdentity = digest(`${recoveryId}:replacement-v1`);
      const body = await buildInput(c.job, c.plan.shots[row.index], c.plan);
      requireValue(typeof body.prompt === 'string' && Buffer.byteLength(body.prompt) < 2400 && Buffer.byteLength(JSON.stringify(body.prompt)) < 2400
        && body.duration === String(c.plan.shots[row.index].seconds) && body.generate_audio === true);
      const saved = await read(failedShotRecoveryPath(recoveryId));
      const claim = { version: 1, kind: 'kling-failed-shot-recovery-v1', recoveryId, ownerHash: c.ownerHash, preparedId: input.preparedId,
        manifestHash: input.manifestHash, correctionId: input.correctionId, model: 'kling', recipe: FAL_RECIPE_VERSION,
        maximumCostCents: c.correction.grant.quote.maximumCostCents, maximumTotalCostCents: c.correction.grant.maximumCostCents,
        originalIdentity: row.identity, originalRequestId: row.receipt.requestId, originalInputHash: row.receipt.inputHash, endpoint: FAL_MODELS.kling,
        replacementIdentity, inputHash: hash(body), shotId: row.shot.id, shotIndex: row.index + 1, providerSeconds: c.plan.shots[row.index].seconds,
        replacementMaximumCents: c.plan.shots[row.index].seconds * 15, terminalFailure: 'PROMPT_LENGTH_422', zeroChargeCents: 0,
        billingEvidenceSha256: input.billing.sha256, rejectionEvidenceSha256: input.rejectionEvidenceSha256, billingObservedAt: input.billing.observedAt,
        priorSpendCents: c.priorSpendCents, totalReplacementMaximumCents: c.totalReplacementMaximumCents,
        selectedRequests: input.failedRequests, originalRequests: c.originals.map(item => ({ requestId: item.receipt.requestId, amountCents: item.billing.amountCents })),
        createdAt: saved?.value.createdAt || new Date(now()).toISOString() };
      requireValue(!saved || hash(saved.value) === hash(claim)); planned.push({ row, claim, body });
    }
    if (!execute) {
      stage = 'reconcile';
      for (const row of c.selected) await verifyRejected({ ...row.receipt, state: 'failed', failureCode: 'FAL_RENDER_FAILED' });
      return { status: 'ready-for-explicit-recovery', clips: planned.map(({ claim }) => ({ clip: claim.shotIndex, originalRequestId: claim.originalRequestId, recoveryId: claim.recoveryId,
      replacementMaximumCents: claim.replacementMaximumCents })), priorSpendCents: c.priorSpendCents, replacementMaximumCents: c.totalReplacementMaximumCents, maximumTotalCostCents: c.correction.grant.maximumCostCents, generationSubmitted: false };
    }
    // Poll only already-persisted request IDs. A missing or uncertain receipt is
    // never permission to create another provider operation.
    for (const row of c.originals.filter(row => !c.selected.includes(row))) {
      stage = 'reconcile';
      const receipt = ['completed', 'failed'].includes(row.receipt.state) ? row.receipt : await client.poll(row.identity);
      requireValue(receipt?.state === 'completed' && receipt.requestId === row.receipt.requestId);
    }
    let submitted = false;
    for (const item of planned) {
      const { claim, row, body } = item;
      stage = 'reconcile';
      await recheck(c); await verifyRejected(row.receipt);
      stage = 'claim';
      await immutable(failedShotRecoveryPath(claim.recoveryId), claim);
      let replacement = await client.get(claim.replacementIdentity);
      if (!replacement) {
        stage = 'auth';
        const grant = await authorize({ email: input.email, preparedId: input.preparedId, manifestHash: input.manifestHash, correctionId: input.correctionId,
          recoveryId: claim.recoveryId, originalIdentity: claim.originalIdentity, originalRequestId: claim.originalRequestId, replacementIdentity: claim.replacementIdentity });
        requireValue(grant?.allowed === true && grant.manifestHash === input.manifestHash && grant.preparedId === input.preparedId
          && grant.correctionId === input.correctionId && grant.originalIdentity === claim.originalIdentity && grant.originalRequestId === claim.originalRequestId
          && grant.originalOrderId === c.correction.grant.originalOrderId && grant.environment === 'production'
          && grant.inputHash === claim.inputHash && grant.replacementMaximumCents === claim.replacementMaximumCents
          && grant.totalReplacementMaximumCents === claim.totalReplacementMaximumCents
          && grant.quoteReference === c.job.authorization.quoteReference && grant.recoveryId === claim.recoveryId
          && grant.replacementIdentity === claim.replacementIdentity && grant.budgetCents === claim.maximumCostCents
          && Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > now() && Date.parse(grant.expiresAt) <= now() + 60_000);
        await recheck(c);
        const current = await read(falRequestPath(row.identity)); requireValue(current?.etag === row.record.etag);
        requireValue(Date.parse(grant.expiresAt) > now());
        stage = 'submission';
        replacement = await client.submit({ identity: claim.replacementIdentity, endpoint: FAL_MODELS.kling, input: body }); submitted = true;
      } else {
        requireValue(replacement.identity === claim.replacementIdentity && replacement.endpoint === FAL_MODELS.kling && replacement.inputHash === claim.inputHash);
        stage = 'poll';
        if (replacement.requestId && !['completed', 'failed'].includes(replacement.state)) replacement = await client.poll(claim.replacementIdentity);
      }
      requireValue(replacement?.identity === claim.replacementIdentity && replacement.endpoint === FAL_MODELS.kling && replacement.inputHash === claim.inputHash);
      if (replacement.state === 'completed') {
        stage = 'claim';
        await output(replacement, claim.providerSeconds); await recheck(c);
        await immutable(`production/fal/choices/${row.identity}.json`, { version: 1, originalIdentity: row.identity, productionId: input.preparedId,
          manifestHash: input.manifestHash, model: 'kling', approvedBy: input.email, promptVersion: FAL_RECIPE_VERSION,
          replacementIdentity: claim.replacementIdentity, requestId: replacement.requestId });
      }
      item.replacement = replacement;
    }
    if (!planned.every(item => item.replacement.state === 'completed')) return { status: 'replacement-pending', generationSubmitted: submitted,
      replacements: planned.map(item => ({ clip: item.claim.shotIndex, state: item.replacement.state, requestId: item.replacement.requestId || null })) };
    stage = 'resume';
    c = await context(input); const outputs = [];
    for (const row of c.originals) {
      const replacement = planned.find(item => item.row.identity === row.identity);
      if (replacement) {
        const choice = (await read(`production/fal/choices/${row.identity}.json`))?.value;
        requireValue(choice?.originalIdentity === row.identity && choice.productionId === input.preparedId && choice.manifestHash === input.manifestHash
          && choice.model === 'kling' && choice.approvedBy === input.email && choice.promptVersion === FAL_RECIPE_VERSION
          && choice.replacementIdentity === replacement.claim.replacementIdentity && choice.requestId === replacement.replacement.requestId);
      }
      const receipt = await client.get(replacement?.claim.replacementIdentity || row.identity);
      const verified = await output(receipt, c.plan.shots[row.index].seconds);
      if (row.shot.status === 'completed') { requireValue(Object.keys(verified).every(key => row.shot.output?.[key] === verified[key])); outputs.push(row.shot); }
      else outputs.push({ ...row.shot, status: 'completed', providerJobId: `fal-${row.identity}`, output: verified, completedAt: new Date(now()).toISOString() });
    }
    await recheck(c);
    const next = { ...c.job, shots: outputs, status: 'awaiting-assembly', timingDisrupted: true, finishingStartedAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(), revision: c.job.revision + 1,
      recovery: { kind: 'kling-failed-shot-recovery-v1', billingEvidenceSha256: input.billing.sha256, recoveryIds: planned.map(item => item.claim.recoveryId) } };
    try { await write(c.jobPath, next, c.jobRecord.etag); } catch { /* A lost write reply requires exact readback. */ }
    requireValue(hash((await read(c.jobPath))?.value) === hash(next));
    const queue = await read(c.queuePath); requireValue(queue?.etag === c.queueRecord.etag);
    const { lease, ...old } = queue.value;
    await write(c.queuePath, { ...old, state: 'pending', attempts: 0, nextAttemptAt: now(), lastResult: 'RECOVERY_VERIFIED', lastFailure: null }, queue.etag);
    return { status: 'awaiting-assembly', resumed: true, generationSubmitted: submitted, completedClips: 12, durationSeconds: 120 };
    } catch (error) {
      throw Object.assign(fail(), { stage, ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) });
    }
  }
  return { run };
}
