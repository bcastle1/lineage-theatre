export function createRemoteProductionAuthorization({ adapter, env = process.env, fetchImpl = fetch } = {}) {
  return { authorizeProduction: async input => {
    const secret = env.LINEAGE_WORKER_SECRET;
    if (!adapter || !/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Worker authorization is not configured.');
    const response = await fetchImpl('https://lineagetheater.com/api/production-worker', {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...input, model: adapter.model, recipe: adapter.modelVersion }),
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
