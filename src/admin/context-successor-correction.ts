type RecordValue = Record<string, unknown>;
export type ContextSuccessorPlan = {
  parentCorrectionId: string; preparedId: string; manifestHash: string; shotId: string;
  filmContext: string; historicalBoundaries: string;
  failedOperationIdentity: string; failedRequestId: string; failedRecordHash: string;
  billingEvidence: RecordValue; maximumNewCostCents: number; reason: string; confirmed: false;
};
const keys = ['parentCorrectionId', 'preparedId', 'manifestHash', 'shotId', 'filmContext', 'historicalBoundaries',
  'failedOperationIdentity', 'failedRequestId', 'failedRecordHash', 'billingEvidence', 'maximumNewCostCents', 'reason', 'confirmed'];
const billingKeys = ['version', 'kind', 'basis', 'account', 'operationIdentity', 'requestId', 'recordHash',
  'costNanoUsd', 'quantity', 'evidenceSha256', 'observedAt', 'approvedBy'];
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: RecordValue, fields: string[]) => Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instruction = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  && value.length <= 2000 && !/[<>\x00-\x1f\x7f]/.test(value);
const invalid = () => new Error('Choose the reviewed scene instruction recovery plan with its exact film, failed request and billing references.');
export const CONTEXT_PLAN_MAX_BYTES = 30 * 1024;

export function parseContextSuccessorPlan(text: string): ContextSuccessorPlan {
  if (new TextEncoder().encode(text).length > CONTEXT_PLAN_MAX_BYTES) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  const value = record(parsed) && 'request' in parsed ? parsed.request : parsed;
  if (!record(value) || !exact(value, keys) || !hash(value.parentCorrectionId) || !hash(value.manifestHash)
    || !hash(value.failedOperationIdentity) || !hash(value.failedRecordHash)
    || typeof value.preparedId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.preparedId)
    || typeof value.shotId !== 'string' || !/^shot-\d{3}$/.test(value.shotId)
    || !instruction(value.filmContext) || !instruction(value.historicalBoundaries)
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
  return structuredClone(value) as ContextSuccessorPlan;
}
export function contextSuccessorRequest(plan: ContextSuccessorPlan, confirmed: boolean) {
  if (confirmed !== true) throw new Error('Confirm these scene instructions and their production allowance.');
  return { ...parseContextSuccessorPlan(JSON.stringify(plan)), action: 'createContextSuccessorCorrection' as const, confirmed: true as const };
}
export type ContextSuccessorResult = {
  correctionId: string; parentCorrectionId: string; originalOrderId: string; preparedId: string; manifestHash: string;
  maximumCostCents: number; maximumNewCostCents: number; status: 'authorized'; customerChargeCents: 0;
};
export function verifyContextSuccessor(value: unknown, expected: ReturnType<typeof contextSuccessorRequest>): ContextSuccessorResult {
  const correction = record(value) && record(value.correction) ? value.correction : null;
  if (!correction || !hash(correction.correctionId) || correction.correctionId === expected.parentCorrectionId || !hash(correction.originalOrderId)
    || correction.status !== 'authorized' || correction.customerChargeCents !== 0
    || !Number.isSafeInteger(correction.maximumCostCents) || Number(correction.maximumCostCents) < expected.maximumNewCostCents
    || (['parentCorrectionId', 'preparedId', 'manifestHash', 'maximumNewCostCents'] as const)
      .some(key => correction[key] !== expected[key])) throw new Error('The corrected film could not be verified. Check its status before reconciling this same request.');
  return correction as ContextSuccessorResult;
}
