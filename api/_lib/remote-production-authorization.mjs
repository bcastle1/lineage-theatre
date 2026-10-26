import { digest, readRecord } from './auth.mjs';

export function createRemoteProductionAuthorization({ adapter, env = process.env, fetchImpl = fetch, read = readRecord } = {}) {
  return { authorizeProduction: async input => {
    const secret = env.LINEAGE_WORKER_SECRET;
    if (!adapter || !/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Worker authorization is not configured.');
    let recipe = adapter.modelVersion;
    if (typeof adapter.recipeForManifest === 'function') {
      if (typeof input.email !== 'string' || input.email !== input.email.toLowerCase().trim()
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.preparedId || '')
        || !/^[a-f0-9]{64}$/.test(input.manifestHash || '')) throw new Error('Worker plan binding is invalid.');
      const ownerHash = digest(input.email), job = (await read(`production/jobs/${ownerHash}/${input.preparedId}.json`))?.value;
      if (!job || job.id !== input.preparedId || job.ownerHash !== ownerHash || job.manifestHash !== input.manifestHash
        || digest(JSON.stringify(job.manifest)) !== input.manifestHash) throw new Error('Worker plan binding is invalid.');
      recipe = adapter.recipeForManifest(job.manifest);
      if (job.provider && (job.provider.model !== adapter.model || job.provider.recipe !== recipe)) throw new Error('Worker plan recipe is invalid.');
    }
    const response = await fetchImpl('https://lineagetheater.com/api/production-worker', {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...input, model: adapter.model, recipe }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Live payment authorization needs attention.'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing payment authorization.');
    let length = 0; const chunks = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 4096) throw new Error('Invalid payment authorization.'); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
  } };
}
