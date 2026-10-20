import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { createPaidFilmCorrections, readPaidFilmCorrection, correctionCoverage, correctionIdForOrder,
  productionCorrectionPath, PaidFilmCorrectionError } from '../api/_lib/paid-film-correction.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { createPaymentsService } from '../api/_lib/payments.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS, falRequestPath } from '../api/_lib/fal-client.mjs';

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

async function recoveryFixture(options = {}) {
  const h = fixture();
  const manifest = { ...h.target.manifest, version: 1, era: '1960s', style: 'Documentary', targetDurationSeconds: 24,
    screenplay: { characters: [], scenes: [], logline: 'A fictional walk through a quiet town.' },
    shots: [{ id: 'scene-one', startMs: 0, targetDurationMs: 12000, characterIds: [], visual: 'A quiet town in morning light.' },
      { id: 'scene-two', startMs: 12000, targetDurationMs: 12000, characterIds: [], visual: 'The same quiet town at noon.' }] };
  h.target.manifest = manifest; h.target.manifestHash = sha(manifest); h.input.manifestHash = h.target.manifestHash;
  h.target.shots.push({ id: 'scene-two', status: 'prepared' });
  h.seed(jobPath(TARGET), h.target);
  const approved = await h.approve(), authorization = await h.auth(), requestKey = digest('saved-original-shot');
  const originalIdentity = digest(`${FAL_RECIPE_VERSION}:kling:${requestKey}`), originalRequestId = 'original-request-id';
  const recoveryId = digest(`kling-prompt-recovery-v1:${originalIdentity}:${originalRequestId}`);
  const replacementIdentity = digest(`${recoveryId}:replacement-v1`);
  const completedKey = digest('saved-completed-shot'), completedIdentity = digest(`${FAL_RECIPE_VERSION}:kling:${completedKey}`);
  h.mutate(jobPath(TARGET), value => { value.status = 'failed'; value.authorization = authorization;
    value.provider = { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION };
    Object.assign(value.shots[0], { status: 'failed', requestKey, providerJobId: `fal-${originalIdentity}` });
    Object.assign(value.shots[1], { status: 'completed', requestKey: completedKey, providerJobId: `fal-${completedIdentity}` }); });
  const queuePath = `production/queue/${digest(OWNER.email)}/${TARGET}.json`;
  h.seed(queuePath, { version: 1, email: OWNER.email, id: TARGET, manifestHash: h.target.manifestHash,
    orderId: approved.correctionId, state: 'attention' });
  const receiptPath = falRequestPath(originalIdentity), originalInputHash = digest('original long prompt');
  h.seed(receiptPath, { version: 1, identity: originalIdentity, endpoint: FAL_MODELS.kling,
    inputHash: originalInputHash, requestId: originalRequestId, state: 'failed', failureCode: 'FAL_RENDER_FAILED' });
  h.seed(falRequestPath(completedIdentity), { version: 1, identity: completedIdentity, endpoint: FAL_MODELS.kling,
    inputHash: digest('completed original input'), requestId: 'completed-request-id', state: 'completed' });
  const claimPath = `production/fal/failed-shot-recoveries/${recoveryId}.json`;
  const claim = { version: 1, kind: 'kling-failed-shot-recovery-v1', recoveryId, ownerHash: digest(OWNER.email),
    preparedId: TARGET, manifestHash: h.target.manifestHash, correctionId: approved.correctionId, model: 'kling', recipe: FAL_RECIPE_VERSION,
    maximumCostCents: 1980, maximumTotalCostCents: 1980, originalIdentity, originalRequestId, originalInputHash,
    endpoint: FAL_MODELS.kling, replacementIdentity, inputHash: digest('shortened directions with exact saved script'),
    shotId: 'scene-one', shotIndex: 1, providerSeconds: 12, replacementMaximumCents: 180,
    terminalFailure: 'PROMPT_LENGTH_422', zeroChargeCents: 0, billingEvidenceSha256: digest('billing evidence'),
    rejectionEvidenceSha256: digest('provider rejection evidence'), billingObservedAt: new Date(NOW).toISOString(),
    priorSpendCents: 168, totalReplacementMaximumCents: 180, selectedRequests: [{ shotIndex: 1, requestId: originalRequestId }],
    originalRequests: [{ requestId: originalRequestId, amountCents: 0 }, { requestId: 'completed-request-id', amountCents: 168 }],
    createdAt: new Date(NOW).toISOString() };
  h.seed(claimPath, claim);
  const input = { email: OWNER.email, correctionId: approved.correctionId, preparedId: TARGET, manifestHash: h.target.manifestHash,
    recoveryId, originalIdentity, originalRequestId, replacementIdentity };
  const service = createPaidFilmCorrections({ ...h.deps, recoveryQuoteProvider: h.deps.quoteProvider,
    readRecoveryCreditCents: async () => 180, ...options });
  return { ...h, claim, claimPath, receiptPath, queuePath, recoveryInput: input,
    recover: change => service.authorizeFailedShotRecovery({ ...input, ...change }) };
}

test('failed-shot authorization reuses the original sale and budget, with remaining wallet capacity and no writes', async () => {
  const h = await recoveryFixture(), writes = h.writes.length, reservations = h.reservations.length;
  await assert.rejects(h.auth());
  const grant = await h.recover();
  assert.equal(grant.allowed, true); assert.equal(grant.budgetCents, 1980); assert.equal(grant.replacementMaximumCents, 180);
  assert.equal(grant.originalOrderId, h.orderId); assert.equal(grant.recoveryId, h.claim.recoveryId);
  assert.equal(grant.inputHash, h.claim.inputHash); assert.equal(grant.quoteReference, 'fictional-kling-correction');
  assert.ok(Date.parse(grant.expiresAt) > h.now() && Date.parse(grant.expiresAt) <= h.now() + 60_000);
  assert.equal(h.writes.length, writes); assert.equal(h.reservations.length, reservations);
  assert.deepEqual(h.verifications.at(-1), { email: OWNER.email, orderId: h.orderId, preparedId: SOURCE, manifestHash: h.original.manifestHash });
});

test('recovery rejects unproven failures, changed bindings, duplicate or overstated repair budgets', async () => {
  const changes = [
    c => { c.zeroChargeCents = 1; }, c => { c.terminalFailure = 'TIMEOUT'; }, c => { c.replacementMaximumCents = 181; },
    c => { c.priorSpendCents = 1801; }, c => { c.totalReplacementMaximumCents = 179; }, c => { c.maximumCostCents = 1981; },
    c => { c.originalRequests[0].amountCents = 1; }, c => { c.originalRequests[0].requestId = 'different-request'; },
    c => { c.selectedRequests.push(c.selectedRequests[0]); }, c => { c.shotIndex = 2; }, c => { c.shotId = 'different'; },
    c => { c.billingEvidenceSha256 = null; }, c => { c.rejectionEvidenceSha256 = null; },
    c => { c.originalInputHash = digest('mismatched original input'); }, c => { c.inputHash = c.originalInputHash; },
  ];
  for (const change of changes) { const h = await recoveryFixture(); h.mutate(h.claimPath, change); await assert.rejects(h.recover()); }
  for (const change of [r => { r.state = 'processing'; }, r => { r.state = 'uncertain'; }, r => { r.failureCode = 'FAL_HTTP_503'; },
    r => { r.result = { video: {} }; }, r => { r.identity = digest('wrong identity'); }]) {
    const h = await recoveryFixture(); h.mutate(h.receiptPath, change); await assert.rejects(h.recover());
  }
});

test('completed original clips require exact 14-cent-per-second billing before replacement authorization', async () => {
  for (const amountCents of [0, 167, 169]) {
    const h = await recoveryFixture();
    h.mutate(h.claimPath, claim => { claim.originalRequests[1].amountCents = amountCents; claim.priorSpendCents = amountCents; });
    await assert.rejects(h.recover());
  }
  const h = await recoveryFixture();
  assert.equal((await h.recover()).allowed, true);
});

test('failed-shot repair cannot overlap a worker, an existing replacement, or an already completed shot', async () => {
  for (const [place, change] of [
    ['queue', q => { q.state = 'pending'; }], ['queue', q => { q.lease = { expiresAt: NOW + 1 }; }],
    ['job', j => { j.lease = { expiresAt: NOW + 1 }; }], ['job', j => { j.status = 'processing'; }],
    ['job', j => { j.shots[0].status = 'completed'; }], ['job', j => { j.authorization.budgetCents++; }],
  ]) { const h = await recoveryFixture(); h.mutate(place === 'queue' ? h.queuePath : jobPath(TARGET), change); await assert.rejects(h.recover()); }
  for (const pathFor of [h => falRequestPath(h.claim.replacementIdentity), h => `production/fal/choices/${h.claim.originalIdentity}.json`]) {
    const h = await recoveryFixture(); h.seed(pathFor(h), { state: 'uncertain' }); await assert.rejects(h.recover());
  }
  const h = await recoveryFixture(); h.mutate(h.queuePath, q => { q.lease = { expiresAt: NOW - 1 }; });
  assert.equal((await h.recover()).allowed, true);
});

test('recovery denies changed payment, insufficient remaining funding, and storage races after live verification', async () => {
  const unfunded = await recoveryFixture({ readRecoveryCreditCents: async () => 179 }); await assert.rejects(unfunded.recover());
  const reversed = await recoveryFixture(); reversed.verifyEffect(() => { throw Error('original sale was reversed'); });
  await assert.rejects(reversed.recover());
  for (const mutate of [h => h.mutate(h.claimPath, c => { c.inputHash = digest('changed'); }),
    h => h.mutate(h.queuePath, q => { q.state = 'pending'; }), h => h.mutate(h.receiptPath, r => { r.state = 'completed'; }),
    h => h.seed(falRequestPath(h.claim.replacementIdentity), { state: 'submitting' }),
    h => h.mutate(jobPath(TARGET), j => { j.lease = { expiresAt: NOW + 1 }; })]) {
    const h = await recoveryFixture(); h.verifyEffect(() => mutate(h)); await assert.rejects(h.recover());
  }
});
