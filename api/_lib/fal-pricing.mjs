import { FAL_MODELS } from './fal-client.mjs';

// Verify the live native-audio video price and base still-image price. The
// selected 4K reference costs twice its listed base image rate.
const reviewed = {
  // O3 Pro native audio is $0.14/second. Keep the reviewed $0.15 ceiling;
  // never interpret the audio-off price as the cost of the selected request.
  kling: { base: 0.14, unit: 'seconds', microUsd: 150000 },
  reference: { base: 0.15, unit: 'images', microUsd: 300000 },
};
export function createFalPricing({ key = () => process.env.FAL_KLING_KEY, fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  return async model => {
    if (model !== 'kling') throw new Error('Only Kling is available for new production.');
    if (!cached || cached.model !== model || now() >= cached.until) {
      const secret = typeof key === 'function' ? key() : key;
      if (!secret) throw new Error('Provider pricing is not configured.');
      const query = new URLSearchParams(); [FAL_MODELS[model],FAL_MODELS.reference].forEach(id => query.append('endpoint_id', id));
      const response = await fetchImpl(`https://api.fal.ai/v1/models/pricing?${query}`, {
        headers: { Authorization: `Key ${secret}`, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Current provider pricing could not be verified.'); }
      const text = await response.text();
      if (text.length > 100000) throw new Error('Provider pricing response is invalid.');
      const body = JSON.parse(text);
      for (const [name, rate] of Object.entries(reviewed)) {
        if(name!==model&&name!=='reference')continue;
        const entries = body.prices?.filter(p => p.endpoint_id === FAL_MODELS[name]);
        if (entries?.length !== 1 || entries[0].currency !== 'USD' || entries[0].unit !== rate.unit
          || entries[0].unit_price !== rate.base) throw new Error('Provider pricing changed and needs review before a new quote.');
      }
      cached = { model, until: now() + 60000 };
    }
    return { videoMicroUsdPerSecond: reviewed[model].microUsd, referenceMicroUsd: reviewed.reference.microUsd,
      pricingVersion: 'kling-o3-native-audio-4k-reference-20261020', expiresAt: new Date(now() + 24 * 3600000).toISOString() };
  };
}
