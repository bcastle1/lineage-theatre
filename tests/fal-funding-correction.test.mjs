import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createFalFunding, FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const env = { FAL_BILLING_KEY: 'synthetic-billing-key', FAL_BILLING_ACCOUNT: 'fictional-account' };
const SOURCE = '11111111-1111-4111-8111-111111111111', TARGET = '22222222-2222-4222-8222-222222222222';
const email = 'owner@example.invalid', ownerHash = digest(email), sourceManifest = { shots: [{ id: 'source' }] };
const sourceHash = digest(JSON.stringify(sourceManifest));
const original = { orderId: digest('original-order'), quoteId: digest('original-quote'), ownerHash,
  preparedId: SOURCE, manifestHash: sourceHash, maximumCostCents: 3840 };
const next = { orderId: digest('next-order'), quoteId: digest('next-quote'), customerEmail: 'next@example.invalid',
  preparedId: '33333333-3333-4333-8333-333333333333', manifestHash: digest('next-manifest'), maximumCostCents: 1920 };
const denied = promise => assert.rejects(promise, error => error.code === 'FAL_FUNDING_UNAVAILABLE');

function fixture(options = {}) {
  let revision = 0, rechecks = 0;
  const records = new Map(), writes = [], reads = [];
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `etag-${++revision}` });
  const read = async path => { reads.push(path); return structuredClone(records.get(path) || null); };
  const write = async (path, value, etag) => {
    assert.equal(records.get(path)?.etag, etag);
    writes.push(path); seed(path, value);
  };
  const order = { id: original.orderId, customerEmail: email, preparedId: SOURCE, manifestHash: sourceHash,
    quoteId: original.quoteId, providerCostCents: 3840, status: 'captured', currency: 'USD',
    merchantBinding: { environment: 'production' } };
  const manifest = { shots: [{ id: 'corrected' }] }, manifestHash = digest(JSON.stringify(manifest));
  const grant = { id: digest('correction'), originalOrderId: original.orderId, originalPreparedId: SOURCE,
    originalManifestHash: sourceHash, preparedId: TARGET, manifestHash, model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION,
    quote: { quoteReference: 'immutable-correction-quote', maximumCostCents: 3840 },
    partial: { version: 1, kind: 'seedance-single-scene-correction-v1', fundingKind: 'original-reservation', billingAccount: env.FAL_BILLING_ACCOUNT,
      originalReservation: structuredClone(original) } };
  const sha256 = digest('fictional finished correction');
  const job = { id: TARGET, ownerHash, manifest, manifestHash, status: 'completed',
    authorization: { correctionId: grant.id, originalOrderId: original.orderId, environment: 'production', manifestHash,
      quoteReference: grant.quote.quoteReference, budgetCents: 3840 },
    provider: { id: 'fal', model: grant.model, recipe: grant.recipe },
    media: { sha256, pathname: `production/media/${ownerHash}/${TARGET}/${sha256}.mp4`, contentType: 'video/mp4',
      sizeBytes: 1024, durationSeconds: 30 } };
  const source = { id: SOURCE, ownerHash, manifestHash: sourceHash, manifest: sourceManifest, status: 'failed' };
  seed(`payments/orders/${original.orderId}.json`, order);
  seed(`production/jobs/${ownerHash}/${SOURCE}.json`, source);
  seed(FAL_FUNDING_PATH, { version: 1, account: env.FAL_BILLING_ACCOUNT, revision: 1,
    entries: [{ ...original, createdAt: new Date(NOW).toISOString() }] });
  const context = { grant, order, job, recheck: async () => {
    rechecks++; await options.recheck?.(rechecks);
  } };
  const service = createFalFunding({ read, write, env, now: () => NOW,
    listBlobs: async () => ({ hasMore: false, blobs: [...records.keys()].filter(path => path.startsWith('payments/orders/'))
      .map(pathname => ({ pathname })) }),
    fetchImpl: async () => new Response(JSON.stringify({ username: env.FAL_BILLING_ACCOUNT,
      credits: { current_balance: options.balance ?? 20, currency: 'USD' } })),
    correctionContext: async input => {
      assert.equal(input.email, email); assert.equal(input.orderId, original.orderId);
      if (options.invalidContext) throw Error('Unverified correction');
      return context;
    } });
  return { service, records, writes, reads, context, seed, rechecks: () => rechecks };
}

test('completed validated partial correction satisfies only its original hold during ordinary admission', async () => {
  const h = fixture(), sourcePath = `production/jobs/${ownerHash}/${SOURCE}.json`, orderPath = `payments/orders/${original.orderId}.json`;
  const sourceBefore = structuredClone(h.records.get(sourcePath)), orderBefore = structuredClone(h.records.get(orderPath));
  await h.service.reserve(next);
  assert.deepEqual(h.records.get(FAL_FUNDING_PATH).value.entries.map(entry => entry.orderId), [next.orderId]);
  assert.deepEqual(h.writes, [FAL_FUNDING_PATH]);
  assert.deepEqual(h.records.get(sourcePath), sourceBefore);
  assert.deepEqual(h.records.get(orderPath), orderBefore);
  assert.equal(h.rechecks(), 2);
});

test('a resolved completed narration successor satisfies the same original hold without reserving its new preparation', async () => {
  const h = fixture(), orderPath = `payments/orders/${original.orderId}.json`, sourcePath = `production/jobs/${ownerHash}/${SOURCE}.json`;
  const orderBefore = structuredClone(h.records.get(orderPath)), sourceBefore = structuredClone(h.records.get(sourcePath));
  h.context.grant.partial.version = 2;
  h.context.grant.partial.kind = 'seedance-single-scene-narration-successor-v1';
  await h.service.reserve(next);
  const entries = h.records.get(FAL_FUNDING_PATH).value.entries;
  assert.deepEqual(entries.map(entry => entry.orderId), [next.orderId]);
  assert.ok(entries.every(entry => entry.preparedId !== TARGET));
  assert.deepEqual(h.records.get(orderPath), orderBefore);
  assert.deepEqual(h.records.get(sourcePath), sourceBefore);
  assert.deepEqual(h.writes, [FAL_FUNDING_PATH]);
  assert.equal(h.rechecks(), 2);
});

test('narration successor must retain exact kind, account, original reservation and completed private delivery', async () => {
  for (const change of [
    context => { context.grant.partial.version = 1; },
    context => { context.grant.partial.kind = 'seedance-single-scene-correction-v1'; },
    context => { context.grant.partial.billingAccount = 'different-account'; },
    context => { context.grant.partial.originalReservation.preparedId = TARGET; },
    context => { context.grant.partial.originalReservation.orderId = digest('successor-order'); },
    context => { context.grant.partial.originalReservation.quoteId = digest('successor-quote'); },
    context => { context.grant.partial.originalReservation.maximumCostCents = 1080; },
    context => { context.job.status = 'failed'; },
    context => { context.job.status = 'awaiting-assembly'; },
    context => { delete context.job.media; },
    context => { context.job.media.pathname = `production/media/${ownerHash}/${SOURCE}/${context.job.media.sha256}.mp4`; },
    context => { context.job.authorization.correctionId = digest('parent-grant'); },
  ]) {
    const h = fixture();
    h.context.grant.partial.version = 2;
    h.context.grant.partial.kind = 'seedance-single-scene-narration-successor-v1';
    change(h.context);
    await denied(h.service.reserve(next));
    assert.deepEqual(h.writes, []);
    assert.equal(h.records.get(FAL_FUNDING_PATH).value.entries[0].orderId, original.orderId);
  }
});

test('a resolved completed context successor satisfies only the unchanged original hold', async () => {
  const h = fixture(), before = structuredClone([...h.records.entries()]);
  h.context.grant.partial.version = 3;
  h.context.grant.partial.kind = 'seedance-single-scene-context-successor-v1';
  await h.service.reserve(next);
  assert.deepEqual(h.records.get(FAL_FUNDING_PATH).value.entries.map(entry => entry.orderId), [next.orderId]);
  assert.deepEqual(h.writes, [FAL_FUNDING_PATH]);
  assert.equal(h.rechecks(), 2);
  assert.deepEqual([...h.records.entries()].filter(([path]) => path !== FAL_FUNDING_PATH),
    before.filter(([path]) => path !== FAL_FUNDING_PATH));
});

test('context fulfillment rejects unsupported generations, altered source bindings and non-delivery', async () => {
  for (const change of [
    context => { context.grant.partial.version = 2; },
    context => { context.grant.partial.version = 4; },
    context => { context.grant.partial.kind = 'seedance-single-scene-narration-successor-v1'; },
    context => { context.grant.partial.billingAccount = 'another-account'; },
    context => { context.grant.partial.originalReservation.quoteId = digest('other-source-quote'); },
    context => { context.grant.partial.originalReservation.ownerHash = digest('other-owner'); },
    context => { context.grant.partial.originalReservation.maximumCostCents = 1080; },
    context => { context.job.authorization.originalOrderId = digest('parent-correction-id'); },
    context => { context.job.status = 'uncertain'; },
    context => { delete context.job.media; },
    context => { context.job.media.pathname = `production/media/${ownerHash}/${SOURCE}/${context.job.media.sha256}.mp4`; },
  ]) {
    const h = fixture(); h.context.grant.partial.version = 3;
    h.context.grant.partial.kind = 'seedance-single-scene-context-successor-v1';
    change(h.context);
    await denied(h.service.reserve(next)); assert.deepEqual(h.writes, []);
    assert.equal(h.records.get(FAL_FUNDING_PATH).value.entries[0].orderId, original.orderId);
  }
});

test('incomplete, legacy, mismatched and unverified corrections retain the original commitment', async () => {
  const changes = [
    context => { delete context.grant.partial; },
    context => { context.grant.partial.version = 2; },
    context => { context.grant.partial.fundingKind = 'new-reservation'; },
    context => { context.grant.partial.originalReservation.quoteId = digest('other'); },
    context => { context.grant.partial.originalReservation.maximumCostCents = 3839; },
    context => { context.grant.originalOrderId = digest('other'); },
    context => { context.grant.originalPreparedId = TARGET; },
    context => { context.grant.originalManifestHash = digest('other'); },
    context => { context.order.quoteId = digest('other'); },
    context => { context.order.customerEmail = 'other@example.invalid'; },
    context => { context.job.status = 'awaiting-assembly'; },
    context => { context.job.status = 'failed'; },
    context => { context.job.id = SOURCE; },
    context => { context.job.ownerHash = digest('other'); },
    context => { context.job.manifest.shots[0].id = 'changed'; },
    context => { context.job.authorization.correctionId = digest('other'); },
    context => { context.job.authorization.originalOrderId = digest('other'); },
    context => { context.job.authorization.environment = 'sandbox'; },
    context => { context.job.authorization.manifestHash = digest('other'); },
    context => { context.job.authorization.quoteReference = 'other'; },
    context => { context.job.authorization.budgetCents = 3841; },
    context => { context.job.provider.model = 'other'; },
    context => { context.job.media.pathname = 'production/media/other.mp4'; },
    context => { context.job.media.sha256 = digest('other'); },
    context => { context.job.media.sizeBytes = 0; },
    context => { context.job.media.durationSeconds = 0; },
    context => { delete context.recheck; },
  ];
  for (const change of changes) {
    const h = fixture(); change(h.context);
    await denied(h.service.reserve(next));
    assert.deepEqual(h.writes, []);
    assert.equal(h.records.get(FAL_FUNDING_PATH).value.entries[0].orderId, original.orderId);
  }
  // The real correction validator rejects changed claims, refunds and missing
  // records. Its refusal must keep the original funding commitment intact.
  const invalid = fixture({ invalidContext: true });
  await denied(invalid.service.reserve(next)); assert.deepEqual(invalid.writes, []);
});

test('correction proof changed after balance lookup cannot publish a new ledger', async () => {
  const h = fixture({ recheck: count => { if (count === 2) throw Error('Source payment changed'); } });
  await denied(h.service.reserve(next));
  assert.equal(h.rechecks(), 2); assert.deepEqual(h.writes, []);
  assert.equal(h.records.get(FAL_FUNDING_PATH).value.entries[0].orderId, original.orderId);
});

test('a fulfilled original commitment cannot be admitted again as a fresh reservation', async () => {
  const h = fixture();
  await denied(h.service.reserve({ ...original, customerEmail: email }));
  assert.deepEqual(h.writes, []);
});

test('completed correction does not spend credit reserved for a different film', async () => {
  const h = fixture();
  const saved = h.records.get(FAL_FUNDING_PATH).value;
  h.seed(FAL_FUNDING_PATH, { ...saved, entries: [...saved.entries,
    { ...original, orderId: digest('unrelated'), quoteId: digest('unrelated-quote'), preparedId: next.preparedId,
      maximumCostCents: 100, createdAt: new Date(NOW).toISOString() }] });
  await denied(h.service.reserve(next));
  assert.deepEqual(h.writes, []);
  assert.equal(h.records.get(FAL_FUNDING_PATH).value.entries.length, 2);
});
