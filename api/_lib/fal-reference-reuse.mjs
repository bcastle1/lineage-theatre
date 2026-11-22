import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { falRequestPath, falRequestUrl, falMediaUrl, FAL_MODELS } from './fal-client.mjs';
import { falReferenceData } from './fal-reference.mjs';
import { characterReferenceInput, characterViewIdentity, startFrameIdentity, falPlan } from './fal-production.mjs';
import { REFERENCE_RECOVERY as S, REFERENCE_REUSE as R, referenceRecoveryHash as hash,
  referenceRecoveryIdentity as originalIdentity, referenceReplacementIdentity, referenceRecoveryId,
  referenceRecoveryPath, referenceChoicePath, referenceGrantPath, referenceJobPath, referenceReuseId,
  referenceReusePath, referenceReuseSourceJobPath, requireReferenceRecovery as requireValue,
  verifyReferenceRecoveryGrant, verifyReferenceRecoveryJob, verifyReferenceRecoveryClaim,
  verifyReferenceReuseApproval, verifyReferenceReuseChild, verifyReferenceReuseRejection,
  verifyReferenceReuseSource, verifyReferenceReuseClaim, resolveReferenceChoice } from './fal-reference-choice.mjs';

async function smallJson(response) {
  requireValue(response.body); const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; requireValue(size <= 16384); chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { requireValue(false); }
  } finally { await reader.cancel().catch(() => {}); }
}

// These two GETs establish the failed child's terminal response. They never
// poll into a mutable local receipt, retry a request, or submit generation.
export async function verifyTopUpRejectedReplacement(child, { key = () => process.env.FAL_KLING_KEY,
  fetchImpl = fetch, now = Date.now } = {}) {
  verifyReferenceReuseChild(child);
  const statusUrl = falRequestUrl(child.statusUrl, child.endpoint, child.requestId, 'status');
  const resultUrl = falRequestUrl(child.responseUrl, child.endpoint, child.requestId, 'result');
  const secret = typeof key === 'function' ? key() : key; requireValue(typeof secret === 'string' && secret.length > 0);
  const get = url => fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Key ${secret}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  const statusResponse = await get(statusUrl); requireValue(statusResponse.status === 200);
  const status = await smallJson(statusResponse);
  requireValue(status.status === 'COMPLETED' && status.request_id === R.failedReplacementRequestId);
  const resultResponse = await get(resultUrl); requireValue(resultResponse.status === 403);
  const result = await smallJson(resultResponse);
  requireValue(Object.keys(result).length === 1 && result.detail === 'User is locked. Reason: TOP_UP.');
  return { version: 1, requestId: child.requestId, status: 'COMPLETED', httpStatus: 403, detail: result.detail,
    statusSha256: hash(status), resultSha256: hash(result), observedAt: new Date(now()).toISOString() };
}

// Trusted dependency seams support synthetic offline fixtures. No request,
// environment variable, or public route can change the production fingerprints.
// There is deliberately no generation client or pricing mutation in this service.
export function createReferenceReuse({ read = readRecord, write = writeRecord, now = Date.now,
  verifyRejected = child => verifyTopUpRejectedReplacement(child, { now }),
  validateOutput = receipt => falReferenceData(falMediaUrl(receipt.result.images[0].url)),
  sourceReceiptFingerprint = hash, imageFingerprint = digest } = {}) {
  const resolveChoice = () => resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash,
    identity: originalIdentity, ownerHash: S.ownerHash }, { read, sourceReceiptFingerprint });
  const summary = (status, choiceHash) => ({ status, generationSubmitted: false, additionalPortraitRequests: 0,
    maximumTotalCostCents: 480, maximumPhysicalReferenceAttempts: 8, sourceIdentity: R.sourceIdentity,
    sourceRequestId: R.sourceRequestId, ...(choiceHash ? { choiceHash } : {}) });
  async function immutable(path, value) {
    const existing = await read(path);
    if (existing) { requireValue(hash(existing.value) === hash(value)); return existing.value; }
    try { await write(path, value); } catch { /* An ambiguous create is resolved only by exact readback. */ }
    const saved = await read(path); requireValue(saved && hash(saved.value) === hash(value)); return saved.value;
  }
  async function context(input) {
    requireValue(input?.email === S.email && input.productionId === S.id && input.manifestHash === S.manifestHash
      && input.sourceRequestId === R.sourceRequestId);
    const [ownerRecord, jobRecord, grantRecord, originalRecord, claimRecord, childRecord, sourceJobRecord, sourceRecord, reuseRecord] = await Promise.all([
      read(userPath(S.email)), read(referenceJobPath), read(referenceGrantPath), read(falRequestPath(originalIdentity)),
      read(referenceRecoveryPath), read(falRequestPath(referenceReplacementIdentity)), read(referenceReuseSourceJobPath),
      read(falRequestPath(R.sourceIdentity)), read(referenceReusePath),
    ]);
    requireValue(isOwner(ownerRecord?.value) && ownerRecord.value.email === S.email && !ownerRecord.value.mustChangePassword);
    const job = verifyReferenceRecoveryJob(jobRecord?.value), grant = grantRecord?.value, original = originalRecord?.value;
    const claim = verifyReferenceRecoveryClaim(claimRecord?.value, { original, grant });
    const child = childRecord?.value, sourceJob = sourceJobRecord?.value, source = sourceRecord?.value;
    verifyReferenceReuseChild(child); verifyReferenceReuseSource(sourceJob, source, { sourceReceiptFingerprint });
    requireValue(claim.budgetMode === 'separate-30-cent-approval' && claim.maximumTotalCostCents === 480
      && claim.inputHash === R.inputHash && job.authorization?.environment === 'production'
      && job.authorization.budgetCents === 450 && job.authorization.manifestHash === S.manifestHash
      && job.authorization.quoteReference === grant.quoteReference);
    const plan = falPlan(job.manifest, 'kling'), character = plan.characters.find(value => value.id === S.characterId);
    const sourceCharacter = sourceJob.manifest.screenplay.characters.find(value => value.id === S.characterId);
    requireValue(plan.referenceCount === 7 && plan.generatedSeconds === 16 && plan.shots.length === 3
      && plan.characters.length === 2 && character?.referencePhotoId === undefined && sourceCharacter
      && hash(character) === hash(sourceCharacter) && hash(characterReferenceInput(job.manifest, character)) === R.inputHash
      && hash(characterReferenceInput(sourceJob.manifest, sourceCharacter)) === R.inputHash);
    const c = { jobRecord, job, grant, original, claim, child, sourceJob, source, plan, reuse: reuseRecord?.value, sourceReceiptFingerprint };
    if (c.reuse) {
      verifyReferenceReuseClaim(c.reuse, c); requireValue(hash(c.reuse.approval) === hash(input));
    }
    return c;
  }
  async function beforeWrite(input, c) {
    verifyReferenceRecoveryGrant(c.grant, now()); verifyReferenceReuseApproval(input, c.grant, now());
    requireValue(c.job.status === 'uncertain' && !c.job.media && !c.job.shots.some(shot => shot.output)
      && (!c.job.lease || c.job.lease.expiresAt <= now()));
    const downstream = [...c.plan.characters.map(character => characterViewIdentity(S.id, S.manifestHash, character.id)),
      ...c.plan.shots.map(shot => startFrameIdentity(S.id, S.manifestHash, shot.id)),
      ...c.job.shots.map(shot => digest(`${S.recipe}:kling:${shot.requestKey}`))];
    requireValue((await Promise.all(downstream.map(identity => read(falRequestPath(identity))))).every(value => !value));
    const adaIdentity = digest(`${S.recipe}:cast:${S.id}:${S.manifestHash}:ada`), ada = (await read(falRequestPath(adaIdentity)))?.value;
    requireValue(ada?.identity === adaIdentity && ada.requestId === S.adaRequestId && ada.endpoint === FAL_MODELS.reference
      && ada.inputHash === hash(characterReferenceInput(c.job.manifest, c.plan.characters.find(character => character.id === 'ada'))));
    // Check the source/job/owner again after all awaited reads. A lost claim
    // response cannot turn changed input or expired approval into authority.
    const latest = await context(input);
    requireValue(latest.jobRecord.etag === c.jobRecord.etag && hash(latest.grant) === hash(c.grant)
      && hash(latest.child) === hash(c.child) && hash(latest.source) === hash(c.source));
    verifyReferenceRecoveryGrant(latest.grant, now()); verifyReferenceReuseApproval(input, latest.grant, now());
    return latest;
  }
  async function reuse(input, { execute = false } = {}) {
    let c = await context(input);
    const selected = await resolveChoice();
    if (selected) {
      requireValue(selected.proof.reuseId === referenceReuseId);
      return summary('reference-choice-ready', selected.proof.choiceHash);
    }
    c = await beforeWrite(input, c);
    const rejection = await verifyRejected(c.child); verifyReferenceReuseRejection(rejection, now());
    const data = await validateOutput(c.source);
    requireValue(typeof data === 'string' && data.startsWith('data:image/jpeg;base64,') && imageFingerprint(data) === R.normalizedImageHash);
    c = await beforeWrite(input, c);
    const reuseClaim = c.reuse || { version: 1, kind: 'existing-reference-reuse-v1', reuseId: referenceReuseId,
      ownerHash: S.ownerHash, productionId: S.id, manifestHash: S.manifestHash, originalIdentity,
      recoveryClaimHash: hash(c.claim), originalReceiptHash: hash(c.original), grantHash: hash(c.grant),
      failedReplacementIdentity: referenceReplacementIdentity, failedReplacementRequestId: R.failedReplacementRequestId,
      failedReplacementReceiptHash: hash(c.child), sourceProductionId: R.sourceProductionId, sourceManifestHash: R.sourceManifestHash,
      sourceIdentity: R.sourceIdentity, sourceRequestId: R.sourceRequestId, sourceReceiptHash: R.sourceReceiptHash,
      sourceResultHash: hash(c.source.result), auditedSourceJobHash: R.auditedSourceJobHash, inputHash: R.inputHash,
      validatedImageHash: R.normalizedImageHash, maximumAdditionalCostCents: 0, maximumNewPortraitRequests: 0,
      maximumTotalCostCents: 480, maximumPhysicalReferenceAttempts: 8, maximumVideoRequests: 3,
      approval: structuredClone(input), rejection, createdAt: new Date(now()).toISOString() };
    verifyReferenceReuseClaim(reuseClaim, c);
    if (!execute) return summary('ready-for-reference-reuse');
    await immutable(referenceReusePath, reuseClaim);
    c = await beforeWrite(input, await context(input));
    // Reuse is a selection only. The normal resume path retains its current
    // grant, prices, preflight, final visual, speech and private-media gates.
    const choice = { version: 1, kind: 'existing-reference-choice-v1', reuseId: referenceReuseId,
      recoveryId: referenceRecoveryId, ownerHash: S.ownerHash, originalIdentity, replacementIdentity: R.sourceIdentity,
      productionId: S.id, manifestHash: S.manifestHash, claimHash: hash(c.claim), reuseClaimHash: hash(c.reuse),
      requestId: R.sourceRequestId, sourceReceiptHash: R.sourceReceiptHash,
      resultHash: hash(c.source.result), validatedImageHash: R.normalizedImageHash };
    await immutable(referenceChoicePath, choice);
    const verified = await resolveChoice(); requireValue(verified?.proof.reuseId === referenceReuseId);
    return summary('reference-choice-ready', verified.proof.choiceHash);
  }
  return { reuse };
}
