import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const contractUrl = moduleUrl((await compile('../src/studio/checkout-contract.ts'))
  .replaceAll('"./hosted-invoice-url.mjs"', JSON.stringify(new URL('../src/studio/hosted-invoice-url.mjs', import.meta.url).href)));
const libraryUrl = moduleUrl(await compile('../src/studio/film-library.ts'));
const preRenderUrl = moduleUrl(await compile('../src/studio/film-prerender.ts'));
const { prepareSavedFilmCheckout } = await import(moduleUrl((await compile('../src/studio/saved-film-purchase.ts'))
  .replaceAll("'./checkout-contract'", JSON.stringify(contractUrl))
  .replaceAll("'./film-library'", JSON.stringify(libraryUrl))
  .replaceAll("'./film-prerender'", JSON.stringify(preRenderUrl))));

const NOW = Date.parse('2026-11-22T12:00:00Z');
const ID = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const readyEntry = () => ({ kind: 'plan', id: ID, manifestHash: HASH, filmId: 'fictional-film', title: 'A fictional test film',
  durationSeconds: 15, createdAt: new Date(NOW - 3600000).toISOString(), updatedAt: new Date(NOW).toISOString(),
  libraryState: 'active', revision: 1, payments: [], production: {
    status: 'completed', completedShots: 3, shotCount: 3, mediaReady: false, needsAttention: false,
    deliveryFlow: 'render-before-payment-v1', artifactReady: true, purchaseReady: true, paymentLocked: true,
    price: { amountCents: 2880, currency: 'USD', preparedId: ID, manifestHash: HASH },
  } });
const configuration = () => ({ available: true, method: 'quickbooks-hosted-invoice', environment: 'production',
  deliveryTerms: 'Payment unlocks this finished film.', refundTerms: 'Contact the studio about a delivery problem.' });
const matchingQuote = () => ({ id: 'b'.repeat(64), orderId: 'c'.repeat(64), preparedId: ID, manifestHash: HASH,
  filmId: 'fictional-film', filmTitle: 'A fictional test film', currency: 'USD', amountCents: 2880,
  expiresAt: new Date(NOW + 60000).toISOString(), sandbox: false, method: 'quickbooks-hosted-invoice',
  deliveryTerms: configuration().deliveryTerms, refundTerms: configuration().refundTerms });
const harness = ({ current = readyEntry(), config = configuration(), quote = matchingQuote() } = {}) => {
  const calls = [];
  const request = async (path, body) => {
    calls.push({ path, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (path === `/api/library?action=detail&kind=plan&id=${ID}` && body === undefined) return { entry: current };
    if (path === '/api/studio' && body?.action === 'prepareCheckout') return config;
    if (path === '/api/studio' && body?.action === 'quote') return quote;
    assert.fail(`Unexpected request: ${path} ${JSON.stringify(body)}`);
  };
  return { calls, run: () => prepareSavedFilmCheckout({ entry: readyEntry(), quoteKey: 'saved-film-quote-v1', request, now: () => NOW }) };
};

test('saved-film checkout refreshes the exact locked artifact, then prepares only configuration and quote', async () => {
  const current = readyEntry(), original = structuredClone(current), h = harness({ current });
  assert.deepEqual(await h.run(), matchingQuote());
  assert.deepEqual(h.calls, [
    { path: `/api/library?action=detail&kind=plan&id=${ID}` },
    { path: '/api/studio', body: { action: 'prepareCheckout' } },
    { path: '/api/studio', body: { action: 'quote', preparedId: ID, idempotencyKey: 'saved-film-quote-v1' } },
  ]);
  assert.deepEqual(current, original);
  assert.equal(h.calls.some(call => ['checkout', 'startProduction', 'startPreRender'].includes(call.body?.action)), false);
});

test('changed saved identity, manifest, or film cannot request checkout configuration', async () => {
  const cases = [value => { value.id = '00000000-0000-4000-8000-000000000002'; value.production.price.preparedId = value.id; },
    value => { value.manifestHash = 'd'.repeat(64); value.production.price.manifestHash = value.manifestHash; },
    value => { value.filmId = 'another-film'; }, value => { value.kind = 'upload'; delete value.production.deliveryFlow; }];
  for (const mutate of cases) {
    const current = readyEntry(); mutate(current);
    const h = harness({ current });
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 1);
  }
});

test('unready, review-needed, unlocked, or already ordered films stop before checkout configuration', async () => {
  const cases = [value => { value.production.purchaseReady = false; },
    value => { value.production.artifactReady = false; value.production.purchaseReady = false; },
    value => { value.production.status = 'processing'; value.production.artifactReady = false; value.production.purchaseReady = false; },
    value => { value.production.needsAttention = true; },
    value => { value.production.paymentLocked = false; value.production.purchaseReady = false; },
    value => { delete value.production.price; }, value => { delete value.production.deliveryFlow; }];
  for (const mutate of cases) {
    const current = readyEntry(); mutate(current);
    const h = harness({ current });
    await assert.rejects(h.run()); assert.equal(h.calls.length, 1);
  }
  for (const status of ['submitting', 'awaiting-payment', 'captured', 'uncertain', 'declined', 'refunded']) {
    const current = readyEntry();
    current.payments = [{ id: 'e'.repeat(64), status, amountCents: 2880, currency: 'USD',
      refundedCents: status === 'refunded' ? 2880 : 0, sandbox: false, requiresReview: status === 'uncertain', receiptAvailable: status === 'captured' }];
    const h = harness({ current });
    await assert.rejects(h.run()); assert.equal(h.calls.length, 1, status);
  }
});

test('unavailable or malformed checkout configuration prevents a quote request', async () => {
  for (const config of [{ available: false }, null, { ...configuration(), method: 'direct-card' },
    { ...configuration(), deliveryTerms: '' }, { ...configuration(), environment: 'unknown' }]) {
    const h = harness({ config });
    await assert.rejects(h.run(), /Checkout is temporarily unavailable/); assert.equal(h.calls.length, 2);
  }
});

test('quotes with a different film, frozen price, environment, terms, or expiry never become purchase permission', async () => {
  const changes = [{ preparedId: '00000000-0000-4000-8000-000000000002' }, { manifestHash: 'd'.repeat(64) },
    { filmId: 'another-film' }, { amountCents: 2881 }, { amountCents: 2879 }, { currency: 'EUR' },
    { sandbox: true }, { sandbox: undefined }, { method: 'direct-card' }, { deliveryTerms: 'Changed delivery terms.' },
    { refundTerms: 'Changed refund terms.' }, { expiresAt: new Date(NOW).toISOString() },
    { expiresAt: new Date(NOW - 1).toISOString() }, { expiresAt: 'invalid' }];
  for (const change of changes) {
    const h = harness({ quote: { ...matchingQuote(), ...change } });
    await assert.rejects(h.run(), /No invoice was requested/); assert.equal(h.calls.length, 3, JSON.stringify(change));
  }
  for (const quote of [null, matchingQuote(), { ...matchingQuote(), sandbox: true }]) {
    const h = harness({ quote, config: { ...configuration(), environment: 'sandbox' } });
    await assert.rejects(h.run(), /No invoice was requested/); assert.equal(h.calls.length, 3);
  }
});
