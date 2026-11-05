import { digest, readRecord } from './auth.mjs';
import { OWNER_EMAIL } from './access.mjs';
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

// Return the actual child identity. Callers explicitly select it; get(original)
// and every historical receipt remain truthful. Valid completed choices remain
// readable after approval expiry and after downstream work has started.
export async function resolveReferenceChoice({ productionId, manifestHash, identity, ownerHash }, { read = readRecord } = {}) {
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
