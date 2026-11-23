import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const load = async path => {
  const source = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const { PRE_RENDER_FLOW, normalizePreRenderStatus, preRenderCanPurchase, preRenderCanResume, preRenderRequest, preRenderQuoteMatches } = await load('../src/studio/film-prerender.ts');
const { filmProductionProgress } = await load('../src/studio/film-production-progress.ts');
const expected = { id: '00000000-0000-4000-8000-000000000001', manifestHash: 'a'.repeat(64) };
const NOW = Date.parse('2026-11-22T12:00:00Z');
const snapshot = (stage = 'creating') => ({ version: 1, stage, percent: stage === 'ready' ? 100 : 42,
  basis: 'confirmed-work', timing: stage === 'ready' ? 'complete' : 'learning',
  asOf: new Date(NOW).toISOString(), observedAt: new Date(NOW - 1000).toISOString(),
  completedScenes: stage === 'ready' ? 3 : 1, totalScenes: 3, estimate: null });
const ready = () => ({ ...expected, deliveryFlow: PRE_RENDER_FLOW, status: 'completed', completedShots: 3, shotCount: 3,
  preparationOnly: false, artifactReady: true, purchaseReady: true, paymentLocked: true, needsAttention: false,
  price: { amountCents: 2880, currency: 'USD', preparedId: expected.id, manifestHash: expected.manifestHash }, progress: snapshot('ready') });

test('only the exact verified completed and locked film permits checkout', () => {
  const original = ready(), normalized = normalizePreRenderStatus({ ...original, providerUrl: 'https://private.invalid/film.mp4' }, expected);
  assert.equal(normalized.artifactReady, true);
  assert.equal(preRenderCanPurchase(normalized, expected), true);
  assert.deepEqual(normalized.price, original.price);
  assert.equal(normalized.providerUrl, undefined);
  assert.equal(preRenderCanPurchase(null, expected), false);
  assert.equal(preRenderCanPurchase({ ...normalized, purchaseReady: false }, expected), false);
  assert.equal(preRenderCanPurchase({ ...normalized, artifactReady: false }, expected), false);
  assert.equal(preRenderCanPurchase({ ...normalized, paymentLocked: false }, expected), false);
  assert.equal(preRenderCanPurchase({ ...normalized, status: 'processing' }, expected), false);
  assert.equal(preRenderCanPurchase({ ...normalized, needsAttention: true }, expected), false);
  assert.equal(preRenderCanPurchase(normalized, { ...expected, id: '00000000-0000-4000-8000-000000000002' }), false);
  assert.equal(preRenderCanPurchase(normalized, { ...expected, manifestHash: 'b'.repeat(64) }), false);
  assert.deepEqual(original, ready(), 'Readiness inspection must not alter the saved state');
});

test('completion alone, altered identities, invalid prices and review flags cannot become purchase permission', () => {
  assert.equal(normalizePreRenderStatus({ status: 'completed' }, expected), null);
  assert.equal(normalizePreRenderStatus({ ...ready(), deliveryFlow: 'legacy-flow' }, expected), null);
  const mutations = [value => { value.id = '00000000-0000-4000-8000-000000000002'; },
    value => { value.manifestHash = 'b'.repeat(64); }, value => { value.price.preparedId = 'another-film'; },
    value => { value.price.manifestHash = 'b'.repeat(64); }, value => { value.price.currency = 'EUR'; },
    value => { value.price.amountCents = 0; }, value => { value.price.amountCents = 28.8; },
    value => { value.price.amountCents = 100_000_001; }, value => { value.price.amountCents = '2880'; },
    value => { value.needsAttention = true; }, value => { value.status = 'processing'; },
    value => { value.completedShots = 4; }, value => { value.shotCount = -1; },
    value => { delete value.artifactReady; }, value => { value.artifactReady = false; }];
  for (const mutate of mutations) {
    const value = ready(); mutate(value);
    assert.throws(() => normalizePreRenderStatus(value, expected));
  }
  for (const change of [{ preparedId: 'another-film' }, { manifestHash: 'b'.repeat(64) },
    { currency: 'EUR' }, { amountCents: 0 }, { amountCents: NaN }]) {
    const value = ready(); Object.assign(value.price, change);
    assert.equal(preRenderCanPurchase(value, expected), false);
  }
});

test('starting pre-rendering requires the accepted exact price and explicit consent, without requesting an invoice', () => {
  assert.deepEqual(preRenderRequest(expected.id, 2880, true), {
    action: 'startPreRender', preparedId: expected.id, acceptedPriceCents: 2880, productionConsent: true,
  });
  for (const args of [[expected.id, 2880, false], [expected.id, 2880, undefined], [expected.id, 2880, 'true'],
    ['another-film', 2880, true], [expected.id, 0, true], [expected.id, -1, true], [expected.id, 28.8, true],
    [expected.id, 100_000_001, true], [expected.id, '2880', true], [expected.id, NaN, true]]) {
    assert.throws(() => preRenderRequest(...args));
  }
  assert.equal(Object.hasOwn(preRenderRequest(expected.id, 2880, true), 'orderId'), false);
});

test('resuming permits only the exact saved locked film before queued or accepted production work', () => {
  const saved = { ...ready(), status: 'prepared', completedShots: 0, preparationOnly: true,
    artifactReady: false, purchaseReady: false, progress: undefined };
  const original = structuredClone(saved);
  assert.equal(preRenderCanResume(normalizePreRenderStatus(saved, expected), expected), true);
  assert.equal(preRenderCanPurchase(saved, expected), false);
  assert.deepEqual(preRenderRequest(saved.id, saved.price.amountCents, true), {
    action: 'startPreRender', preparedId: expected.id, acceptedPriceCents: 2880, productionConsent: true,
  }, 'A resume keeps the same prepared identity and frozen price');
  assert.throws(() => preRenderRequest(saved.id, saved.price.amountCents, false), 'Resume still needs explicit consent');
  assert.equal(preRenderCanResume(null, expected), false);
  for (const status of ['queued', 'submitting', 'processing', 'uncertain', 'failed', 'completed']) {
    assert.equal(preRenderCanResume({ ...saved, status }, expected), false, status);
  }
  for (const change of [{ completedShots: 1 }, { completedShots: -1 }, { completedShots: '0' },
    { needsAttention: true }, { needsAttention: 'false' }, { artifactReady: true }, { artifactReady: undefined },
    { purchaseReady: true }, { purchaseReady: undefined }, { paymentLocked: false }, { paymentLocked: 'true' },
    { deliveryFlow: 'legacy-flow' }, { id: '00000000-0000-4000-8000-000000000002' },
    { manifestHash: 'b'.repeat(64) }, { shotCount: -1 }]) {
    assert.equal(preRenderCanResume({ ...saved, ...change }, expected), false, JSON.stringify(change));
  }
  for (const change of [{ preparedId: 'another-film' }, { manifestHash: 'b'.repeat(64) }, { currency: 'EUR' },
    { amountCents: 0 }, { amountCents: 28.8 }, { amountCents: '2880' }, { amountCents: 100_000_001 }]) {
    assert.equal(preRenderCanResume({ ...saved, price: { ...saved.price, ...change } }, expected), false);
  }
  assert.equal(preRenderCanResume(saved, { ...expected, manifestHash: 'b'.repeat(64) }), false);
  assert.equal(preRenderCanResume(saved, { ...expected, id: '00000000-0000-4000-8000-000000000002' }), false);
  assert.deepEqual(saved, original, 'Read-only recovery inspection must retain its saved grant identity');
});

test('a pre-render quote must name the exact saved film at its frozen production price', () => {
  const target = { ...expected, filmId: 'fictional-film', price: ready().price };
  const quote = { preparedId: expected.id, manifestHash: expected.manifestHash, filmId: target.filmId,
    currency: 'USD', amountCents: 2880, sandbox: false };
  assert.equal(preRenderQuoteMatches(quote, target), true);
  assert.equal(preRenderQuoteMatches(null, target), false);
  for (const change of [{ preparedId: '00000000-0000-4000-8000-000000000002' },
    { manifestHash: 'b'.repeat(64) }, { filmId: 'another-film' }, { currency: 'EUR' },
    { amountCents: 2881 }, { amountCents: 2879 }, { amountCents: '2880' }, { sandbox: true }]) {
    assert.equal(preRenderQuoteMatches({ ...quote, ...change }, target), false, JSON.stringify(change));
  }
  for (const change of [{ preparedId: 'another-film' }, { manifestHash: 'b'.repeat(64) },
    { currency: 'EUR' }, { amountCents: 0 }, { amountCents: 28.8 }, { amountCents: NaN },
    { amountCents: 100_000_001 }, { amountCents: '2880' }]) {
    const price = { ...target.price, ...change };
    assert.equal(preRenderQuoteMatches({ ...quote, amountCents: price.amountCents }, { ...target, price }), false);
  }
});

test('unpaid studio-funded work shows real production progress without claiming payment or playback', () => {
  const input = { paid: false, studioFunded: true, ready: false, status: 'processing', progress: snapshot(), now: NOW };
  const creating = filmProductionProgress(input);
  assert.equal(creating.stageKey, 'creating'); assert.equal(creating.percent, 42);
  assert.equal(creating.stage, 'Creating your film');
  assert.doesNotMatch(JSON.stringify(creating), /payment received|your payment is|ready to watch|available to watch/i);
  for (const status of ['queued', 'failed']) {
    const view = filmProductionProgress({ paid: false, studioFunded: true, ready: false, status, now: NOW });
    assert.doesNotMatch(view.explanation, /your payment|pay again/i);
    assert.match(view.explanation, /no payment/i);
  }
  const unavailable = filmProductionProgress({ paid: false, studioFunded: true, ready: false, status: 'prepared', available: false, now: NOW });
  assert.match(unavailable.explanation, /No payment has been requested/);
  assert.equal(unavailable.stage, 'Production has not started');
});

test('a verified studio-funded completed film is ready to purchase until payment unlocks it', () => {
  const input = { paid: false, studioFunded: true, ready: true, status: 'completed', progress: snapshot('ready'), now: NOW };
  const locked = filmProductionProgress(input);
  assert.equal(locked.stageKey, 'ready'); assert.equal(locked.stage, 'Ready to purchase');
  assert.equal(locked.percent, 100); assert.match(locked.explanation, /Payment unlocks watching and downloading/);
  assert.doesNotMatch(locked.stage, /watch/i);
  const unverified = filmProductionProgress({ ...input, ready: false });
  assert.equal(unverified.stageKey, 'finishing'); assert.notEqual(unverified.percent, 100);
  const delivered = filmProductionProgress({ ...input, paid: true });
  assert.equal(delivered.stage, 'Ready to watch'); assert.equal(delivered.percent, 100);
  assert.match(delivered.explanation, /available to watch and download/);
});

test('legacy unpaid films still await payment even if untrusted progress claims completion', () => {
  for (const studioFunded of [undefined, false, 'true']) {
    const view = filmProductionProgress({ paid: false, studioFunded, ready: true, status: 'completed', progress: snapshot('ready'), now: NOW });
    assert.equal(view.stageKey, 'waiting'); assert.equal(view.stage, 'Waiting for payment confirmation');
    assert.equal(view.percent, null); assert.equal(view.estimate, null);
  }
});
