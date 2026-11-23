type RecordValue = Record<string, unknown>;
export type PartialCorrectionPlan = {
  originalOrderId: string; preparedId: string; manifestHash: string; shotId: string; visual: string;
  maximumNewCostCents: number; reason: string; confirmed: false;
  reuseEvidence: RecordValue[]; billingEvidence: RecordValue;
};
const keys = ['originalOrderId', 'preparedId', 'manifestHash', 'shotId', 'visual', 'maximumNewCostCents',
  'reason', 'confirmed', 'reuseEvidence', 'billingEvidence'];
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: RecordValue, fields: string[]) => Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const reuseKeys = ['shotId', 'operationIdentity', 'requestId', 'inputHash', 'sourceRecordHash', 'mediaSha256', 'sizeBytes'];
const billingKeys = ['version', 'kind', 'account', 'originalOrderId', 'sourceManifestHash', 'observedAt', 'approvedBy',
  'completeAttemptHistory', 'evidenceSha256', 'attempts'];
const invalid = () => new Error('Choose the reviewed scene recovery plan. The file must contain its exact references, clip evidence and billing review.');
export const PARTIAL_PLAN_MAX_BYTES = 30 * 1024;

// Import is local review only. In particular, a file cannot supply confirmation
// or make the client send unrelated fields to the administrator endpoint.
export function parsePartialCorrectionPlan(text: string): PartialCorrectionPlan {
  if (new TextEncoder().encode(text).length > PARTIAL_PLAN_MAX_BYTES) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  const value = record(parsed) && 'request' in parsed ? parsed.request : parsed;
  if (!record(value) || !exact(value, keys)
    || typeof value.originalOrderId !== 'string' || !/^[a-f0-9]{64}$/.test(value.originalOrderId)
    || typeof value.preparedId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.preparedId)
    || typeof value.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestHash)
    || typeof value.shotId !== 'string' || !/^shot-\d{3}$/.test(value.shotId)
    || typeof value.visual !== 'string' || !value.visual.trim() || value.visual.length > 10_000
    || typeof value.reason !== 'string' || value.reason.trim().length < 10 || value.reason.length > 500
    || !Number.isSafeInteger(value.maximumNewCostCents) || Number(value.maximumNewCostCents) < 1 || Number(value.maximumNewCostCents) > 1980
    || value.confirmed !== false || !Array.isArray(value.reuseEvidence) || value.reuseEvidence.length !== 3
    || !value.reuseEvidence.every(row => record(row) && exact(row, reuseKeys))
    || !record(value.billingEvidence) || !exact(value.billingEvidence, billingKeys)
    || !Array.isArray(value.billingEvidence.attempts) || value.billingEvidence.attempts.length < 4 || value.billingEvidence.attempts.length > 20
    || !value.billingEvidence.attempts.every(row => record(row) && exact(row, ['operationIdentity', 'requestId', 'recordHash', 'costNanoUsd']))) throw invalid();
  return structuredClone(value) as PartialCorrectionPlan;
}

export function partialCorrectionRequest(plan: PartialCorrectionPlan, confirmed: boolean) {
  if (confirmed !== true) throw new Error('Review and confirm this scene revision and its production limit.');
  const reviewed = parsePartialCorrectionPlan(JSON.stringify(plan));
  return { ...reviewed, action: 'createPartialProductionCorrection' as const, confirmed: true as const };
}
export type PartialCorrectionResult = {
  correctionId: string; originalOrderId: string; preparedId: string; manifestHash: string;
  maximumCostCents: number; maximumNewCostCents: number; status: 'authorized'; customerChargeCents: 0;
};
export function verifyPartialCorrection(value: unknown, expected: ReturnType<typeof partialCorrectionRequest>): PartialCorrectionResult {
  const result = record(value) && record(value.correction) ? value.correction : null;
  if (!result || typeof result.correctionId !== 'string' || !/^[a-f0-9]{64}$/.test(result.correctionId)
    || result.status !== 'authorized' || result.customerChargeCents !== 0
    || !Number.isSafeInteger(result.maximumCostCents) || Number(result.maximumCostCents) < expected.maximumNewCostCents
    || (['originalOrderId', 'preparedId', 'manifestHash', 'maximumNewCostCents'] as const).some(key => result[key] !== expected[key]))
    throw new Error('The recovery result could not be verified. Check this corrected film before retrying the same request.');
  return result as PartialCorrectionResult;
}
