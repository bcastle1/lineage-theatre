import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { falRequestPath } from '../api/_lib/fal-client.mjs';
import { REFERENCE_RECOVERY as S, referenceGrantPath, referenceJobPath } from '../api/_lib/fal-reference-choice.mjs';
import { candidateCanaryProfile, candidateOperationBounds } from '../scripts/test-kling-cast-continuity.mjs';
import { parseRecoveryArguments, parseRecoveryEvidence, runReferenceRecovery, resumeSelectedReference,
  ZERO_CHARGE_FLAG, ADDITIONAL_30_FLAG } from '../scripts/recover-cast-canary-reference.mjs';

const evidence = mode => ({ email: S.email, productionId: S.id, manifestHash: S.manifestHash,
  originalRequestId: S.originalRequestId, budgetMode: mode });
const env = { LINEAGE_CANARY_OWNER_EMAIL: S.email, BLOB_READ_WRITE_TOKEN: 'test-storage',
  FAL_KLING_KEY: 'test-provider', LINEAGE_WORKER_SECRET: 'test-worker' };
const fixture = (mode = 'verified-zero-charge') => {
  const bytes = Buffer.from(JSON.stringify(evidence(mode)));
  return { bytes, hash: digest(bytes), flag: mode === 'verified-zero-charge' ? ZERO_CHARGE_FLAG : ADDITIONAL_30_FLAG };
};

test('reference recovery CLI requires a distinct explicit execution flag and byte-pinned evidence', () => {
  const f = fixture();
  assert.equal(parseRecoveryArguments(['plan', 'proof.json', f.hash]).action, 'plan');
  for (const args of [['run', 'proof.json', f.hash], ['recover', 'proof.json', f.hash, '--yes'],
    ['plan', 'proof.json', f.hash, ZERO_CHARGE_FLAG], ['run', 'proof.json', 'not-a-hash', ZERO_CHARGE_FLAG]])
    assert.throws(() => parseRecoveryArguments(args), { code: 'REFERENCE_RECOVERY_USAGE' });
  assert.throws(() => parseRecoveryEvidence(f.bytes, '0'.repeat(64), f.flag), { code: 'REFERENCE_RECOVERY_EVIDENCE_REQUIRED' });
  assert.throws(() => parseRecoveryEvidence(f.bytes, f.hash, ADDITIONAL_30_FLAG), { code: 'REFERENCE_RECOVERY_APPROVAL_MISMATCH' });
  const wrong = Buffer.from(JSON.stringify({ ...evidence('verified-zero-charge'), productionId: 'different-job' }));
  assert.throws(() => parseRecoveryEvidence(wrong, digest(wrong), f.flag), { code: 'REFERENCE_RECOVERY_EVIDENCE_REQUIRED' });
});

test('read-only recovery plan never advances production, regardless of returned readiness', async () => {
  const f = fixture(); const calls = [];
  const result = await runReferenceRecovery(['plan', 'proof.json', f.hash], env, {
    loadEvidence: async () => f.bytes, recover: async (_input, options) => { calls.push(options); return { status: 'reference-choice-ready' }; },
    resume: async () => assert.fail('plan must not advance'), continueCanary: async () => assert.fail('plan must not run'),
  });
  assert.equal(result.status, 'reference-choice-ready'); assert.deepEqual(calls, [{ execute: false }]);
});

test('single recover action cannot silently continue the rest of the film', async () => {
  const f = fixture('separate-30-cent-approval');
  await runReferenceRecovery(['recover', 'proof.json', f.hash, f.flag], env, {
    loadEvidence: async () => f.bytes, recover: async (_input, options) => {
      assert.deepEqual(options, { execute: true }); return { status: 'reference-choice-ready' };
    }, resume: async () => assert.fail('recover must not advance'), continueCanary: async () => assert.fail('recover must not run'),
  });
});

test('run waits for the same replacement and then uses one normal resume and canary continuation', async () => {
  const f = fixture(); const calls = []; let attempts = 0;
  const result = await runReferenceRecovery(['run', 'proof.json', f.hash, f.flag], env, {
    loadEvidence: async () => f.bytes, recover: async (input, options) => {
      assert.deepEqual(input, evidence('verified-zero-charge')); assert.equal(options.execute, true);
      calls.push('recover'); return { status: ++attempts < 3 ? 'replacement-pending' : 'reference-choice-ready' };
    }, pause: async () => calls.push('wait'), resume: async () => { calls.push('resume'); return { advanceCalls: 1 }; },
    continueCanary: async () => { calls.push('continue'); return { status: 'completed' }; },
  });
  assert.deepEqual(calls, ['recover', 'wait', 'recover', 'wait', 'recover', 'resume', 'continue']);
  assert.equal(result.status, 'completed');
});

test('uncertain replacement or wrong approval stops without advancing or restarting', async () => {
  const f = fixture(); let calls = 0;
  const dependencies = { loadEvidence: async () => f.bytes, recover: async () => { calls++; return { status: 'uncertain' }; },
    resume: async () => assert.fail('uncertain must not advance'), continueCanary: async () => assert.fail('uncertain must not run') };
  await assert.rejects(runReferenceRecovery(['run', 'proof.json', f.hash, f.flag], env, dependencies), { code: 'REFERENCE_RECOVERY_NOT_READY' });
  assert.equal(calls, 1);
  await assert.rejects(runReferenceRecovery(['run', 'proof.json', f.hash, f.flag], env, {
    ...dependencies, recover: async () => ({ status: 'replacement-pending', state: 'uncertain' }),
    pause: async () => assert.fail('uncertain claim must stop immediately'),
  }), { code: 'REFERENCE_RECOVERY_NOT_READY' });
  await assert.rejects(runReferenceRecovery(['run', 'proof.json', f.hash, ADDITIONAL_30_FLAG], env, dependencies), { code: 'REFERENCE_RECOVERY_APPROVAL_MISMATCH' });
  assert.equal(calls, 1);
});

function resumeFixture() {
  const now = Date.parse('2026-11-05T21:00:00Z'), profile = candidateCanaryProfile();
  const grant = { version: 1, kind: profile.summary.kind, runKey: S.runKey, characterBindingVersion: 3,
    ownerHash: S.ownerHash, preparedId: S.id, manifestHash: S.manifestHash, recipe: S.recipe,
    maximumCostCents: 450, maximumVideoRequests: 3, maximumReferenceRequests: 7,
    videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000, quotedCostCents: 450,
    funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    quoteReference: digest(`${S.recipe}:kling:${S.manifestHash}:150000:300000`),
    approvedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString() };
  const job = { id: S.id, ownerHash: S.ownerHash, mode: 'operator-test', status: 'uncertain',
    manifestHash: S.manifestHash, manifest: profile.manifest,
    authorization: { manifestHash: S.manifestHash, environment: 'production', budgetCents: 450, quoteReference: grant.quoteReference },
    shots: profile.manifest.shots.map((shot, i) => ({ id: shot.id, requestKey: digest(`${S.id}:${S.manifestHash}:${shot.id}`),
      status: ['processing', 'uncertain', 'prepared'][i] })) };
  job.shots[0].providerJobId = `fal-${digest(`${S.recipe}:kling:${job.shots[0].requestKey}`)}`;
  const actor = { email: S.email, role: 'owner' }; const calls = [];
  const read = async path => {
    const value = path === userPath(S.email) ? actor : path === referenceJobPath ? job : path === referenceGrantPath ? grant : null;
    return value ? { value } : null;
  };
  const options = { read, now: () => now, client: {}, pricing: {}, resolveChoice: async () => ({ proof: { choiceHash: 'a'.repeat(64) } }),
    makeGuard: () => ({}), makeAdapter: () => ({}), makeFilm: ({ authorize }) => ({ advance: async input => {
      const approval = await authorize({ ...input, manifestHash: S.manifestHash, mode: 'operator-test' });
      assert.equal(approval.budgetCents, 450); calls.push('advance'); job.status = 'processing'; return { status: 'processing' };
    } }) };
  return { options, job, actor, grant, calls };
}

test('selected-reference resume advances the exact stopped job once under its unchanged grant', async () => {
  const f = resumeFixture(); const before = JSON.stringify(f.grant);
  assert.deepEqual(await resumeSelectedReference(f.options), { status: 'processing', advanceCalls: 1 });
  assert.deepEqual(await resumeSelectedReference(f.options), { status: 'processing', advanceCalls: 0 });
  assert.deepEqual(f.calls, ['advance']); assert.equal(JSON.stringify(f.grant), before);
});

test('selected-reference resume rejects missing choice, active lease, different film, revoked owner and changed choice', async () => {
  for (const mutate of [f => { f.options.resolveChoice = async () => null; },
    f => { f.job.lease = { expiresAt: f.options.now() + 60000 }; }, f => { f.job.manifestHash = 'b'.repeat(64); },
    f => { f.actor.role = 'customer'; }, f => { f.job.shots[0].providerJobId = 'already-submitted'; },
    f => { const previous = f.options.read;
      const [identity] = [...candidateOperationBounds(S.id)].find(([, bound]) => bound.kind === 'video');
      f.options.read = async path => path === falRequestPath(identity) ? { value: { state: 'queued' } } : previous(path); },
    f => { let count = 0; f.options.resolveChoice = async () => ({ proof: { choiceHash: String(++count) } }); }]) {
    const f = resumeFixture(); mutate(f);
    await assert.rejects(resumeSelectedReference(f.options)); assert.deepEqual(f.calls, []);
  }
});
