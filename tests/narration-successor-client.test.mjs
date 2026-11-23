import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile(new URL('../src/admin/narration-successor-correction.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { parseNarrationSuccessorPlan, narrationSuccessorRequest, verifyNarrationSuccessor, NARRATION_PLAN_MAX_BYTES } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const plan = () => ({ parentCorrectionId: 'a'.repeat(64), preparedId: '11111111-2222-4333-8444-555555555555',
  manifestHash: 'b'.repeat(64), shotId: 'shot-003', narration: 'After years teaching, her work took her to nearby towns.',
  failedOperationIdentity: 'c'.repeat(64), failedRequestId: 'fictional-moderated-retry', failedRecordHash: 'd'.repeat(64),
  maximumNewCostCents: 1080, reason: 'Owner approved this fictional narration revision with the existing visuals and timing.', confirmed: false,
  billingEvidence: { version: 1, kind: 'owner-reviewed-request-zero-charge-v1', basis: 'provider-request-billing-row',
    account: 'offline-only', operationIdentity: 'c'.repeat(64), requestId: 'fictional-moderated-retry',
    recordHash: 'd'.repeat(64), costNanoUsd: 0, quantity: 0, evidenceSha256: 'e'.repeat(64),
    observedAt: '2026-11-24T12:00:00Z', approvedBy: 'owner@example.invalid' } });

test('narration import only reviews the exact plan and requires a separate explicit confirmation', () => {
  const imported = parseNarrationSuccessorPlan(JSON.stringify({ request: plan(), privateNotes: 'Do not transmit.' }));
  assert.deepEqual(imported, plan());
  assert.throws(() => narrationSuccessorRequest(imported, false));
  const request = narrationSuccessorRequest(imported, true);
  assert.equal(request.action, 'createNarrationSuccessorCorrection');
  assert.equal(request.confirmed, true);
  assert.equal(request.privateNotes, undefined);
  imported.narration = 'Different text'; imported.billingEvidence.quantity = 2;
  assert.equal(request.narration, plan().narration);
  assert.equal(request.billingEvidence.quantity, 0);
});

test('narration plan cannot preconfirm, widen scope or replace exact zero-charge request evidence', () => {
  for (const change of [{ confirmed: true }, { action: 'retryPartialProductionCorrection' }, { maximumNewCostCents: 0 },
    { maximumNewCostCents: 1981 }, { maximumNewCostCents: '1080' }, { maximumNewCostCents: 1.5 },
    { parentCorrectionId: 'wrong' }, { preparedId: 'wrong' }, { manifestHash: 'wrong' }, { failedRecordHash: 'wrong' },
    { shotId: '' }, { failedRequestId: 'contains space' }, { reason: '' }, { narration: '' }, { visual: 'Unapproved revision' },
    { replacementUrl: 'https://example.invalid/video.mp4' }])
    assert.throws(() => parseNarrationSuccessorPlan(JSON.stringify({ ...plan(), ...change })));
  for (const change of [{ costNanoUsd: 1 }, { quantity: 1 }, { requestId: 'another-request' }, { operationIdentity: 'f'.repeat(64) },
    { recordHash: 'f'.repeat(64) }, { evidenceSha256: 'wrong' }, { observedAt: 'not-a-date' },
    { basis: 'provider-terminal500-nonbilling-policy' }, { rawExport: 'private bytes' }]) {
    const value = plan(); Object.assign(value.billingEvidence, change);
    assert.throws(() => parseNarrationSuccessorPlan(JSON.stringify(value)));
  }
  assert.throws(() => parseNarrationSuccessorPlan(' '.repeat(NARRATION_PLAN_MAX_BYTES + 1)));
});

test('only the expected new version under the original payment can be shown as authorized', () => {
  const request = narrationSuccessorRequest(plan(), true);
  const correction = { correctionId: 'f'.repeat(64), parentCorrectionId: request.parentCorrectionId, originalOrderId: 'e'.repeat(64),
    preparedId: request.preparedId, manifestHash: request.manifestHash, maximumCostCents: 3840,
    maximumNewCostCents: request.maximumNewCostCents, status: 'authorized', customerChargeCents: 0 };
  assert.deepEqual(verifyNarrationSuccessor({ correction }, request), correction);
  for (const change of [{ correctionId: request.parentCorrectionId }, { status: 'completed' }, { preparedId: 'another' },
    { parentCorrectionId: 'e'.repeat(64) }, { manifestHash: 'e'.repeat(64) }, { originalOrderId: 'wrong' },
    { maximumCostCents: 1 }, { maximumNewCostCents: 1081 }, { customerChargeCents: 1 }])
    assert.throws(() => verifyNarrationSuccessor({ correction: { ...correction, ...change } }, request));
  assert.throws(() => verifyNarrationSuccessor({}, request));
});
