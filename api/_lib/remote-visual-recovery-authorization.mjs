// The worker keeps QuickBooks credentials on the web host. This route validates
// the exact paused recovery plan before issuing a short-lived payment grant.
export function createRemoteVisualRecoveryAuthorization({ env = process.env, fetchImpl = fetch } = {}) {
  return async ({ recoveryPlan }) => {
    const secret = env.LINEAGE_WORKER_SECRET;
    if (!/^[a-f0-9]{64}$/.test(secret || '') || !recoveryPlan) throw Error('Recovery authorization is unavailable.');
    const response = await fetchImpl('https://lineagetheater.com/api/production-worker', {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action: 'authorize-visual-review-recovery', workerProtocol: 2, recoveryPlan }),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error('Live recovery authorization needs attention.'); }
    const reader = response.body?.getReader(); if (!reader) throw Error('Missing recovery authorization.');
    let length = 0; const chunks = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 4096) throw Error('Invalid recovery authorization.'); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
  };
}
