import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { buildFilmManifest, fictionalOperatorProject, productionJobPath } from '../api/_lib/film-production.mjs';
import { productionQueuePath } from '../api/_lib/production-queue.mjs';
import { standardFilmVoices, nextSoundtrackAttempt } from '../scripts/automatic-film-soundtrack.mjs';
import { soundtrackPlan } from '../scripts/rebuild-film-soundtrack.mjs';
import { createSoundtrackCastingApproval, readSoundtrackCasting, soundtrackCastingPath } from '../scripts/authored-soundtrack-casting.mjs';
const hash = value => digest(JSON.stringify(value)), clone = structuredClone;

function fixture() {
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject()), email = OWNER_EMAIL;
  const job = { id: '12345678-1234-1234-1234-123456789abc', ownerHash: digest(email), mode: 'customer', status: 'awaiting-assembly',
    provider: { id: 'fal', model: 'kling' }, manifest, manifestHash,
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: { sha256: 'f'.repeat(64) } })) };
  const defaults = standardFilmVoices(manifest, manifestHash), ids = manifest.screenplay.characters.map(c => c.id);
  const voices = { narratorVoice: 'am_michael', characterVoices: Object.fromEntries(ids.map((id, index) => [id, ['am_adam', 'af_heart'][index]])) };
  const selected = { ...voices, speakerAliases: defaults.speakerAliases }, plan = soundtrackPlan({ manifest, manifestHash, ...selected });
  const fitReport = { version: 1, kind: 'soundtrack-fit-inspection-v1', manifestHash, durationMs: plan.durationMs, speed: 1,
    providerGenerationCalls: 0, requestedNarratorVoice: voices.narratorVoice,
    requestedCharacterVoicesSha256: hash(Object.entries(voices.characterVoices).sort(([a], [b]) => a.localeCompare(b))), fits: true,
    scenes: plan.scenes.map(scene => ({ sceneIndex: scene.sceneIndex, durationMs: scene.durationMs, fits: true,
      turns: scene.turns.map(turn => ({ turnIndex: turn.turnIndex, generatedMs: 1000, retainedMs: 900, trimStartMs: 50, trimEndMs: 50,
        availableMs: 3000, overrunMs: 0, fits: true })) })) };
  const binding = { version: 1, recipe: 'automatic-stock-soundtrack-v1', ownerHash: job.ownerHash, id: job.id, manifestHash,
    sources: job.shots.map(shot => ({ shotId: shot.id, sha256: 'a'.repeat(64), sizeBytes: 100 })),
    sourceOutputsSha256: hash(job.shots.map(shot => ({ id: shot.id, output: shot.output }))), voices: defaults };
  const prior = { kind: 'automatic-stock-soundtrack-v1', bindingHash: hash(binding), binding, state: 'building', attempts: 1, attemptId: 'first' };
  const jobPath = productionJobPath(email, job.id), queuePath = productionQueuePath(email, job.id);
  const priorPath = `production/soundtracks/${job.ownerHash}/${job.id}/${prior.bindingHash}/construction.json`;
  const records = new Map([[jobPath, { value: clone(job), etag: 'job-1' }], [queuePath, { value: { email, id: job.id, manifestHash, state: 'attention' }, etag: 'queue-1' }],
    [userPath(email), { value: { email, role: 'owner', status: 'active' }, etag: 'user-1' }], [priorPath, { value: clone(prior), etag: 'prior-1' }]]);
  let writes = 0, payments = 0, loseResponse = false, beforeWrite;
  const read = async path => clone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (beforeWrite) await beforeWrite(path, value);
    const old = records.get(path);
    if (old ? old.etag !== etag : etag !== undefined) throw Error('etag conflict');
    records.set(path, { value: clone(value), etag: `write-${++writes}` });
    if (loseResponse) throw Error('lost response');
  };
  const run = createSoundtrackCastingApproval({ read, write, now: () => 1_800_000_000_000, requirePayment: async () => { payments++; } });
  const input = { email, preparedId: job.id, manifestHash, priorBindingHash: prior.bindingHash, priorReceiptSha256: hash(prior),
    voices, fitReport, reason: 'Reviewed fictional cast and exact offline timing.', confirmed: true };
  return { job, jobPath, queuePath, priorPath, prior, defaults, records, input, read, run,
    execute: () => run(input, { execute: true, defaultVoices: defaults }),
    setLoseResponse: () => { loseResponse = true; }, setBeforeWrite: value => { beforeWrite = value; },
    counts: () => ({ writes, payments }) };
}

test('casting preparation is read-only and activation preserves sources, immutable approval and consumed attempts', async () => {
  const f = fixture(), priorBytes = hash(f.prior);
  const ready = await f.run(f.input, { defaultVoices: f.defaults });
  assert.equal(ready.prepared, true); assert.equal(ready.approved, false); assert.equal(f.counts().writes, 0);
  const result = await f.execute(); assert.equal(result.approved, true); assert.equal(result.priorAttempts, 1); assert.equal(result.remainingAttempts, 1);
  const selected = await readSoundtrackCasting({ job: f.job, defaultVoices: f.defaults, read: f.read });
  assert.equal(selected.approvalSha256, result.approvalSha256); assert.equal(selected.priorReceiptSha256, priorBytes);
  assert.deepEqual(selected.sources, f.prior.binding.sources); assert.deepEqual(selected.voices.characterVoices, f.input.voices.characterVoices);
  assert.equal(f.records.get(f.priorPath).value.state, 'superseded');
  assert.deepEqual(await f.execute(), result); assert.equal(f.counts().writes, 2);
});

test('lost approval and fence write responses reconcile only exact readbacks', async () => {
  const f = fixture(); f.setLoseResponse();
  const first = await f.execute(); assert.equal(first.approved, true);
  assert.deepEqual(await f.execute(), first); assert.equal(f.counts().writes, 2);
});

test('live claims, stale job/output/receipt, exhausted attempts, invalid voices and stale timing fail before writes', async () => {
  const changes = [
    f => { f.records.get(f.queuePath).value.lease = { expiresAt: 1_900_000_000_000 }; },
    f => { f.records.get(f.queuePath).value.state = 'pending'; },
    f => { f.records.get(f.jobPath).value.lease = { expiresAt: 1_900_000_000_000 }; },
    f => { f.records.get(f.jobPath).value.shots[0].output.sha256 = 'b'.repeat(64); },
    f => { f.records.get(f.priorPath).value.attempts = 2; },
    f => { f.input.priorReceiptSha256 = 'b'.repeat(64); },
    f => { f.input.voices.narratorVoice = Object.values(f.input.voices.characterVoices)[0]; },
    f => { f.input.voices.characterVoices.extra = 'am_echo'; },
    f => { f.input.fitReport.requestedNarratorVoice = 'am_echo'; },
    f => { f.input.fitReport.requestedCharacterVoicesSha256 = 'b'.repeat(64); },
    f => { f.input.fitReport.scenes[0].turns[0].overrunMs = 1; },
    f => { f.input.fitReport.scenes[0].turns[0].fits = false; },
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.execute()); assert.equal(f.counts().writes, 0); }
});

test('an immutable intent blocks default workers until exact prior receipt fence completes', async () => {
  const f = fixture(); let interrupted = false;
  f.setBeforeWrite(async path => { if (path === f.priorPath && !interrupted) { interrupted = true; throw Error('interrupted'); } });
  await assert.rejects(f.execute());
  assert.equal(f.records.has(soundtrackCastingPath(f.job)), true);
  await assert.rejects(readSoundtrackCasting({ job: f.job, defaultVoices: f.defaults, read: f.read }));
  assert.equal((await f.execute()).approved, true);
});

test('concurrent original receipt change cannot be overwritten and a different approval cannot replace the first', async () => {
  const f = fixture(); let raced = false;
  f.setBeforeWrite(async path => {
    if (path === f.priorPath && !raced) { raced = true; const r = f.records.get(path); r.etag = 'new-attempt'; r.value.attempts = 2; }
  });
  await assert.rejects(f.execute()); assert.equal(f.records.get(f.priorPath).value.attempts, 2);
  await assert.rejects(f.execute());
  const g = fixture(); await g.execute(); g.input.reason = 'A different subsequent casting request.';
  await assert.rejects(g.execute()); assert.equal(g.counts().writes, 2);
});

test('runtime approval guard fails after source, job or fenced receipt changes', async () => {
  const f = fixture(); await f.execute();
  const modified = clone(f.job); modified.shots[0].output.extra = true;
  await assert.rejects(readSoundtrackCasting({ job: modified, defaultVoices: f.defaults, read: f.read }));
  f.records.get(f.priorPath).value.attempts = 0;
  await assert.rejects(readSoundtrackCasting({ job: f.job, defaultVoices: f.defaults, read: f.read }));
});

test('a new voice binding inherits consumed construction attempts and cannot reset the two-attempt limit', () => {
  assert.equal(nextSoundtrackAttempt(undefined), 1);
  assert.equal(nextSoundtrackAttempt(1), 2);
  assert.equal(nextSoundtrackAttempt(undefined, 1), 2);
  for (const [saved, inherited] of [[2, 0], [2, 1], [undefined, 2], [0, 1], [-1, 0], [1.5, 0]])
    assert.throws(() => nextSoundtrackAttempt(saved, inherited));
});
