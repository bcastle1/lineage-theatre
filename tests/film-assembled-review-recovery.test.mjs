import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, decision, response, hash } from './fixtures/assembled-review-recovery.mjs';
import { createAssembledReviewRecovery, assembledReviewRecoveryPath } from '../api/_lib/film-assembled-review-recovery.mjs';
import { createFilmVisualReviewService, verifyFilmVisualReceipts } from '../api/_lib/film-visual-review.mjs';
import { FILM_DISCLOSURE } from '../api/_lib/film-overlays.mjs';

const reviewerFor = (h, fetchImpl, extra = {}) => createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now,
  key: 'synthetic-only', authorize: async () => true, fetchImpl, ...extra });
const delivery = (h, proofs) => ({ email: h.email, id: h.input.id, manifestHash: h.input.manifestHash,
  manifest: h.value(h.jobPath).manifest, artifact: h.assembledArtifact,
  review: { version: 1, manifestHash: h.input.manifestHash, passed: true, shots: proofs } });

test('v6 changes only review order, retaining payment, source outputs, editorial directions and every prior decision', async () => {
  const h = await fixture(), before = h.value(h.jobPath), order = h.value(h.orderPath);
  const history = [...h.records].filter(([path]) => /visual-review-(?:recoveries|bindings)\/|visual-reviews\//.test(path));
  const count = h.writes.length;
  const plan = await h.service(h.input);
  assert.equal(plan.status, 'planned'); assert.equal(plan.reviewStage, 'assembled-film'); assert.equal(h.writes.length, count);
  const applied = await h.apply();
  assert.equal(applied.maximumNewVideoRequests, 0); assert.equal(applied.additionalReviewAllowance, 1); assert.equal(applied.reusedPassingReviews, 3);
  const after = h.value(h.jobPath);
  for (const field of ['manifest', 'shots', 'visualReviewRecovery', 'visualEvidenceRecovery', 'visualEditorialRecovery', 'visualFinalEditorialRecovery'])
    assert.deepEqual(after[field], before[field]);
  assert.deepEqual(h.value(h.orderPath), order);
  for (const [path, record] of history) assert.deepEqual(h.records.get(path), record);
  const savedWrites = h.writes.length;
  assert.equal((await h.apply()).status, 'already-resumed'); assert.equal(h.writes.length, savedWrites);
});

test('only the ending is freshly reviewed from final global frames, with all canonical overlays required and three v4 proofs reused', async () => {
  const h = await fixture(); await h.apply(); const requests = [];
  const reviewer = reviewerFor(h, async (_url, init) => { requests.push(JSON.parse(init.body)); return response(decision()); });
  const proofs = [];
  for (let i = 0; i < 4; i++) proofs.push(await reviewer(h.reviewInput(i)));
  assert.deepEqual(proofs.slice(0, 3), h.passingProofs); assert.deepEqual(proofs.map(proof => proof.reviewVersion), [4, 4, 4, 6]);
  assert.equal(requests.length, 1);
  const request = requests[0], scene = JSON.parse(request.input[0].content[0].text).scene;
  assert.equal(scene.reviewStage, 'assembled-film'); assert.equal(scene.renderedDisclosure.text, FILM_DISCLOSURE);
  assert.equal(scene.renderedDisclosure.startMs, h.value(h.jobPath).manifest.shots[3].startMs);
  assert.match(request.instructions, /FINAL ASSEMBLED FILM/); assert.match(request.instructions, /MUST now be visible and correctly spelled/);
  assert.doesNotMatch(request.instructions, /before final assembly|overlays are added later/);
  assert.equal(scene.editorialRevision.revisedAction, 'He offers the pencil to the child.');
  assert.equal(proofs[0].editorialRevision.revisedAction, 'After the writing, they exchange a smile.');
  assert.deepEqual(scene.appliedTextCorrections, h.value(h.jobPath).visualReviewRecovery.textCorrections);
  const binding = h.value(proofs[3].receiptPath).binding;
  assert.deepEqual(binding.sampleTimes, h.reviewInput(3).frames.map(frame => frame.atMs));
  assert.notDeepEqual(binding.frameHashes, h.value(h.prior.receiptPath).binding.frameHashes);
  assert.deepEqual(binding.assembledArtifact, h.assembledArtifact); assert.deepEqual(proofs[3].assembledArtifact, h.assembledArtifact);
  await verifyFilmVisualReceipts(delivery(h, proofs), { read: h.read });
  assert.deepEqual(await reviewer(h.reviewInput(3)), proofs[3]); assert.equal(requests.length, 1);
  for (const artifact of [undefined, { ...h.assembledArtifact, sha256: 'c'.repeat(64) }, { ...h.assembledArtifact, sizeBytes: 4001 },
    { ...h.assembledArtifact, durationSeconds: h.assembledArtifact.durationSeconds + .01 }])
    await assert.rejects(verifyFilmVisualReceipts({ ...delivery(h, proofs), artifact }, { read: h.read }));
  const forged = structuredClone(proofs); forged[3].assembledArtifact.sha256 = 'c'.repeat(64);
  await assert.rejects(verifyFilmVisualReceipts(delivery(h, forged), { read: h.read }));
});

test('missing artifact, local source times, wrong target, unbounded artifact and extra artifact fields stop before inference or claim', async () => {
  const h = await fixture(); await h.apply(); let calls = 0;
  const reviewer = reviewerFor(h, async () => { calls++; return response(decision()); });
  const invalid = [h.rawReviewInput(3), { ...h.reviewInput(0), assembledArtifact: h.assembledArtifact }];
  const local = h.reviewInput(3); local.frames = h.rawReviewInput(3).frames; invalid.push(local);
  for (const patch of [{ sha256: 'invalid' }, { sizeBytes: 0 }, { durationSeconds: 99 }, { path: 'untrusted.mp4' }])
    invalid.push({ ...h.reviewInput(3), assembledArtifact: { ...h.assembledArtifact, ...patch } });
  const count = h.writes.length;
  for (const input of invalid) await assert.rejects(reviewer(input));
  assert.equal(calls, 0); assert.equal(h.writes.length, count);
});

test('v6 never forces a pass or grants a second review for altered artifact bytes or JPEG encoding', async () => {
  for (const mode of ['mismatch', 'unverifiable', 'lost']) {
    const h = await fixture(); await h.apply(); let calls = 0;
    const reviewer = reviewerFor(h, async () => { calls++; if (mode === 'lost') throw Error('Synthetic lost response');
      return response({ ...decision(), sceneAction: mode, findings: [mode === 'mismatch' ? 'wrong-action-or-setting' : 'insufficient-visible-evidence'] }); });
    if (mode === 'lost') { await assert.rejects(reviewer(h.reviewInput(3))); await assert.rejects(reviewer(h.reviewInput(3))); }
    else { const proof = await reviewer(h.reviewInput(3)); assert.equal(proof.passed, false); assert.deepEqual(await reviewer(h.reviewInput(3)), proof);
      await assert.rejects(verifyFilmVisualReceipts(delivery(h, [...h.passingProofs, { ...proof, passed: true }]), { read: h.read })); }
    const artifactChanged = h.reviewInput(3); artifactChanged.assembledArtifact.sha256 = 'c'.repeat(64);
    await assert.rejects(reviewer(artifactChanged));
    const pixelsChanged = h.reviewInput(3); pixelsChanged.frames[0].dataUrl = h.dataUrl;
    await assert.rejects(reviewer(pixelsChanged)); assert.equal(calls, 1);
  }
});

test('eligibility requires exact prior v5 rejection, all passing reviews, unchanged source and original unrefunded payment', async () => {
  for (const change of [
    h => h.records.delete(h.passingProofs[1].receiptPath),
    h => h.mutate(h.prior.receiptPath, receipt => { receipt.decision.appearance = 'mismatch'; }),
    h => h.mutate(h.prior.receiptPath, receipt => { receipt.bindingHash = 'a'.repeat(64); }),
    h => h.mutate(h.jobPath, job => { job.shots[3].output.sizeBytes++; }),
    h => h.mutate(h.orderPath, order => { order.status = 'refunded'; }),
    h => h.seed(`production/visual-review-bindings/${h.job.ownerHash}/${h.job.id}/unknown/${'a'.repeat(64)}.json`, {}),
    h => { h.input.revisedAction = 'Unapproved revision.'; },
  ]) {
    const h = await fixture(); change(h); const count = h.writes.length;
    await assert.rejects(h.apply()); assert.equal(h.writes.length, count);
  }
});

test('single-flight reads are fresh at each inference gate and revocation prevents any reviewed receipt', async () => {
  const h = await fixture(); await h.apply(); const counts = new Map(); let calls = 0, authorizations = 0;
  const reviewer = reviewerFor(h, async () => { calls++;
    h.mutate(assembledReviewRecoveryPath(h.value(h.jobPath)), grant => { grant.sourceOutputHash = 'c'.repeat(64); });
    return response(decision());
  }, { read: async path => { counts.set(path, (counts.get(path) || 0) + 1); return h.read(path); }, authorize: async () => { authorizations++; return true; } });
  await assert.rejects(reviewer(h.reviewInput(3))); assert.equal(calls, 1); assert.equal(authorizations, 3);
  // Every chain validator requests the job, but each gate has one immutable
  // snapshot read. The post-inference gate must independently detect revocation.
  assert.equal(counts.get(h.jobPath), 3);
  // Revocation stops the third gate before it reads this grant's old receipt.
  assert.equal(counts.get(h.prior.receiptPath), 2);
  assert.equal([...h.records.values()].filter(record => record.value.version === 6 && record.value.state === 'reviewed').length, 0);
  await assert.rejects(reviewer(h.reviewInput(3))); assert.equal(calls, 1);
});

test('lost recovery writes adopt the exact saved grant without changing review scope', async () => {
  const h = await fixture(); let lost = false;
  const service = createAssembledReviewRecovery({ ...h.options, write: async (path, value, etag) => {
    await h.write(path, value, etag); if (!lost && path === h.jobPath) { lost = true; throw Error('Synthetic lost reply'); }
  } });
  assert.equal((await service(h.input, { apply: true })).status, 'resumed'); assert.equal(lost, true);
  assert.equal(h.value(h.queuePath).assembledVisualReviewRecoveryHash, hash(h.value(h.jobPath).assembledVisualReviewRecovery));
});
