import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fixture, hash, decision, response } from './fixtures/visual-evidence-recovery.mjs';
import { createVisualEvidenceRecovery, visualEvidenceRecoveryPath, readVisualEvidenceRecovery } from '../api/_lib/film-visual-evidence-recovery.mjs';
import { createFilmVisualReviewService, verifyFilmVisualReceipts } from '../api/_lib/film-visual-review.mjs';

test('evidence recovery preserves paid source clips and both previous decisions, resumes exactly once', async () => {
  const h = await fixture(), source = h.value(h.jobPath), oldReceipt = h.value(h.stageProof.receiptPath), order = h.value(h.orderPath);
  const writeCount = h.writes.length;
  assert.equal((await h.service(h.input)).status, 'planned'); assert.equal(h.writes.length, writeCount);
  const result = await h.apply(); assert.equal(result.maximumNewVideoRequests, 0); assert.equal(result.additionalReviewAllowance, 1);
  assert.equal(h.value(h.queuePath).state, 'pending'); assert.equal(h.value(h.jobPath).finishingFailure.state, 'retrying');
  assert.deepEqual(h.value(h.jobPath).shots, source.shots); assert.deepEqual(h.value(h.jobPath).manifest, source.manifest);
  assert.deepEqual(h.value(h.stageProof.receiptPath), oldReceipt); assert.deepEqual(h.value(h.orderPath), order);
  const count = h.writes.length; assert.equal((await h.apply()).status, 'already-resumed'); assert.equal(h.writes.length, count);
  await readVisualEvidenceRecovery(h.value(h.jobPath), { read: h.read });
});

test('real mismatches, wrong receipts, changed source, missing payment or a live lease cannot authorize recovery', async () => {
  for (const change of [
    h => h.mutate(h.stageProof.receiptPath, v => { v.decision.sceneAction = 'mismatch'; }),
    h => h.mutate(h.stageProof.receiptPath, v => { v.state = 'submitting'; }),
    h => h.mutate(h.stageProof.receiptPath, v => { v.attempts = 2; }),
    h => h.mutate(h.jobPath, v => { v.shots[0].output.sizeBytes++; }),
    h => h.mutate(h.orderPath, v => { v.status = 'refunded'; }),
    h => h.mutate(h.queuePath, v => { v.lease = { token: 'synthetic', expiresAt: h.now() + 1000 }; }),
  ]) {
    const h = await fixture(); change(h); const count = h.writes.length;
    await assert.rejects(h.apply()); assert.equal(h.writes.length, count);
  }
});

test('lost grant/job/queue acknowledgements recover only exact writes without another allowance', async () => {
  for (const match of ['grant', 'job', 'queue']) {
    const h = await fixture(); let lost = false;
    const service = createVisualEvidenceRecovery({ ...h.options, write: async (path, value, etag) => {
      await h.write(path, value, etag);
      if (!lost && (match === 'grant' ? path === visualEvidenceRecoveryPath(h.value(h.jobPath))
        : match === 'job' ? path === h.jobPath : path === h.queuePath)) { lost = true; throw Error('Synthetic lost reply'); }
    } });
    assert.equal((await service(h.input, { apply: true })).status, 'resumed'); assert.equal(lost, true);
    assert.equal((await service(h.input, { apply: true })).status, 'already-resumed');
  }
});

test('expired permission and state changes while authorizing never release the attention queue', async () => {
  for (const mode of ['expired', 'changed']) {
    const h = await fixture();
    const service = createVisualEvidenceRecovery({ ...h.options, authorize: async args => {
      const value = await h.options.authorize(args);
      if (mode === 'expired') value.expiresAt = new Date(h.now() - 1).toISOString();
      else h.mutate(h.queuePath, v => { v.attempts++; });
      return value;
    } });
    await assert.rejects(service(h.input, { apply: true })); assert.equal(h.value(h.queuePath).state, 'attention');
  }
});

test('expanded review binds original frames, explicit reference mode, one new decision and final delivery', async () => {
  const h = await fixture(); await h.apply(); const requests = [];
  const review = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
    fetchImpl: async (_url, init) => { const request = JSON.parse(init.body); requests.push(request); return response(decision()); } });
  const proofs = [];
  for (let index = 0; index < 4; index++) proofs.push(await review(h.reviewInput(index)));
  assert.equal(proofs[0].reviewVersion, 3); assert.deepEqual(proofs.slice(1).map(p => p.reviewVersion), [2, 2, 2]);
  assert.equal(requests[0].input[0].content.filter(v => v.type === 'input_image').length, 9);
  const context = JSON.parse(requests[0].input[0].content[0].text);
  assert.ok(context.characters.every(v => v.appearanceReference === 'description-and-cross-frame-consistency'));
  assert.ok(requests.slice(1).every(request => JSON.parse(request.input[0].content[0].text).characters
    .every(v => v.appearanceReference === 'description-and-cross-frame-consistency')));
  assert.match(requests[0].instructions, /creative description referring to a supplied or labeled portrait does not create/);
  assert.equal(requests[0].text.format.schema.properties.observations.items.properties.sampleIndex.maximum, 9);
  const prior = h.value(h.stageProof.receiptPath), current = h.value(proofs[0].receiptPath);
  assert.deepEqual([current.binding.frameHashes[1], current.binding.frameHashes[4], current.binding.frameHashes[7]], prior.binding.frameHashes);
  await verifyFilmVisualReceipts({ email: h.email, id: h.input.id, manifestHash: h.input.manifestHash,
    manifest: h.value(h.jobPath).manifest, review: { version: 1, manifestHash: h.input.manifestHash, passed: true, shots: proofs } }, { read: h.read });
  assert.deepEqual(await review(h.reviewInput()), proofs[0]); assert.equal(requests.length, 4);
  h.mutate(proofs[0].receiptPath, v => { v.decision.sceneAction = 'unverifiable'; });
  await assert.rejects(verifyFilmVisualReceipts({ email: h.email, id: h.input.id, manifestHash: h.input.manifestHash,
    manifest: h.value(h.jobPath).manifest, review: { version: 1, manifestHash: h.input.manifestHash, passed: true, shots: proofs } }, { read: h.read }));
});

test('v3 insufficient evidence remains an honest failure and never buys another model attempt', async () => {
  const h = await fixture(); await h.apply(); let calls = 0;
  const review = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
    fetchImpl: async () => { calls++; return response({ ...decision(), sceneAction: 'unverifiable', findings: ['insufficient-visible-evidence'] }); } });
  const proof = await review(h.reviewInput()); assert.equal(proof.passed, false); assert.equal(proof.failureReason, 'VISUAL_EVIDENCE_INSUFFICIENT');
  assert.deepEqual(await review(h.reviewInput()), proof); assert.equal(calls, 1);
});

test('concurrent reviews, alternate JPEGs and transport uncertainty cannot repeat the v3 inference', async () => {
  for (const lost of [false, true]) {
    const h = await fixture(); await h.apply(); let calls = 0;
    const review = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
      fetchImpl: async () => { calls++; if (lost) throw Error('Synthetic unknown execution'); return response(decision()); } });
    const results = await Promise.allSettled([review(h.reviewInput()), review(h.reviewInput())]);
    assert.equal(calls, 1); assert.equal(results.some(v => v.status === 'fulfilled'), !lost);
    const alternate = h.reviewInput();
    const bytes = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#aa8855' } }).jpeg().toBuffer();
    alternate.frames[0].dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    await assert.rejects(review(alternate)); assert.equal(calls, 1);
  }
});

test('revoked grant, altered old receipt and stale snapshots cannot approve new or cached evidence', async () => {
  for (const kind of ['grant', 'old-receipt', 'stale']) {
    const h = await fixture(); const stale = h.reviewInput(); await h.apply();
    if (kind === 'grant') h.records.delete(visualEvidenceRecoveryPath(h.value(h.jobPath)));
    if (kind === 'old-receipt') h.mutate(h.stageProof.receiptPath, v => { v.decision.appearance = 'consistent'; });
    let calls = 0;
    const review = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
      fetchImpl: async () => { calls++; return response(decision()); } });
    await assert.rejects(review(kind === 'stale' ? stale : h.reviewInput())); assert.equal(calls, 0);
  }
});
