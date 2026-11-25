import { digest } from './auth.mjs';

// The exact review plan is inspected without acquiring a lease, changing a
// clip, or requesting model inference. Payment credentials stay on the host.
export function createRemoteVisualFinalEditorialAuthorization({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  return async ({ recoveryPlan }) => {
    const fail = () => { throw Object.assign(Error('The final-scene editorial recovery authorization needs verification.'), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' }); };
    const secret = env.LINEAGE_WORKER_SECRET;
    if (!/^[a-f0-9]{64}$/.test(secret || '') || !recoveryPlan || Array.isArray(recoveryPlan)
      || Object.keys(recoveryPlan).sort().join(',') !== 'email,id,jobHash,manifestHash,originalAction,priorBindingHash,priorReceiptHash,queueHash,revisedAction') fail();
    const expectedHash = digest(JSON.stringify(recoveryPlan));
    let response;
    try {
      response = await fetchImpl('https://lineagetheater.com/api/production-worker', {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action: 'authorize-visual-final-editorial-recovery', recoveryPlan, workerProtocol: 2 }),
      });
    } catch { fail(); }
    if (!response.ok) { await response.body?.cancel(); fail(); }
    const reader = response.body?.getReader(); if (!reader) fail();
    let length = 0; const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 4096) fail(); chunks.push(value);
      }
      const permission = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (permission?.allowed !== true || permission.environment !== 'production'
        || permission.manifestHash !== recoveryPlan.manifestHash || permission.recoveryRequestHash !== expectedHash
        || !Number.isFinite(Date.parse(permission.expiresAt)) || Date.parse(permission.expiresAt) <= now()) fail();
      return permission;
    } catch { fail(); }
    finally { await reader.cancel().catch(() => {}); }
  };
}
