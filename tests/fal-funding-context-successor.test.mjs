import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createFalFunding, FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { readCorrectionFulfillment, narrationSuccessorPath } from '../api/_lib/narration-successor.mjs';
import { requireFinishedFilmPayment, validateStoredProductionMedia } from '../api/_lib/production-media.mjs';
import { contextSuccessorFixture } from './fixtures/context-successor.mjs';

const next = { customerEmail: 'next-context@example.invalid', orderId: digest('context-next-order'),
  quoteId: digest('context-next-quote'), preparedId: '99999999-9999-4999-8999-999999999999',
  manifestHash: digest('context-next-manifest'), maximumCostCents: 1920 };
const denied = promise => assert.rejects(promise, error => error.code === 'FAL_FUNDING_UNAVAILABLE');
const posts = h => h.calls.filter(call => call.method === 'POST');
const links = h => [narrationSuccessorPath(h.parent.grant.partial.parentCorrectionId), narrationSuccessorPath(h.parent.grant.id)];
async function completedContext() {
  const h = await contextSuccessorFixture(); await h.approve(); await h.enqueue();
  for (let pass = 0; pass < 8; pass++) {
    await h.run();
    if ((await h.read(h.jobPath(h.targetId))).value.status === 'awaiting-assembly') break;
  }
  assert.equal((await h.read(h.jobPath(h.targetId))).value.status, 'awaiting-assembly');
  const sha256 = digest('synthetic verified completed context successor');
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

test('completed two-link context correction uses the original paid sale for private playback and retires only its original hold', async () => {
  const h = await completedContext(), job = (await h.read(h.jobPath(h.targetId))).value;
  const paths = [...h.records.keys()].filter(path => path !== FAL_FUNDING_PATH);
  const before = await Promise.all(paths.map(h.read)), initialPosts = posts(h).length;
  const context = await readCorrectionFulfillment({ email: h.email, orderId: h.orderId, read: h.read, now: h.now });
  assert.equal(context.grant.id, h.correctionId); assert.equal(context.grant.partial.version, 3);
  assert.equal(context.order.id, h.orderId); await context.recheck();
  assert.equal(validateStoredProductionMedia(job, h.email).sha256, job.media.sha256);
  await requireFinishedFilmPayment({ job, email: h.email, actor: h.actor, read: h.read, now: h.now });
  await assert.rejects(requireFinishedFilmPayment({ job, email: 'someone-else@example.invalid',
    actor: { email: 'someone-else@example.invalid', role: 'owner' }, read: h.read, now: h.now }));
  assert.throws(() => validateStoredProductionMedia(job, 'someone-else@example.invalid'));
  const wrongSource = structuredClone(job); wrongSource.authorization.originalOrderId = h.parent.grant.id;
  await assert.rejects(requireFinishedFilmPayment({ job: wrongSource, email: h.email, actor: h.actor, read: h.read, now: h.now }));
  await funding(h).reserve(next);
  assert.deepEqual((await h.read(FAL_FUNDING_PATH)).value.entries.map(entry => entry.orderId), [next.orderId]);
  assert.deepEqual(await Promise.all(paths.map(h.read)), before);
  assert.equal(posts(h).length, initialPosts);
});

test('two-link fulfillment retains the original hold on missing links, alternate descendants, non-delivery or revoked payment', async () => {
  for (const kind of ['missing-first-link', 'missing-second-link', 'bad-first-link', 'bad-second-link', 'skipped-parent',
    'missing-child', 'third-hop', 'cycle', 'failed', 'uncertain', 'missing-media', 'wrong-media-owner',
    'wrong-source-quote', 'refund', 'wrong-account']) {
    const h = await completedContext(), [first, second] = links(h);
    if (kind === 'missing-first-link') h.records.delete(first);
    if (kind === 'missing-second-link') h.records.delete(second);
    if (kind === 'bad-first-link') h.mutate(first, link => { link.grantHash = digest('bad-first-link'); });
    if (kind === 'bad-second-link') h.mutate(second, link => { link.grantHash = digest('bad-second-link'); });
    if (kind === 'skipped-parent') h.seed(first, (await h.read(second)).value);
    if (kind === 'missing-child') h.records.delete(`production/corrections/${h.correctionId}.json`);
    if (kind === 'third-hop') h.seed(narrationSuccessorPath(h.correctionId), {});
    if (kind === 'cycle') h.mutate(second, link => { link.correctionId = h.parent.grant.partial.parentCorrectionId; });
    if (kind === 'failed' || kind === 'uncertain') h.mutate(h.jobPath(h.targetId), job => { job.status = kind; });
    if (kind === 'missing-media') h.mutate(h.jobPath(h.targetId), job => { delete job.media; });
    if (kind === 'wrong-media-owner') h.mutate(h.jobPath(h.targetId), job => { job.media.pathname = 'production/media/another-owner.mp4'; });
    if (kind === 'wrong-source-quote') h.mutate(`payments/orders/${h.orderId}.json`, order => { order.quoteId = digest('different-quote'); });
    if (kind === 'refund') h.mutate(`payments/orders/${h.orderId}.json`, order => { order.refundedCents = 1; });
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

test('changing either successor link or adding a third after balance read cannot publish admission', async () => {
  for (const depth of [0, 1, 2]) {
    const h = await completedContext(), before = await h.read(FAL_FUNDING_PATH), writeCount = h.writes.length;
    await denied(funding(h, () => {
      if (depth === 2) h.seed(narrationSuccessorPath(h.correctionId), {});
      else h.mutate(links(h)[depth], link => { link.grantHash = digest('changed-link-during-balance'); });
    }).reserve(next));
    assert.deepEqual(await h.read(FAL_FUNDING_PATH), before); assert.equal(h.writes.length, writeCount);
  }
});

test('a narration-terminal absence proof expires when its one context successor is approved', async () => {
  const h = await contextSuccessorFixture();
  const context = await readCorrectionFulfillment({ email: h.email, orderId: h.orderId, read: h.read, now: h.now });
  assert.equal(context.grant.id, h.parent.grant.id); await context.recheck();
  await h.approve();
  await assert.rejects(context.recheck());
});
