type RecordValue = Record<string, unknown>;
export type NarrationSuccessorPlan = {
  parentCorrectionId: string; preparedId: string; manifestHash: string; shotId: string; narration: string;
  failedOperationIdentity: string; failedRequestId: string; failedRecordHash: string;
  billingEvidence: RecordValue; maximumNewCostCents: number; reason: string; confirmed: false;
};
const keys = ['parentCorrectionId', 'preparedId', 'manifestHash', 'shotId', 'narration', 'failedOperationIdentity',
  'failedRequestId', 'failedRecordHash', 'billingEvidence', 'maximumNewCostCents', 'reason', 'confirmed'];
const billingKeys = ['version', 'kind', 'basis', 'account', 'operationIdentity', 'requestId', 'recordHash',
  'costNanoUsd', 'quantity', 'evidenceSha256', 'observedAt', 'approvedBy'];
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: RecordValue, fields: string[]) => Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('Choose the reviewed narration recovery plan with its exact film, failed request and billing references.');
export const NARRATION_PLAN_MAX_BYTES = 30 * 1024;

export function parseNarrationSuccessorPlan(text: string): NarrationSuccessorPlan {
  if (new TextEncoder().encode(text).length > NARRATION_PLAN_MAX_BYTES) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  const value = record(parsed) && 'request' in parsed ? parsed.request : parsed;
  if (!record(value) || !exact(value, keys) || !hash(value.parentCorrectionId) || !hash(value.manifestHash)
    || !hash(value.failedOperationIdentity) || !hash(value.failedRecordHash)
    || typeof value.preparedId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.preparedId)
    || typeof value.shotId !== 'string' || !/^shot-\d{3}$/.test(value.shotId)
    || typeof value.narration !== 'string' || !value.narration.trim() || value.narration.length > 2000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.narration)
    || typeof value.failedRequestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.failedRequestId)
    || typeof value.reason !== 'string' || value.reason.trim().length < 10 || value.reason.length > 500 || /[<>\x00-\x1f\x7f]/.test(value.reason)
    || !Number.isSafeInteger(value.maximumNewCostCents) || Number(value.maximumNewCostCents) < 1 || Number(value.maximumNewCostCents) > 1980
    || value.confirmed !== false || !record(value.billingEvidence) || !exact(value.billingEvidence, billingKeys)) throw invalid();
  const billing = value.billingEvidence;
  if (billing.version !== 1 || billing.kind !== 'owner-reviewed-request-zero-charge-v1'
    || billing.basis !== 'provider-request-billing-row' || billing.costNanoUsd !== 0 || billing.quantity !== 0
    || billing.operationIdentity !== value.failedOperationIdentity || billing.requestId !== value.failedRequestId
    || billing.recordHash !== value.failedRecordHash || !hash(billing.evidenceSha256)
    || typeof billing.account !== 'string' || !/^[\w.-]{1,100}$/.test(billing.account)
    || typeof billing.observedAt !== 'string' || !Number.isFinite(Date.parse(billing.observedAt))
    || typeof billing.approvedBy !== 'string' || !billing.approvedBy.includes('@')) throw invalid();
  return structuredClone(value) as NarrationSuccessorPlan;
}
export function narrationSuccessorRequest(plan: NarrationSuccessorPlan, confirmed: boolean) {
  if (confirmed !== true) throw new Error('Confirm this narration revision and its production allowance.');
  return { ...parseNarrationSuccessorPlan(JSON.stringify(plan)), action: 'createNarrationSuccessorCorrection' as const, confirmed: true as const };
}
export type NarrationSuccessorResult = {
  correctionId: string; parentCorrectionId: string; originalOrderId: string; preparedId: string; manifestHash: string;
  maximumCostCents: number; maximumNewCostCents: number; status: 'authorized'; customerChargeCents: 0;
};
export function verifyNarrationSuccessor(value: unknown, expected: ReturnType<typeof narrationSuccessorRequest>): NarrationSuccessorResult {
  const correction = record(value) && record(value.correction) ? value.correction : null;
  if (!correction || !hash(correction.correctionId) || correction.correctionId === expected.parentCorrectionId || !hash(correction.originalOrderId)
    || correction.status !== 'authorized' || correction.customerChargeCents !== 0
    || !Number.isSafeInteger(correction.maximumCostCents) || Number(correction.maximumCostCents) < expected.maximumNewCostCents
    || (['parentCorrectionId', 'preparedId', 'manifestHash', 'maximumNewCostCents'] as const)
      .some(key => correction[key] !== expected[key])) throw new Error('The revised film could not be verified. Check its status before reconciling this same request.');
  return correction as NarrationSuccessorResult;
}
