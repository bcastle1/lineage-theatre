import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { digest } from '../api/_lib/auth.mjs';
import { createWorkerAssembly } from '../scripts/production-worker.mjs';

const email = 'text-worker@example.invalid', id = '11111111-1111-4111-8111-111111111111';
const source = Buffer.from('0000ftypisom00000000000000000000');
const corrected = Buffer.from('0000ftypisom11111111111111111111');
const stopAfterAssembly = Error('Synthetic assembly boundary reached');

function fixture(root) {
  const manifest = { productionPlan: { provider: 'seedance' }, visualContinuity: { version: 1 },
    targetDurationSeconds: 30, shots: [0, 1, 2, 3].map(index => ({ id: `shot-${index}`, targetDurationMs: 7500 })) };
  const job = { id, ownerHash: digest(email), status: 'awaiting-assembly', manifest, manifestHash: digest(JSON.stringify(manifest)),
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: {
      url: `https://media.example.invalid/${shot.id}.mp4`, contentType: 'video/mp4', sizeBytes: source.length,
      durationSeconds: 8, sha256: digest(source) } })), visualReviewRecovery: { textCorrections: [{ shotId: 'shot-3' }] } };
  const events = [], read = async () => null;
  const options = { tempRoot: root, adapter: { available: true, outputHosts: ['media.example.invalid'] }, read,
    fetchImpl: async () => new Response(source, { headers: { 'content-type': 'video/mp4' } }),
    recoveryFor: async (value, dependencies) => {
      events.push('validate'); assert.equal(value, job); assert.equal(dependencies.read, read); return job.visualReviewRecovery;
    },
    applyTextCorrections: async ({ clips, work }) => {
      events.push('correct');
      for (const clip of clips) assert.deepEqual(await readFile(clip.path), source);
      const path = join(work, 'corrected-working-clip.mp4'); await writeFile(path, corrected, { flag: 'wx' });
      return clips.map((clip, index) => index === 3 ? { ...clip, path, sourceClipPath: clip.path,
        textCorrection: { version: 1, sourceSha256: digest(source), outputSha256: digest(corrected) } } : clip);
    },
    reviewVisuals: () => assert.fail('Test must define visual review'),
    assemble: () => assert.fail('Test must define assembly'),
    putBlob: () => assert.fail('Test never publishes media') };
  return { job, options, events, input: { email, id, job, stillOwned: async () => true } };
}
async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'lineage-text-integration-'));
  try { await run(root); assert.deepEqual(await readdir(root), []); }
  finally { if (dirname(resolve(root)) === resolve(tmpdir())) await rm(root, { recursive: true, force: true }); }
}

test('worker reviews and assembles the identical approved working clips while preserving all source bytes and job bindings', async () => {
  await withRoot(async root => {
    const f = fixture(root), original = structuredClone(f.job); let reviewed;
    f.options.reviewVisuals = async ({ clips }) => {
      f.events.push('review'); reviewed = clips;
      assert.deepEqual(await readFile(clips[3].path), corrected);
      assert.deepEqual(await readFile(clips[3].sourceClipPath), source);
      for (const clip of clips.slice(0, 3)) assert.deepEqual(await readFile(clip.path), source);
      return { passed: true };
    };
    f.options.assemble = async ({ clips }) => {
      f.events.push('assemble'); assert.equal(clips, reviewed);
      assert.deepEqual(await readFile(clips[3].path), corrected);
      assert.deepEqual(await readFile(clips[3].sourceClipPath), source);
      throw stopAfterAssembly;
    };
    await assert.rejects(createWorkerAssembly(f.options)(f.input), error => error === stopAfterAssembly);
    assert.deepEqual(f.events, ['validate', 'correct', 'validate', 'review', 'assemble']);
    assert.deepEqual(f.job, original);
  });
});

test('invalidated recovery, failed correction, source change or lost lease prevents review and assembly', async () => {
  for (const scenario of ['missing-grant', 'revoked-grant', 'transform-failure', 'source-change', 'lost-lease']) {
    await withRoot(async root => {
      const f = fixture(root); let owned = true, corrections = 0, validations = 0;
      const apply = f.options.applyTextCorrections;
      f.input.stillOwned = async () => owned;
      f.options.recoveryFor = async () => {
        validations++;
        if (scenario === 'missing-grant' || scenario === 'revoked-grant' && validations === 2) return null;
        return f.job.visualReviewRecovery;
      };
      f.options.applyTextCorrections = async input => {
        corrections++;
        if (scenario === 'transform-failure') throw Error('Synthetic correction error');
        const result = await apply(input);
        if (scenario === 'lost-lease') owned = false;
        return result;
      };
      if (scenario === 'source-change') f.job.shots[3].output.sha256 = digest('wrong source');
      await assert.rejects(createWorkerAssembly(f.options)(f.input));
      assert.equal(corrections, ['missing-grant', 'source-change'].includes(scenario) ? 0 : 1);
    });
  }
});
