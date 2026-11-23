import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { partialFixture, sha } from './fixtures/partial-correction.mjs';
import { readPaidFilmCorrection, productionCorrectionPath, correctionIdForOrder } from '../api/_lib/paid-film-correction.mjs';
import { buildPartialCorrectionManifest } from '../api/_lib/partial-film-correction.mjs';
import { falRequestPath } from '../api/_lib/fal-client.mjs';
import { createFalFunding, FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { createProductionQueue, productionQueuePath } from '../api/_lib/production-queue.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';

const posts = h => h.calls.filter(call => call.method === 'POST');
async function step(h, index, changes = {}) {
  const job = (await h.read(h.jobPath(h.targetId))).value;
  return h.adapter.submitShot({ email: h.email, productionId: job.id, manifest: job.manifest, manifestHash: job.manifestHash,
    correctionId: correctionIdForOrder(h.orderId), shot: job.manifest.shots[index], idempotencyKey: job.shots[index].requestKey,
    authorizeSpend: async () => { await h.auth(); return true; }, ...changes });
}

test('partial approval preserves the original sale and creates a bound new version from real prepared Seedance output', async () => {
  const h = await partialFixture(), sourceBefore = await h.read(h.jobPath(h.source.id)), orderBefore = await h.read(`payments/orders/${h.orderId}.json`);
  const ledgerBefore = await h.read(FAL_FUNDING_PATH), result = await h.approve(), target = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(result.customerChargeCents, 0); assert.equal(result.maximumCostCents, h.cost); assert.equal(result.maximumNewCostCents, 720);
  assert.equal(target.filmId, h.source.filmId); assert.equal(target.provider.model, 'seedance'); assert.equal(target.partialCorrection.version, 1);
  const reversed = structuredClone(target.manifest); reversed.shots[2].visual = h.source.manifest.shots[2].visual;
  reversed.screenplay.scenes[2].visual = h.source.manifest.screenplay.scenes[2].visual;
  reversed.visualContinuity.scenes[2].direction = h.source.manifest.visualContinuity.scenes[2].direction;
  assert.deepEqual(reversed, h.source.manifest);
  assert.deepEqual(await h.read(h.jobPath(h.source.id)), sourceBefore); assert.deepEqual(await h.read(`payments/orders/${h.orderId}.json`), orderBefore);
  assert.deepEqual(await h.read(FAL_FUNDING_PATH), ledgerBefore); assert.equal(posts(h).length, 0);
  const writes = h.writes.length; assert.deepEqual(await h.approve(), result); assert.equal(h.writes.length, writes);
  assert.equal(h.verifications.length, 2, 'An idempotent retry still verifies the live sale');
  const grant = await h.auth(); assert.equal(grant.budgetCents, h.cost); assert.equal(grant.partialCorrectionVersion, 1);
});

test('all three byte-verified reused shots bypass generation and the approved changed shot submits once', async () => {
  const h = await partialFixture(); await h.approve();
  for (const index of [0, 1, 3]) {
    const result = await step(h, index); assert.equal(result.status, 'completed'); assert.equal(result.reviewedReuse, true);
    assert.equal(result.output.sha256, h.input.reuseEvidence.find(row => row.shotId === h.source.shots[index].id).mediaSha256);
  }
  assert.equal(posts(h).length, 0);
  assert.equal((await step(h, 2)).status, 'queued'); assert.equal(posts(h).length, 1);
  assert.equal((await step(h, 2)).status, 'completed'); assert.equal(posts(h).length, 1);
  assert.equal((await step(h, 2)).status, 'completed'); assert.equal(posts(h).length, 1);
});

test('changed keys, missing authorization markers, missing grants and corrupt reused bytes never fall through to a new render', async () => {
  for (const kind of ['key', 'correction', 'grant', 'marker', 'bytes', 'receipt']) {
    const h = await partialFixture({ corruptMedia: kind === 'bytes' }); await h.approve();
    if (kind === 'grant') h.records.delete(productionCorrectionPath(correctionIdForOrder(h.orderId)));
    if (kind === 'marker') h.mutate(h.jobPath(h.targetId), job => { delete job.partialCorrection; });
    if (kind === 'receipt') h.records.delete(falRequestPath(h.input.reuseEvidence[0].operationIdentity));
    await assert.rejects(step(h, kind === 'key' || kind === 'correction' ? 2 : 0,
      kind === 'key' ? { idempotencyKey: digest('another-key') } : kind === 'correction' ? { correctionId: undefined } : {}));
    assert.equal(posts(h).length, 0, kind);
  }
});

test('lost changed-scene submission stays uncertain without a second POST', async () => {
  const h = await partialFixture({ lostSubmit: true }); await h.approve();
  assert.equal((await step(h, 2)).status, 'uncertain'); assert.equal((await step(h, 2)).status, 'uncertain');
  assert.equal(posts(h).length, 1);
});

test('source activity, unaccepted budget, wrong account and incomplete terminal evidence fail before authorization', async () => {
  for (const kind of ['source', 'queue', 'lease', 'health', 'budget', 'account', 'pending', 'billing', 'proof-expiry', 'refund']) {
    const h = await partialFixture({ proofExpiry: kind === 'proof-expiry' ? 'invalid-date' : undefined, reversed: kind === 'refund' });
    if (kind === 'source') h.mutate(h.jobPath(h.source.id), job => { job.status = 'processing'; });
    if (kind === 'queue') h.mutate(h.queuePath, queue => { queue.state = 'pending'; });
    if (kind === 'lease') h.mutate(h.queuePath, queue => { queue.lease = { expiresAt: h.now() + 1000 }; });
    if (kind === 'health') h.mutate('production/worker-health.json', health => { delete health.partialCorrectionVersion; });
    if (kind === 'budget') h.input.maximumNewCostCents = 1;
    if (kind === 'account') h.input.billingEvidence.account = 'another-account';
    if (kind === 'billing') h.input.billingEvidence.attempts.pop();
    if (kind === 'pending') {
      const row = h.input.billingEvidence.attempts[2], path = falRequestPath(row.operationIdentity);
      h.mutate(path, operation => { operation.state = 'queued'; delete operation.failureCode; }); row.recordHash = sha((await h.read(path)).value);
    }
    await assert.rejects(h.approve(), undefined, kind); assert.equal(posts(h).length, 0);
    assert.equal(h.records.has(productionCorrectionPath(correctionIdForOrder(h.orderId))), false);
  }
});

test('exact original reservation and current payment remain required on approval retry and every new authorization', async () => {
  for (const kind of ['removed', 'changed', 'account', 'refund', 'receipt']) {
    const h = await partialFixture(); await h.approve();
    if (kind === 'removed') h.records.delete(FAL_FUNDING_PATH);
    if (kind === 'changed') h.mutate(FAL_FUNDING_PATH, value => { value.entries[0].maximumCostCents--; });
    if (kind === 'account') h.mutate(FAL_FUNDING_PATH, value => { value.account = 'another-account'; });
    if (kind === 'refund') h.options.reversed = true;
    if (kind === 'receipt') h.mutate(falRequestPath(h.input.reuseEvidence[0].operationIdentity), value => { value.inputHash = digest('changed'); });
    await assert.rejects(h.auth()); await assert.rejects(h.approve()); assert.equal(posts(h).length, 0);
  }
});

test('proof recheck catches source operation mutations and one immutable source claim rejects another visual', async () => {
  const h = await partialFixture(); await h.approve();
  const context = await readPaidFilmCorrection({ email: h.email, correctionId: correctionIdForOrder(h.orderId), read: h.read, now: h.now });
  const other = buildPartialCorrectionManifest(h.source.manifest, { shotId: h.input.shotId, visual: 'Another fictional garden.' });
  await assert.rejects(h.approve({ manifestHash: other.manifestHash, visual: other.manifest.shots[2].visual }));
  h.mutate(falRequestPath(h.input.reuseEvidence[1].operationIdentity), operation => { operation.checkedAt = new Date(h.now()).toISOString(); });
  await assert.rejects(context.recheck()); assert.equal(posts(h).length, 0);
});

test('a configured account switch cannot reuse earlier billing evidence even if its reservation ledger was copied', async () => {
  const h = await partialFixture(); await h.approve();
  h.env.FAL_BILLING_ACCOUNT = 'different-current-account';
  h.mutate(FAL_FUNDING_PATH, ledger => { ledger.account = h.env.FAL_BILLING_ACCOUNT; });
  await assert.rejects(h.auth()); await assert.rejects(h.approve());
  assert.equal(posts(h).length, 0);
});

test('real film and queue reuse three clips, keep full assembly gates, and preserve original-payment delivery coverage', async () => {
  const h = await partialFixture(); await h.approve();
  const queue = createProductionQueue({ read: h.read, write: h.write, now: h.now, film: h.film, paymentService: h.service });
  await queue.enqueue({ actor: h.actor, id: h.targetId, orderId: correctionIdForOrder(h.orderId) });
  const path = productionQueuePath(h.email, h.targetId);
  for (let pass = 0; pass < 6; pass++) {
    await queue.runTicket(path); h.advance(11000);
    if ((await h.read(h.jobPath(h.targetId))).value.status === 'awaiting-assembly') break;
  }
  const job = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(job.status, 'awaiting-assembly'); assert.ok(job.shots.every(shot => shot.status === 'completed'));
  assert.equal(posts(h).length, 1); assert.equal(job.media, undefined, 'Full Astra, audio and assembly validation must still finish');
  await requireFinishedFilmPayment({ job, email: h.email, actor: h.actor, read: h.read, now: h.now });
  h.mutate(`payments/orders/${h.orderId}.json`, order => { order.refundedCents = 1; });
  await assert.rejects(requireFinishedFilmPayment({ job, email: h.email, actor: h.actor, read: h.read, now: h.now }));
});

test('ordinary admission retires the source hold only after the actual validated correction context has completed private media', async () => {
  const h = await partialFixture(); await h.approve(); const auth = await h.auth();
  const mediaHash = digest('synthetic finished bytes'), media = { sha256: mediaHash, contentType: 'video/mp4', sizeBytes: 1024,
    durationSeconds: 24, pathname: `production/media/${digest(h.email)}/${h.targetId}/${mediaHash}.mp4` };
  h.mutate(h.jobPath(h.targetId), job => { job.authorization = auth; job.status = 'completed'; job.shots.forEach(shot => { shot.status = 'completed'; }); job.media = media; });
  const originalBefore = await h.read(h.jobPath(h.source.id)), orderBefore = await h.read(`payments/orders/${h.orderId}.json`);
  const funding = createFalFunding({ read: h.read, write: h.write, now: h.now, env: h.env,
    listBlobs: async () => ({ hasMore: false, blobs: [{ pathname: `payments/orders/${h.orderId}.json` }] }),
    fetchImpl: async () => Response.json({ username: h.env.FAL_BILLING_ACCOUNT, credits: { currency: 'USD', current_balance: 10 } }) });
  const next = { customerEmail: 'fictional-next@example.invalid', orderId: digest('next'), quoteId: digest('next-quote'),
    preparedId: '99999999-9999-4999-8999-999999999999', manifestHash: digest('next-manifest'), maximumCostCents: 500 };
  await funding.reserve(next);
  assert.deepEqual((await h.read(FAL_FUNDING_PATH)).value.entries.map(row => row.orderId), [next.orderId]);
  assert.deepEqual(await h.read(h.jobPath(h.source.id)), originalBefore); assert.deepEqual(await h.read(`payments/orders/${h.orderId}.json`), orderBefore);
});
