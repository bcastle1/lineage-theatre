import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createFalFunding, FAL_FUNDING_PATH, readFalCreditCents } from '../api/_lib/fal-funding.mjs';

const env = { FAL_BILLING_KEY: 'synthetic-billing-only-key', FAL_BILLING_ACCOUNT: 'fictional-account' };
const now = Date.parse('2026-10-20T12:00:00Z');
const json = value => new Response(JSON.stringify(value));
const billing = balance => ({ username: env.FAL_BILLING_ACCOUNT, credits: { current_balance: balance, currency: 'USD' } });
const input = (name = 'first', maximumCostCents = 600) => ({
  orderId: digest(`order:${name}`), customerEmail: `${name}@example.invalid`,
  quoteId: digest(`quote:${name}`),
  preparedId: `${digest(name).slice(0, 8)}-1234-5678-9876-123456789012`,
  manifestHash: digest(JSON.stringify({ shots: [{ id: name }] })), maximumCostCents,
});
const failure = promise => assert.rejects(promise, error => error.code === 'FAL_FUNDING_UNAVAILABLE'
  && error.message === 'Production funding could not be reserved.');
function fixture(options = {}) {
  let serial = 0, balance = options.balance ?? 10;
  const records = new Map(), requests = [], writes = [];
  const seed = (path, value) => records.set(path, { etag: `etag-${++serial}`, value: structuredClone(value) });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    await options.beforeWrite?.(path, value, etag);
    const prior = records.get(path);
    if (prior ? prior.etag !== etag : Boolean(etag)) throw Error('Synthetic conditional conflict');
    writes.push({ path, value: structuredClone(value) }); seed(path, value);
    await options.afterWrite?.(path, value);
    return read(path);
  };
  const listBlobs = options.listBlobs || (async () => ({ hasMore: false,
    blobs: [...records.keys()].filter(path => path.startsWith('payments/orders/')).map(pathname => ({ pathname })) }));
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return json(billing(balance)); };
  const dependencies = { read, write, listBlobs, fetchImpl, env: options.env || env, now: () => now };
  const service = createFalFunding(dependencies);
  const order = (value, status = 'awaiting-payment') => {
    seed(`payments/orders/${value.orderId}.json`, { id: value.orderId, customerEmail: value.customerEmail,
      preparedId: value.preparedId, manifestHash: value.manifestHash, quoteId: value.quoteId, providerCostCents: value.maximumCostCents,
      merchantBinding: { environment: 'production' }, currency: 'USD', status });
  };
  const completed = (value, name) => {
    const ownerHash = digest(value.customerEmail), sha256 = digest('fictional completed film');
    const path = `production/jobs/${ownerHash}/${value.preparedId}.json`;
    seed(path, { status: 'completed', id: value.preparedId, ownerHash, manifestHash: value.manifestHash,
      manifest: { shots: [{ id: name }] }, media: { sha256, contentType: 'video/mp4',
        pathname: `production/media/${ownerHash}/${value.preparedId}/${sha256}.mp4` } });
    return path;
  };
  return { service, seed, read, records, writes, requests, order, completed,
    peer: () => createFalFunding(dependencies), balance: value => { balance = value; } };
}

test('billing uses only the fixed account endpoint and rounds available cents down', async () => {
  let request;
  const amount = await readFalCreditCents({ env, fetchImpl: async (url, init) => {
    request = { url, init }; return json(billing(7.929));
  } });
  assert.equal(amount, 792);
  assert.equal(request.url, 'https://api.fal.ai/v1/account/billing?expand=credits');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.Authorization, 'Key synthetic-billing-only-key');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'omit');
});

test('missing billing configuration, malformed balances, account mismatch and failed reads fail privately', async () => {
  for (const configured of [{}, { ...env, FAL_BILLING_KEY: '' }, { ...env, FAL_BILLING_ACCOUNT: '' }])
    await failure(readFalCreditCents({ env: configured, fetchImpl: () => assert.fail('No configured request') }));
  for (const body of [{}, { ...billing(10), username: 'different-account' }, billing(null), billing('10'), billing(-1),
    billing(10_000_001), { username: env.FAL_BILLING_ACCOUNT, credits: { current_balance: 10, currency: 'EUR' } }])
    await failure(readFalCreditCents({ env, fetchImpl: async () => json(body) }));
  for (const fetchImpl of [async () => new Response('PRIVATE_PROVIDER_DETAILS', { status: 403 }),
    async () => new Response('not JSON'), async () => new Response('x'.repeat(65_537)),
    async () => { throw Error('PRIVATE_PROVIDER_DETAILS'); }])
    await failure(readFalCreditCents({ env, fetchImpl }));
});

test('full budget is held durably and exact retry/recheck uses fresh balance without another hold', async () => {
  const h = fixture({ balance: 20 }), value = input('first', 1980);
  const reservation = await h.service.reserve(value);
  assert.equal(await reservation.recheck(), true);
  await h.service.reserve(value);
  const ledger = (await h.read(FAL_FUNDING_PATH)).value;
  assert.equal(ledger.revision, 3);
  assert.equal(ledger.account, env.FAL_BILLING_ACCOUNT);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].maximumCostCents, 1980);
  assert.equal(ledger.entries[0].ownerHash, digest(value.customerEmail));
  assert.equal(h.requests.length, 3);
  assert.doesNotMatch(JSON.stringify(ledger), /current_balance|synthetic-billing-only-key|@example/);
});

test('insufficient balance blocks admission and a later falling balance blocks final recheck', async () => {
  const low = fixture({ balance: 7.92 });
  await failure(low.service.reserve(input('first', 1980)));
  assert.equal(low.writes.length, 0);
  const h = fixture(), reservation = await h.service.reserve(input());
  h.balance(5.99);
  await failure(reservation.recheck());
  assert.equal((await h.read(FAL_FUNDING_PATH)).value.entries.length, 1);
});

test('concurrent distinct checkouts cannot both reserve the same available credit', async () => {
  const h = fixture();
  const outcomes = await Promise.allSettled([h.service.reserve(input()), h.peer().reserve(input('second'))]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
  assert.equal((await h.read(FAL_FUNDING_PATH)).value.entries.length, 1);
});

test('unknown writes are reconciled by exact readback and repeated write failures never admit', async () => {
  let first = true;
  const h = fixture({ afterWrite: () => { if (first) { first = false; throw Error('Uncertain write'); } } });
  await h.service.reserve(input());
  assert.equal((await h.read(FAL_FUNDING_PATH)).value.entries.length, 1);
  let count = 0;
  const broken = fixture({ beforeWrite: () => { count++; throw Error('Storage unavailable'); } });
  await failure(broken.service.reserve(input()));
  assert.equal(count, 3);
  assert.equal(broken.records.has(FAL_FUNDING_PATH), false);
});

test('old unpaid, uncertain, captured and refunded orders each retain a full production commitment', async () => {
  for (const status of ['awaiting-payment', 'submitting', 'uncertain', 'captured', 'partially-refunded', 'refunded']) {
    const h = fixture();
    h.order(input('old', 400), status);
    await failure(h.service.reserve(input('new', 700)));
    assert.equal(h.writes.length, 0, status);
  }
});

test('existing legacy card orders use their provider estimate and explicit sandbox/declined orders are excluded', async () => {
  const h = fixture(), old = input('old', 400);
  h.order(old);
  const path = `payments/orders/${old.orderId}.json`, order = (await h.read(path)).value;
  delete order.providerCostCents; order.providerCostEstimateCents = 400; h.seed(path, order);
  await failure(h.service.reserve(input('new', 700)));
  h.seed(path, { ...order, merchantBinding: { environment: 'sandbox' } });
  await h.service.reserve(input('new', 700));
  const declined = fixture(); declined.order(old, 'declined');
  await declined.service.reserve(input('new', 700));
});

test('an owner allowance raises the existing commitment rather than using its original customer price', async () => {
  const h = fixture(), old = input('old', 100); h.order(old, 'captured');
  h.seed(`production/allowances/${old.orderId}.json`, {
    orderId: old.orderId, customerEmail: old.customerEmail, preparedId: old.preparedId,
    manifestHash: old.manifestHash, maximumCostCents: 400,
  });
  await failure(h.service.reserve(input('new', 700)));
});

test('only a matching completed private artifact releases the old commitment', async () => {
  const old = input('old', 400);
  const valid = fixture(); valid.order(old); valid.completed(old, 'old');
  await valid.service.reserve(input('new', 700));
  assert.equal((await valid.read(FAL_FUNDING_PATH)).value.entries.length, 1);
  for (const changed of ['status', 'manifest', 'manifestHash', 'ownerHash', 'media']) {
    const h = fixture(); h.order(old); const path = h.completed(old, 'old'), job = (await h.read(path)).value;
    if (changed === 'status') job.status = 'awaiting-assembly';
    if (changed === 'manifest') job.manifest.shots[0].id = 'changed';
    if (changed === 'manifestHash') job.manifestHash = digest('changed');
    if (changed === 'ownerHash') job.ownerHash = digest('changed');
    if (changed === 'media') job.media.pathname = 'production/media/wrong.mp4';
    h.seed(path, job);
    await failure(h.service.reserve(input('new', 700)));
  }
});

test('a hold without an invoice or job never expires and bound fields cannot be changed on retry', async () => {
  const h = fixture(), first = input(); await h.service.reserve(first);
  await failure(h.service.reserve(input('second')));
  for (const change of [{ maximumCostCents: 1 }, { manifestHash: digest('different') },
    { preparedId: input('other').preparedId }, { customerEmail: 'other@example.invalid' }])
    await failure(h.service.reserve({ ...first, ...change }));
  assert.equal((await h.read(FAL_FUNDING_PATH)).value.entries.length, 1);
});

test('unknown order schema and malformed ledger fail closed', async () => {
  const h = fixture(), old = input('old');
  h.order(old, 'unrecognized-status'); await failure(h.service.reserve(input()));
  for (const change of [{ version: 2 }, { account: 'different-account' }, { revision: -1 }, { revision: '1' },
    { entries: [{ invalid: true }] }]) {
    const bad = fixture();
    bad.seed(FAL_FUNDING_PATH, { version: 1, account: env.FAL_BILLING_ACCOUNT, revision: 1, entries: [], ...change });
    await failure(bad.service.reserve(input()));
  }
});

test('order enumeration fails closed at its bound, invalid paths, empty continuation and repeated pages', async () => {
  const blobs = Array.from({ length: 1000 }, (_, index) => ({ pathname: `payments/orders/${digest(String(index))}.json` }));
  for (const page of [{ blobs, hasMore: true, cursor: 'more' }, { blobs: [], hasMore: true, cursor: 'more' },
    { blobs: [{ pathname: 'payments/orders/not-an-order.json' }], hasMore: false }]) {
    const h = fixture({ listBlobs: async () => page });
    await failure(h.service.reserve(input()));
    assert.equal(h.requests.length, 0);
  }
  let calls = 0;
  const h = fixture({ listBlobs: async () => {
    calls++; return { blobs: [{ pathname: `payments/orders/${digest(String(calls))}.json` }], hasMore: true, cursor: 'same' };
  } });
  await failure(h.service.reserve(input())); assert.equal(calls, 2);
});

test('invalid reservation input fails before billing or storage writes', async () => {
  for (const change of [{ orderId: 'bad' }, { preparedId: '../escape' }, { manifestHash: 'bad' },
    { customerEmail: 'UPPER@example.invalid' }, { maximumCostCents: 0 }, { maximumCostCents: 0.1 }]) {
    const h = fixture(); await failure(h.service.reserve({ ...input(), ...change }));
    assert.equal(h.requests.length, 0); assert.equal(h.writes.length, 0);
  }
});

test('expired unattempted order is CAS fenced before its immutable receipt releases the hold', async () => {
  const h = fixture(), old = input('old', 600);
  await h.service.reserve(old); h.order(old, 'uncertain');
  const path = `payments/orders/${old.orderId}.json`;
  h.seed(path, { ...(await h.read(path)).value, checkoutMethod: 'quickbooks-hosted-invoice',
    expiresAt: new Date(now - 1).toISOString(), checkoutBlock: 'production-funding' });
  const unfenced = await h.read(path);
  await h.service.reserve(input('new', 700));
  const fenced = await h.read(path);
  assert.notEqual(fenced.etag, unfenced.etag);
  assert.equal(await h.service.wasReleased(fenced.value), true);
  assert.equal((await h.read(FAL_FUNDING_PATH)).value.entries.length, 1);
  assert.equal((await h.read(FAL_FUNDING_PATH)).value.entries[0].orderId, input('new').orderId);
  const fenceWrite = h.writes.findIndex(value => value.path === path);
  const receiptWrite = h.writes.findIndex(value => value.path.startsWith('production/fal/funding-releases/'));
  assert.ok(fenceWrite >= 0 && receiptWrite > fenceWrite);
  await failure(h.service.reserve(old));
});

test('missing, uncertain or mismatched expiry receipt cannot authorize restart', async () => {
  const h = fixture(), old = input('old'); h.order(old, 'uncertain');
  const path = `payments/orders/${old.orderId}.json`;
  h.seed(path, { ...(await h.read(path)).value, checkoutMethod: 'quickbooks-hosted-invoice', expiresAt: new Date(now - 1).toISOString() });
  const released = await h.service.releaseExpiredOrder(old.orderId, old.quoteId);
  assert.equal(await h.service.wasReleased(released.value), true);
  const receipt = `production/fal/funding-releases/${old.orderId}/${old.quoteId}.json`;
  h.records.delete(receipt);
  assert.equal(await h.service.wasReleased(released.value), false);
  h.seed(receipt, { ...released.value.fundingRelease, quoteId: digest('different') });
  assert.equal(await h.service.wasReleased(released.value), false);
  await failure(h.service.releaseExpiredOrder(old.orderId, old.quoteId));
});

test('expired attempted, externally identified or paid orders can never be fenced for a fresh invoice', async () => {
  for (const changed of [{ invoiceAttemptedAt: new Date(now - 60_000).toISOString() },
    { invoiceAttemptedAt: '' }, { invoiceId: '30' }, { invoiceNumber: '1001' }, { invoiceUrl: 'https://connect.intuit.com/portal/x' },
    { capturedAt: new Date(now - 60_000).toISOString() }, { status: 'captured' }, { providerChargeId: 'external' },
    { paymentIds: ['40'] }, { accountingPayments: [{ id: '40' }] }]) {
    const h = fixture(), old = input('old'); h.order(old, 'uncertain');
    const path = `payments/orders/${old.orderId}.json`;
    h.seed(path, { ...(await h.read(path)).value, checkoutMethod: 'quickbooks-hosted-invoice',
      expiresAt: new Date(now - 1).toISOString(), ...changed });
    await failure(h.service.releaseExpiredOrder(old.orderId, old.quoteId));
    assert.equal(h.writes.length, 0);
  }
});

test('an old release receipt cannot release a newer quote budget for the same film order', async () => {
  const h = fixture(), old = input('old'); await h.service.reserve(old); h.order(old, 'uncertain');
  const path = `payments/orders/${old.orderId}.json`;
  h.seed(path, { ...(await h.read(path)).value, checkoutMethod: 'quickbooks-hosted-invoice', expiresAt: new Date(now - 1).toISOString() });
  await h.service.releaseExpiredOrder(old.orderId, old.quoteId);
  const next = { ...old, quoteId: digest('fresh quote'), maximumCostCents: 900 };
  h.order(next, 'submitting');
  await h.service.reserve(next);
  await failure(h.service.reserve(input('second', 200)));
  const held = (await h.read(FAL_FUNDING_PATH)).value.entries[0];
  assert.equal(held.quoteId, next.quoteId);
  assert.equal(held.maximumCostCents, 900);
  await failure(h.service.releaseExpiredOrder(old.orderId, old.quoteId));
});

test('a concurrent invoice claim defeats an expired-order release fence', async () => {
  let h, raced = false;
  h = fixture({ beforeWrite: (path, value) => {
    if (path.startsWith('payments/orders/') && value.fundingRelease && !raced) {
      raced = true; h.seed(path, { ...h.records.get(path).value, invoiceAttemptedAt: new Date(now - 2).toISOString() });
    }
  } });
  const old = input('old'); h.order(old, 'uncertain');
  const path = `payments/orders/${old.orderId}.json`;
  h.seed(path, { ...(await h.read(path)).value, checkoutMethod: 'quickbooks-hosted-invoice', expiresAt: new Date(now - 1).toISOString() });
  await failure(h.service.releaseExpiredOrder(old.orderId, old.quoteId));
  assert.equal(h.writes.length, 0);
});
