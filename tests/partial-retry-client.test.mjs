import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile(new URL('../src/admin/partial-production-retry.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { parsePartialRetryPlan, partialRetryRequest, verifyPartialRetry, PARTIAL_RETRY_MAX_BYTES } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const plan = () => ({ correctionId: 'a'.repeat(64), preparedId: '11111111-2222-4333-8444-555555555555',
  manifestHash: 'b'.repeat(64), shotId: 'shot-002', failedOperationIdentity: 'c'.repeat(64),
  failedRequestId: 'fictional-service-failure', failedRecordHash: 'd'.repeat(64), maximumNewCostCents: 720,
  reason: 'Retry the same fictional garden scene after a confirmed service failure.', confirmed: false,
  billingEvidence: { version: 1, kind: 'owner-reviewed-zero-charge-v1', account: 'offline-only',
    operationIdentity: 'c'.repeat(64), requestId: 'fictional-service-failure', recordHash: 'd'.repeat(64), costNanoUsd: 0,
    evidenceSha256: 'e'.repeat(64), observedAt: '2026-11-24T12:00:00Z', approvedBy: 'owner@example.invalid',
    basis: 'provider-terminal500-nonbilling-policy', policyUrl: 'https://fal.ai/docs/documentation/model-apis/pricing' } });

test('reviewed retry file cannot authorize production or forward unrelated private notes', () => {
  const imported = parsePartialRetryPlan(JSON.stringify({ request: plan(), privateNotes: 'Do not transmit.' }));
  assert.deepEqual(imported, plan());
  assert.throws(() => partialRetryRequest(imported, false));
  const request = partialRetryRequest(imported, true);
  assert.equal(request.action, 'retryPartialProductionCorrection');
  assert.equal(request.confirmed, true);
  assert.equal(request.privateNotes, undefined);
  imported.billingEvidence.costNanoUsd = 100;
  assert.equal(request.billingEvidence.costNanoUsd, 0);
});

test('retry import rejects preconfirmation, broader spending and mismatched zero-charge evidence', () => {
  for (const change of [{ confirmed: true }, { action: 'createProductionCorrection' }, { maximumNewCostCents: 0 },
    { maximumNewCostCents: 1981 }, { maximumNewCostCents: '720' }, { maximumNewCostCents: 1.5 },
    { correctionId: 'wrong' }, { preparedId: 'wrong' }, { manifestHash: 'wrong' }, { failedRecordHash: 'wrong' },
    { shotId: '' }, { failedRequestId: 'contains space' }, { reason: '' }, { visual: 'Unapproved revision' }])
    assert.throws(() => parsePartialRetryPlan(JSON.stringify({ ...plan(), ...change })));
  for (const change of [{ costNanoUsd: 1 }, { requestId: 'another-request' }, { operationIdentity: 'f'.repeat(64) },
    { recordHash: 'f'.repeat(64) }, { evidenceSha256: 'wrong' }, { observedAt: 'not-a-date' },
    { basis: 'wallet-balance' }, { policyUrl: 'https://example.invalid' }, { rawExport: 'private bytes' }]) {
    const value = plan(); Object.assign(value.billingEvidence, change);
    assert.throws(() => parsePartialRetryPlan(JSON.stringify(value)));
  }
  assert.throws(() => parsePartialRetryPlan(' '.repeat(PARTIAL_RETRY_MAX_BYTES + 1)));
});

test('uncertain or mismatched retry result cannot appear as authorization for another scene or cost', () => {
  const request = partialRetryRequest(plan(), true);
  const retry = { id: 'f'.repeat(64), status: 'authorized', correctionId: request.correctionId,
    preparedId: request.preparedId, manifestHash: request.manifestHash, shotId: request.shotId,
    failedRequestId: request.failedRequestId, maximumNewCostCents: request.maximumNewCostCents, customerChargeCents: 0 };
  assert.deepEqual(verifyPartialRetry({ retry }, request), retry);
  for (const change of [{ id: 'wrong' }, { status: 'completed' }, { preparedId: 'another' },
    { correctionId: 'e'.repeat(64) }, { manifestHash: 'e'.repeat(64) }, { shotId: 'shot-003' },
    { failedRequestId: 'another-request' }, { maximumNewCostCents: 721 }, { customerChargeCents: 1 }])
    assert.throws(() => verifyPartialRetry({ retry: { ...retry, ...change } }, request));
  assert.throws(() => verifyPartialRetry({}, request));
});
