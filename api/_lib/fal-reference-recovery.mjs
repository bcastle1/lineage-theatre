import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { createFalClient, falRequestPath, falRequestUrl, falMediaUrl, FAL_MODELS } from './fal-client.mjs';
import { createFalPricing } from './fal-pricing.mjs';
import { falReferenceData } from './fal-reference.mjs';
import { characterReferenceInput, characterViewIdentity, startFrameIdentity, falPlan } from './fal-production.mjs';
import { REFERENCE_RECOVERY as S, referenceRecoveryHash as hash, referenceRecoveryIdentity as originalIdentity,
  referenceReplacementIdentity as replacementIdentity, referenceRecoveryId as recoveryId, referenceRecoveryPath,
  referenceChoicePath, referenceGrantPath, referenceJobPath, requireReferenceRecovery as requireValue,
  verifyReferenceRecoveryGrant, verifyReferenceRecoveryJob, verifyReferenceRecoveryEvidence,
  verifyReferenceRecoveryRejection, verifyReferenceRecoveryClaim, resolveReferenceChoice } from './fal-reference-choice.mjs';

async function smallJson(response) {
  requireValue(response.body); const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; requireValue(size <= 16384); chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { requireValue(false); }
  } finally { await reader.cancel().catch(() => {}); }
}
// The queue's terminal state alone is not success. Bind the exact status and
// replayed result error to this original request without changing its receipt.
export async function verifyTopUpRejectedReference(original, { key = () => process.env.FAL_KLING_KEY,
  fetchImpl = fetch, now = Date.now } = {}) {
  requireValue(original?.identity === originalIdentity && original.requestId === S.originalRequestId
    && original.endpoint === FAL_MODELS.reference && !original.result);
  const secret = typeof key === 'function' ? key() : key; requireValue(typeof secret === 'string' && secret.length > 0);
  const get = url => fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Key ${secret}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  const statusResponse = await get(falRequestUrl(original.statusUrl, original.endpoint, original.requestId, 'status'));
  requireValue(statusResponse.status === 200); const status = await smallJson(statusResponse);
  requireValue(status.status === 'COMPLETED' && status.request_id === original.requestId);
  const response = await get(falRequestUrl(original.responseUrl, original.endpoint, original.requestId, 'result'));
  requireValue(response.status === 403); const result = await smallJson(response);
  requireValue(Object.keys(result).length === 1 && result.detail === 'User is locked. Reason: TOP_UP.');
  return { version: 1, requestId: original.requestId, status: 'COMPLETED', httpStatus: 403, detail: result.detail,
    statusSha256: hash(status), resultSha256: hash(result), observedAt: new Date(now()).toISOString() };
}

export function createReferenceRecovery({ read = readRecord, write = writeRecord, now = Date.now,
  client = createFalClient({ key: () => process.env.FAL_KLING_KEY, read, write, now }),
  pricing = createFalPricing({ key: () => process.env.FAL_KLING_KEY }),
  verifyRejected = original => verifyTopUpRejectedReference(original, { now }),
  validateOutput = receipt => falReferenceData(falMediaUrl(receipt.result.images[0].url)) } = {}) {
  const childStatus = child => ['failed', 'uncertain', 'submitting'].includes(child.state) || !child.requestId
    ? 'replacement-needs-attention' : 'replacement-pending';
  async function immutable(path, value) {
    const previous = await read(path);
    if (previous) { requireValue(hash(previous.value) === hash(value)); return previous.value; }
    try { await write(path, value); } catch { /* Re-read an ambiguous conditional write; never create a different claim. */ }
    const saved = await read(path); requireValue(saved && hash(saved.value) === hash(value)); return saved.value;
  }
  function bindInput(input) {
    requireValue(input?.email === S.email && input.productionId === S.id && input.manifestHash === S.manifestHash
      && input.originalRequestId === S.originalRequestId);
  }
  function evidence(input) {
    return { budgetMode: input.budgetMode, ...(input.billingEvidence ? { billingEvidence: input.billingEvidence } : {}),
      ...(input.replacementApproval ? { replacementApproval: input.replacementApproval } : {}),
      ...(input.additionalApproval ? { additionalApproval: input.additionalApproval } : {}) };
  }
  async function context(input) {
    bindInput(input);
    const [ownerRecord, jobRecord, grantRecord, originalRecord, claimRecord] = await Promise.all([
      read(userPath(S.email)), read(referenceJobPath), read(referenceGrantPath), read(falRequestPath(originalIdentity)), read(referenceRecoveryPath),
    ]);
    const owner = ownerRecord?.value; requireValue(isOwner(owner) && owner.email === S.email && !owner.mustChangePassword);
    const job = verifyReferenceRecoveryJob(jobRecord?.value), plan = falPlan(job.manifest, 'kling');
    requireValue(plan.referenceCount === 7 && plan.generatedSeconds === 16 && plan.shots.length === 3 && plan.characters.length === 2);
    const character = plan.characters.find(value => value.id === S.characterId);
    requireValue(character && character.referencePhotoId === undefined);
    const body = characterReferenceInput(job.manifest, character), original = originalRecord?.value, grant = grantRecord?.value;
    requireValue(job.authorization?.environment === 'production' && job.authorization.budgetCents === 450
      && job.authorization.manifestHash === S.manifestHash && job.authorization.quoteReference === grant?.quoteReference);
    requireValue(originalRecord?.etag && original?.identity === originalIdentity && original.requestId === S.originalRequestId
      && original.endpoint === FAL_MODELS.reference && original.inputHash === hash(body)
      && ['queued', 'processing', 'failed'].includes(original.state) && !original.result);
    let claim = claimRecord?.value;
    if (claim) {
      verifyReferenceRecoveryClaim(claim, { original, grant });
      requireValue(hash(evidence(input)) === hash(evidence(claim)));
    } else {
      verifyReferenceRecoveryGrant(grant, now()); verifyReferenceRecoveryEvidence(input, now());
    }
    return { jobRecord, job, plan, body, originalRecord, original, grant, claim };
  }
  async function noDownstream(c) {
    requireValue(c.job.status === 'uncertain' && !c.job.media && !c.job.shots.some(shot => shot.output)
      && (!c.job.lease || c.job.lease.expiresAt <= now()));
    const identities = [...c.plan.characters.map(character => characterViewIdentity(S.id, S.manifestHash, character.id)),
      ...c.plan.shots.map(shot => startFrameIdentity(S.id, S.manifestHash, shot.id)),
      ...c.job.shots.map(shot => digest(`${S.recipe}:kling:${shot.requestKey}`))];
    requireValue((await Promise.all(identities.map(identity => read(falRequestPath(identity))))).every(value => !value));
    const adaId = digest(`${S.recipe}:cast:${S.id}:${S.manifestHash}:ada`), ada = (await read(falRequestPath(adaId)))?.value;
    const adaCharacter = c.plan.characters.find(character => character.id === 'ada');
    requireValue(ada?.identity === adaId && ada.endpoint === FAL_MODELS.reference && ada.requestId === S.adaRequestId
      && ada.inputHash === hash(characterReferenceInput(c.job.manifest, adaCharacter)));
  }
  async function spendingChecks(input, c) {
    verifyReferenceRecoveryGrant(c.grant, now()); verifyReferenceRecoveryEvidence(input, now());
    await noDownstream(c);
    const heartbeat = (await read('production/worker-health.json'))?.value;
    requireValue(heartbeat?.ready === true && heartbeat.model === 'kling' && heartbeat.recipe === S.recipe
      && heartbeat.characterBindingVersion === 3 && heartbeat.visualChecksVersion === 1 && heartbeat.deliveryChecksVersion === 1
      && Date.parse(heartbeat.checkedAt) <= now() && now() - Date.parse(heartbeat.checkedAt) <= 180000);
    const rates = await pricing('kling');
    requireValue(Number.isSafeInteger(rates.videoMicroUsdPerSecond) && rates.videoMicroUsdPerSecond > 0
      && rates.videoMicroUsdPerSecond <= c.grant.videoMicroUsdPerSecond
      && Number.isSafeInteger(rates.referenceMicroUsd) && rates.referenceMicroUsd > 0
      && rates.referenceMicroUsd <= c.grant.referenceMicroUsd && rates.referenceMicroUsd <= 300000
      && Date.parse(rates.expiresAt) > now());
    // Count the failed original conservatively unless an explicit zero row was
    // approved. Do not spend unused quote headroom on an unapproved retry.
    const referenceAttempts = input.budgetMode === 'verified-zero-charge' ? 7 : 8;
    requireValue(Math.ceil((16 * rates.videoMicroUsdPerSecond + referenceAttempts * rates.referenceMicroUsd) / 10000)
      <= verifyReferenceRecoveryEvidence(input, now()));
  }
  async function recover(input, { execute = false } = {}) {
    let c = await context(input);
    const selected = await resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash, identity: originalIdentity, ownerHash: S.ownerHash }, { read });
    if (selected) return { status: 'reference-choice-ready', generationSubmitted: false, replacementIdentity,
      choiceHash: selected.proof.choiceHash, maximumTotalCostCents: c.claim.maximumTotalCostCents };
    let child = await client.get(replacementIdentity);
    requireValue(!child || c.claim);
    if (!child) {
      await spendingChecks(input, c);
      const rejection = await verifyRejected(c.original); verifyReferenceRecoveryRejection(rejection, now());
      const claim = c.claim || { version: 1, kind: 'funded-reference-recovery-v1', recoveryId,
        ownerHash: S.ownerHash, approvedBy: S.email, productionId: S.id, manifestHash: S.manifestHash,
        originalIdentity, originalRequestId: S.originalRequestId, replacementIdentity, endpoint: FAL_MODELS.reference,
        inputHash: hash(c.body), originalReceiptHash: hash(c.original), grantHash: hash(c.grant),
        maximumReplacementCostCents: 30, maximumTotalCostCents: verifyReferenceRecoveryEvidence(input, now()),
        maximumPhysicalReferenceAttempts: 8, maximumVideoRequests: 3, ...evidence(input), rejection, createdAt: new Date(now()).toISOString() };
      verifyReferenceRecoveryClaim(claim, { original: c.original, grant: c.grant });
      if (!execute) return { status: 'ready-for-reference-recovery', generationSubmitted: false, recoveryId, replacementIdentity,
        maximumReplacementCostCents: 30, maximumTotalCostCents: claim.maximumTotalCostCents, maximumPhysicalReferenceAttempts: 8 };
      await immutable(referenceRecoveryPath, claim);
      c = await context(input); await spendingChecks(input, c);
      // Both original receipt and job must still be the reviewed versions at
      // the final boundary. createFalClient supplies the atomic child claim.
      const [original, job, grant, owner] = await Promise.all([
        read(falRequestPath(originalIdentity)), read(referenceJobPath), read(referenceGrantPath), read(userPath(S.email)),
      ]);
      requireValue(original?.etag === c.originalRecord.etag && job?.etag === c.jobRecord.etag
        && hash(grant?.value) === hash(c.grant) && isOwner(owner?.value) && owner.value.email === S.email && !owner.value.mustChangePassword);
      verifyReferenceRecoveryGrant(grant.value, now()); verifyReferenceRecoveryEvidence(input, now());
      child = await client.submit({ identity: replacementIdentity, endpoint: FAL_MODELS.reference, input: c.body });
      return { status: childStatus(child), generationSubmitted: true, replacementIdentity, state: child.state,
        requestId: child.requestId || null, maximumTotalCostCents: c.claim.maximumTotalCostCents };
    }
    requireValue(child.identity === replacementIdentity && child.endpoint === FAL_MODELS.reference && child.inputHash === hash(c.body));
    if (!execute) return { status: child.state === 'completed' ? 'replacement-awaiting-selection' : childStatus(child),
      generationSubmitted: false, replacementIdentity, state: child.state, maximumTotalCostCents: c.claim.maximumTotalCostCents };
    // Existing child reconciliation never authorizes another POST, even when
    // approval expires or the submit receipt was lost.
    if (child.requestId && !['completed', 'failed'].includes(child.state)) child = await client.poll(replacementIdentity);
    if (child.state !== 'completed') return { status: childStatus(child), generationSubmitted: false,
      replacementIdentity, state: child.state, requestId: child.requestId || null, maximumTotalCostCents: c.claim.maximumTotalCostCents };
    requireValue(child.identity === replacementIdentity && child.endpoint === FAL_MODELS.reference
      && child.inputHash === hash(c.body) && child.result?.images?.length === 1);
    falMediaUrl(child.result.images[0].url);
    const data = await validateOutput(child); requireValue(typeof data === 'string' && data.startsWith('data:image/jpeg;base64,'));
    c = await context(input); await noDownstream(c);
    const choice = { version: 1, kind: 'funded-reference-choice-v1', recoveryId, originalIdentity, replacementIdentity,
      productionId: S.id, manifestHash: S.manifestHash, claimHash: hash(c.claim), requestId: child.requestId,
      resultHash: hash(child.result), validatedImageHash: digest(data) };
    await immutable(referenceChoicePath, choice);
    const verified = await resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash, identity: originalIdentity, ownerHash: S.ownerHash }, { read });
    requireValue(verified);
    return { status: 'reference-choice-ready', generationSubmitted: false, replacementIdentity,
      choiceHash: verified.proof.choiceHash, maximumTotalCostCents: c.claim.maximumTotalCostCents };
  }
  return { recover };
}
