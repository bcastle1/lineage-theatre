import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { buildFilmManifest, createFilmProductionService, fictionalOperatorProject, productionJobPath } from '../api/_lib/film-production.mjs';
import { createFilmLibraryService } from '../api/_lib/film-library.mjs';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
const source = ts.transpileModule(await readFile(new URL('../src/studio/film-library.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { productionLabel, libraryCanWatch } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const at = Date.parse('2026-11-05T20:00:00Z'), id = '11111111-1111-4111-8111-111111111111';
const actor = { email: OWNER_EMAIL, role: 'owner' }, failure = { stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH' };
function fixture() {
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject());
  const job = { version: 1, revision: 1, id, filmId: manifest.filmId, ownerHash: digest(actor.email), mode: 'operator-test',
    manifest, manifestHash, status: 'awaiting-assembly', createdAt: new Date(at - 1000).toISOString(), updatedAt: new Date(at).toISOString(),
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed' })) };
  const path = productionJobPath(actor.email, id), records = new Map([[path, { value: job, etag: 'original' }],
    [userPath(actor.email), { value: actor, etag: 'actor' }]]);
  let revision = 0, beforeWrite;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (beforeWrite) await beforeWrite(path, value);
    if (records.get(path)?.etag !== etag) throw Error('precondition failed');
    records.set(path, { value: structuredClone(value), etag: String(++revision) });
  };
  const film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now: () => at,
    verifyAssembledMedia: async ({ artifact }) => artifact });
  const library = createFilmLibraryService({ read, write, now: () => at });
  const input = { email: actor.email, id, manifestHash, failure, needsAttention: true, stillOwned: async () => true };
  return { job, path, records, read, write, film, library, input, beforeWrite: value => { beforeWrite = value; } };
}
test('an owned terminal finishing failure reaches Needs attention without a queue ticket or playable-media claim', async () => {
  const f = fixture(); assert.equal(await f.film.recordFinishingFailure({ ...f.input, failure: { ...failure, message: 'private-provider-url' } }), true);
  const saved = (await f.read(f.path)).value;
  assert.deepEqual(saved.finishingFailure, { version: 1, manifestHash: f.job.manifestHash, ...failure, state: 'attention', recordedAt: new Date(at).toISOString() });
  const { entry } = await f.library.detail(actor, { kind: 'plan', id });
  assert.equal(entry.production.needsAttention, true); assert.equal(entry.production.progress.stage, 'attention');
  assert.equal(entry.production.progress.percent, null); assert.equal(productionLabel(entry), 'Needs attention');
  assert.equal(libraryCanWatch(entry), false); assert.equal(entry.mediaUrl, undefined);
  assert.doesNotMatch(JSON.stringify(entry), /private-provider-url|finishingFailure|VISUAL_CONTINUITY_MISMATCH/);
  assert.equal((await f.film.status({ email: actor.email, id })).needsAttention, true);
});
test('expired or replaced finishing claim, foreign manifest and unrecognized diagnostics cannot write a failure', async () => {
  for (const change of [{ stillOwned: async () => false }, { manifestHash: 'f'.repeat(64) },
    { failure: { stage: 'visual-review', reason: 'private-provider-url' } }, { failure: { stage: 'unknown', reason: failure.reason } },
    { stillOwned: undefined }, { needsAttention: 'yes' }]) {
    const f = fixture(); assert.equal(await f.film.recordFinishingFailure({ ...f.input, ...change }), false);
    assert.equal((await f.read(f.path)).value.finishingFailure, undefined);
  }
});
test('completed media wins before recording and during the conditional write; stale failure cannot overwrite it', async () => {
  for (const duringWrite of [false, true]) {
    const f = fixture(), completed = { ...structuredClone(f.job), status: 'completed', media: { sha256: 'b'.repeat(64) } };
    if (duringWrite) f.beforeWrite(() => { f.records.set(f.path, { value: completed, etag: 'completed' }); });
    else f.records.set(f.path, { value: completed, etag: 'completed' });
    assert.equal(await f.film.recordFinishingFailure(f.input), false);
    assert.deepEqual((await f.read(f.path)).value, completed);
  }
});
test('the first terminal failure is retained and cannot be downgraded by a later transient failure', async () => {
  const f = fixture(); await f.film.recordFinishingFailure(f.input);
  const original = await f.read(f.path);
  assert.equal(await f.film.recordFinishingFailure({ ...f.input, failure: { stage: 'download', reason: 'DOWNLOAD_FAILED' }, needsAttention: false }), false);
  assert.deepEqual(await f.read(f.path), original);
});
test('retryable finishing remains active and successful verified completion clears its transient marker', async () => {
  const f = fixture(); await f.film.recordFinishingFailure({ ...f.input, needsAttention: false, failure: { stage: 'download', reason: 'DOWNLOAD_FAILED' } });
  const { entry } = await f.library.detail(actor, { kind: 'plan', id });
  assert.equal(entry.production.needsAttention, false); assert.equal(entry.production.progress.stage, 'finishing');
  const artifact = { playable: true, manifestHash: f.job.manifestHash, pathname: `production/media/${digest(actor.email)}/${id}/${'b'.repeat(64)}.mp4`,
    sha256: 'b'.repeat(64), contentType: 'video/mp4', sizeBytes: 100, durationSeconds: 15, width: 1920, height: 1080, frameRate: 24 };
  await f.film.acceptAssembly({ email: actor.email, id, manifestHash: f.job.manifestHash, artifact, stillOwned: async () => true });
  const saved = (await f.read(f.path)).value; assert.equal(saved.status, 'completed'); assert.equal(saved.finishingFailure, undefined);
});
