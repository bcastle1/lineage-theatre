import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authoredPcm, joinAuthoredPcm } from '../scripts/adjacent-authored-speech.mjs';
import { createRepairSpeechResolver, verifyAuthoredSceneEquivalence } from '../scripts/repair-name-proof.mjs';
import { soundtrackPlan } from '../scripts/rebuild-film-soundtrack.mjs';

const hash = value => createHash('sha256').update(value).digest('hex'), sha = value => hash(JSON.stringify(value));
const rejected = { code: 'FILM_SPEECH_REVIEW_REQUIRED' };
function wav(milliseconds, channels = 2) {
  const data = Buffer.alloc(milliseconds * 48 * channels * 2, 7), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(48000 * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const transcript = (text, duration = 15, offset = 0) => ({ duration, words: text.split(' ').map((word, i) => ({ word, start: offset + .2 + i * .3, end: offset + .4 + i * .3 })) });
async function fixture(t, first = 'We counted twenty-one birds.', second = 'They returned home.') {
  const root = await mkdtemp(join(tmpdir(), 'authored-scene-core-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'soundtrack'));
  const shots = [first, second].map((narration, i) => ({ id: `shot-${i + 1}`, narration, dialogue: '', characterIds: [],
    startMs: i * 7500, targetDurationMs: 7500, sceneIndex: 0, sceneParts: 2, scenePart: i + 1,
    continuity: { precedingShotId: i ? 'shot-1' : null } }));
  const manifest = { version: 1, targetDurationSeconds: 15, sound: { musicRequested: false },
    screenplay: { characters: [], scenes: [{ narration: first + ' ' + second, dialogue: '', characterIds: [] }] }, shots };
  const manifestHash = sha(manifest), voices = { narratorVoice: 'am_michael', characterVoices: {}, speakerAliases: {} };
  const plan = soundtrackPlan({ manifest, manifestHash, ...voices });
  const provenance = { recipe: plan.recipe, engine: 'kokoro-82m-v1.0-cpu', manifestHash, sourceTextRewritten: false, speed: 1,
    runtimeVersions: { misaki: '0.9.4' }, musicRequested: false, scenes: [] };
  const audioPaths = [];
  for (const scene of plan.scenes) {
    const bytes = wav(scene.durationMs), file = `${scene.shotId}-mix.wav`, path = join(root, 'soundtrack', file);
    await writeFile(path, bytes); audioPaths.push(path);
    const turn = scene.turns[0], turnBytes = wav(6000), turnFile = `${scene.shotId}-turn.wav`;
    await writeFile(join(root, 'soundtrack', turnFile), turnBytes);
    provenance.scenes.push({ shotId: scene.shotId, durationMs: scene.durationMs, originalProviderAudioIncluded: false,
      mix: { file, sizeBytes: bytes.length, sha256: hash(bytes) }, turns: [{ ...turn, speed: 1,
        synthesisTextSha256: turn.textSha256, phonemesSha256: 'c'.repeat(64), startSeconds: .06, endSeconds: 6.06,
        audio: { file: turnFile, sizeBytes: turnBytes.length, sha256: hash(turnBytes) } }] });
  }
  const joined = joinAuthoredPcm([wav(7500), wav(7500)], [7500, 7500]), combinedAudioPath = join(root, 'joined.wav');
  await writeFile(combinedAudioPath, joined.bytes);
  return { manifest, manifestHash, voices, provenance, constructionRoot: root, audioPaths, combinedAudioPath,
    shotIds: shots.map(s => s.id), root };
}

test('PCM joining preserves every stereo or mono sample and exact frame counts', () => {
  for (const channels of [1, 2]) {
    const source = [wav(11053, channels), wav(11052, channels)], joined = joinAuthoredPcm(source, [11053, 11052]);
    assert.equal(authoredPcm(joined.bytes).frames, 1061040);
    assert.equal(authoredPcm(joined.bytes).channels, channels);
    assert.deepEqual(authoredPcm(joined.bytes).data, Buffer.concat(source.map(x => authoredPcm(x).data)));
  }
});
test('PCM joining rejects resampling, channel mismatch, duration drift and truncated RIFF', () => {
  assert.throws(() => joinAuthoredPcm([wav(1000), wav(1000, 1)], [1000, 1000]), rejected);
  assert.throws(() => joinAuthoredPcm([wav(1000), wav(1000)], [1001, 1000]), rejected);
  const rate = wav(1000); rate.writeUInt32LE(24000, 24); assert.throws(() => authoredPcm(rate), rejected);
  assert.throws(() => authoredPcm(wav(1000).subarray(0, -1)), rejected);
});
test('shared core proves exact cardinal forms with original source turns and scene offsets', async t => {
  const f = await fixture(t), full = transcript('We counted 21 birds They returned home');
  const proof = await verifyAuthoredSceneEquivalence({ ...f, normalTranscript: full, contextTranscript: structuredClone(full) });
  assert.equal(proof.scope, 'authored-scene-window'); assert.equal(proof.shotId, undefined);
  assert.equal(proof.spans[0].method, 'canonical-cardinal-0-99-v1');
  assert.equal(proof.spans[0].sourceTurn.shotId, 'shot-1');
  assert.equal(proof.spans[0].sourceTurn.offsetSeconds, 0);
  const later = await fixture(t, 'We returned home.', 'We counted twenty-one birds.');
  const shifted = { duration: 15, words: [...transcript('We returned home').words, ...transcript('We counted 21 birds', 15, 7.5).words] };
  const next = await verifyAuthoredSceneEquivalence({ ...later, normalTranscript: shifted, contextTranscript: structuredClone(shifted) });
  assert.equal(next.spans[0].sourceTurn.shotId, 'shot-2'); assert.equal(next.spans[0].sourceTurn.offsetSeconds, 7.5);
});
test('standalone resolver keeps its exact previous cardinal behavior and rejects ordinary changes', async t => {
  const f = await fixture(t), resolver = createRepairSpeechResolver({ ...f, receiptRoot: f.root });
  const good = transcript('We counted 21 birds', 7.5), input = { manifest: f.manifest, shot: f.manifest.shots[0], audioPath: f.audioPaths[0] };
  const proof = await resolver({ ...input, normalTranscript: good, contextTranscript: structuredClone(good) });
  assert.equal(proof.shotId, 'shot-1'); assert.equal(proof.scope, undefined); assert.equal(proof.spans[0].sourceTurn, undefined);
  const bad = transcript('We counted 21 cats', 7.5);
  await assert.rejects(resolver({ ...input, normalTranscript: bad, contextTranscript: structuredClone(bad) }), rejected);
});
test('whole-scene exact words can cross the cut boundary without a localization claim', async t => {
  const f = await fixture(t, 'We could also', 'mean beginning again.'), full = transcript('We could also mean beginning again');
  full.words[3].start = 7.2; full.words[3].end = 7.9;
  full.words[4].start = 8; full.words[4].end = 8.3; full.words[5].start = 8.4; full.words[5].end = 8.7;
  assert.equal(await verifyAuthoredSceneEquivalence({ ...f, normalTranscript: full, contextTranscript: structuredClone(full) }), null);
});
test('whole-scene core rejects ordinary substitutions, pass disagreement, endguard and inconsistent saved scene', async t => {
  for (const mode of ['ordinary', 'context', 'endguard', 'original-scene', 'source']) {
    const f = await fixture(t), full = transcript('We counted 21 birds They returned home'), other = structuredClone(full);
    if (mode === 'ordinary') { full.words[3].word = 'cats'; other.words[3].word = 'cats'; }
    if (mode === 'context') other.words[3].word = 'cats';
    if (mode === 'endguard') full.words[0].end = 15;
    if (mode === 'original-scene') { f.manifest.screenplay.scenes[0].narration += ' Extra.'; f.manifestHash = sha(f.manifest); f.provenance.manifestHash = f.manifestHash; }
    if (mode === 'source') await writeFile(f.audioPaths[0], wav(7400));
    await assert.rejects(verifyAuthoredSceneEquivalence({ ...f, normalTranscript: full, contextTranscript: other }), rejected);
  }
});
