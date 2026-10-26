import { FAL_MODELS } from './fal-client.mjs';

// Verify the live native-audio video price and base still-image price. The
// selected 4K reference costs twice its listed base image rate.
const reviewed = {
  // O3 Pro native audio is $0.14/second. Keep the reviewed $0.15 ceiling;
  // never interpret the audio-off price as the cost of the selected request.
  kling: { base: 0.14, unit: 'seconds', microUsd: 150000 },
  reference: { base: 0.15, unit: 'images', microUsd: 300000 },
  // /edit uses exactly one 1K image with web search disabled, unlike the
  // original 4K front reference. These are separately priced operations.
  referenceEdit: { base: 0.15, unit: 'images', microUsd: 150000 },
  speech: { base: 0.007, unit: 'generations', microUsd: 7000 },
  // The public endpoint's /llms.txt defines the otherwise opaque API "units":
  // $0.014 per input-video second rounded UP per clip to five-second blocks.
  lipsync: { base: 0.014, unit: 'units', microUsd: 14000 },
};
export function createFalPricing({ key = () => process.env.FAL_KLING_KEY, fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  return async (model, { performance = false } = {}) => {
    if (model !== 'kling') throw new Error('Only Kling is available for new production.');
    const names = performance ? ['kling', 'reference', 'referenceEdit', 'speech', 'lipsync'] : ['kling', 'reference'];
    if (!cached || cached.model !== model || cached.performance !== performance || now() >= cached.until) {
      const secret = typeof key === 'function' ? key() : key;
      if (!secret) throw new Error('Provider pricing is not configured.');
      const query = new URLSearchParams(); names.forEach(name => query.append('endpoint_id', FAL_MODELS[name]));
      const response = await fetchImpl(`https://api.fal.ai/v1/models/pricing?${query}`, {
        headers: { Authorization: `Key ${secret}`, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Current provider pricing could not be verified.'); }
      const text = await response.text();
      if (text.length > 100000) throw new Error('Provider pricing response is invalid.');
      const body = JSON.parse(text);
      for (const name of names) {
        const rate = reviewed[name];
        const entries = body.prices?.filter(p => p.endpoint_id === FAL_MODELS[name]);
        if (entries?.length !== 1 || entries[0].currency !== 'USD' || entries[0].unit !== rate.unit
          || entries[0].unit_price !== rate.base) throw new Error('Provider pricing changed and needs review before a new quote.');
      }
      cached = { model, performance, until: now() + 60000 };
    }
    return { videoMicroUsdPerSecond: reviewed[model].microUsd, referenceMicroUsd: reviewed.reference.microUsd,
      ...(performance ? { referenceEditMicroUsd: reviewed.referenceEdit.microUsd,
        speechMicroUsd: reviewed.speech.microUsd, lipsyncMicroUsdPerSecond: reviewed.lipsync.microUsd,
        lipsyncBillingIncrementSeconds: 5 } : {}),
      // Audio-off O3 is currently $0.112/s. Keep the existing $0.15/s
      // reviewed ceiling instead of lowering the payment reserve implicitly.
      pricingVersion: performance ? 'kling-elements-stock-voice-lipsync-20261026'
        : 'kling-o3-native-audio-4k-reference-20261020', expiresAt: new Date(now() + 24 * 3600000).toISOString() };
  };
}
