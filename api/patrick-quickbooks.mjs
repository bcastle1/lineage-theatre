import { createHash, timingSafeEqual } from 'node:crypto';
import { json, readBody, limitAction } from './_lib/auth.mjs';
import { audit } from './_lib/admin.mjs';
import { createPatrickQuickBooks } from './_lib/patrick-quickbooks.mjs';

const hash = value => createHash('sha256').update(value).digest();
export function createPatrickQuickBooksHandler({ env = process.env, service = createPatrickQuickBooks({ env }),
  limiter = limitAction, auditImpl = audit } = {}) {
  return async function handler(req, res) {
    if (!['POST', 'GET'].includes(req.method)) return json(res, 405, { error_code: 'QBO_METHOD_INVALID' });
    const cron = req.method === 'GET', secret = cron ? env.CRON_SECRET : env.PAC_QUICKBOOKS_READ_KEY;
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || /\s/.test(secret))
      return json(res, 503, { error_code: 'QBO_SETUP_REQUIRED' });
    const authorization = req.headers?.authorization;
    if (typeof authorization !== 'string' || authorization.length > 1024
      || !timingSafeEqual(hash(authorization), hash(`Bearer ${secret}`))) return json(res, 401, { error_code: 'QBO_AUTHORIZATION_REQUIRED' });
    try {
      if (!(await limiter('pac-quickbooks-read', 60, 60000))) return json(res, 429, { error_code: 'QBO_RATE_LIMITED' });
      const body = cron ? { name: 'quickbooks_connection_status', arguments: {} } : await readBody(req, 4096);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'arguments'].includes(key))
        || typeof body.name !== 'string' || !body.arguments) return json(res, 400, { error_code: 'QBO_ARGUMENTS_INVALID' });
      const result = await service.read(body.name, body.arguments);
      // Record metadata only. No prompts, financial rows, provider credentials,
      // or query filters enter this audit record.
      await auditImpl('private-ai-core:patrick', 'quickbooks.finance.read', body.name, { readOnly: true, successful: true, maintenance: cron });
      return json(res, 200, cron ? { status: result.status, read_only: true } : result);
    } catch (error) {
      const code = /^QBO_[A-Z_]+$/.test(error.message) ? error.message : 'QBO_CONNECTION_UNAVAILABLE';
      return json(res, /INVALID$/.test(code) ? 400 : 503, { error_code: code });
    }
  };
}
export default createPatrickQuickBooksHandler();
