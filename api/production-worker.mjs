import { timingSafeEqual } from 'node:crypto';
import { digest, json, readBody, readRecord, limitAction } from './_lib/auth.mjs';
import { payments } from './_lib/payments.mjs';
import { falProductionAdapter } from './_lib/fal-production.mjs';
import { productionQueuePath } from './_lib/production-queue.mjs';

// The isolated media worker receives short-lived payment grants, never the
// merchant's QuickBooks credentials. Every grant still runs the live invoice,
// allocation, recorded-reversal, owner, manifest and full-film budget checks.
export function createProductionWorkerHandler({ env = process.env, paymentService = payments,
  adapter = falProductionAdapter, read = readRecord, limiter = limitAction, now = Date.now } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { code: 'METHOD_NOT_ALLOWED' }); }
    const secret = env.LINEAGE_WORKER_SECRET, header = req.headers?.authorization;
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) return json(res, 503, { code: 'WORKER_UNAVAILABLE' });
    if (typeof header !== 'string' || header.length > 128
      || !timingSafeEqual(Buffer.from(digest(header)), Buffer.from(digest(`Bearer ${secret}`))))
      return json(res, 401, { code: 'WORKER_AUTH_REQUIRED' });
    try {
      const body = await readBody(req, 2048);
      if (!body || Object.keys(body).sort().join(',') !== 'email,manifestHash,model,orderId,preparedId,recipe'
        || body.model !== adapter.model || body.recipe !== adapter.modelVersion || !adapter.available
        || typeof body.email !== 'string' || body.email !== body.email.toLowerCase().trim()
        || !/^[a-f0-9]{64}$/.test(body.orderId || '') || !/^[a-f0-9]{64}$/.test(body.manifestHash || ''))
        return json(res, 400, { code: 'WORKER_REQUEST_INVALID' });
      const ticket = (await read(productionQueuePath(body.email, body.preparedId)))?.value;
      if (ticket?.state !== 'pending' || ticket.email !== body.email || ticket.id !== body.preparedId
        || ticket.orderId !== body.orderId || ticket.manifestHash !== body.manifestHash || !(ticket.lease?.expiresAt > now()))
        return json(res, 409, { code: 'WORKER_QUEUE_REQUIRED' });
      if (!await limiter('production-worker:authorize', 120, 60_000)) return json(res, 429, { code: 'WORKER_RATE_LIMITED' });
      const { email, preparedId, manifestHash, orderId } = body;
      return json(res, 200, await paymentService.authorizeProduction({ email, preparedId, manifestHash, orderId }));
    } catch { return json(res, 503, { code: 'PRODUCTION_AUTHORIZATION_UNAVAILABLE' }); }
  };
}
export default createProductionWorkerHandler();
