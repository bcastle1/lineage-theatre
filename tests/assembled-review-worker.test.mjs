import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWorkerAssembly } from '../scripts/production-worker.mjs';
import { digest } from '../api/_lib/auth.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

const sourceBytes = Buffer.from('0000ftypisom00000000000000000000');
const filmBytes = Buffer.from('0000ftypisomassembled00000000000');
const correctedBytes = Buffer.from('0000ftypisomcorrected00000000000');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lineage-assembled-review-'));
  const manifest = { visualContinuity: { version: 1 }, productionPlan: { provider: 'seedance', version: 1 },
    targetDurationSeconds: 20, shots: [0, 1, 2, 3].map(index => ({ id: `shot-00${index + 1}`, startMs: index * 5000, targetDurationMs: 5000 })) };
  const manifestHash = digest(JSON.stringify(manifest)), events = [], publications = [], hooks = {};
  let owned = true;
  const job = { status: 'awaiting-assembly', manifest, manifestHash,
    assembledVisualReviewRecovery: { policy: 'assembled-ending-review-v6', shotId: 'shot-004' },
    visualReviewRecovery: { textCorrections: [{ shotId: 'shot-004' }] },
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: {
      url: `https://media.example.invalid/${shot.id}.mp4`, contentType: 'video/mp4',
      sizeBytes: sourceBytes.length, sha256: digest(sourceBytes), durationSeconds: 5 } })) };
  const report = { manifestHash, sha256: digest(filmBytes), sizeBytes: filmBytes.length, contentType: 'video/mp4',
    durationSeconds: 20, width: 1920, height: 1080, frameRate: 24, hasAudio: true, playable: true, technicalSample: false,
    audioReview: { passed: true, source: 'seedance-native', verification: 'audio-decode-and-duration', transcriptVerified: false } };
  const input = { email: 'fictional@example.invalid', id: '00000000-0000-4000-8000-000000000001', job, stillOwned: async () => owned };
  const options = { tempRoot: root, adapter: { available: true, outputHosts: ['media.example.invalid'] },
    fetchImpl: async () => new Response(sourceBytes, { headers: { 'content-type': 'video/mp4' } }),
    recoveryFor: async () => true,
    applyTextCorrections: async ({ clips, work }) => {
      events.push('correct'); const corrected = join(work, 'corrected-ending.mp4');
      await writeFile(corrected, correctedBytes); return clips.map((clip, index) => index === 3 ? { ...clip, path: corrected } : clip);
    },
    assemble: async ({ clips, outputPath }) => {
      events.push('assemble'); assert.deepEqual(await readFile(clips[3].path), correctedBytes);
      await writeFile(outputPath, filmBytes); await writeFile(outputPath + '.vtt', 'WEBVTT\n');
      await hooks.assemble?.(); return structuredClone(report);
    },
    reviewVisuals: async input => {
      events.push('review'); assert.deepEqual(await readFile(input.assembled.path), filmBytes);
      assert.deepEqual({ ...input.assembled, path: undefined }, { path: undefined, sha256: digest(filmBytes), sizeBytes: filmBytes.length, durationSeconds: 20 });
      await hooks.review?.(input);
      return { version: 1, manifestHash, passed: hooks.passed !== false, shots: [] };
    },
    putBlob: async (pathname, bytes, options) => {
      events.push(pathname.endsWith('.mp4') ? 'upload-film' : 'upload-captions');
      publications.push({ pathname, bytes: Buffer.from(bytes), options });
    },
  };
  return { root, job, report, input, options, events, publications, hooks, revoke: () => { owned = false; },
    finish: () => createWorkerAssembly(options)(input),
    clean: async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); } };
}

test('assembled recovery corrects clips, verifies assembly, reviews final bytes and uploads those exact immutable bytes', async () => {
  const f = await fixture();
  try {
    const artifact = await f.finish();
    assert.deepEqual(f.events, ['correct', 'assemble', 'review', 'upload-film', 'upload-captions']);
    assert.deepEqual(f.publications[0].bytes, filmBytes);
    assert.equal(f.publications[0].options.access, 'private'); assert.equal(f.publications[0].options.allowOverwrite, false);
    assert.equal(artifact.sha256, digest(f.publications[0].bytes)); assert.equal(artifact.visualReview.passed, true);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.clean(); }
});

test('changed final bytes during review cannot be published under the earlier artifact identity', async () => {
  for (const replacement of [Buffer.alloc(filmBytes.length, 1), filmBytes.subarray(0, filmBytes.length - 1)]) {
    const f = await fixture();
    try {
      f.hooks.review = async ({ assembled }) => writeFile(assembled.path, replacement);
      await assert.rejects(f.finish(), error => finishingFailure(error)?.reason === 'STORED_CHECKSUM_MISMATCH');
      assert.deepEqual(f.events, ['correct', 'assemble', 'review']); assert.equal(f.publications.length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.clean(); }
  }
});

test('invalid assembly, unsuccessful review and lost ownership each stop before publication', async () => {
  for (const mode of ['invalid-report', 'review-rejected', 'lease-before-review', 'lease-after-review']) {
    const f = await fixture();
    try {
      if (mode === 'invalid-report') f.report.sha256 = digest('different assembled artifact');
      if (mode === 'review-rejected') f.hooks.passed = false;
      if (mode === 'lease-before-review') f.hooks.assemble = f.revoke;
      if (mode === 'lease-after-review') f.hooks.review = f.revoke;
      await assert.rejects(f.finish()); assert.equal(f.publications.length, 0);
      if (mode === 'invalid-report' || mode === 'lease-before-review') assert.ok(!f.events.includes('review'));
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.clean(); }
  }
});
