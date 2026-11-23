type RecordValue = Record<string, unknown>;
export type PartialRetryPlan = {
  correctionId: string; preparedId: string; manifestHash: string; shotId: string;
  failedOperationIdentity: string; failedRequestId: string; failedRecordHash: string;
  billingEvidence: RecordValue; maximumNewCostCents: number; reason: string; confirmed: false;
};
const keys = ['correctionId', 'preparedId', 'manifestHash', 'shotId', 'failedOperationIdentity',
  'failedRequestId', 'failedRecordHash', 'billingEvidence', 'maximumNewCostCents', 'reason', 'confirmed'];
const evidenceKeys = ['version', 'kind', 'account', 'operationIdentity', 'requestId', 'recordHash',
  'costNanoUsd', 'evidenceSha256', 'observedAt', 'approvedBy', 'basis', 'policyUrl'];
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: RecordValue, fields: string[]) => Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('Choose the reviewed retry plan for this exact failed scene and its production limit.');
export const PARTIAL_RETRY_MAX_BYTES = 30 * 1024;

export function parsePartialRetryPlan(text: string): PartialRetryPlan {
  if (new TextEncoder().encode(text).length > PARTIAL_RETRY_MAX_BYTES) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  const value = record(parsed) && 'request' in parsed ? parsed.request : parsed;
  if (!record(value) || !exact(value, keys) || !hash(value.correctionId) || !hash(value.manifestHash)
    || !hash(value.failedOperationIdentity) || !hash(value.failedRecordHash)
    || typeof value.preparedId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.preparedId)
    || typeof value.shotId !== 'string' || !/^shot-\d{3}$/.test(value.shotId)
    || typeof value.failedRequestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.failedRequestId)
    || typeof value.reason !== 'string' || value.reason.trim().length < 10 || value.reason.length > 500
    || !Number.isSafeInteger(value.maximumNewCostCents) || Number(value.maximumNewCostCents) < 1 || Number(value.maximumNewCostCents) > 1980
    || value.confirmed !== false || !record(value.billingEvidence) || !exact(value.billingEvidence, evidenceKeys)) throw invalid();
  const evidence = value.billingEvidence;
  if (evidence.version !== 1 || evidence.kind !== 'owner-reviewed-zero-charge-v1' || evidence.costNanoUsd !== 0
    || evidence.operationIdentity !== value.failedOperationIdentity || evidence.requestId !== value.failedRequestId
    || evidence.recordHash !== value.failedRecordHash || !hash(evidence.evidenceSha256)
    || typeof evidence.account !== 'string' || !/^[\w.-]{1,100}$/.test(evidence.account)
    || typeof evidence.observedAt !== 'string' || !Number.isFinite(Date.parse(evidence.observedAt))
    || typeof evidence.approvedBy !== 'string' || !evidence.approvedBy.includes('@')
    || evidence.basis !== 'provider-terminal500-nonbilling-policy'
    || evidence.policyUrl !== 'https://fal.ai/docs/documentation/model-apis/pricing') throw invalid();
  return structuredClone(value) as PartialRetryPlan;
}

export function partialRetryRequest(plan: PartialRetryPlan, confirmed: boolean) {
  if (confirmed !== true) throw new Error('Confirm one retry of this unchanged scene within the existing allowance.');
  return { ...parsePartialRetryPlan(JSON.stringify(plan)), action: 'retryPartialProductionCorrection' as const, confirmed: true as const };
}
export type PartialRetryResult = {
  id: string; status: 'authorized'; correctionId: string; preparedId: string; manifestHash: string;
  shotId: string; failedRequestId: string; maximumNewCostCents: number; customerChargeCents: 0;
};
export function verifyPartialRetry(value: unknown, expected: ReturnType<typeof partialRetryRequest>): PartialRetryResult {
  const retry = record(value) && record(value.retry) ? value.retry : null;
  if (!retry || !hash(retry.id) || retry.status !== 'authorized' || retry.customerChargeCents !== 0
    || (['correctionId', 'preparedId', 'manifestHash', 'shotId', 'failedRequestId', 'maximumNewCostCents'] as const)
      .some(key => retry[key] !== expected[key])) throw new Error('The retry result could not be verified. Check this film before reconciling the same request.');
  return retry as PartialRetryResult;
}
