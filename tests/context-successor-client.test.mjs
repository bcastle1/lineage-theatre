import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile(new URL('../src/admin/context-successor-correction.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { parseContextSuccessorPlan, contextSuccessorRequest, verifyContextSuccessor, CONTEXT_PLAN_MAX_BYTES } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const plan = () => ({ parentCorrectionId: 'a'.repeat(64), preparedId: '11111111-2222-4333-8444-555555555555',
  manifestHash: 'b'.repeat(64), shotId: 'shot-003', filmContext: 'A fictional family works together in a garden.',
  historicalBoundaries: 'Show only the approved quiet garden. Do not invent events.',
  failedOperationIdentity: 'c'.repeat(64), failedRequestId: 'fictional-moderated-scene', failedRecordHash: 'd'.repeat(64),
  maximumNewCostCents: 1080, reason: 'Owner approved these fictional background instructions with the existing narration, visuals and timing.', confirmed: false,
  billingEvidence: { version: 1, kind: 'owner-reviewed-request-zero-charge-v1', basis: 'provider-request-billing-row',
    account: 'offline-only', operationIdentity: 'c'.repeat(64), requestId: 'fictional-moderated-scene',
    recordHash: 'd'.repeat(64), costNanoUsd: 0, quantity: 0, evidenceSha256: 'e'.repeat(64),
    observedAt: '2026-11-24T12:00:00Z', approvedBy: 'owner@example.invalid' } });

test('scene instruction import reviews only the exact two instructions and requires separate confirmation', () => {
  const imported = parseContextSuccessorPlan(JSON.stringify({ request: plan(), privateNotes: 'Do not transmit.' }));
  assert.deepEqual(imported, plan());
  assert.throws(() => contextSuccessorRequest(imported, false));
  const request = contextSuccessorRequest(imported, true);
  assert.equal(request.action, 'createContextSuccessorCorrection');
  assert.equal(request.confirmed, true); assert.equal(request.privateNotes, undefined);
  imported.filmContext = 'Different context'; imported.historicalBoundaries = 'Different limits'; imported.billingEvidence.quantity = 1;
  assert.equal(request.filmContext, plan().filmContext); assert.equal(request.historicalBoundaries, plan().historicalBoundaries);
  assert.equal(request.billingEvidence.quantity, 0);
});

test('scene instruction import rejects script edits, unsupported instructions and widened billing scope', () => {
  for (const change of [{ confirmed: true }, { action: 'createNarrationSuccessorCorrection' }, { maximumNewCostCents: 0 },
    { maximumNewCostCents: 1981 }, { maximumNewCostCents: '1080' }, { maximumNewCostCents: 1.5 },
    { parentCorrectionId: 'wrong' }, { preparedId: 'wrong' }, { manifestHash: 'wrong' }, { failedRecordHash: 'wrong' },
    { shotId: '' }, { failedRequestId: 'contains space' }, { reason: '' }, { filmContext: '' }, { historicalBoundaries: '' },
    { filmContext: 'First line\nExtra instruction' }, { historicalBoundaries: '<tag>' }, { filmContext: 'x'.repeat(2001) },
    { narration: 'Unapproved words' }, { visual: 'Unapproved design' }, { providerContext: {} },
    { replacementUrl: 'https://example.invalid/video.mp4' }])
    assert.throws(() => parseContextSuccessorPlan(JSON.stringify({ ...plan(), ...change })));
  for (const change of [{ costNanoUsd: 1 }, { quantity: 1 }, { requestId: 'another-request' }, { operationIdentity: 'f'.repeat(64) },
    { recordHash: 'f'.repeat(64) }, { evidenceSha256: 'wrong' }, { observedAt: 'not-a-date' },
    { basis: 'provider-terminal500-nonbilling-policy' }, { rawExport: 'private bytes' }]) {
    const value = plan(); Object.assign(value.billingEvidence, change);
    assert.throws(() => parseContextSuccessorPlan(JSON.stringify(value)));
  }
  assert.throws(() => parseContextSuccessorPlan(' '.repeat(CONTEXT_PLAN_MAX_BYTES + 1)));
});

test('scene instruction authorization must return the exact successor, unchanged ceiling and no new customer charge', () => {
  const request = contextSuccessorRequest(plan(), true);
  const correction = { correctionId: 'f'.repeat(64), parentCorrectionId: request.parentCorrectionId, originalOrderId: 'e'.repeat(64),
    preparedId: request.preparedId, manifestHash: request.manifestHash, maximumCostCents: 3840,
    maximumNewCostCents: request.maximumNewCostCents, status: 'authorized', customerChargeCents: 0 };
  assert.deepEqual(verifyContextSuccessor({ correction }, request), correction);
  for (const change of [{ correctionId: request.parentCorrectionId }, { status: 'completed' }, { preparedId: 'another' },
    { parentCorrectionId: 'e'.repeat(64) }, { manifestHash: 'e'.repeat(64) }, { originalOrderId: 'wrong' },
    { maximumCostCents: 1 }, { maximumNewCostCents: 1081 }, { customerChargeCents: 1 }])
    assert.throws(() => verifyContextSuccessor({ correction: { ...correction, ...change } }, request));
  assert.throws(() => verifyContextSuccessor({}, request));
});
