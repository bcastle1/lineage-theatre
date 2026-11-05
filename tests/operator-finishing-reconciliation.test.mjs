import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOperatorFinishingReconciler } from '../scripts/reconcile-operator-finishing.mjs';
import { buildFilmManifest, fictionalOperatorProject, productionJobPath } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { visualReceiptPath } from '../api/_lib/film-visual-review.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
const now = Date.parse('2026-11-05T20:00:00Z'), id = '11111111-1111-4111-8111-111111111111', email = OWNER_EMAIL;
function fixture() {
  const manifest = planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest, { characterBindingVersion: 2 });
  const manifestHash = digest(JSON.stringify(manifest)), ownerHash = digest(email);
  const job = { version: 1, revision: 1, id, filmId: manifest.filmId, mode: 'operator-test', ownerHash, manifest, manifestHash,
    status: 'awaiting-assembly', provider: { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION },
    createdAt: new Date(now - 600_000).toISOString(), updatedAt: new Date(now - 1000).toISOString(),
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: { url: `https://v3.fal.media/${shot.id}.mp4`,
      contentType: 'video/mp4', sizeBytes: 1000, durationSeconds: shot.targetDurationMs / 1000 } })) };
  const binding = { version: 1, manifestHash, shotId: job.shots[0].id, outputHash: digest(JSON.stringify(job.shots[0].output)),
    precedingOutputHash: null, frameHashes: ['a', 'b', 'c'].map(value => value.repeat(64)) }, bindingHash = digest(JSON.stringify(binding));
  const receipt = { version: 1, state: 'reviewed', model: STORY_MODEL, binding, bindingHash, reviewedAt: new Date(now - 1000).toISOString(),
    decision: { appearance: 'consistent', wardrobe: 'mismatch', sceneAction: 'consistent', imageIntegrity: 'consistent', findings: ['wardrobe-change'] } };
  const jobPath = productionJobPath(email, id), receiptPath = visualReceiptPath(ownerHash, id, bindingHash);
  const leasePath = `production/operator-canaries/${ownerHash}/${id}/finishing-lease.json`;
  const records = new Map([[jobPath, { value: job, etag: 'job' }], [receiptPath, { value: receipt, etag: 'receipt' }],
    [userPath(email), { value: { email, role: 'owner' }, etag: 'actor' }]]), writes = [];
  let revision = 0, beforeWrite, afterWrite;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (beforeWrite) await beforeWrite(path, value);
    if (records.get(path)?.etag !== etag) throw Error('precondition failed');
    records.set(path, { value: structuredClone(value), etag: String(++revision) }); writes.push(path);
    if (afterWrite) await afterWrite(path, value);
  };
  return { job, receipt, records, jobPath, receiptPath, leasePath, writes, input: { email, id, manifestHash, bindingHash },
    reconcile: createOperatorFinishingReconciler({ read, write, now: () => now, uuid: () => 'synthetic-finishing-claim' }),
    beforeWrite: fn => { beforeWrite = fn; }, afterWrite: fn => { afterWrite = fn; } };
}
test('planning historical failure reconciliation is read-only and identifies only its bound fixed-code change', async () => {
  const f = fixture(), before = structuredClone([...f.records]);
  const plan = await f.reconcile(f.input);
  assert.equal(plan.status, 'planned'); assert.equal(plan.canApply, true); assert.equal(plan.providerSubmissions, 0);
  assert.deepEqual(plan.failure, { stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH' });
  assert.deepEqual([...f.records], before); assert.deepEqual(f.writes, []);
  assert.doesNotMatch(JSON.stringify(plan), /v3.fal.media|wardrobe-change|frameHashes|screenplay/);
});
test('approved in-memory reconciliation changes only the exact job diagnostic and its owned lease', async () => {
  const f = fixture(), receipt = structuredClone(f.records.get(f.receiptPath));
  const result = await f.reconcile(f.input, { apply: true });
  assert.equal(result.changed, true); assert.equal(f.records.get(f.jobPath).value.finishingFailure.state, 'attention');
  assert.equal(f.records.get(f.leasePath).value.token, null); assert.deepEqual(f.records.get(f.receiptPath), receipt);
  assert.ok(f.writes.every(path => [f.jobPath, f.leasePath].includes(path)));
  const writes = f.writes.length;
  assert.equal((await f.reconcile(f.input, { apply: true })).changed, false); assert.equal(f.writes.length, writes);
});
test('active claims, foreign or changed receipts, completed media and nonfixed operator content cannot be reconciled', async () => {
  const busy = fixture(); busy.records.set(busy.leasePath, { value: { token: 'another-worker', expiresAt: now + 1000 }, etag: 'busy' });
  assert.equal((await busy.reconcile(busy.input)).canApply, false);
  await assert.rejects(busy.reconcile(busy.input, { apply: true }), { code: 'FINISHING_RECONCILIATION_BUSY' }); assert.equal(busy.writes.length, 0);
  for (const change of [f => { f.receipt.binding.manifestHash = 'f'.repeat(64); },
    f => { f.receipt.decision.wardrobe = 'consistent'; f.receipt.decision.findings = []; },
    f => { f.job.shots[0].output.sizeBytes++; }, f => { f.receipt.model = 'unreviewed-model'; },
    f => { f.job.status = 'completed'; f.job.media = { sha256: 'b'.repeat(64) }; },
    f => { f.job.manifest.screenplay.logline += ' Different customer film.'; },
    f => { f.records.get(userPath(email)).value.status = 'suspended'; }]) {
    const f = fixture(); change(f); await assert.rejects(f.reconcile(f.input, { apply: true })); assert.equal(f.writes.length, 0);
  }
});
test('a replacement claim or concurrent completion after planning cannot be overwritten', async () => {
  const stolen = fixture(); stolen.afterWrite(path => { if (path === stolen.leasePath) stolen.records.set(path, { value: {
    token: 'replacement-claim', manifestHash: stolen.input.manifestHash, expiresAt: now + 1000 }, etag: 'new-owner' }); });
  await assert.rejects(stolen.reconcile(stolen.input, { apply: true }), { code: 'FINISHING_RECONCILIATION_CHANGED' });
  assert.equal(stolen.records.get(stolen.jobPath).value.finishingFailure, undefined);
  assert.equal(stolen.records.get(stolen.leasePath).value.token, 'replacement-claim');
  const complete = fixture(); complete.beforeWrite(path => { if (path === complete.jobPath) complete.records.set(path, {
    value: { ...structuredClone(complete.job), status: 'completed', media: { sha256: 'c'.repeat(64) } }, etag: 'completed' }); });
  await assert.rejects(complete.reconcile(complete.input, { apply: true }), { code: 'FINISHING_RECONCILIATION_CHANGED' });
  assert.equal(complete.records.get(complete.jobPath).value.status, 'completed'); assert.equal(complete.records.get(complete.jobPath).value.finishingFailure, undefined);
});
test('the command rejects apply without its separate explicit flag before private reads', () => {
  const script = fileURLToPath(new URL('../scripts/reconcile-operator-finishing.mjs', import.meta.url)), f = fixture();
  const run = spawnSync(process.execPath, [script, 'apply', id, f.input.manifestHash, f.input.bindingHash], {
    encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test' } });
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).code, 'FINISHING_RECONCILIATION_USAGE');
});
