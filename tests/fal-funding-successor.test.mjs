import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createFalFunding, FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { readCorrectionFulfillment, narrationSuccessorPath } from '../api/_lib/narration-successor.mjs';
import { requireFinishedFilmPayment, validateStoredProductionMedia } from '../api/_lib/production-media.mjs';
import { successorFixture } from './fixtures/narration-successor.mjs';

const next = { customerEmail: 'fictional-next@example.invalid', orderId: digest('successor-funding-next'),
  quoteId: digest('successor-funding-next-quote'), preparedId: '99999999-9999-4999-8999-999999999999',
  manifestHash: digest('successor-funding-next-manifest'), maximumCostCents: 1920 };
const denied = promise => assert.rejects(promise, error => error.code === 'FAL_FUNDING_UNAVAILABLE');
const posts = h => h.calls.filter(call => call.method === 'POST');

async function completedSuccessor() {
  const h = await successorFixture(); await h.approve(); await h.enqueue();
  for (let pass = 0; pass < 8; pass++) {
    await h.run();
    if ((await h.read(h.jobPath(h.targetId))).value.status === 'awaiting-assembly') break;
  }
  assert.equal((await h.read(h.jobPath(h.targetId))).value.status, 'awaiting-assembly');
  const sha256 = digest('synthetic verified narration successor media');
  h.mutate(h.jobPath(h.targetId), job => {
    job.status = 'completed';
    job.media = { sha256, contentType: 'video/mp4', sizeBytes: 1024, durationSeconds: 30,
      pathname: `production/media/${digest(h.email)}/${h.targetId}/${sha256}.mp4` };
  });
  return h;
}
function funding(h, onBalance) {
  return createFalFunding({ read: h.read, write: h.write, env: h.env, now: h.now,
    listBlobs: async () => ({ hasMore: false, blobs: [...h.records.keys()].filter(path => path.startsWith('payments/orders/'))
      .map(pathname => ({ pathname })) }),
    fetchImpl: async () => {
      await onBalance?.();
      return Response.json({ username: h.env.FAL_BILLING_ACCOUNT, credits: { currency: 'USD', current_balance: 20 } });
    } });
}

test('real completed narration successor retains original-payment access and satisfies only the original funding hold', async () => {
  const h = await completedSuccessor(), job = (await h.read(h.jobPath(h.targetId))).value;
  const paths = [h.jobPath(h.source.id), h.jobPath(h.parent.job.id), `payments/orders/${h.orderId}.json`,
    `production/corrections/${h.parent.grant.id}.json`, `production/corrections/${h.correctionId}.json`,
    narrationSuccessorPath(h.parent.grant.id)];
  const before = await Promise.all(paths.map(h.read)), initialPosts = posts(h).length;
  const context = await readCorrectionFulfillment({ email: h.email, orderId: h.orderId, read: h.read, now: h.now });
  assert.equal(context.grant.id, h.correctionId); assert.equal(context.grant.partial.version, 2);
  assert.equal(context.order.id, h.orderId); await context.recheck();
  assert.equal(validateStoredProductionMedia(job, h.email).sha256, job.media.sha256);
  await requireFinishedFilmPayment({ job, email: h.email, actor: h.actor, read: h.read, now: h.now });
  await assert.rejects(requireFinishedFilmPayment({ job, email: 'different@example.invalid',
    actor: { email: 'different@example.invalid', role: 'owner' }, read: h.read, now: h.now }));
  assert.throws(() => validateStoredProductionMedia(job, 'different@example.invalid'));
  const wrongSource = structuredClone(job); wrongSource.authorization.originalOrderId = digest('different-paid-order');
  await assert.rejects(requireFinishedFilmPayment({ job: wrongSource, email: h.email, actor: h.actor, read: h.read, now: h.now }));
  await funding(h).reserve(next);
  assert.deepEqual((await h.read(FAL_FUNDING_PATH)).value.entries.map(entry => entry.orderId), [next.orderId]);
  assert.deepEqual(await Promise.all(paths.map(h.read)), before);
  assert.equal(posts(h).length, initialPosts, 'Funding and access validation never submit provider work');
});

test('failed, missing, ambiguous, refunded and altered successors keep the original reservation held', async () => {
  for (const kind of ['missing-link', 'bad-link', 'missing-child', 'failed', 'unfinished', 'missing-media',
    'wrong-media-owner', 'wrong-source-quote', 'refund', 'second-hop', 'wrong-account']) {
    const h = await completedSuccessor(), linkPath = narrationSuccessorPath(h.parent.grant.id);
    if (kind === 'missing-link') h.records.delete(linkPath);
    if (kind === 'bad-link') h.mutate(linkPath, link => { link.grantHash = digest('tampered'); });
    if (kind === 'missing-child') h.records.delete(`production/corrections/${h.correctionId}.json`);
    if (kind === 'failed') h.mutate(h.jobPath(h.targetId), job => { job.status = 'failed'; });
    if (kind === 'unfinished') h.mutate(h.jobPath(h.targetId), job => { job.status = 'awaiting-assembly'; });
    if (kind === 'missing-media') h.mutate(h.jobPath(h.targetId), job => { delete job.media; });
    if (kind === 'wrong-media-owner') h.mutate(h.jobPath(h.targetId), job => { job.media.pathname = 'production/media/another-owner.mp4'; });
    if (kind === 'wrong-source-quote') h.mutate(`payments/orders/${h.orderId}.json`, order => { order.quoteId = digest('different-quote'); });
    if (kind === 'refund') h.mutate(`payments/orders/${h.orderId}.json`, order => { order.refundedCents = 1; });
    if (kind === 'second-hop') h.seed(narrationSuccessorPath(h.correctionId), {});
    if (kind === 'wrong-account') {
      h.env.FAL_BILLING_ACCOUNT = 'different-account';
      h.mutate(FAL_FUNDING_PATH, ledger => { ledger.account = h.env.FAL_BILLING_ACCOUNT; });
    }
    const before = await h.read(FAL_FUNDING_PATH), writeCount = h.writes.length;
    await denied(funding(h).reserve(next));
    assert.deepEqual(await h.read(FAL_FUNDING_PATH), before, kind);
    assert.equal(h.writes.length, writeCount, kind);
  }
});

test('successor linkage changed after balance lookup prevents funding publication', async () => {
  const h = await completedSuccessor(), before = await h.read(FAL_FUNDING_PATH), writeCount = h.writes.length;
  await denied(funding(h, () => h.mutate(narrationSuccessorPath(h.parent.grant.id), link => {
    link.grantHash = digest('changed-during-balance-read');
  })).reserve(next));
  assert.deepEqual(await h.read(FAL_FUNDING_PATH), before);
  assert.equal(h.writes.length, writeCount);
});

test('legacy resolver absence proof rejects a newly appearing successor link during recheck', async () => {
  const h = await successorFixture();
  const context = await readCorrectionFulfillment({ email: h.email, orderId: h.orderId, read: h.read, now: h.now });
  assert.equal(context.grant.id, h.parent.grant.id);
  h.seed(narrationSuccessorPath(h.parent.grant.id), {});
  await assert.rejects(context.recheck());
});
