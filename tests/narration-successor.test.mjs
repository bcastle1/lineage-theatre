import test from 'node:test';
import assert from 'node:assert/strict';
import { successorFixture } from './fixtures/narration-successor.mjs';
import { readPaidFilmCorrection } from '../api/_lib/paid-film-correction.mjs';
import { FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { falShotInput, falPlan, SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { sha } from './fixtures/partial-correction.mjs';
import { falRequestPath } from '../api/_lib/fal-client.mjs';
import { narrationSuccessorPath } from '../api/_lib/narration-successor.mjs';
import { digest } from '../api/_lib/auth.mjs';

test('one narration successor preserves all timing and three clips under the unchanged original payment and hold', async () => {
  const h = await successorFixture(), before = new Map(h.records), posts = h.calls.filter(r => r.method === 'POST').length;
  const approved = await h.approve(); assert.equal(approved.maximumNewCostCents, 1080); assert.equal(approved.customerChargeCents, 0);
  assert.deepEqual(await h.approve(), approved);
  const context = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: h.read, now: h.now });
  assert.equal(context.grant.partial.version, 2); assert.equal(context.grant.quote.maximumCostCents, 3840);
  assert.equal(context.grant.quote.providerCostCents, 1080); assert.equal(context.job.filmId, h.parent.job.filmId);
  const restored = structuredClone(context.job.manifest), changed = restored.shots.find(row => row.id === h.input.shotId);
  changed.narration = h.parent.job.manifest.shots.find(row => row.id === h.input.shotId).narration;
  restored.screenplay.scenes[changed.sceneIndex].narration = changed.narration;
  assert.deepEqual(restored, h.parent.job.manifest);
  await h.enqueue();
  for (let i = 0; i < 5; i++) { await h.run(); if ((await h.read(h.jobPath(h.targetId))).value.status === 'awaiting-assembly') break; }
  const job = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(job.status, 'awaiting-assembly'); assert.equal(job.shots.filter(row => row.status === 'completed').length, 4);
  const submitted = h.calls.filter(row => row.method === 'POST').slice(posts);
  assert.equal(submitted.length, 1); assert.equal(submitted[0].body.duration, '9'); assert.equal(submitted[0].body.resolution, '1080p');
  assert.equal(submitted[0].body.generate_audio, true);
  assert.deepEqual(submitted[0].body, falShotInput(job.manifest, falPlan(job.manifest, 'seedance').shots[2], 'seedance', {}));
  for (const proof of context.grant.partial.reused) {
    const current = job.shots.find(row => row.id === proof.shotId), previous = h.parent.job.shots.find(row => row.id === proof.shotId);
    assert.deepEqual(current.output, previous.output);
    assert.match(current.providerJobId, /^fal-[a-f0-9]{64}$/); // New target identity, same verified source bytes.
  }
  for (const path of [h.jobPath(h.parent.job.id), h.jobPath(h.source.id), `payments/orders/${h.orderId}.json`,
    `production/corrections/${h.parent.grant.id}.json`, FAL_FUNDING_PATH]) assert.deepEqual(h.records.get(path), before.get(path));
  assert.equal(h.calls.filter(row => row.method === 'POST').length, posts + 1);
});

test('successor rejects unconfirmed, wrong billing, altered receipt, released funding and reversed payment before creating target', async () => {
  for (const change of [h => ({ confirmed: false }), h => ({ failedRecordHash: 'f'.repeat(64) }),
    h => ({ billingEvidence: { ...h.input.billingEvidence, costNanoUsd: 1 } }),
    h => ({ billingEvidence: { ...h.input.billingEvidence, account: 'another-account' } }),
    h => { h.mutate(FAL_FUNDING_PATH, value => { value.entries = []; }); return {}; },
    h => { h.mutate(`payments/orders/${h.orderId}.json`, value => { value.refundedCents = 1; }); return {}; }]) {
    const h = await successorFixture(), count = h.calls.filter(row => row.method === 'POST').length, writes = h.writes.length;
    await assert.rejects(h.approve(change(h))); assert.equal(await h.read(h.jobPath(h.targetId)), null); assert.equal(h.writes.length, writes);
    assert.equal(h.calls.filter(row => row.method === 'POST').length, count);
  }
});

test('terminal verification rejects unresolved, wrong request and nonmatching provider result without a new request', async () => {
  for (const options of [{ successorProviderStatus: { status: 'IN_PROGRESS' } }, { successorProviderHttp: 500 },
    { successorProviderBody: { detail: [{ type: 'unknown', loc: ['body'] }] } }]) {
    const h = await successorFixture(options), count = h.calls.filter(row => row.method === 'POST').length;
    await assert.rejects(h.approve()); assert.equal(await h.read(h.jobPath(h.targetId)), null);
    assert.equal(h.calls.filter(row => row.method === 'POST').length, count);
  }
});

test('pending predecessor, active lease, changed retained bytes, stale worker or altered prior proof prevents any successor writes', async () => {
  for (const change of [
    h => h.mutate(falRequestPath(h.failed.identity), row => { row.state = 'queued'; }),
    h => h.mutate(h.jobPath(h.parent.job.id), row => { row.lease = { token: 'active', expiresAt: h.now() + 1000 }; }),
    h => h.mutate(`production/queue/${digest(h.email)}/${h.parent.job.id}.json`, row => { row.state = 'pending'; }),
    h => h.mutate(h.jobPath(h.parent.job.id), row => { row.shots[0].output.sha256 = 'f'.repeat(64); }),
    h => h.mutate('production/worker-health.json', row => { delete row.narrationSuccessorVersion; }),
    h => h.mutate(falRequestPath(h.parent.retry.grant.failedOperationIdentity), row => { row.failureCode = 'FAL_HTTP_500'; }),
  ]) {
    const h = await successorFixture(); change(h); const writes = h.writes.length;
    await assert.rejects(h.approve()); assert.equal(h.writes.length, writes);
    assert.equal(await h.read(h.jobPath(h.targetId)), null);
  }
});

test('partial successor execution never spends after its approval, evidence, payment, funding or target bindings change', async () => {
  for (const change of [
    h => h.records.delete(`production/correction-successor-intents/${h.parent.grant.id}.json`),
    h => h.mutate(narrationSuccessorPath(h.parent.grant.id), row => { row.grantHash = 'f'.repeat(64); }),
    h => h.records.delete(`production/corrections/${h.correctionId}.json`),
    h => h.mutate(h.jobPath(h.targetId), row => { delete row.partialCorrection; }),
    h => h.mutate(h.jobPath(h.targetId), row => { row.shots[0].requestKey = 'f'.repeat(64); }),
    h => h.mutate(`payments/orders/${h.orderId}.json`, row => { row.refundedCents = 1; }),
    h => h.mutate(FAL_FUNDING_PATH, row => { row.entries = []; }),
  ]) {
    const h = await successorFixture(); await h.approve(); await h.enqueue(); change(h);
    const posts = h.calls.filter(row => row.method === 'POST').length;
    await h.run(); assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
  }
});

test('lost new submission remains one uncertain operation; a failed successor cannot get another retry or child', async () => {
  for (const lost of [true, false]) {
    const h = await successorFixture(); const approved = await h.approve();
    if (lost) h.settings.lostSubmit = true; else h.settings.retryFailure = true;
    await h.enqueue(); for (let i = 0; i < 6; i++) await h.run();
    const posts = h.calls.filter(row => row.method === 'POST').length, before = (await h.read(h.jobPath(h.targetId))).value;
    assert.equal(before.status, lost ? 'uncertain' : 'failed'); assert.equal(posts, 3);
    assert.deepEqual(await h.approve(), approved);
    await h.enqueue(); for (let i = 0; i < 3; i++) await h.run();
    assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
    const failedOperationIdentity = digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${before.shots[2].requestKey}`);
    await assert.rejects(h.service.approvePartialRetry({ ...h.input, correctionId: h.correctionId, failedOperationIdentity }));
    await assert.rejects(h.approve({ parentCorrectionId: h.correctionId }));
    assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
  }
});
