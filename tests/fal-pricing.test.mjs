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
const seedancePrices = () => [FAL_MODELS.seedance, FAL_MODELS.seedanceText].map(endpoint_id => ({
  endpoint_id, unit: '1000 tokens', unit_price: 0.0214, currency: 'USD',
}));
test('Seedance pricing verifies both US endpoints and quotes only supported video generation', async () => {
  let calls = 0;
  const read = createFalPricing({ key: model => `fixture-${model}`, fetchImpl: async (url, options) => {
    calls++;
    const seedance = new URL(url).searchParams.getAll('endpoint_id').includes(FAL_MODELS.seedance);
    if (seedance) assert.deepEqual(new URL(url).searchParams.getAll('endpoint_id').sort(),
      [FAL_MODELS.seedance, FAL_MODELS.seedanceText].sort());
    assert.equal(options.headers.Authorization, seedance ? 'Key fixture-seedance' : 'Key fixture-kling');
    return Response.json({ prices: seedance ? seedancePrices() : prices() });
  } });
  await read('kling');
  const rates = await read('seedance');
  assert.equal(rates.videoMicroUsdPerSecond, 1_200_000);
  assert.equal(rates.referenceMicroUsd, 0);
  assert.match(rates.pricingVersion, /seedance-2\.5-us-1080p/);
  await read('seedance');
  assert.equal(calls, 2);
});
test('missing, duplicated, or changed Seedance endpoint pricing blocks checkout', async () => {
  for (const mutate of [p => p.pop(), p => p.shift(), p => p.push(p[0]), p => { p[1].unit_price = 0.02; },
    p => { p[0].unit = 'seconds'; }, p => { p[1].currency = 'EUR'; }]) {
    const p = seedancePrices();
    mutate(p);
    const read = createFalPricing({ key: 'fixture', fetchImpl: async () => Response.json({ prices: p }) });
    await assert.rejects(read('seedance'), /pricing changed/);
  }
});
test('unsupported models have no price', async()=>{
  const read=createFalPricing({fetchImpl:()=>assert.fail('no legacy quote request')});
  for(const model of ['wan','unknown'])await assert.rejects(read(model),/No reviewed price/);
});
