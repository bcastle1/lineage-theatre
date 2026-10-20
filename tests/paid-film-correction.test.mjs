import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { createPaidFilmCorrections, readPaidFilmCorrection, correctionCoverage, correctionIdForOrder,
  productionCorrectionPath, PaidFilmCorrectionError } from '../api/_lib/paid-film-correction.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { createPaymentsService } from '../api/_lib/payments.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z'), OWNER = { email: OWNER_EMAIL, role: 'owner' };
const SOURCE = '11111111-1111-4111-8111-111111111111', TARGET = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const sha = value => digest(JSON.stringify(value));
const jobPath = id => `production/jobs/${digest(OWNER.email)}/${id}.json`;
function makeJob(id, title) {
  const manifest = { filmId: id, title, screenplay: { characters: [], scenes: [] }, sources: [], shots: [{ id: 'scene-one' }] };
  return { id, mode: 'customer', ownerHash: digest(OWNER.email), filmId: id, manifest, manifestHash: sha(manifest),
    status: 'prepared', shots: [{ id: 'scene-one', status: 'prepared' }] };
}
function fixture(options = {}) {
  let serial = 0, at = NOW, failWrite, verifyEffect;
  const records = new Map(), writes = [], quotes = [], verifications = [], reservations = [];
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `etag-${++serial}` });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (failWrite?.(path, value)) throw Error('storage unavailable');
    if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw Error('CAS conflict');
    writes.push(path); seed(path, value);
    if (options.uncertainWrite?.(path)) throw Error('reply lost');
  };
  const original = makeJob(SOURCE, 'Original fictional story'), target = makeJob(TARGET, 'Corrected fictional story');
  original.status = 'completed'; original.shots[0].status = 'completed';
  const orderId = digest(`${OWNER.email}:production:${original.manifestHash}`);
  const order = { id: orderId, customerEmail: OWNER.email, preparedId: SOURCE, manifestHash: original.manifestHash, filmId: original.filmId,
    status: 'captured', currency: 'USD', amountCents: 3870, providerCostCents: 2580, markupCents: 1290, refundedCents: 0,
    checkoutMethod: 'quickbooks-hosted-invoice', provider: 'quickbooks', confirmationSource: 'quickbooks-accounting',
    quoteId: digest('original paid quote'), invoiceId: '123', customerId: '124', balanceCents: 0, paymentIds: ['125'],
    accountingPayments: [{ id: '125', allocatedCents: 3870 }], capturedAt: new Date(NOW - 1000).toISOString(),
    accountingCheckedAt: new Date(NOW - 1000).toISOString(), lastCheckStage: 'complete', lastCheckFailureReason: null,
    merchantBinding: { environment: 'production', realmId: '126', grantId: digest('original grant') } };
  seed(userPath(OWNER.email), OWNER); seed(jobPath(SOURCE), original); seed(jobPath(TARGET), target);
  seed(`payments/orders/${orderId}.json`, order);
  const verifyPaidSale = async input => {
    verifications.push(structuredClone(input));
    assert.deepEqual(input, { email: OWNER.email, orderId, preparedId: SOURCE, manifestHash: original.manifestHash });
    await verifyEffect?.();
    if (options.reversed) throw Error('recorded refund');
    const record = await read(`payments/orders/${orderId}.json`);
    return { order: record.value, expiresAt: new Date(at + 60_000).toISOString(),
      recheck: async () => assert.equal((await read(`payments/orders/${orderId}.json`)).etag, record.etag) };
  };
  const deps = { read, write, now: () => at, verifyPaidSale,
    quoteProvider: async input => { quotes.push(input); return { ...input, currency: 'USD', providerCostCents: 1980, maximumCostCents: 1980,
      quoteReference: 'fictional-kling-correction', expiresAt: new Date(at + 86400_000).toISOString(),
      apiVerified: true, qualityVerified: true, commercialTermsVerified: true, ...options.quote }; },
    reserveFunding: async input => { reservations.push(input); if (options.noFunds) throw Error('funding unavailable'); return { recheck: async () => true }; } };
  const service = createPaidFilmCorrections(deps);
  const input = { actor: OWNER, originalOrderId: orderId, preparedId: TARGET, manifestHash: target.manifestHash,
    maximumCostCents: 1980, reason: 'Customer requested this corrected screenplay and selected photo.', confirmed: true };
  const mutate = (path, fn) => { const r = structuredClone(records.get(path).value); fn(r); seed(path, r); };
  return { service, deps, records, writes, quotes, reservations, verifications, input, read, write, seed, target, original, order, orderId,
    approve: changes => service.approve({ ...input, ...changes }), advance: ms => { at += ms; }, now: () => at, mutate,
    failWrites: fn => { failWrite = fn; }, verifyEffect: fn => { verifyEffect = fn; }, verifyPaidSale,
    auth: () => service.authorizeProduction({ email: OWNER.email, orderId: correctionIdForOrder(orderId), preparedId: TARGET, manifestHash: target.manifestHash }) };
}

test('merchant correction binds the immutable original sale and new plan without financial writes or customer charge', async () => {
  const h = fixture(), before = structuredClone(h.records.get(`payments/orders/${h.orderId}.json`));
  const result = await h.approve();
  assert.equal(result.correctionId, correctionIdForOrder(h.orderId)); assert.equal(result.customerChargeCents, 0);
  assert.equal(result.status, 'authorized'); assert.equal(result.maximumCostCents, 1980);
  assert.deepEqual(h.records.get(`payments/orders/${h.orderId}.json`), before);
  assert.ok(h.writes.every(path => path.startsWith('production/')));
  assert.equal(h.reservations.length, 1); assert.equal(h.reservations[0].orderId, result.correctionId);
  assert.equal(h.reservations[0].preparedId, TARGET); assert.equal(h.reservations[0].manifestHash, h.target.manifestHash);
  assert.deepEqual(await h.approve(), result); assert.equal(h.reservations.length, 1); assert.equal(h.quotes.length, 1);
  const context = await readPaidFilmCorrection({ email: OWNER.email, job: h.target, read: h.read, now: h.now });
  assert.deepEqual(correctionCoverage(context), { kind: 'original-payment', correctionId: result.correctionId, orderId: h.orderId,
    originalPreparedId: SOURCE, amountCents: 3870, currency: 'USD', receiptAvailable: true, customerChargeCents: 0 });
});

test('correction requires current owner, explicit confirmation, exact target, reviewed budget and actual quote', async () => {
  for (const changes of [{ confirmed: false }, { maximumCostCents: 1981 }, { maximumCostCents: 0 }, { manifestHash: digest('wrong plan') },
    { actor: { email: 'other@example.invalid', role: 'owner' } }, { actor: { ...OWNER, mustChangePassword: true } }, { reason: '<invalid>' }]) {
    const h = fixture(); await assert.rejects(h.approve(changes)); assert.equal(h.reservations.length, 0);
  }
  for (const change of [{ status: 'suspended' }, { role: 'customer' }, { mustChangePassword: true }]) {
    const h = fixture(); h.mutate(userPath(OWNER.email), value => Object.assign(value, change));
    await assert.rejects(h.approve()); assert.equal(h.reservations.length, 0);
  }
  for (const quote of [{ maximumCostCents: 1981 }, { providerCostCents: 1981 }, { environment: 'sandbox' }, { qualityVerified: false },
    { preparedId: OTHER }, { manifestHash: digest('mismatch') }, { expiresAt: new Date(NOW).toISOString() }]) {
    const h = fixture({ quote }); await assert.rejects(h.approve()); assert.equal(h.reservations.length, 0);
  }
});

test('every grant rechecks the real source sale and cannot switch a started film or its budget', async () => {
  const h = fixture(); const result = await h.approve(), first = await h.auth();
  assert.equal(first.originalOrderId, h.orderId); assert.equal(first.correctionId, result.correctionId);
  assert.equal(first.manifestHash, h.target.manifestHash); assert.equal(first.budgetCents, 1980);
  h.mutate(jobPath(TARGET), value => { value.status = 'processing'; value.authorization = first;
    value.provider = { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION }; value.shots[0].status = 'processing'; });
  await h.auth(); assert.equal(h.verifications.length, 3);
  h.mutate(jobPath(TARGET), value => { value.authorization.originalOrderId = digest('different order'); });
  await assert.rejects(h.auth());
});

test('recorded refunds, source mutation, stale proof and missing funding fail closed', async () => {
  for (const options of [{ reversed: true }, { noFunds: true }]) {
    const h = fixture(options); await assert.rejects(h.approve());
    assert.equal(h.records.has(productionCorrectionPath(correctionIdForOrder(h.orderId))), false);
  }
  for (const change of [value => { value.refundedCents = 1; }, value => { value.status = 'refunded'; },
    value => { value.refundOperation = {}; }, value => { value.amountCents++; }, value => { value.customerEmail = 'other@example.invalid'; }]) {
    const h = fixture(); await h.approve(); h.mutate(`payments/orders/${h.orderId}.json`, change);
    await assert.rejects(h.auth()); await assert.rejects(readPaidFilmCorrection({ email: OWNER.email, job: h.target, read: h.read, now: h.now }));
  }
  const h = fixture(); await h.approve(); h.advance(86400_001); const refreshed = await h.auth();
  assert.ok(Date.parse(refreshed.expiresAt) > h.now()); assert.equal(refreshed.quoteReference, 'fictional-kling-correction');
});

test('one immutable source claim wins competing targets and uncertain writes are reconciled without a second grant', async () => {
  const h = fixture({ uncertainWrite: () => true }), other = makeJob(OTHER, 'Another correction');
  h.seed(jobPath(OTHER), other);
  const results = await Promise.allSettled([h.approve(), h.approve({ preparedId: OTHER, manifestHash: other.manifestHash })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(h.reservations.length, 1);
  assert.equal(h.writes.filter(path => path.startsWith('production/corrections/')).length, 1);
  const winner = results[0].status === 'fulfilled' ? {} : { preparedId: OTHER, manifestHash: other.manifestHash };
  await h.approve(winner); assert.equal(h.reservations.length, 1);
});

test('interrupted funding publication can resume only the exact claimed target and original approval', async () => {
  const h = fixture(); let fail = true;
  h.failWrites(path => fail && path.startsWith('production/corrections/'));
  await assert.rejects(h.approve()); assert.equal(h.reservations.length, 1);
  await assert.rejects(h.approve({ reason: 'Changed request after the claim.' }));
  fail = false; h.advance(86400_001); await h.approve(); assert.equal(h.quotes.length, 2);
  const result = await h.approve(); assert.equal(result.preparedId, TARGET);
});

test('real payments dispatcher recognizes only a persisted correction and invokes hosted live-sale verification', async () => {
  const h = fixture(); const result = await h.approve();
  const payments = createPaymentsService({ read: h.read, write: h.write, now: h.now, hostedCheckout: { verifyPaidSale: h.verifyPaidSale },
    correctionQuoteProvider: h.deps.quoteProvider });
  const grant = await payments.authorizeProduction({ email: OWNER.email, orderId: result.correctionId, preparedId: TARGET, manifestHash: h.target.manifestHash });
  assert.equal(grant.correctionId, result.correctionId); assert.equal(h.verifications.length, 2);
  await assert.rejects(payments.authorizeProduction({ email: OWNER.email, orderId: result.correctionId, preparedId: SOURCE, manifestHash: h.original.manifestHash }));
});

test('finished media and authored soundtrack require the explicit correction, saved authorization and intact original payment', async () => {
  const h = fixture(); await h.approve(); const grant = await h.auth();
  h.mutate(jobPath(TARGET), value => { value.status = 'awaiting-assembly'; value.shots[0].status = 'completed';
    value.authorization = grant; value.provider = { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION }; });
  const job = (await h.read(jobPath(TARGET))).value;
  await requireFinishedFilmPayment({ job, email: OWNER.email, actor: OWNER, read: h.read, now: h.now });
  h.mutate(`payments/orders/${h.orderId}.json`, value => { value.refundedCents = 1; });
  await assert.rejects(requireFinishedFilmPayment({ job, email: OWNER.email, actor: OWNER, read: h.read, now: h.now }));
  const unapproved = fixture();
  await assert.rejects(requireFinishedFilmPayment({ job: { ...unapproved.target, authorization: grant }, email: OWNER.email, actor: OWNER,
    read: unapproved.read, now: unapproved.now }));
});
