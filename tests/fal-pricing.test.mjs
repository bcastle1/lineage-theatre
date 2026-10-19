import test from 'node:test';
import assert from 'node:assert/strict';
import { createFalPricing } from '../api/_lib/fal-pricing.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';
const prices = () => [
  { endpoint_id: FAL_MODELS.seedance, currency: 'USD', unit: '1000 tokens', unit_price: 0.0214 },
  { endpoint_id: FAL_MODELS.wan, currency: 'USD', unit: 'seconds', unit_price: 0.05 },
  { endpoint_id: FAL_MODELS.reference, currency: 'USD', unit: 'images', unit_price: 0.15 },
];
test('live base rates are verified before returning reviewed 1080p and 4K prices', async () => {
  let calls = 0, now = Date.parse('2026-10-19T00:00:00Z');
  const read = createFalPricing({ key: 'fixture', now: () => now, fetchImpl: async (url, options) => {
    calls++; assert.equal(new URL(url).origin, 'https://api.fal.ai'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ prices: prices() }));
  } });
  assert.equal((await read('wan')).videoMicroUsdPerSecond, 200000);
  assert.equal((await read('seedance')).referenceMicroUsd, 300000); assert.equal(calls, 1);
  now += 61000; const rate = await read('seedance'); assert.equal(calls, 2);
  assert.equal(Date.parse(rate.expiresAt), now + 86400000);
});
test('changed rates, currency, units and absent model prices fail closed', async () => {
  for (const mutate of [p => { p[0].unit_price = 0.03; }, p => { p[1].currency = 'EUR'; }, p => { p[1].unit = 'minutes'; }, p => p.pop()]) {
    const p = prices(); mutate(p);
    const read = createFalPricing({ key: 'fixture', fetchImpl: async () => new Response(JSON.stringify({ prices: p })) });
    await assert.rejects(read('wan'), /pricing changed/);
  }
});
