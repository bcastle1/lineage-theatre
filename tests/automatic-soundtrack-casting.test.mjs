import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { automaticFilmVoiceCandidates, standardFilmVoices } from '../scripts/automatic-film-soundtrack.mjs';
import { selectAutomaticSoundtrackCasting, readAutomaticSoundtrackCasting, automaticSoundtrackCastingPath } from '../scripts/authored-soundtrack-casting.mjs';
import { soundtrackPlan } from '../scripts/rebuild-film-soundtrack.mjs';

const hash = value => digest(JSON.stringify(value)), clone = structuredClone;
const rejected = { code: 'SOUNDTRACK_CASTING_UNVERIFIED' };
function fixture({ fits = [true, true], loseResponses = false } = {}) {
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject());
  const job = { id: '12345678-1234-1234-1234-123456789abc', ownerHash: digest('approved@example.test'), mode: 'customer',
    status: 'awaiting-assembly', provider: { id: 'fal' }, manifest, manifestHash,
    authorization: { environment: 'production', manifestHash },
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: { sha256: 'a'.repeat(64) } })) };
  const sources = job.shots.map(shot => ({ shotId: shot.id, sha256: 'b'.repeat(64), sizeBytes: 100 }));
  const defaultVoices = standardFilmVoices(manifest, manifestHash), candidates = automaticFilmVoiceCandidates(manifest, manifestHash);
  const records = new Map(), writes = [], inspections = []; let guards = 0;
  const read = async path => clone(records.get(path) || null);
  const write = async (path, value, etag) => {
    const previous = records.get(path);
    if (previous ? previous.etag !== etag : etag !== undefined) throw Error('immutable/CAS conflict');
    records.set(path, { value: clone(value), etag: `write-${writes.length}` }); writes.push({ path, value: clone(value) });
    if (loseResponses) throw Error('lost acknowledgement');
  };
  const options = { job, sources, defaultVoices, candidates, read, write, now: () => 1_800_000_000_000,
    guard: async () => { guards++; }, inspectFit: async request => {
      inspections.push(clone(request));
      const plan = soundtrackPlan(request), fitsHere = fits[request.narratorVoice === 'am_michael' ? 0 : 1];
      return { version: 1, kind: 'soundtrack-fit-inspection-v1', manifestHash, durationMs: plan.durationMs, speed: 1,
        providerGenerationCalls: 0, fits: fitsHere, scenes: plan.scenes.map(scene => ({ sceneIndex: scene.sceneIndex,
          durationMs: scene.durationMs, fits: fitsHere, turns: scene.turns.map(turn => ({ turnIndex: turn.turnIndex,
            generatedMs: 1000, retainedMs: 900, trimStartMs: 50, trimEndMs: 50,
            availableMs: fitsHere ? 1000 : 800, overrunMs: fitsHere ? 0 : 100, fits: fitsHere })) })) };
    } };
  return { ...options, options, records, writes, inspections, guards: () => guards,
    execute: () => selectAutomaticSoundtrackCasting(options) };
}

test('automatic stock casting is stable by character ID, distinct, and does not change spoken text', () => {
  const f = fixture(), shuffled = clone(f.job.manifest); shuffled.screenplay.characters.reverse();
  assert.deepEqual(automaticFilmVoiceCandidates(shuffled, hash(shuffled)), f.candidates);
  for (const voices of f.candidates) {
    const assigned = [voices.narratorVoice, ...Object.values(voices.characterVoices)];
    assert.equal(new Set(assigned).size, assigned.length);
    const plan = soundtrackPlan({ manifest: f.job.manifest, manifestHash: f.job.manifestHash, ...voices });
    const original = soundtrackPlan({ manifest: f.job.manifest, manifestHash: f.job.manifestHash, ...f.defaultVoices });
    assert.deepEqual(plan.scenes.map(scene => scene.turns.map(turn => [turn.speakerId, turn.text, turn.textSha256])),
      original.scenes.map(scene => scene.turns.map(turn => [turn.speakerId, turn.text, turn.textSha256])));
  }
});

test('one fitting candidate is durably selected and repeated selection never inspects or rewrites', async () => {
  const f = fixture(), original = clone(f.job), selected = await f.execute(), writes = f.writes.length;
  assert.equal(selected.voices.narratorVoice, 'am_michael'); assert.equal(f.inspections.length, 1);
  assert.deepEqual(await f.execute(), selected); assert.equal(f.inspections.length, 1); assert.equal(f.writes.length, writes);
  assert.deepEqual(f.job, original); assert.ok(f.guards() >= 4);
  assert.ok(f.writes.every(entry => entry.path.startsWith('production/soundtracks/') && !entry.path.endsWith('/construction.json')));
  assert.deepEqual(f.inspections[0].manifest, f.job.manifest);
  assert.equal(f.records.get(automaticSoundtrackCastingPath(f.job)).value.binding.authorizationSha256, hash(f.job.authorization));
});

test('only two natural-speed fit candidates may run and the second passing selection is immutable', async () => {
  const f = fixture({ fits: [false, true] }), selected = await f.execute();
  assert.equal(selected.voices.narratorVoice, 'am_puck'); assert.equal(f.inspections.length, 2);
  assert.deepEqual(await f.execute(), selected); assert.equal(f.inspections.length, 2);
  assert.ok(f.writes.filter(entry => entry.value.kind === 'automatic-casting-fit-v1' && entry.value.state === 'inspected')
    .every(entry => entry.value.fitReport.speed === 1 && entry.value.fitReport.providerGenerationCalls === 0));
});

test('both failed fits remain recorded and retries cannot synthesize again or consume construction attempts', async () => {
  const f = fixture({ fits: [false, false] });
  await assert.rejects(f.execute(), rejected); await assert.rejects(f.execute(), rejected);
  assert.equal(f.inspections.length, 2); assert.equal(f.records.has(automaticSoundtrackCastingPath(f.job)), false);
  assert.ok(f.writes.every(entry => !entry.path.endsWith('/construction.json')));
});

test('lost write responses recover through exact readbacks without repeated local synthesis', async () => {
  const f = fixture({ fits: [false, true], loseResponses: true });
  const selected = await f.execute(); assert.deepEqual(await f.execute(), selected); assert.equal(f.inspections.length, 2);
});

test('interrupted fit claims and racing claims never permit an unbounded retry', async () => {
  const f = fixture(); f.options.inspectFit = async () => { f.inspections.push('interrupted'); throw Error('offline runtime interrupted'); };
  await assert.rejects(f.execute(), /offline runtime interrupted/); await assert.rejects(f.execute(), rejected);
  assert.equal(f.inspections.length, 1); assert.equal(f.records.has(automaticSoundtrackCastingPath(f.job)), false);
  const raced = fixture(), write = raced.options.write;
  raced.options.write = async (path, value, etag) => {
    await write(path, value.state === 'inspecting' ? { ...value, claimId: 'another-worker' } : value, etag);
  };
  await assert.rejects(raced.execute(), rejected); assert.equal(raced.inspections.length, 0);
});

test('changed manifest, source, authorization, selection or fit evidence cannot reuse a casting', async () => {
  const mutations = [
    f => { f.options.sources[0].sha256 = 'c'.repeat(64); },
    f => { f.options.job.authorization.manifestHash = 'c'.repeat(64); },
    f => { f.options.job.shots[0].output.sha256 = 'c'.repeat(64); },
    f => { f.options.job.manifest.shots[0].narration += ' Changed.'; },
    f => { f.records.get(automaticSoundtrackCastingPath(f.job)).value.voices.narratorVoice = 'am_puck'; },
    f => { f.records.get(automaticSoundtrackCastingPath(f.job)).value.fitReport.scenes[0].turns[0].retainedMs = 100_000; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); await f.execute(); const writes = f.writes.length; mutate(f);
    await assert.rejects(f.execute(), rejected); assert.equal(f.inspections.length, 1); assert.equal(f.writes.length, writes);
  }
});

test('claim/payment guard failure after fit blocks selection and malformed fit evidence is rejected', async () => {
  const f = fixture(), inspect = f.options.inspectFit; let valid = true;
  f.options.guard = async () => { if (!valid) throw Error('payment or claim changed'); };
  f.options.inspectFit = async request => { const result = await inspect(request); valid = false; return result; };
  await assert.rejects(f.execute(), /payment or claim changed/);
  assert.equal(f.records.has(automaticSoundtrackCastingPath(f.job)), false);
  const bad = fixture(), inspectBad = bad.options.inspectFit;
  bad.options.inspectFit = async request => { const result = await inspectBad(request); result.speed = 1.1; return result; };
  await assert.rejects(bad.execute(), rejected); assert.equal(bad.records.has(automaticSoundtrackCastingPath(bad.job)), false);
});

test('reading a missing automatic casting is side-effect free', async () => {
  const f = fixture(); assert.equal(await readAutomaticSoundtrackCasting({ job: f.job, read: f.read }), null);
  assert.equal(f.inspections.length, 0); assert.equal(f.writes.length, 0);
});

test('selected casting cannot substitute fit evidence or bypass the immutable inspection receipt', async () => {
  const f = fixture(); await f.execute();
  const saved = f.records.get(automaticSoundtrackCastingPath(f.job)).value;
  saved.fitReport.scenes[0].turns[0].generatedMs++;
  saved.fitReportSha256 = hash(saved.fitReport);
  await assert.rejects(f.execute(), rejected); assert.equal(f.inspections.length, 1);
  const g = fixture(); await g.execute();
  const path = [...g.records.keys()].find(value => value.includes('/casting-fit/'));
  g.records.delete(path);
  await assert.rejects(g.execute(), rejected); assert.equal(g.inspections.length, 1);
});
