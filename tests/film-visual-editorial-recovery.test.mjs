import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, hash, decision, response, originalAction, revisedAction } from './fixtures/visual-editorial-recovery.mjs';
import { createVisualEditorialRecovery, visualEditorialRecoveryPath } from '../api/_lib/film-visual-editorial-recovery.mjs';
import { createFilmVisualReviewService, verifyFilmVisualReceipts, stageVisualSceneContext, editorialSceneContext } from '../api/_lib/film-visual-review.mjs';

test('one approved editorial clause is recorded without changing manifest, audio, clips, text corrections or payment', async () => {
  const h = await fixture(), before = h.value(h.jobPath), order = h.value(h.orderPath), receipt = h.value(h.prior.receiptPath), count = h.writes.length;
  assert.equal((await h.service(h.input)).status, 'planned'); assert.equal(h.writes.length, count);
  const result = await h.apply(); assert.equal(result.maximumNewVideoRequests, 0); assert.equal(result.initialExpandedReviews, 3);
  const after = h.value(h.jobPath);
  assert.deepEqual(after.manifest, before.manifest); assert.deepEqual(after.shots, before.shots); assert.deepEqual(h.value(h.orderPath), order);
  assert.deepEqual(after.visualReviewRecovery, before.visualReviewRecovery); assert.deepEqual(after.visualEvidenceRecovery, before.visualEvidenceRecovery);
  assert.deepEqual(h.value(h.prior.receiptPath), receipt);
  const stage = stageVisualSceneContext(after, after.manifest.shots[0]), effective = editorialSceneContext(after, after.manifest.shots[0]);
  assert.ok(stage.visual.includes(originalAction)); assert.ok(effective.visual.includes(revisedAction)); assert.ok(!effective.visual.includes(originalAction));
  assert.deepEqual(editorialSceneContext(after, after.manifest.shots[3]).appliedTextCorrections, before.visualReviewRecovery.textCorrections);
  const writes = h.writes.length; assert.equal((await h.apply()).status, 'already-resumed'); assert.equal(h.writes.length, writes);
});

test('a mismatch, new uncertainty, changed revision, absent old clause or existing later-shot review cannot obtain this recovery', async () => {
  for (const change of [
    h => h.mutate(h.prior.receiptPath, receipt => { receipt.decision.sceneAction = 'mismatch'; }),
    h => h.mutate(h.prior.receiptPath, receipt => { receipt.decision.appearance = 'unverifiable'; }),
    h => { h.input.originalAction = 'A clause that was never saved.'; },
    h => { h.input.revisedAction = h.input.originalAction; },
    h => h.seed(`production/visual-reviews/${h.job.ownerHash}/${h.job.id}/${'a'.repeat(64)}.json`, { version: 2, binding: { shotId: 'shot-002' } }),
    h => h.seed(`production/visual-review-bindings/${h.job.ownerHash}/${h.job.id}/pre-assembly-overlays-v2/${'b'.repeat(64)}.json`, {}),
  ]) {
    const h = await fixture(); change(h); const count = h.writes.length;
    await assert.rejects(h.apply()); assert.equal(h.writes.length, count);
  }
});

test('all four initial v4 reviews use nine samples and final delivery records the first-shot editorial change', async () => {
  const h = await fixture(); await h.apply(); const requests = [];
  const reviewer = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return response(decision()); } });
  const proofs = [];
  for (let i = 0; i < 4; i++) proofs.push(await reviewer(h.reviewInput(i)));
  assert.ok(proofs.every(proof => proof.reviewVersion === 4 && proof.passed)); assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.input[0].content.filter(part => part.type === 'input_image').length === 9));
  const contexts = requests.map(request => JSON.parse(request.input[0].content[0].text));
  assert.ok(contexts[0].scene.visual.includes(revisedAction)); assert.equal(contexts[0].scene.editorialRevision.originalAction, originalAction);
  assert.ok(contexts.slice(1).every(context => !context.scene.editorialRevision));
  assert.deepEqual(contexts[3].scene.appliedTextCorrections, h.value(h.jobPath).visualReviewRecovery.textCorrections);
  assert.deepEqual(h.value(proofs[0].receiptPath).binding.frameHashes, h.value(h.prior.receiptPath).binding.frameHashes);
  const input = { email: h.email, id: h.input.id, manifestHash: h.input.manifestHash, manifest: h.value(h.jobPath).manifest,
    review: { version: 1, manifestHash: h.input.manifestHash, passed: true, shots: proofs } };
  await verifyFilmVisualReceipts(input, { read: h.read });
  assert.deepEqual(await reviewer(h.reviewInput()), proofs[0]); assert.equal(requests.length, 4);
  delete proofs[0].editorialRevision;
  await assert.rejects(verifyFilmVisualReceipts(input, { read: h.read }));
});

test('the revised action never forces a pass, and each clip has one attempt despite alternate frames or lost responses', async () => {
  for (const mode of ['mismatch', 'unverifiable', 'lost']) {
    const h = await fixture(); await h.apply(); let calls = 0;
    const reviewer = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
      fetchImpl: async () => { calls++; if (mode === 'lost') throw Error('Synthetic uncertain inference');
        return response({ ...decision(), sceneAction: mode, findings: [mode === 'mismatch' ? 'wrong-action-or-setting' : 'insufficient-visible-evidence'] }); } });
    if (mode === 'lost') { await assert.rejects(reviewer(h.reviewInput(1))); await assert.rejects(reviewer(h.reviewInput(1))); }
    else { const proof = await reviewer(h.reviewInput(1)); assert.equal(proof.passed, false); assert.deepEqual(await reviewer(h.reviewInput(1)), proof); }
    assert.equal(calls, 1);
  }
});

test('revoked payment, lost approval replies and altered saved editorial grant retain exact recovery boundaries', async () => {
  const h = await fixture(); let lost = false;
  const service = createVisualEditorialRecovery({ ...h.options, write: async (path, value, etag) => {
    await h.write(path, value, etag); if (!lost && path === h.jobPath) { lost = true; throw Error('Synthetic lost reply'); }
  } });
  assert.equal((await service(h.input, { apply: true })).status, 'resumed'); assert.equal(lost, true);
  h.mutate(visualEditorialRecoveryPath(h.value(h.jobPath)), grant => { grant.revisedAction += ' A different action.'; });
  await assert.rejects(service(h.input, { apply: true }));
  const revoked = await fixture(); revoked.mutate(revoked.orderPath, order => { order.status = 'refunded'; });
  await assert.rejects(revoked.apply()); assert.equal(revoked.value(revoked.queuePath).state, 'attention');
});
