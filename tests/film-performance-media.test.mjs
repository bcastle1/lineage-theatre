import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePerformanceClip, assembleFilm, performanceMusicFilters, verifyPerformanceMusicMedia } from '../scripts/assemble-film.mjs';
import { buildPerformanceMusic } from '../scripts/film-performance-music.mjs';
import { prepareFilmPerformance, storeFilmPerformanceReview } from '../scripts/review-film-performance.mjs';
import { verifyFilmPerformanceReceipts } from '../api/_lib/film-performance-review.mjs';
import { digest } from '../api/_lib/auth.mjs';
import { KLING_VOICES, FILM_PERFORMANCE_RECIPE } from '../api/_lib/film-performance.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', sha = value => createHash('sha256').update(value).digest('hex');
const probe = spawnSync(ffmpeg, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
const unavailable = !process.env.FFMPEG_PATH && probe.error?.code === 'ENOENT';
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic FFmpeg fixture timeout.')); }, 60_000);
    child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-3000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Synthetic FFmpeg fixture failed: ${stderr}`)); });
  });
}
function manifestFor(mode) {
  const voiceId = KLING_VOICES[0].id, text = mode === 'silent' ? '' : 'A fictional spoken line.';
  return { version: 1, targetDurationSeconds: 3, productionPlan: { performanceVersion: 1 },
    performance: { version: 1, recipe: FILM_PERFORMANCE_RECIPE, narratorVoiceId: voiceId },
    screenplay: { characters: [{ id: 'ada', name: 'Ada', voiceId, wardrobe: 'Green apron.' }],
      scenes: [{ characterIds: ['ada'], narration: mode === 'narration' ? text : '', dialogue: mode === 'dialogue' ? `Ada: ${text}` : '' }] },
    shots: [{ id: 'shot-001', sceneIndex: 0, startMs: 0, targetDurationMs: 3000, characterIds: ['ada'],
      narration: mode === 'narration' ? text : '', dialogue: mode === 'dialogue' ? `Ada: ${text}` : '',
      performance: { mode, speakerId: mode === 'dialogue' ? 'ada' : null, voiceId: mode === 'silent' ? null : voiceId, text } }] };
}

test('real decoded media preserves synchronized dialogue and only appends silence to selected narration',
  { skip: unavailable ? 'Optional FFmpeg runtime not installed; set FFMPEG_PATH to require it.' : false }, async t => {
  assert.equal(probe.error, undefined); assert.equal(probe.status, 0);
  const root = await mkdtemp(join(tmpdir(), 'lineage-performance-real-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const silent = join(root, 'silent.mp4'), dialogue = join(root, 'dialogue.mp4'), long = join(root, 'long.mp4'), short = join(root, 'short.mp4');
  for (const [path, seconds, audible] of [[silent, 3, false], [dialogue, 3, true], [long, 4, true], [short, 2, true]])
    await run(['-n', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30',
      ...(audible ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []), '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(audible ? ['-c:a', 'aac'] : []),
      '-metadata', 'comment=SYNTHETIC MEDIA TEST ONLY - NO GENERATED PERFORMANCE', path]);
  const narration = join(root, 'narration.wav'), tooLong = join(root, 'narration-too-long.wav');
  for (const [path, seconds] of [[narration, 1], [tooLong, 3.1]]) await run(['-n', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-t', String(seconds), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', path]);
  const pcm = path => run(['-i', path, '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 's16le', '-']);

  await t.test('dialogue retains the exact source file and embedded audio selection through assembly', async () => {
    const manifest = manifestFor('dialogue'), clip = { shotId: 'shot-001', path: dialogue }, before = sha(await readFile(dialogue));
    const measured = await preparePerformanceClip({ manifest, shot: manifest.shots[0], clip, work: root, ffmpeg });
    assert.equal(clip.audioPath, undefined); assert.equal(sha(await readFile(dialogue)), before);
    assert.equal(measured.audioSelection, 'embedded-synchronized'); assert.equal(measured.videoDurationSeconds, 3);
    assert.equal(measured.videoStartSeconds, 0); assert.equal(measured.sourceAudioStartSeconds, 0);
    const outputPath = join(root, 'dialogue-film.mp4');
    const report = await assembleFilm({ manifest, manifestHash: sha(JSON.stringify(manifest)), clips: [clip], outputPath, ffmpeg });
    assert.equal(report.playable, true); assert.equal(report.hasAudio, true); assert.equal(report.durationSeconds, 3);
    assert.equal(sha(await readFile(dialogue)), before);
  });
  await t.test('dialogue with an offset audio or video start is held before timestamp normalization', async () => {
    const manifest = manifestFor('dialogue');
    for (const track of ['a', 'v']) {
      const path = join(root, `${track}-offset.mp4`);
      await run(['-n', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        `-filter:${track}`, `${track === 'a' ? 'asetpts' : 'setpts'}=PTS+0.2/TB`,
        '-fps_mode:v', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
      const original = sha(await readFile(path)), clip = { shotId: 'shot-001', path };
      await assert.rejects(preparePerformanceClip({ manifest, shot: manifest.shots[0], clip, work: root, ffmpeg }),
        error => finishingFailure(error)?.reason === 'PERFORMANCE_AUDIO_MISMATCH');
      await assert.rejects(assembleFilm({ manifest, manifestHash: sha(JSON.stringify(manifest)), clips: [clip],
        outputPath: join(root, `${track}-offset-must-not-assemble.mp4`), ffmpeg }),
        error => finishingFailure(error)?.reason === 'PERFORMANCE_AUDIO_MISMATCH');
      assert.equal(sha(await readFile(path)), original); assert.equal(clip.audioPath, undefined);
    }
  });
  await t.test('narration keeps every PCM sample unchanged and adds only trailing zero samples', async () => {
    const manifest = manifestFor('narration'), work = join(root, 'narration'); await mkdir(work);
    const clip = { shotId: 'shot-001', path: silent, audioPath: narration }, sourceHash = sha(await readFile(narration));
    const measured = await preparePerformanceClip({ manifest, shot: manifest.shots[0], clip, work, ffmpeg });
    assert.equal(measured.sourceAudioDurationSeconds, 1); assert.ok(Math.abs(measured.selectedAudioDurationSeconds - 3) < 0.000001);
    assert.equal(measured.audioSelection, 'stock-narration-silence-padded'); assert.equal(sha(await readFile(narration)), sourceHash);
    const original = await pcm(narration), selected = await pcm(clip.audioPath);
    assert.deepEqual(selected.subarray(0, original.length), original);
    assert.equal(selected.length, 3 * 48000 * 2 * 2); assert.ok(selected.subarray(original.length).every(byte => byte === 0));
  });
  await t.test('planned silent footage gets exactly three seconds of silence without generating speech', async () => {
    const manifest = manifestFor('silent'), work = join(root, 'silence'); await mkdir(work);
    const clip = { shotId: 'shot-001', path: silent };
    const measured = await preparePerformanceClip({ manifest, shot: manifest.shots[0], clip, work, ffmpeg });
    assert.equal(measured.sourceAudioDurationSeconds, null); assert.equal(measured.audioSelection, 'planned-silence');
    assert.ok((await pcm(clip.audioPath)).every(byte => byte === 0));
    assert.equal((await assembleFilm({ manifest, manifestHash: sha(JSON.stringify(manifest)), clips: [clip], ffmpeg,
      outputPath: join(work, 'silent-film.mp4') })).hasAudio, true);
  });
  await t.test('short, long, audio-missing and undecodable dialogue cannot be padded, truncated or dubbed', async () => {
    const manifest = manifestFor('dialogue'), corrupt = join(root, 'corrupt.mp4'); await writeFile(corrupt, 'not a complete media stream');
    for (const path of [short, long, silent, corrupt]) await assert.rejects(preparePerformanceClip({ manifest, shot: manifest.shots[0],
      clip: { shotId: 'shot-001', path }, work: root, ffmpeg }), error => error.code === 'FILM_PERFORMANCE_REVIEW_REQUIRED');
    await assert.rejects(preparePerformanceClip({ manifest, shot: manifest.shots[0], clip: { shotId: 'shot-001', path: dialogue, audioPath: narration },
      work: root, ffmpeg }), error => finishingFailure(error)?.reason === 'PERFORMANCE_AUDIO_MISMATCH');
    await assert.rejects(assembleFilm({ manifest, manifestHash: sha(JSON.stringify(manifest)), clips: [{ shotId: 'shot-001', path: long }],
      outputPath: join(root, 'must-not-trim-dialogue.mp4'), ffmpeg }), error => finishingFailure(error)?.reason === 'PERFORMANCE_DURATION_MISMATCH');
  });
  await t.test('narration that exceeds its timeline is rejected without shortening its speech', async () => {
    const manifest = manifestFor('narration'), before = sha(await readFile(tooLong));
    await assert.rejects(preparePerformanceClip({ manifest, shot: manifest.shots[0], clip: { shotId: 'shot-001', path: silent, audioPath: tooLong },
      work: root, ffmpeg }), error => finishingFailure(error)?.reason === 'PERFORMANCE_DURATION_MISMATCH');
    assert.equal(sha(await readFile(tooLong)), before);
  });
  await t.test('actual narration receipt distinguishes provider source bytes from the padded selected track', async () => {
    const manifest = manifestFor('narration'), manifestHash = sha(JSON.stringify(manifest)), email = 'fictional@example.invalid';
    const id = '00000000-0000-4000-8000-000000000003', work = join(root, 'proof'); await mkdir(work);
    const output = { url: 'https://media.example.invalid/video.mp4', sizeBytes: (await readFile(silent)).length,
      audio: { url: 'https://media.example.invalid/voice.wav', sizeBytes: (await readFile(narration)).length } };
    output.performance = { version: 1, recipe: FILM_PERFORMANCE_RECIPE, ...manifest.shots[0].performance,
      textSha256: sha(manifest.shots[0].performance.text), videoOperationId: 'a'.repeat(64), speechOperationId: 'b'.repeat(64),
      sourceVideoUrlSha256: sha(output.url), outputVideoUrlSha256: sha(output.url), audioUrlSha256: sha(output.audio.url) };
    delete output.performance.text;
    const job = { id, ownerHash: digest(email), manifest, manifestHash, status: 'awaiting-assembly', shots: [{ id: 'shot-001', status: 'completed', output }] };
    const records = new Map([[`production/jobs/${digest(email)}/${id}.json`, { value: job }]]);
    const read = async path => records.get(path), write = async (path, value) => records.set(path, { value });
    const clips = [{ shotId: 'shot-001', path: silent, audioPath: narration }], stillOwned = async () => true;
    const observations = await prepareFilmPerformance({ job, clips, work, ffmpeg, stillOwned });
    assert.equal(observations[0].providerAudioSha256, sha(await readFile(narration)));
    assert.equal(observations[0].selectedAudioContainerSha256, sha(await readFile(clips[0].audioPath)));
    assert.notEqual(observations[0].providerAudioSha256, observations[0].selectedAudioContainerSha256);
    const speechReview = { version: 1, method: 'local-speech-transcription', passed: true, shots: [{ shotId: 'shot-001', scriptMatched: true }] };
    // The recognizer boundary is synthetic here; this test proves byte provenance,
    // complete local decode, and padding, not speech or provider-quality acceptance.
    const review = await storeFilmPerformanceReview({ email, id, job, clips, observations, artifactSha256: 'f'.repeat(64), speechReview, stillOwned }, { read, write });
    await verifyFilmPerformanceReceipts({ email, id, manifest, manifestHash, artifactSha256: 'f'.repeat(64), speechReview, review }, { read });
  });
  await t.test('the actual score mix preserves every speech sample position with fixed gains and no normalization', async () => {
    const score = join(root, 'synthetic-score.wav');
    await run(['-n', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '3', '-af', 'volume=0.4',
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', score]);
    const speech = join(root, 'narration', 'shot-001-performance.wav');
    const inputSpeech = await pcm(speech), inputScore = await pcm(score);
    const mixed = await run(['-i', speech, '-i', score, '-filter_complex',
      ['[0:a:0]anull[speech]', ...performanceMusicFilters(1, 3)].join(';'), '-map', '[audio]', '-c:a', 'pcm_f32le', '-f', 'f32le', '-']);
    assert.equal(mixed.length, inputSpeech.length * 2);
    let maximumError = 0;
    for (let offset = 0; offset < inputSpeech.length; offset += 2) {
      const wanted = 0.95 * inputSpeech.readInt16LE(offset) / 32768 + 0.25 * inputScore.readInt16LE(offset) / 32768;
      maximumError = Math.max(maximumError, Math.abs(mixed.readFloatLE(offset * 2) - wanted));
    }
    assert.ok(maximumError < 0.000001, `Fixed additive sample error: ${maximumError}`);
    const manifest = manifestFor('dialogue'); manifest.sound = { musicRequested: true };
    const receipt = { version: 1, requested: true, recipe: 'original-midi-fluidr3-performance-v1', durationSeconds: 3,
      midiSha256: 'a'.repeat(64), midiBytes: 32, scoreSha256: sha(await readFile(score)), scoreBytes: (await readFile(score)).length,
      soundfontSha256: 'b'.repeat(64), soundfontPackage: 'fluid-soundfont-gm', soundfontPackageVersion: '3.1-5.3',
      maximumScorePeak: 0.1, speechGain: 0.95, scoreGain: 0.25, speechOffsetSamples: 0, sampleRate: 48000, channels: 2 };
    await verifyPerformanceMusicMedia({ music: { path: score, receipt }, manifest, ffmpeg });
    const report = await assembleFilm({ manifest, manifestHash: sha(JSON.stringify(manifest)), clips: [{ shotId: 'shot-001', path: dialogue }],
      music: { path: score, receipt }, ffmpeg, outputPath: join(root, 'dialogue-with-score.mp4') });
    assert.deepEqual(report.music, receipt); assert.equal(report.durationSeconds, 3);
    await assert.rejects(assembleFilm({ manifest, manifestHash: sha(JSON.stringify(manifest)), clips: [{ shotId: 'shot-001', path: dialogue }],
      ffmpeg, outputPath: join(root, 'must-not-drop-music.mp4') }));
    for (const altered of [{ ...receipt, scoreSha256: 'f'.repeat(64) }, { ...receipt, speechOffsetSamples: 4800 },
      { ...receipt, speechGain: 0.9 }, { ...receipt, durationSeconds: 4 }])
      await assert.rejects(verifyPerformanceMusicMedia({ music: { path: score, receipt: altered }, manifest, ffmpeg }));
    const loud = { ...receipt, scoreSha256: sha(await readFile(narration)), scoreBytes: (await readFile(narration)).length };
    await assert.rejects(verifyPerformanceMusicMedia({ music: { path: narration, receipt: loud }, manifest, ffmpeg }));
  });
  await t.test('a music request cannot be silently omitted and score-builder bytes must match its receipt', async () => {
    const manifest = manifestFor('silent'), work = join(root, 'builder'); await mkdir(work);
    let calls = 0;
    assert.deepEqual(await buildPerformanceMusic({ manifest, manifestHash: sha(JSON.stringify(manifest)), work },
      { build: async () => { calls++; } }), { receipt: { requested: false } });
    assert.equal(calls, 0); manifest.sound = { musicRequested: true };
    await assert.rejects(buildPerformanceMusic({ manifest, manifestHash: sha(JSON.stringify(manifest)), work },
      { build: async () => ({ requested: false }) }));
  });
});
