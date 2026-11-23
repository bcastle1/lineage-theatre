import test from 'node:test';
import assert from 'node:assert/strict';
import { contextSuccessorFixture } from './fixtures/context-successor.mjs';
import { readPaidFilmCorrection } from '../api/_lib/paid-film-correction.mjs';
import { FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { falShotInput, falPlan } from '../api/_lib/fal-production.mjs';
import { falRequestPath } from '../api/_lib/fal-client.mjs';
import { contextSuccessorPath } from '../api/_lib/context-successor.mjs';
import { digest } from '../api/_lib/auth.mjs';

test('one bounded context successor changes exactly two selected prompt lines, retaining narration, three clips and original payment', async () => {
  const h = await contextSuccessorFixture(), before = new Map(h.records), initialPosts = h.calls.filter(row => row.method === 'POST').length;
  const approved = await h.approve(); assert.deepEqual(await h.approve(), approved);
  assert.equal(approved.maximumNewCostCents, 1080); assert.equal(approved.customerChargeCents, 0);
  const context = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: h.read, now: h.now });
  assert.equal(context.grant.partial.version, 3); assert.equal(context.grant.quote.maximumCostCents, 3840); assert.equal(context.grant.quote.providerCostCents, 1080);
  const restored = structuredClone(context.job.manifest); delete restored.shots[2].providerContext;
  assert.deepEqual(restored, h.parent.job.manifest);
  const priorInput = falShotInput(h.parent.job.manifest, h.parent.job.manifest.shots[2], 'seedance', {});
  const nextInput = falShotInput(context.job.manifest, context.job.manifest.shots[2], 'seedance', {});
  assert.deepEqual({ ...priorInput, prompt: null }, { ...nextInput, prompt: null });
  const oldLines = priorInput.prompt.split('\n'), lines = nextInput.prompt.split('\n');
  assert.equal(lines.length, oldLines.length);
  assert.deepEqual(lines.filter((line, i) => line !== oldLines[i]), [
    `Film context: ${h.input.filmContext}`, `Historical boundaries: ${h.input.historicalBoundaries}`]);
  for (const i of [0, 1, 3]) assert.deepEqual(falShotInput(context.job.manifest, context.job.manifest.shots[i], 'seedance', {}),
    falShotInput(h.parent.job.manifest, h.parent.job.manifest.shots[i], 'seedance', {}));
  await h.enqueue(); for (let i = 0; i < 6; i++) { await h.run(); if ((await h.read(h.jobPath(h.targetId))).value.status === 'awaiting-assembly') break; }
  const job = (await h.read(h.jobPath(h.targetId))).value; assert.equal(job.status, 'awaiting-assembly');
  const submitted = h.calls.filter(row => row.method === 'POST').slice(initialPosts);
  assert.equal(submitted.length, 1); assert.deepEqual(submitted[0].body, nextInput);
  assert.equal(nextInput.duration, '9'); assert.equal(nextInput.resolution, '1080p'); assert.equal(nextInput.generate_audio, true);
  for (const proof of context.grant.partial.reused)
    assert.deepEqual(job.shots.find(row => row.id === proof.shotId).output, h.parent.job.shots.find(row => row.id === proof.shotId).output);
  for (const path of [h.jobPath(h.source.id), ...h.ancestors.flatMap(a => [h.jobPath(a.job.id), `production/corrections/${a.grant.id}.json`]),
    `payments/orders/${h.orderId}.json`, FAL_FUNDING_PATH]) assert.deepEqual(h.records.get(path), before.get(path));
});

test('wrong owner, scope, zero-cost proof, failed receipt, funding, account and payment block before any context approval writes', async () => {
  for (const change of [h => ({ actor: { email: 'other@example.invalid', role: 'owner' } }), h => ({ confirmed: false }),
    h => ({ historicalBoundaries: 'Unapproved\nextra prompt line' }), h => ({ maximumNewCostCents: 1081 }),
    h => ({ billingEvidence: { ...h.input.billingEvidence, costNanoUsd: 1 } }), h => ({ failedRecordHash: 'f'.repeat(64) }),
    h => { h.env.FAL_BILLING_ACCOUNT = 'other'; return {}; },
    h => { h.mutate(FAL_FUNDING_PATH, row => { row.entries = []; }); return {}; },
    h => { h.mutate(`payments/orders/${h.orderId}.json`, row => { row.refundedCents = 1; }); return {}; },
    h => { h.mutate(falRequestPath(h.failed.identity), row => { row.state = 'queued'; }); return {}; },
    h => { h.mutate(h.jobPath(h.parent.job.id), row => { row.shots[0].output.sha256 = 'f'.repeat(64); }); return {}; },
    h => { h.mutate(h.jobPath(h.parent.job.id), row => { row.lease = { token: 'active', expiresAt: h.now() + 1000 }; }); return {}; },
    h => { h.mutate('production/worker-health.json', row => { delete row.sceneContextSuccessorVersion; }); return {}; },
  ]) {
    const h = await contextSuccessorFixture(), changes = change(h), writes = h.writes.length, posts = h.calls.filter(row => row.method === 'POST').length;
    await assert.rejects(h.approve(changes)); assert.equal(h.writes.length, writes); assert.equal(await h.read(h.jobPath(h.targetId)), null);
    assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
  }
});

test('a context override without its matching third-version grant cannot submit provider work', async () => {
  const h = await contextSuccessorFixture(), posts = h.calls.filter(row => row.method === 'POST').length;
  await assert.rejects(h.adapter.submitShot({ manifest: h.built.manifest, manifestHash: h.built.manifestHash,
    shot: h.built.manifest.shots[2], productionId: h.targetId, idempotencyKey: digest('unbound-context'), authorizeSpend: async () => true }));
  for (const bad of [{ version: 1, filmContext: 'one', historicalBoundaries: 'two', extra: true },
    { version: 2, filmContext: 'one', historicalBoundaries: 'two' }]) {
    const manifest = structuredClone(h.built.manifest); manifest.shots[2].providerContext = bad;
    assert.throws(() => falPlan(manifest, 'seedance'));
  }
  assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
});

test('changed override, multiple overridden shots, missing intent and wrong grant all block a saved context target before POST', async () => {
  for (const change of [h => h.mutate(h.jobPath(h.targetId), row => { row.manifest.shots[0].providerContext = row.manifest.shots[2].providerContext; }),
    h => h.mutate(h.jobPath(h.targetId), row => { row.manifest.shots[2].providerContext.filmContext = 'Different instructions'; }),
    h => h.records.delete(`production/correction-successor-intents/${h.parent.grant.id}.json`),
    h => h.mutate(`production/corrections/${h.correctionId}.json`, row => { row.partial.version = 2; }),
  ]) {
    const h = await contextSuccessorFixture(); await h.approve(); await h.enqueue(); change(h);
    const posts = h.calls.filter(row => row.method === 'POST').length;
    await h.run(); assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
  }
});

test('expiry during batched payment/context rechecks still denies the new scene authorization', async () => {
  const h = await contextSuccessorFixture(); await h.approve();
  // It is valid when received and expires during the asynchronous final
  // rechecks. Passing every record comparison must not extend that deadline.
  h.settings.proofExpiry = new Date(h.now() + 1000).toISOString();
  h.settings.onProofRecheck = () => h.advance(1001);
  const posts = h.calls.filter(row => row.method === 'POST').length;
  await assert.rejects(h.service.authorizeProduction({ email: h.email, orderId: h.correctionId,
    preparedId: h.targetId, manifestHash: h.built.manifestHash }));
  assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
});

test('lost submit or failed context successor cannot authorize another child or another paid attempt', async () => {
  for (const lost of [true, false]) {
    const h = await contextSuccessorFixture(), approved = await h.approve();
    if (lost) h.settings.lostSubmit = true; else h.settings.retryFailure = true;
    await h.enqueue(); for (let i = 0; i < 6; i++) await h.run();
    assert.equal((await h.read(h.jobPath(h.targetId))).value.status, lost ? 'uncertain' : 'failed');
    const posts = h.calls.filter(row => row.method === 'POST').length; assert.equal(posts, 4);
    assert.deepEqual(await h.approve(), approved); await h.enqueue(); for (let i = 0; i < 3; i++) await h.run();
    await assert.rejects(h.approve({ parentCorrectionId: h.correctionId }));
    await assert.rejects(h.service.approveNarrationSuccessor({ ...h.input, narration: 'Another sentence.', parentCorrectionId: h.correctionId }));
    await assert.rejects(h.service.approvePartialRetry({ ...h.input, correctionId: h.correctionId }));
    assert.equal(h.calls.filter(row => row.method === 'POST').length, posts);
    assert.equal(await h.read(contextSuccessorPath(h.correctionId)), null);
  }
});
