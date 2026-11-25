import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, decision, response, originalAction, revisedAction } from './fixtures/visual-final-editorial-recovery.mjs';
import { createVisualFinalEditorialRecovery, visualFinalEditorialRecoveryPath } from '../api/_lib/film-visual-final-editorial-recovery.mjs';
import { createFilmVisualReviewService, verifyFilmVisualReceipts, editorialSceneContext, finalEditorialSceneContext } from '../api/_lib/film-visual-review.mjs';

test('v5 records only the last action revision, retaining all clips, grants, original payment and four v4 decisions', async () => {
  const h = await fixture(), before = h.value(h.jobPath), receipts = h.v4Proofs.map(proof => h.value(proof.receiptPath)), order = h.value(h.orderPath);
  const count = h.writes.length;
  assert.equal((await h.service(h.input)).status, 'planned'); assert.equal(h.writes.length, count);
  const result = await h.apply(); assert.equal(result.maximumNewVideoRequests, 0); assert.equal(result.reusedPassingReviews, 3);
  const after = h.value(h.jobPath);
  assert.deepEqual(after.manifest, before.manifest); assert.deepEqual(after.shots, before.shots); assert.deepEqual(h.value(h.orderPath), order);
  for (const key of ['visualReviewRecovery', 'visualEvidenceRecovery', 'visualEditorialRecovery']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(h.v4Proofs.map(proof => h.value(proof.receiptPath)), receipts);
  const last = after.manifest.shots[3];
  assert.ok(editorialSceneContext(after, last).visual.includes(originalAction));
  assert.ok(finalEditorialSceneContext(after, last).visual.includes(revisedAction));
  const writes = h.writes.length; assert.equal((await h.apply()).status, 'already-resumed'); assert.equal(h.writes.length, writes);
});

test('three v4 passing proofs are reused byte-for-byte; only the last clip receives a fresh truthful v5 review', async () => {
  const h = await fixture(); await h.apply(); const requests = [];
  const reviewer = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return response(decision()); } });
  const proofs = [];
  for (let i = 0; i < 4; i++) proofs.push(await reviewer(h.reviewInput(i)));
  assert.deepEqual(proofs.slice(0, 3), h.passingProofs); assert.deepEqual(proofs.map(proof => proof.reviewVersion), [4, 4, 4, 5]);
  assert.equal(requests.length, 1); assert.equal(requests[0].input[0].content.filter(part => part.type === 'input_image').length, 9);
  const scene = JSON.parse(requests[0].input[0].content[0].text).scene;
  assert.ok(scene.visual.includes(revisedAction)); assert.ok(!scene.visual.includes(originalAction));
  assert.equal(scene.editorialRevision.originalAction, originalAction);
  assert.deepEqual(scene.appliedTextCorrections, h.value(h.jobPath).visualReviewRecovery.textCorrections);
  assert.deepEqual(h.value(proofs[3].receiptPath).binding.frameHashes, h.value(h.prior.receiptPath).binding.frameHashes);
  const input = { email: h.email, id: h.input.id, manifestHash: h.input.manifestHash, manifest: h.value(h.jobPath).manifest,
    review: { version: 1, manifestHash: h.input.manifestHash, passed: true, shots: proofs } };
  await verifyFilmVisualReceipts(input, { read: h.read });
  assert.deepEqual(await reviewer(h.reviewInput(3)), proofs[3]); assert.equal(requests.length, 1);
  delete proofs[3].editorialRevision; await assert.rejects(verifyFilmVisualReceipts(input, { read: h.read }));
});

test('missing or altered passing receipts, a different failure, changed source or a prior extra claim stop approval', async () => {
  for (const change of [
    h => h.records.delete(h.passingProofs[1].receiptPath),
    h => h.mutate(h.passingProofs[0].receiptPath, receipt => { receipt.decision.sceneAction = 'unverifiable'; }),
    h => h.mutate(h.prior.receiptPath, receipt => { receipt.decision.appearance = 'mismatch'; }),
    h => h.mutate(h.prior.receiptPath, receipt => { receipt.bindingHash = 'a'.repeat(64); }),
    h => h.mutate(h.jobPath, job => { job.shots[3].output.sizeBytes++; }),
    h => h.seed(`production/visual-review-bindings/${h.job.ownerHash}/${h.job.id}/unknown/${'a'.repeat(64)}.json`, {}),
    h => { h.input.originalAction = 'Unrecorded action.'; },
  ]) {
    const h = await fixture(); change(h); const count = h.writes.length;
    await assert.rejects(h.apply()); assert.equal(h.writes.length, count);
  }
});

test('v5 never forces a pass or repeats an uncertain or rejected final review', async () => {
  for (const mode of ['mismatch', 'unverifiable', 'lost']) {
    const h = await fixture(); await h.apply(); let calls = 0;
    const reviewer = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
      fetchImpl: async () => { calls++; if (mode === 'lost') throw Error('Synthetic ambiguous response');
        return response({ ...decision(), sceneAction: mode, findings: [mode === 'mismatch' ? 'wrong-action-or-setting' : 'insufficient-visible-evidence'] }); } });
    if (mode === 'lost') { await assert.rejects(reviewer(h.reviewInput(3))); await assert.rejects(reviewer(h.reviewInput(3))); }
    else { const proof = await reviewer(h.reviewInput(3)); assert.equal(proof.passed, false); assert.deepEqual(await reviewer(h.reviewInput(3)), proof); }
    assert.equal(calls, 1);
  }
});

test('lost application replies recover once and changed grants or revoked payment never authorize final review', async () => {
  const h = await fixture(); let lost = false;
  const service = createVisualFinalEditorialRecovery({ ...h.options, write: async (path, value, etag) => {
    await h.write(path, value, etag); if (!lost && path === h.jobPath) { lost = true; throw Error('Synthetic lost reply'); }
  } });
  assert.equal((await service(h.input, { apply: true })).status, 'resumed'); assert.equal(lost, true);
  h.mutate(visualFinalEditorialRecoveryPath(h.value(h.jobPath)), grant => { grant.revisedAction += ' Different direction.'; });
  await assert.rejects(service(h.input, { apply: true }));
  const revoked = await fixture(); revoked.mutate(revoked.orderPath, order => { order.status = 'refunded'; });
  await assert.rejects(revoked.apply()); assert.equal(revoked.value(revoked.queuePath).state, 'attention');
});
