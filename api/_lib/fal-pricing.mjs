import { FAL_MODELS } from './fal-client.mjs';

const seedanceBase = { unit: '1000 tokens', base: 0.0214 };
const reviewed = {
  seedance: {
    endpoints: { seedance: seedanceBase, seedanceText: seedanceBase },
    // Both US endpoints publish a 1080p rate of $0.0234 per 1,000 tokens
    // and an estimated $1.164/sec. At 16:9 1080p with native audio and no
    // video inputs, the existing reviewed $1.20/sec budget covers both.
    videoMicroUsdPerSecond: 1_200_000, referenceMicroUsd: 0,
    pricingVersion: 'seedance-2.5-us-1080p-native-audio-20261122',
  },
  kling: {
    endpoints: { kling: { unit: 'seconds', base: 0.14 }, reference: { unit: 'images', base: 0.15 } },
    // Preserve historical quote calculations, including the 4K image multiplier.
    videoMicroUsdPerSecond: 150_000, referenceMicroUsd: 300_000,
    pricingVersion: 'kling-o3-native-audio-4k-reference-20261020',
  },
};
export function createFalPricing({ key = model => model === 'seedance' ? process.env.FAL_KEY : process.env.FAL_KLING_KEY, fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  return async model => {
    if (!Object.hasOwn(reviewed, model)) throw new Error('No reviewed price for this video model.');
    const profile = reviewed[model];
    if (!cached || cached.model !== model || now() >= cached.until) {
      const secret = typeof key === 'function' ? key(model) : key;
      if (!secret) throw new Error('Provider pricing is not configured.');
      const query = new URLSearchParams();
      for (const name of Object.keys(profile.endpoints)) query.append('endpoint_id', FAL_MODELS[name]);
      const response = await fetchImpl(`https://api.fal.ai/v1/models/pricing?${query}`, {
        headers: { Authorization: `Key ${secret}`, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Current provider pricing could not be verified.'); }
      const text = await response.text();
      if (text.length > 100000) throw new Error('Provider pricing response is invalid.');
      const body = JSON.parse(text);
      for (const [name, rate] of Object.entries(profile.endpoints)) {
        const entries = body.prices?.filter(p => p.endpoint_id === FAL_MODELS[name]);
        if (entries?.length !== 1 || entries[0].currency !== 'USD' || entries[0].unit !== rate.unit
          || entries[0].unit_price !== rate.base) throw new Error('Provider pricing changed and needs review before a new quote.');
      }
      cached = { model, until: now() + 60000 };
    }
    return { videoMicroUsdPerSecond: profile.videoMicroUsdPerSecond, referenceMicroUsd: profile.referenceMicroUsd,
      pricingVersion: profile.pricingVersion, expiresAt: new Date(now() + 24 * 3600000).toISOString() };
  };
}
