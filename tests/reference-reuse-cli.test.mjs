import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { REFERENCE_RECOVERY as S } from '../api/_lib/fal-reference-choice.mjs';
import { parseReuseArguments, parseReuseEvidence, runReferenceReuse, REUSE_FLAG } from '../scripts/reuse-cast-canary-reference.mjs';

const evidence = () => ({ version: 1, kind: 'existing-reference-reuse-approval', email: S.email,
  productionId: S.id, manifestHash: S.manifestHash, sourceRequestId: '01a1ad45-4fcd-7483-aa6c-03596e2f039d',
  maximumAdditionalCostCents: 0, maximumNewPortraitRequests: 0, maximumTotalCostCents: 480,
  evidenceSha256: digest('synthetic approval'), approvedAt: '2026-11-05T21:00:00.000Z', expiresAt: '2026-11-05T22:00:00.000Z' });
const env = { LINEAGE_CANARY_OWNER_EMAIL: S.email, BLOB_READ_WRITE_TOKEN: 'offline-storage',
  FAL_KLING_KEY: 'offline-provider', LINEAGE_WORKER_SECRET: 'offline-worker' };
function fixture() {
  const input = evidence(), bytes = Buffer.from(JSON.stringify(input)), hash = digest(bytes), calls = [], events = [];
  return { input, bytes, hash, calls, events, options: {
    loadEvidence: async () => bytes,
    reuse: async (value, options) => { calls.push(['reuse', value, options]); return {
      status: options.execute ? 'reference-choice-ready' : 'ready-for-reference-reuse', generationSubmitted: false,
      additionalPortraitRequests: 0, maximumTotalCostCents: 480 }; },
    resume: async () => { calls.push(['resume']); return { status: 'processing', advanceCalls: 1 }; },
    continueCanary: async () => { calls.push(['canary']); return { status: 'completed' }; },
    emit: event => events.push(event),
  } };
}

test('existing portrait CLI requires pinned evidence and its own execution flag', () => {
  const f = fixture();
  assert.equal(parseReuseArguments(['plan', 'proof.json', f.hash]).action, 'plan');
  for (const args of [['run', 'proof.json', f.hash], ['select', 'proof.json', f.hash, '--yes'],
    ['plan', 'proof.json', f.hash, REUSE_FLAG], ['run', 'proof.json', 'bad-hash', REUSE_FLAG],
    ['run', 'proof.json', f.hash, '--execute-approved-additional-30-cent-reference-recovery-20261105']])
    assert.throws(() => parseReuseArguments(args), { code: 'REFERENCE_REUSE_USAGE' });
  assert.throws(() => parseReuseEvidence(f.bytes, '0'.repeat(64)), { code: 'REFERENCE_REUSE_EVIDENCE_REQUIRED' });
  for (const change of [{ productionId: 'another-job' }, { email: 'another@example.com' },
    { sourceRequestId: S.originalRequestId }, { maximumNewPortraitRequests: 1 }, { maximumTotalCostCents: 510 },
    { maximumAdditionalCostCents: 30 }, { kind: 'additional-reference-approval' }]) {
    const bytes = Buffer.from(JSON.stringify({ ...f.input, ...change }));
    assert.throws(() => parseReuseEvidence(bytes, digest(bytes)), { code: 'REFERENCE_REUSE_EVIDENCE_REQUIRED' });
  }
});

test('read-only reuse plan cannot resume the canary or create a selection', async () => {
  const f = fixture();
  const result = await runReferenceReuse(['plan', 'proof.json', f.hash], env, f.options);
  assert.equal(result.status, 'ready-for-reference-reuse');
  assert.deepEqual(f.calls, [['reuse', f.input, { execute: false }]]);
  assert.equal(f.events[0].maximumTotalCostCents, 480);
});

test('selection-only command does not start remaining generation', async () => {
  const f = fixture();
  const result = await runReferenceReuse(['select', 'proof.json', f.hash, REUSE_FLAG], env, f.options);
  assert.equal(result.status, 'reference-choice-ready');
  assert.deepEqual(f.calls, [['reuse', f.input, { execute: true }]]);
});

test('run resumes once only after a validated zero-new-portrait choice', async () => {
  const f = fixture();
  const result = await runReferenceReuse(['run', 'proof.json', f.hash, REUSE_FLAG], env, f.options);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.calls, [['reuse', f.input, { execute: true }], ['resume'], ['canary']]);
  assert.ok(f.events.find(event => event.advanceCalls === 1));
});

test('uncertain selection or resumed failure cannot start further canary work', async () => {
  for (const selected of [{ status: 'ready-for-reference-reuse', generationSubmitted: false, additionalPortraitRequests: 0 },
    { status: 'reference-choice-ready', generationSubmitted: true, additionalPortraitRequests: 0 },
    { status: 'reference-choice-ready', generationSubmitted: false, additionalPortraitRequests: 1 }]) {
    const f = fixture(); f.options.reuse = async () => selected;
    await assert.rejects(runReferenceReuse(['run', 'proof.json', f.hash, REUSE_FLAG], env, f.options), { code: 'REFERENCE_REUSE_NOT_READY' });
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.options.resume = async () => { throw Error('synthetic stopped resume'); };
  await assert.rejects(runReferenceReuse(['run', 'proof.json', f.hash, REUSE_FLAG], env, f.options));
  assert.equal(f.calls.length, 1);
});

test('misconfigured owner stops before reading evidence or touching storage', async () => {
  const f = fixture(); let reads = 0; f.options.loadEvidence = async () => { reads++; return f.bytes; };
  await assert.rejects(runReferenceReuse(['run', 'proof.json', f.hash, REUSE_FLAG], { ...env,
    LINEAGE_CANARY_OWNER_EMAIL: 'other@example.com' }, f.options), { code: 'REFERENCE_REUSE_CONFIGURATION_REQUIRED' });
  assert.equal(reads, 0); assert.deepEqual(f.calls, []);
});
