import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile(new URL('../src/admin/partial-production-correction.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { parsePartialCorrectionPlan, partialCorrectionRequest, verifyPartialCorrection, PARTIAL_PLAN_MAX_BYTES } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const plan = () => ({ originalOrderId: 'a'.repeat(64), preparedId: '11111111-2222-4333-8444-555555555555',
  manifestHash: 'b'.repeat(64), shotId: 'shot-002', visual: 'An adult walks through a quiet office corridor.',
  maximumNewCostCents: 720, reason: 'Owner approved an illustrative scene revision.', confirmed: false,
  reuseEvidence: [1, 3, 4].map(id => ({ shotId: `shot-00${id}`, operationIdentity: 'd'.repeat(64), requestId: `fictional-${id}`,
    inputHash: 'e'.repeat(64), sourceRecordHash: 'f'.repeat(64), mediaSha256: 'a'.repeat(64), sizeBytes: 128 })),
  billingEvidence: { version: 1, kind: 'owner-reviewed-provider-billing-v1', account: 'offline-only',
    originalOrderId: 'a'.repeat(64), sourceManifestHash: 'b'.repeat(64), observedAt: '2026-11-24T12:00:00Z',
    approvedBy: 'owner@example.invalid', completeAttemptHistory: true, evidenceSha256: 'c'.repeat(64),
    attempts: [1, 2, 3, 4].map(id => ({ operationIdentity: 'd'.repeat(64), requestId: `fictional-${id}`, recordHash: 'e'.repeat(64), costNanoUsd: 0 })) } });

test('import does not authorize spending and does not forward unrelated wrapper data', () => {
  const imported = parsePartialCorrectionPlan(JSON.stringify({ request: plan(), privateNotes: 'Local review only' }));
  assert.deepEqual(imported, plan());
  assert.equal(imported.confirmed, false);
  assert.throws(() => partialCorrectionRequest(imported, false));
  const request = partialCorrectionRequest(imported, true);
  assert.equal(request.action, 'createPartialProductionCorrection');
  assert.equal(request.confirmed, true);
  assert.equal(request.privateNotes, undefined);
  imported.reuseEvidence[0].shotId = 'changed';
  assert.equal(request.reuseEvidence[0].shotId, 'shot-001');
});

test('a file cannot preconfirm recovery, alter the action or introduce an unbounded request', () => {
  for (const change of [
    { confirmed: true }, { action: 'createProductionCorrection' }, { maximumNewCostCents: 0 },
    { maximumNewCostCents: 1981 }, { maximumNewCostCents: 1.5 }, { maximumNewCostCents: '720' },
    { originalOrderId: 'wrong' }, { manifestHash: 'wrong' }, { preparedId: 'wrong' },
    { reuseEvidence: [] }, { billingEvidence: null }, { visual: '' }, { reason: '' },
  ]) assert.throws(() => parsePartialCorrectionPlan(JSON.stringify({ ...plan(), ...change })));
  assert.throws(() => parsePartialCorrectionPlan(' '.repeat(PARTIAL_PLAN_MAX_BYTES + 1)));
  assert.throws(() => parsePartialCorrectionPlan('{"secret":"not a recovery plan"}'));
  const extra = plan(); extra.billingEvidence.rawPrivateFile = 'Unrelated local data';
  assert.throws(() => parsePartialCorrectionPlan(JSON.stringify(extra)));
});

test('an uncertain response cannot be displayed as a different successful correction', () => {
  const request = partialCorrectionRequest(plan(), true);
  const correction = { correctionId: 'c'.repeat(64), originalOrderId: request.originalOrderId,
    preparedId: request.preparedId, manifestHash: request.manifestHash, maximumCostCents: 2400,
    maximumNewCostCents: request.maximumNewCostCents, status: 'authorized', customerChargeCents: 0 };
  assert.deepEqual(verifyPartialCorrection({ correction }, request), correction);
  for (const change of [{ preparedId: 'different' }, { originalOrderId: 'd'.repeat(64) },
    { manifestHash: 'e'.repeat(64) }, { maximumNewCostCents: 721 }, { maximumCostCents: 1 },
    { customerChargeCents: 1 }, { status: 'completed' }, { correctionId: 'wrong' }])
    assert.throws(() => verifyPartialCorrection({ correction: { ...correction, ...change } }, request));
  assert.throws(() => verifyPartialCorrection({}, request));
});
