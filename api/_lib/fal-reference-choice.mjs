import { digest, readRecord, userPath } from './auth.mjs';
import { OWNER_EMAIL, isOwner } from './access.mjs';
import { falRequestPath, falMediaUrl, FAL_MODELS } from './fal-client.mjs';

// This is one reviewed recovery, not a general retry policy. Historical request
// receipts and the original seven-reference grant are never rewritten.
export const REFERENCE_RECOVERY = Object.freeze({
  email: OWNER_EMAIL, ownerHash: digest(OWNER_EMAIL),
  id: 'ec43a635-8c7e-8f99-dc90-d4ceb2681bb5',
  manifestHash: '601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f',
  recipe: 'lineage-realistic-kling-o3-v1', runKey: 'kling-cast-continuity-canary-20261105-v3',
  characterId: 'alice', originalRequestId: '01a1ad68-46cc-7520-91a4-dba5bf63908c',
  adaRequestId: '01a1ad68-4280-7fc0-9efd-0f85c47ee016',
});
const S = REFERENCE_RECOVERY, HASH = /^[a-f0-9]{64}$/;
export const referenceRecoveryHash = value => digest(JSON.stringify(value));
export const referenceRecoveryIdentity = digest(`${S.recipe}:cast:${S.id}:${S.manifestHash}:${S.characterId}`);
export const referenceRecoveryId = digest(`funded-reference-recovery-v1:${referenceRecoveryIdentity}:${S.originalRequestId}`);
export const referenceReplacementIdentity = digest(`${referenceRecoveryId}:replacement-v1`);
export const referenceRecoveryPath = `production/fal/reference-recoveries/${referenceRecoveryId}.json`;
export const referenceChoicePath = `production/fal/reference-choices/${referenceRecoveryIdentity}.json`;
export const referenceGrantPath = `production/operator-canaries/${S.ownerHash}/${S.id}/grant.json`;
export const referenceJobPath = `production/jobs/${S.ownerHash}/${S.id}.json`;
// One previously generated portrait, independently audited on 2026-11-05.
// Its former film's failed visual verdict is not a verdict on this new film.
export const REFERENCE_REUSE = Object.freeze({
  sourceProductionId: 'f7d53722-1e84-bb97-9948-2deb3741c07a',
  sourceManifestHash: '242696e7d84c765468f5e33717b32480326da65488f0d7ff8573b2938ad70358',
  sourceIdentity: '11b980e6144bdff5352a8b0a91005b5f140483410dd208c38b07e7a9b1022181',
  sourceRequestId: '01a1ad45-4fcd-7483-aa6c-03596e2f039d',
  inputHash: '13b865e66a71833f45f2ec909e134db18727f9755e0519667af6545d5a435916',
  sourceReceiptHash: '5335a73632871c2c60a8fcd825e7d2e9404d98c813832fc56eba81c05847dc50',
  normalizedImageHash: 'af365675820ba0d9624432125939a9523332c26465db38402c2854e9a892534d',
  auditedSourceJobHash: '79be6b063bd75f5f516df5f9f4db5a1bfbf99a90caf70faf9b9b1a141c5c4a5e',
  failedReplacementRequestId: '01a1ad9a-db17-71f1-8426-f77b261e1852',
});
const R = REFERENCE_REUSE;
export const referenceReuseId = digest(`existing-reference-reuse-v1:${referenceRecoveryIdentity}:${R.sourceIdentity}:${R.sourceRequestId}`);
export const referenceReusePath = `production/fal/reference-reuses/${referenceReuseId}.json`;
export const referenceReuseSourceJobPath = `production/jobs/${S.ownerHash}/${R.sourceProductionId}.json`;
export function requireReferenceRecovery(value) {
  if (!value) throw Object.assign(new Error('The exact reference recovery needs verification.'), { code: 'REFERENCE_RECOVERY_UNVERIFIED' });
}
const requireValue = requireReferenceRecovery;
export function verifyReferenceRecoveryGrant(grant, at) {
  const approved = Date.parse(grant?.approvedAt), expiry = Date.parse(grant?.expiresAt);
  const cost = Math.ceil((16 * grant?.videoMicroUsdPerSecond + 7 * grant?.referenceMicroUsd) / 10000);
  requireValue(grant?.version === 1 && grant.kind === 'fictional-kling-quality-canary-v1'
    && grant.runKey === S.runKey && grant.characterBindingVersion === 3 && grant.ownerHash === S.ownerHash
    && grant.preparedId === S.id && grant.manifestHash === S.manifestHash && grant.recipe === S.recipe
    && grant.maximumCostCents === 450 && grant.maximumVideoRequests === 3 && grant.maximumReferenceRequests === 7
    && Number.isSafeInteger(grant.videoMicroUsdPerSecond) && grant.videoMicroUsdPerSecond > 0 && grant.videoMicroUsdPerSecond <= 150000
    && Number.isSafeInteger(grant.referenceMicroUsd) && grant.referenceMicroUsd > 0 && grant.referenceMicroUsd <= 300000
    && cost <= 450 && grant.quotedCostCents === cost && grant.funding === 'existing-merchant-provider-credit'
    && grant.fictionalOnly === true && grant.quoteReference === digest(`${S.recipe}:kling:${S.manifestHash}:${grant.videoMicroUsdPerSecond}:${grant.referenceMicroUsd}`)
    && Number.isFinite(at) && approved <= at && expiry > at && expiry <= approved + 86400000);
  return grant;
}
export function verifyReferenceRecoveryJob(job) {
  requireValue(job?.id === S.id && job.ownerHash === S.ownerHash && job.mode === 'operator-test'
    && job.manifestHash === S.manifestHash && referenceRecoveryHash(job.manifest) === S.manifestHash
    && job.manifest.productionPlan?.characterBindingVersion === 3 && job.shots?.length === 3
    && job.shots.every((shot, index) => shot.id === job.manifest.shots[index].id
      && shot.requestKey === digest(`${S.id}:${S.manifestHash}:${shot.id}`))
    && job.provider?.id === 'fal' && job.provider.model === 'kling' && job.provider.recipe === S.recipe);
  return job;
}
export function verifyReferenceRecoveryEvidence(input, at) {
  requireValue(['verified-zero-charge', 'separate-30-cent-approval'].includes(input.budgetMode));
  const zero = input.budgetMode === 'verified-zero-charge';
  const a = zero ? input.replacementApproval : input.additionalApproval;
  requireValue(a?.version === 1 && a.kind === (zero ? 'zero-charge-reference-replacement-approval' : 'additional-reference-approval')
    && a.email === S.email && a.preparedId === S.id && a.manifestHash === S.manifestHash
    && a.originalRequestId === S.originalRequestId && a.maximumReplacementRequests === 1
    && a.maximumPhysicalReferenceAttempts === 8 && a.maximumAdditionalCostCents === (zero ? 0 : 30)
    && a.maximumTotalCostCents === (zero ? 450 : 480) && HASH.test(a.evidenceSha256 || '')
    && Date.parse(a.approvedAt) <= at && Date.parse(a.expiresAt) > at
    && Date.parse(a.expiresAt) <= Date.parse(a.approvedAt) + 86400000);
  if (input.budgetMode === 'verified-zero-charge') {
    const e = input.billingEvidence;
    requireValue(!input.additionalApproval && e?.version === 1 && e.kind === 'fal-request-zero-charge'
      && e.requestId === S.originalRequestId && e.endpoint === FAL_MODELS.reference
      && e.amountCents === 0 && e.quantity === 0 && ['fal-billing-export', 'fal-support-confirmation'].includes(e.source)
      && HASH.test(e.sourceSha256 || '') && Date.parse(e.observedAt) <= at && at - Date.parse(e.observedAt) <= 86400000);
    return 450;
  }
  requireValue(!input.billingEvidence && !input.replacementApproval);
  return 480;
}
export function verifyReferenceRecoveryRejection(e, at) {
  requireValue(e?.version === 1 && e.requestId === S.originalRequestId && e.status === 'COMPLETED'
    && e.httpStatus === 403 && e.detail === 'User is locked. Reason: TOP_UP.'
    && HASH.test(e.statusSha256 || '') && HASH.test(e.resultSha256 || '')
    && Date.parse(e.observedAt) <= at && at - Date.parse(e.observedAt) <= 60000);
}
export function verifyReferenceRecoveryClaim(claim, { original, grant }) {
  const at = Date.parse(claim?.createdAt);
  verifyReferenceRecoveryGrant(grant, at);
  const ceiling = verifyReferenceRecoveryEvidence(claim, at);
  verifyReferenceRecoveryRejection(claim.rejection, at);
  requireValue(claim.version === 1 && claim.kind === 'funded-reference-recovery-v1'
    && claim.recoveryId === referenceRecoveryId && claim.ownerHash === S.ownerHash && claim.approvedBy === S.email
    && claim.productionId === S.id && claim.manifestHash === S.manifestHash && claim.originalIdentity === referenceRecoveryIdentity
    && claim.originalRequestId === S.originalRequestId && claim.replacementIdentity === referenceReplacementIdentity
    && claim.endpoint === FAL_MODELS.reference && HASH.test(claim.inputHash || '')
    && claim.originalReceiptHash === referenceRecoveryHash(original) && claim.grantHash === referenceRecoveryHash(grant)
    && original?.identity === referenceRecoveryIdentity && original.requestId === S.originalRequestId
    && original.endpoint === FAL_MODELS.reference && original.inputHash === claim.inputHash && !original.result
    && claim.maximumReplacementCostCents === 30 && claim.maximumTotalCostCents === ceiling
    && claim.maximumPhysicalReferenceAttempts === 8 && claim.maximumVideoRequests === 3);
  return claim;
}

export function verifyReferenceReuseApproval(approval, grant, at) {
  requireValue(approval?.version === 1 && approval.kind === 'existing-reference-reuse-approval'
    && approval.email === S.email && approval.productionId === S.id && approval.manifestHash === S.manifestHash
    && approval.sourceRequestId === R.sourceRequestId && approval.maximumAdditionalCostCents === 0
    && approval.maximumNewPortraitRequests === 0 && approval.maximumTotalCostCents === 480
    && HASH.test(approval.evidenceSha256 || '') && Number.isFinite(at)
    && Date.parse(approval.approvedAt) <= at && Date.parse(approval.approvedAt) >= Date.parse(grant?.approvedAt)
    && Date.parse(approval.expiresAt) > at && Date.parse(approval.expiresAt) <= Date.parse(grant?.expiresAt));
}
export function verifyReferenceReuseRejection(rejection, at) {
  verifyReferenceRecoveryRejection({ ...rejection, requestId: S.originalRequestId }, at);
  requireValue(rejection?.requestId === R.failedReplacementRequestId);
}
export function verifyReferenceReuseSource(sourceJob, receipt, { sourceReceiptFingerprint = referenceRecoveryHash } = {}) {
  requireValue(sourceJob?.id === R.sourceProductionId && sourceJob.ownerHash === S.ownerHash && sourceJob.mode === 'operator-test'
    && sourceJob.manifestHash === R.sourceManifestHash && referenceRecoveryHash(sourceJob.manifest) === R.sourceManifestHash
    && sourceJob.manifest.productionPlan?.characterBindingVersion === 2
    && sourceJob.provider?.id === 'fal' && sourceJob.provider.model === 'kling' && sourceJob.provider.recipe === S.recipe
    && receipt?.identity === R.sourceIdentity && receipt.requestId === R.sourceRequestId
    && receipt.endpoint === FAL_MODELS.reference && receipt.state === 'completed' && receipt.inputHash === R.inputHash
    && receipt.result?.images?.length === 1 && sourceReceiptFingerprint(receipt) === R.sourceReceiptHash);
  falMediaUrl(receipt.result.images[0].url);
}
export function verifyReferenceReuseChild(child) {
  requireValue(child?.identity === referenceReplacementIdentity && child.requestId === R.failedReplacementRequestId
    && child.endpoint === FAL_MODELS.reference && child.inputHash === R.inputHash
    && ['queued', 'processing', 'failed'].includes(child.state) && !child.result);
}
export function verifyReferenceReuseClaim(reuse, { claim, original, grant, child, sourceJob, source, job,
  sourceReceiptFingerprint = referenceRecoveryHash }) {
  verifyReferenceRecoveryClaim(claim, { original, grant }); verifyReferenceRecoveryJob(job);
  requireValue(claim.budgetMode === 'separate-30-cent-approval' && claim.maximumTotalCostCents === 480
    && claim.inputHash === R.inputHash && job.authorization?.environment === 'production'
    && job.authorization.budgetCents === 450 && job.authorization.manifestHash === S.manifestHash
    && job.authorization.quoteReference === grant.quoteReference);
  verifyReferenceReuseChild(child); verifyReferenceReuseSource(sourceJob, source, { sourceReceiptFingerprint });
  const at = Date.parse(reuse?.createdAt);
  verifyReferenceRecoveryGrant(grant, at); verifyReferenceReuseApproval(reuse?.approval, grant, at);
  verifyReferenceReuseRejection(reuse?.rejection, at);
  const sourceAlice = sourceJob.manifest.screenplay?.characters?.find(character => character.id === S.characterId);
  const currentAlice = job.manifest.screenplay?.characters?.find(character => character.id === S.characterId);
  requireValue(sourceAlice && currentAlice && sourceAlice.referencePhotoId === undefined
    && referenceRecoveryHash(sourceAlice) === referenceRecoveryHash(currentAlice)
    && reuse.version === 1 && reuse.kind === 'existing-reference-reuse-v1' && reuse.reuseId === referenceReuseId
    && reuse.ownerHash === S.ownerHash && reuse.productionId === S.id && reuse.manifestHash === S.manifestHash
    && reuse.originalIdentity === referenceRecoveryIdentity && reuse.recoveryClaimHash === referenceRecoveryHash(claim)
    && reuse.originalReceiptHash === referenceRecoveryHash(original) && reuse.grantHash === referenceRecoveryHash(grant)
    && reuse.failedReplacementIdentity === referenceReplacementIdentity && reuse.failedReplacementRequestId === R.failedReplacementRequestId
    && reuse.failedReplacementReceiptHash === referenceRecoveryHash(child)
    && reuse.sourceProductionId === R.sourceProductionId && reuse.sourceManifestHash === R.sourceManifestHash
    && reuse.sourceIdentity === R.sourceIdentity && reuse.sourceRequestId === R.sourceRequestId
    && reuse.sourceReceiptHash === R.sourceReceiptHash && reuse.sourceResultHash === referenceRecoveryHash(source.result)
    && reuse.auditedSourceJobHash === R.auditedSourceJobHash && reuse.inputHash === R.inputHash
    && reuse.validatedImageHash === R.normalizedImageHash && reuse.maximumAdditionalCostCents === 0
    && reuse.maximumNewPortraitRequests === 0 && reuse.maximumTotalCostCents === 480
    && reuse.maximumPhysicalReferenceAttempts === 8 && reuse.maximumVideoRequests === 3);
  return reuse;
}

// Return the actual child identity. Callers explicitly select it; get(original)
// and every historical receipt remain truthful. Valid completed choices remain
// readable after approval expiry and after downstream work has started.
export async function resolveReferenceChoice({ productionId, manifestHash, identity, ownerHash }, {
  read = readRecord, sourceReceiptFingerprint = referenceRecoveryHash,
} = {}) {
  if (identity !== referenceRecoveryIdentity) return null;
  const choice = (await read(referenceChoicePath))?.value;
  if (!choice) return null;
  requireValue(productionId === S.id && manifestHash === S.manifestHash && ownerHash === S.ownerHash);
  const [claimRecord, originalRecord, grantRecord, jobRecord, childRecord] = await Promise.all([
    read(referenceRecoveryPath), read(falRequestPath(identity)), read(referenceGrantPath), read(referenceJobPath),
    read(falRequestPath(referenceReplacementIdentity)),
  ]);
  verifyReferenceRecoveryJob(jobRecord?.value);
  const claim = verifyReferenceRecoveryClaim(claimRecord?.value, { original: originalRecord?.value, grant: grantRecord?.value });
  if (choice.kind === 'existing-reference-choice-v1') {
    const [reuseRecord, sourceJobRecord, sourceRecord, ownerRecord] = await Promise.all([
      read(referenceReusePath), read(referenceReuseSourceJobPath), read(falRequestPath(R.sourceIdentity)), read(userPath(S.email)),
    ]);
    requireValue(isOwner(ownerRecord?.value) && ownerRecord.value.email === S.email && !ownerRecord.value.mustChangePassword);
    const receipt = sourceRecord?.value;
    const reuse = verifyReferenceReuseClaim(reuseRecord?.value, { claim, original: originalRecord?.value, grant: grantRecord?.value,
      child: childRecord?.value, sourceJob: sourceJobRecord?.value, source: receipt, job: jobRecord.value, sourceReceiptFingerprint });
    requireValue(choice.version === 1 && choice.reuseId === referenceReuseId && choice.recoveryId === referenceRecoveryId
      && choice.ownerHash === S.ownerHash && choice.productionId === S.id && choice.manifestHash === S.manifestHash
      && choice.originalIdentity === identity && choice.replacementIdentity === R.sourceIdentity
      && choice.reuseClaimHash === referenceRecoveryHash(reuse) && choice.claimHash === referenceRecoveryHash(claim)
      && choice.requestId === R.sourceRequestId && choice.sourceReceiptHash === R.sourceReceiptHash
      && choice.resultHash === referenceRecoveryHash(receipt.result) && choice.validatedImageHash === R.normalizedImageHash);
    return { receipt, proof: { recoveryId: referenceRecoveryId, originalIdentity: identity,
      replacementIdentity: receipt.identity, choiceHash: referenceRecoveryHash(choice), resultHash: choice.resultHash,
      reuseId: referenceReuseId, sourceProductionId: R.sourceProductionId, sourceManifestHash: R.sourceManifestHash,
      sourceReceiptHash: R.sourceReceiptHash, reuseClaimHash: choice.reuseClaimHash, validatedImageHash: R.normalizedImageHash } };
  }
  const receipt = childRecord?.value;
  requireValue(choice.version === 1 && choice.kind === 'funded-reference-choice-v1'
    && choice.recoveryId === referenceRecoveryId && choice.originalIdentity === identity
    && choice.replacementIdentity === referenceReplacementIdentity && choice.productionId === S.id
    && choice.manifestHash === S.manifestHash && choice.claimHash === referenceRecoveryHash(claim)
    && receipt?.identity === referenceReplacementIdentity && receipt.endpoint === FAL_MODELS.reference
    && receipt.inputHash === claim.inputHash && receipt.state === 'completed' && receipt.result?.images?.length === 1
    && choice.requestId === receipt.requestId && /^[a-zA-Z0-9_-]{8,100}$/.test(receipt.requestId || '')
    && receipt.requestId !== S.originalRequestId && receipt.requestId !== S.adaRequestId
    && choice.resultHash === referenceRecoveryHash(receipt.result) && HASH.test(choice.validatedImageHash || ''));
  falMediaUrl(receipt.result.images[0].url);
  return { receipt, proof: { recoveryId: referenceRecoveryId, originalIdentity: identity,
    replacementIdentity: receipt.identity, choiceHash: referenceRecoveryHash(choice), resultHash: choice.resultHash } };
}
