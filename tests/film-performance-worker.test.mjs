import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../api/_lib/auth.mjs';
import { KLING_VOICES, FILM_PERFORMANCE_RECIPE, validateFilmPerformance } from '../api/_lib/film-performance.mjs';
import { validatePerformanceReviewProof, verifyFilmPerformanceReceipts } from '../api/_lib/film-performance-review.mjs';
import { createWorkerAssembly, workerFinishingCapabilities, publishWorkerHeartbeat } from '../scripts/production-worker.mjs';
import { prepareFilmPerformance, storeFilmPerformanceReview } from '../scripts/review-film-performance.mjs';
import { createAutomaticSoundtrackFallback } from '../scripts/automatic-film-soundtrack.mjs';
import { reviewFilmSpeech } from '../scripts/review-film-speech.mjs';
import { finishingFailure, markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { validateStoredProductionMedia } from '../api/_lib/production-media.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const email = 'customer@example.invalid', id = '00000000-0000-4000-8000-000000000001';
const video = Buffer.from('fictional encoded media boundary fixture only'), film = Buffer.from('fictional assembled media boundary fixture only');
function fixture() {
  const voiceId = KLING_VOICES[0].id, text = 'Hello, Alice.';
  const manifest = { version: 1, targetDurationSeconds: 3, performance: { version: 1, recipe: FILM_PERFORMANCE_RECIPE, narratorVoiceId: voiceId },
    productionPlan: { performanceVersion: 1 }, visualContinuity: { version: 1 },
    screenplay: { characters: [{ id: 'ada', name: 'Ada', voiceId, wardrobe: 'Green apron.' }],
      scenes: [{ characterIds: ['ada'], narration: '', dialogue: `Ada: ${text}` }] },
    shots: [{ id: 'shot-001', sceneIndex: 0, startMs: 0, targetDurationMs: 3000, characterIds: ['ada'], narration: '', dialogue: `Ada: ${text}`,
      performance: { mode: 'dialogue', speakerId: 'ada', voiceId, text } }] };
  const url = 'https://media.example.invalid/synchronized.mp4?private=fixture';
  const output = { url, contentType: 'video/mp4', sizeBytes: video.length, durationSeconds: 3,
    performance: { version: 1, recipe: FILM_PERFORMANCE_RECIPE, mode: 'dialogue', speakerId: 'ada', voiceId,
      textSha256: sha(text), videoOperationId: 'a'.repeat(64), speechOperationId: 'b'.repeat(64),
      sourceVideoUrlSha256: sha('https://media.example.invalid/source.mp4'), outputVideoUrlSha256: sha(url), audioUrlSha256: null } };
  const job = { id, ownerHash: digest(email), mode: 'customer', status: 'awaiting-assembly', manifest,
    manifestHash: sha(JSON.stringify(manifest)), shots: [{ id: 'shot-001', status: 'completed', output }] };
  const records = new Map([[`production/jobs/${digest(email)}/${id}.json`, { value: structuredClone(job), etag: '1' }]]);
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value) => { if (records.has(path)) throw new Error('precondition failed'); records.set(path, { value: structuredClone(value), etag: '1' }); };
  const speech = { version: 1, method: 'local-speech-transcription', passed: true,
    shots: [{ shotId: 'shot-001', scriptMatched: true, contextSilence: false }] };
  return { job, read, write, records, speech };
}
const decoded = { videoDurationSeconds: 3, videoFrameRate: 30, videoStartSeconds: 0, sourceAudioStartSeconds: 0, sourceAudioDurationSeconds: 3,
  selectedAudioDurationSeconds: 3, audioSelection: 'embedded-synchronized' };
const prepare = input => prepareFilmPerformance(input, { prepareClip: async () => decoded });
const held = error => error.code === 'FILM_PERFORMANCE_REVIEW_REQUIRED';

async function workerFixture(t, options = {}) {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'lineage-performance-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = { fetch: 0, fallback: 0, assemble: 0, upload: 0 };
  const assemble = createWorkerAssembly({ tempRoot: root, adapter: { id: 'fal', available: true, outputHosts: ['media.example.invalid'] },
    read: f.read, write: f.write, preparePerformance: prepare,
    fetchImpl: async () => { calls.fetch++; return new Response(video, { headers: { 'content-type': 'video/mp4' } }); },
    reviewVisuals: async () => ({ version: 2, passed: true }), reviewSpeech: async input => {
      assert.equal(input.allowAudioEdits, false); return f.speech;
    }, soundtrackFallback: async () => { calls.fallback++; throw new Error('must not replace audio'); },
    assemble: async ({ clips, outputPath }) => {
      calls.assemble++; assert.equal(clips[0].audioPath, undefined); assert.deepEqual(await readFile(clips[0].path), video);
      await writeFile(outputPath, film); await writeFile(`${outputPath}.vtt`, 'WEBVTT\n');
      return { manifestHash: f.job.manifestHash, sha256: sha(film), sizeBytes: film.length, width: 1280, height: 720, frameRate: 30,
        contentType: 'video/mp4', durationSeconds: 3, hasAudio: true, playable: true, technicalSample: false };
    }, putBlob: async () => { calls.upload++; }, ...options });
  return { ...f, root, calls, run: () => assemble({ email, id, job: f.job, stillOwned: async () => true }) };
}

test('selected synchronized dialogue gets a private byte-bound receipt without audio replacement', async t => {
  const f = await workerFixture(t), artifact = await f.run();
  assert.equal(validateFilmPerformance(f.job.manifest), true);
  assert.deepEqual(f.calls, { fetch: 1, fallback: 0, assemble: 1, upload: 2 });
  const proof = artifact.performanceReview;
  assert.equal(proof.passed, true); assert.equal(proof.artifactSha256, sha(film));
  const receipt = (await f.read(proof.receiptPath)).value;
  assert.equal(receipt.binding.shots[0].videoSha256, sha(video));
  assert.equal(receipt.binding.shots[0].selectedAudioContainerSha256, sha(video));
  assert.equal(receipt.binding.shots[0].providerAudioSha256, null);
  assert.equal(receipt.binding.shots[0].provenance.voiceId, f.job.manifest.shots[0].performance.voiceId);
  assert.doesNotMatch(JSON.stringify(receipt), /https:|private=|Hello, Alice/);
  await verifyFilmPerformanceReceipts({ email, id, manifest: f.job.manifest, manifestHash: f.job.manifestHash,
    artifactSha256: artifact.sha256, review: proof, speechReview: f.speech }, { read: f.read });
  const completed = { ...f.job, status: 'completed', performanceReview: proof, media: { ...artifact, pathname: artifact.pathname } };
  assert.equal(validateStoredProductionMedia(completed, email).sha256, artifact.sha256);
  for (const change of [{ performanceReview: undefined }, { performanceReview: { ...proof, artifactSha256: 'f'.repeat(64) } }])
    assert.throws(() => validateStoredProductionMedia({ ...completed, ...change }, email));
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(workerFinishingCapabilities, { filmPerformanceVersion: 1, visualChecksVersion: 2 });
});

test('new speaking contracts reject missing or changed provenance before any media fetch', async t => {
  for (const change of [output => delete output.performance, output => output.performance.voiceId = KLING_VOICES[1].id,
    output => output.performance.textSha256 = 'f'.repeat(64), output => output.url += '&changed=1',
    output => output.audio = { url: 'https://media.example.invalid/dub.wav' }, output => output.performance.speechOperationId = null]) {
    const f = await workerFixture(t); change(f.job.shots[0].output);
    await assert.rejects(f.run(), held); assert.deepEqual(f.calls, { fetch: 0, fallback: 0, assemble: 0, upload: 0 });
  }
});

test('new dialogue fails held on speech mismatch or an audio-changing reviewer, never invokes legacy fallback', async t => {
  for (const reviewSpeech of [async () => { throw markFinishingFailure(new Error('private provider detail'), 'speech-review', 'SPEECH_SCRIPT_MISMATCH'); },
    async ({ clips }) => { clips[0].audioPath = 'replacement.wav'; return fixture().speech; },
    async () => ({ ...fixture().speech, shots: [{ ...fixture().speech.shots[0], edit: { removedExtraSpeech: true } }] })]) {
    const f = await workerFixture(t, { reviewSpeech });
    await assert.rejects(f.run(), held); assert.equal(f.calls.fallback, 0); assert.equal(f.calls.upload, 0);
  }
  const f = await workerFixture(t, { prepareClips: async () => { throw new Error('must not run'); } });
  await assert.rejects(f.run(), held); assert.equal(f.calls.fetch, 0);
});

test('the legacy automatic soundtrack entry refuses a performance contract before storage or synthesis', async () => {
  let calls = 0;
  const fallback = createAutomaticSoundtrackFallback({ read: async () => { calls++; }, write: async () => { calls++; }, build: async () => { calls++; } });
  await assert.rejects(fallback({ job: fixture().job }), held); assert.equal(calls, 0);
});

test('strict speech review rejects an otherwise removable extra word before any FFmpeg edit', async () => {
  const f = fixture(), clip = { shotId: 'shot-001', path: 'not-opened.mp4' };
  const transcript = { duration: 3, words: [{ word: 'Hello', start: 0.1, end: 0.5 }, { word: 'Alice', start: 0.6, end: 1 },
    { word: 'extra', start: 2, end: 2.3 }] };
  await assert.rejects(reviewFilmSpeech({ manifest: f.job.manifest, clips: [clip], ffmpeg: 'must-not-execute', allowAudioEdits: false,
    transcribe: async () => transcript }), error => finishingFailure(error)?.reason === 'SPEECH_UNEXPECTED');
  assert.equal(clip.audioPath, undefined);
});

test('receipt verification rejects changed final clips, speech, coverage, source bytes and binding identity', async t => {
  const f = await workerFixture(t), artifact = await f.run(), proof = artifact.performanceReview;
  const input = { email, id, manifest: f.job.manifest, manifestHash: f.job.manifestHash,
    artifactSha256: artifact.sha256, review: proof, speechReview: f.speech };
  const original = structuredClone(f.records);
  for (const mutate of [
    records => records.get(proof.receiptPath).value.binding.shots.pop(),
    records => records.get(proof.receiptPath).value.binding.shots[0].videoSha256 = 'f'.repeat(64),
    records => records.get(`production/jobs/${digest(email)}/${id}.json`).value.shots[0].output.url += '&changed=1',
    records => records.get(`production/jobs/${digest(email)}/${id}.json`).value.ownerHash = 'f'.repeat(64),
  ]) {
    const records = structuredClone(original); mutate(records);
    await assert.rejects(verifyFilmPerformanceReceipts(input, { read: async path => records.get(path) }), held);
  }
  await assert.rejects(verifyFilmPerformanceReceipts({ ...input, speechReview: { ...f.speech, passed: false } }, { read: f.read }), held);
  assert.throws(() => validatePerformanceReviewProof({ ...input, ownerHash: digest(email), review: { ...proof, shotCount: 2 } }), held);
});

test('missing or offset decoded start times cannot become a verified dialogue receipt or upload', async t => {
  for (const starts of [{ videoStartSeconds: undefined }, { sourceAudioStartSeconds: undefined },
    { sourceAudioStartSeconds: 0.2 }, { videoStartSeconds: 0.2 }, { sourceAudioStartSeconds: NaN }]) {
    const f = await workerFixture(t, { preparePerformance: input => prepareFilmPerformance(input,
      { prepareClip: async () => ({ ...decoded, ...starts }) }) });
    await assert.rejects(f.run(), held);
    assert.equal(f.calls.upload, 0); assert.equal(f.calls.fallback, 0);
    assert.equal([...f.records.keys()].some(path => path.startsWith('production/performance-reviews/')), false);
  }
});

test('media changes during review or a lost lease cannot persist a performance receipt', async t => {
  const f = fixture(), work = await mkdtemp(join(tmpdir(), 'lineage-performance-mutation-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const path = join(work, 'clip.mp4'); await writeFile(path, video);
  const clips = [{ shotId: 'shot-001', path }], stillOwned = async () => true;
  const observations = await prepare({ job: f.job, clips, work, stillOwned });
  const input = { email, id, job: f.job, clips, observations, artifactSha256: sha(film), speechReview: f.speech, stillOwned };
  await assert.rejects(storeFilmPerformanceReview({ ...input, stillOwned: async () => false }, f), held);
  await writeFile(path, Buffer.from('different complete native container bytes'));
  await assert.rejects(storeFilmPerformanceReview(input, f), held);
  assert.equal([...f.records.keys()].some(path => path.startsWith('production/performance-reviews/')), false);
});

test('worker heartbeat preserves legacy recipe identity and advertises the separate verified performance implementation', async () => {
  const writes = [], checkedAt = Date.parse('2026-10-26T12:00:00Z');
  await publishWorkerHeartbeat({ adapter: { model: 'kling', modelVersion: 'legacy-recipe-fixture' }, now: () => checkedAt,
    musicAssets: async () => ({ ready: true }),
    read: async path => ({ etag: path }), write: async (path, value, etag) => writes.push({ path, value, etag }) });
  assert.deepEqual(writes.map(row => row.path), ['production/worker-health.json', 'production/worker-health-performance-v1.json']);
  assert.deepEqual(writes.map(row => row.value.recipe), ['legacy-recipe-fixture', FILM_PERFORMANCE_RECIPE]);
  for (const { path, value, etag } of writes) {
    assert.equal(etag, path); assert.equal(value.checkedAt, new Date(checkedAt).toISOString());
    assert.equal(value.ready, true); assert.equal(value.filmPerformanceVersion, 1); assert.equal(value.visualChecksVersion, 2);
  }
  writes.length = 0;
  await publishWorkerHeartbeat({ adapter: { model: 'kling', modelVersion: 'legacy-recipe-fixture' }, musicAssets: async () => ({ ready: false }),
    read: async () => null, write: async (path, value) => writes.push({ path, value }) });
  assert.equal(writes[0].value.ready, true); assert.equal(writes[1].value.ready, false); assert.equal(writes[1].value.performanceMusicVersion, 0);
});
