import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { digest } from '../api/_lib/auth.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { extractVisualFrame, createRemoteVisualReview, createFilmVisualReviewer } from '../scripts/review-film-visuals.mjs';
import { createWorkerAssembly } from '../scripts/production-worker.mjs';

const email = 'visual-worker@example.invalid', id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('0000ftypisom00000000000000000000');
const failureReason = reason => error => { assert.deepEqual(finishingFailure(error), { stage: 'visual-review', reason }); return true; };
async function fixture() {
  const jpeg = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#667788' } }).jpeg().toBuffer();
  const image = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const manifest = { visualContinuity: { version: 1 }, targetDurationSeconds: 30,
    shots: [0, 0, 1].map((sceneIndex, index) => ({ id: `shot-${index + 1}`, sceneIndex, targetDurationMs: 10000 })) };
  const job = { status: 'awaiting-assembly', manifest, manifestHash: digest(JSON.stringify(manifest)),
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: { url: `https://v3.fal.media/${shot.id}.mp4`,
      contentType: 'video/mp4', sizeBytes: bytes.length, durationSeconds: 10 } })) };
  const clips = manifest.shots.map(shot => ({ shotId: shot.id, path: join(tmpdir(), `${shot.id}.mp4`) }));
  const proof = shotId => ({ version: 1, shotId, manifestHash: job.manifestHash,
    bindingHash: digest(shotId), passed: true, receiptPath: `production/visual-reviews/${digest(email)}/${id}/${digest(shotId)}.json` });
  return { jpeg, image, job, clips, proof, input: { email, id, job, clips, ffmpeg: 'fixture-ffmpeg', stillOwned: async () => true } };
}

test('frame extraction uses local-only ffmpeg protocols, fixed sampling time and bounded photographic output', async () => {
  const f = await fixture(); let called = false;
  const image = await extractVisualFrame({ path: 'C:\\fixture\\a movie.mp4', atMs: 1500, ffmpeg: 'fixture-ffmpeg',
    spawnImpl: (executable, args, options) => {
      called = true; assert.equal(executable, 'fixture-ffmpeg');
      assert.deepEqual(options, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      assert.equal(args[args.indexOf('-ss') + 1], '1.500');
      assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
      assert.equal(args[args.indexOf('-i') + 1], 'C:\\fixture\\a movie.mp4');
      assert.equal(args[args.indexOf('-frames:v') + 1], '1');
      assert.match(args[args.indexOf('-vf') + 1], /scale=768:768:force_original_aspect_ratio=decrease/);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => assert.fail('Successful extraction must not be killed');
      queueMicrotask(() => { child.stdout.write(f.jpeg.subarray(0, 100)); child.stdout.end(f.jpeg.subarray(100)); child.emit('close', 0); });
      return child;
    } });
  assert.equal(called, true); assert.deepEqual(Buffer.from(image.split(',')[1], 'base64'), f.jpeg);
});

test('invalid frame positions, failed extraction and output limits cannot produce reviewable frames', async () => {
  for (const change of [{ atMs: -1 }, { atMs: Infinity }, { atMs: 15001 }, { atMs: 1.5 }, { path: '' }])
    await assert.rejects(extractVisualFrame({ path: 'fixture.mp4', atMs: 1000, ...change,
      spawnImpl: () => assert.fail('Do not start invalid extraction') }), failureReason('VISUAL_REVIEW_REQUIRED'));
  for (const scenario of ['short', 'oversized', 'failed', 'unavailable']) {
    let killed = 0;
    const spawnImpl = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough();
      child.kill = () => { killed++; queueMicrotask(() => child.emit('close', 1)); return true; };
      queueMicrotask(() => {
        if (scenario === 'unavailable') child.emit('error', new Error('Missing executable'));
        else { child.stdout.end(Buffer.alloc(scenario === 'short' ? 99 : scenario === 'oversized' ? 250001 : 200)); child.emit('close', scenario === 'failed' ? 1 : 0); }
      });
      return child;
    };
    await assert.rejects(extractVisualFrame({ path: 'fixture.mp4', atMs: 1000, spawnImpl }), failureReason('VISUAL_REVIEW_UNAVAILABLE'));
    assert.equal(killed, scenario === 'oversized' ? 1 : 0);
  }
});

test('worker samples every cut and compares a preceding sample only at same-scene boundaries', async () => {
  const f = await fixture(), extracts = [], requests = [];
  const work = await mkdtemp(join(tmpdir(), 'lineage-visual-test-'));
  try {
    const reviewer = createFilmVisualReviewer({ extract: async input => { extracts.push(input); return f.image; },
      review: async input => { requests.push(input); return f.proof(input.shotId); } });
    const result = await reviewer({ ...f.input, work });
    assert.equal(extracts.length, 9); assert.equal(requests.length, 3);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.email, email); assert.equal(request.preparedId, id); assert.equal(request.manifestHash, f.job.manifestHash);
      assert.deepEqual(request.frames.slice(0, 3).map(frame => frame.atMs), [1500, 5000, 8500]);
      assert.ok(request.frames.slice(0, 3).every(frame => frame.shotId === f.job.manifest.shots[index].id));
      assert.equal(request.frames.length, index === 1 ? 4 : 3);
    }
    assert.deepEqual(requests[1].frames[3], requests[0].frames[2]);
    assert.equal(result.passed, true); assert.equal(result.sampling, 'three-frames-per-cut-and-same-scene-boundary');
    assert.deepEqual(result.shots, f.job.manifest.shots.map(shot => f.proof(shot.id)));
    assert.deepEqual(JSON.parse(await readFile(join(work, 'visual-review.json'), 'utf8')), result);
    assert.equal(JSON.stringify(result).includes('data:image'), false);
  } finally { if (dirname(resolve(work)) === resolve(tmpdir())) await rm(work, { recursive: true, force: true }); }
});

test('missing, swapped, mismatched or failing visual proofs stop the worker before a passing film report', async () => {
  const f = await fixture();
  for (const mutate of [proof => null, proof => ({ ...proof, version: 2 }), proof => ({ ...proof, shotId: 'wrong-shot' }),
    proof => ({ ...proof, manifestHash: 'a'.repeat(64) }), proof => ({ ...proof, bindingHash: 'not-a-hash' }),
    proof => ({ ...proof, receiptPath: null }), proof => ({ ...proof, passed: false })]) {
    let calls = 0;
    const reviewer = createFilmVisualReviewer({ extract: async () => f.image,
      review: async input => { calls++; return mutate(f.proof(input.shotId)); } });
    await assert.rejects(reviewer(f.input)); assert.equal(calls, 1);
  }
  const reviewer = createFilmVisualReviewer({ extract: () => assert.fail('Do not extract wrong clip'), review: () => assert.fail('Do not review wrong clip') });
  await assert.rejects(reviewer({ ...f.input, clips: [...f.clips].reverse() }), failureReason('VISUAL_REVIEW_REQUIRED'));
});

test('lost worker ownership before extraction or after model review prevents a passing report', async () => {
  const f = await fixture();
  const initial = createFilmVisualReviewer({ extract: () => assert.fail('No extraction without lease'), review: () => assert.fail('No inference without lease') });
  await assert.rejects(initial({ ...f.input, stillOwned: async () => false }), failureReason('WORKER_CLAIM_EXPIRED'));
  let owned = true, requests = 0;
  const during = createFilmVisualReviewer({ extract: async () => f.image,
    review: async input => { requests++; owned = false; return f.proof(input.shotId); } });
  await assert.rejects(during({ ...f.input, stillOwned: async () => owned }), failureReason('WORKER_CLAIM_EXPIRED'));
  assert.equal(requests, 1);
});

test('ownership lost during extraction is rechecked before requesting paid visual inference', async () => {
  const f = await fixture(); let owned = true, requests = 0;
  const reviewer = createFilmVisualReviewer({ extract: async () => { owned = false; return f.image; },
    review: async input => { requests++; return f.proof(input.shotId); } });
  await assert.rejects(reviewer({ ...f.input, stillOwned: async () => owned }), failureReason('WORKER_CLAIM_EXPIRED'));
  assert.equal(requests, 0);
});

test('remote visual review uses the authenticated fixed worker endpoint and bounded responses', async () => {
  const f = await fixture(), input = { email, preparedId: id, manifestHash: f.job.manifestHash, shotId: 'shot-1', frames: [] };
  let calls = 0;
  const review = createRemoteVisualReview({ env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://lineagetheater.com/api/production-worker'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
    assert.deepEqual(JSON.parse(options.body), { action: 'review-film-visuals', ...input });
    return new Response(JSON.stringify(f.proof(input.shotId)));
  } });
  assert.deepEqual(await review(input), f.proof('shot-1')); assert.equal(calls, 1);
  await assert.rejects(createRemoteVisualReview({ env: {}, fetchImpl: () => assert.fail('Missing secret') })(input), failureReason('VISUAL_REVIEW_UNAVAILABLE'));
  for (const response of [() => new Response('{}', { status: 503 }), () => new Response(' '.repeat(4097)), () => new Response('{malformed')])
    await assert.rejects(createRemoteVisualReview({ env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, fetchImpl: async () => response() })(input));
});

test('the assembly worker never assembles or publishes new films without a passing visual review', async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'lineage-visual-gate-test-'));
  try {
    for (const reviewVisuals of [async () => null, async () => ({ passed: false }), async () => { throw new Error('Visual evidence unavailable'); }]) {
      const assemble = createWorkerAssembly({ tempRoot: root, adapter: { available: true, outputHosts: ['v3.fal.media'] },
        fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }),
        reviewVisuals, assemble: () => assert.fail('Do not assemble before visual verification'), putBlob: () => assert.fail('Do not publish unreviewed film') });
      await assert.rejects(assemble({ email, id, job: f.job, stillOwned: async () => true }));
      assert.deepEqual(await readdir(root), []);
    }
  } finally { if (dirname(resolve(root)) === resolve(tmpdir())) await rm(root, { recursive: true, force: true }); }
});

test('legacy films retain their existing assembly workflow without new samples or inference', async () => {
  const f = await fixture(); delete f.job.manifest.visualContinuity;
  assert.equal(await createFilmVisualReviewer({ extract: () => assert.fail('Legacy film needs no extraction'),
    review: () => assert.fail('Legacy film needs no new inference') })(f.input), null);
});
