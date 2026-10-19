import { FAL_MODELS } from './fal-client.mjs';

// Resolution multipliers are reviewed against the exact endpoint contracts.
// The API lists base rates; treating those as 1080p prices underquotes the film.
const reviewed = {
  seedance: { base: 0.0214, unit: '1000 tokens', microUsd: 1200000 },
  wan: { base: 0.05, unit: 'seconds', microUsd: 200000 },
  reference: { base: 0.15, unit: 'images', microUsd: 300000 },
};
export function createFalPricing({ key = () => process.env.FAL_KEY, fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  return async model => {
    if (!['seedance', 'wan'].includes(model)) throw new Error('Unsupported production model.');
    if (!cached || now() >= cached.until) {
      const secret = typeof key === 'function' ? key() : key;
      if (!secret) throw new Error('Provider pricing is not configured.');
      const query = new URLSearchParams(); Object.values(FAL_MODELS).forEach(id => query.append('endpoint_id', id));
      const response = await fetchImpl(`https://api.fal.ai/v1/models/pricing?${query}`, {
        headers: { Authorization: `Key ${secret}`, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Current provider pricing could not be verified.'); }
      const text = await response.text();
      if (text.length > 100000) throw new Error('Provider pricing response is invalid.');
      const body = JSON.parse(text);
      for (const [name, rate] of Object.entries(reviewed)) {
        const entries = body.prices?.filter(p => p.endpoint_id === FAL_MODELS[name]);
        if (entries?.length !== 1 || entries[0].currency !== 'USD' || entries[0].unit !== rate.unit
          || entries[0].unit_price !== rate.base) throw new Error('Provider pricing changed and needs review before a new quote.');
      }
      cached = { until: now() + 60000 };
    }
    return { videoMicroUsdPerSecond: reviewed[model].microUsd, referenceMicroUsd: reviewed.reference.microUsd,
      pricingVersion: '1080p-4k-20261018', expiresAt: new Date(now() + 24 * 3600000).toISOString() };
  };
}
