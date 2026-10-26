import test from 'node:test';
import assert from 'node:assert/strict';
import { createFalPricing } from '../api/_lib/fal-pricing.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';
const prices = () => [
  { endpoint_id: FAL_MODELS.kling, currency: 'USD', unit: 'seconds', unit_price: 0.14 },
  { endpoint_id: FAL_MODELS.reference, currency: 'USD', unit: 'images', unit_price: 0.15 },
];
test('live base rates are verified before returning reviewed 1080p and 4K prices', async () => {
  let calls = 0, now = Date.parse('2026-10-19T00:00:00Z');
  const read = createFalPricing({ key: 'fixture', now: () => now, fetchImpl: async (url, options) => {
    calls++; assert.equal(new URL(url).origin, 'https://api.fal.ai'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ prices: prices() }));
  } });
  assert.equal((await read('kling')).videoMicroUsdPerSecond, 150000);
  assert.equal((await read('kling')).referenceMicroUsd, 300000); assert.equal(calls, 1);
  now += 61000; const rate = await read('kling'); assert.equal(calls, 2);
  assert.equal(Date.parse(rate.expiresAt), now + 86400000);
});
test('changed rates, currency, units and absent model prices fail closed', async () => {
  for (const mutate of [p => { p[0].unit_price = 0.03; }, p => { p[0].currency = 'EUR'; }, p => { p[0].unit = 'minutes'; }, p => p.pop()]) {
    const p = prices(); mutate(p);
    const read = createFalPricing({ key: 'fixture', fetchImpl: async () => new Response(JSON.stringify({ prices: p })) });
    await assert.rejects(read('kling'), /pricing changed/);
  }
});
test('legacy prices cannot authorize new production', async()=>{
  const read=createFalPricing({fetchImpl:()=>assert.fail('no legacy quote request')});
  for(const model of ['wan','seedance'])await assert.rejects(read(model),/Only Kling/);
});

const performancePrices = () => [...prices(),
  { endpoint_id: FAL_MODELS.referenceEdit, currency: 'USD', unit: 'images', unit_price: .15 },
  { endpoint_id: FAL_MODELS.speech, currency: 'USD', unit: 'generations', unit_price: .007 },
  { endpoint_id: FAL_MODELS.lipsync, currency: 'USD', unit: 'units', unit_price: .014 },
];
test('new performance price verifies every paid endpoint and cannot reuse a legacy-only cached price', async () => {
  const queries = [], read = createFalPricing({ key: 'fixture', fetchImpl: async url => {
    queries.push(new URL(url).searchParams.getAll('endpoint_id'));
    return new Response(JSON.stringify({ prices: performancePrices() }));
  } });
  const legacy = await read('kling'); assert.equal(legacy.speechMicroUsd, undefined);
  const price = await read('kling', { performance: true });
  assert.deepEqual(queries[1], [FAL_MODELS.kling, FAL_MODELS.reference, FAL_MODELS.referenceEdit, FAL_MODELS.speech, FAL_MODELS.lipsync]);
  assert.equal(price.referenceEditMicroUsd, 150000); assert.equal(price.speechMicroUsd, 7000);
  assert.equal(price.lipsyncMicroUsdPerSecond, 14000); assert.equal(price.lipsyncBillingIncrementSeconds, 5);
  await read('kling', { performance: true }); assert.equal(queries.length, 2);
  await read('kling'); assert.equal(queries.length, 3);
});
test('new quotes fail closed on missing, duplicate, changed or wrongly denominated speech/reference prices', async () => {
  for (const index of [2, 3, 4]) for (const mutate of [p => p.splice(index, 1), p => p.push({ ...p[index] }),
    p => { p[index].unit_price += .001; }, p => { p[index].currency = 'EUR'; }, p => { p[index].unit = 'minutes'; }]) {
    const p = performancePrices(); mutate(p);
    const read = createFalPricing({ key: 'fixture', fetchImpl: async () => new Response(JSON.stringify({ prices: p })) });
    await assert.rejects(read('kling', { performance: true }), /pricing changed/);
  }
});
