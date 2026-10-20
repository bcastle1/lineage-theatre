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
