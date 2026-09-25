import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatrickQuickBooks, readFinanceResponse } from '../api/_lib/patrick-quickbooks.mjs';
import { createPatrickQuickBooksHandler } from '../api/patrick-quickbooks.mjs';

const key = 'A'.repeat(43), binding = { environment: 'production', realmId: '123', grantId: 'a'.repeat(64) };
function fixture(overrides = {}) {
  const calls = [];
  const service = createPatrickQuickBooks({ env: { PAC_QUICKBOOKS_REALM_ID: '123' }, transport: {
    readiness: async () => ({ binding: { ...binding, ...overrides.binding } }),
    request: async (bound, operation) => { calls.push({ bound, operation }); return Response.json(operation.path.startsWith('/companyinfo/')
      ? { CompanyInfo: { CompanyName: overrides.company || 'BROCO Tech' } } : { QueryResponse: { Invoice: [{ Id: '1' }] } }); },
  } });
  return { service, calls };
}
test('read service pins production company before renewal or data requests and checks returned company name', async () => {
  for (const wrong of [{ environment: 'sandbox' }, { realmId: '456' }]) {
    const h = fixture({ binding: wrong }); await assert.rejects(h.service.read('quickbooks_company_info', {}), /QBO_COMPANY_MISMATCH/);
    assert.equal(h.calls.length, 0);
  }
  const wrongName = fixture({ company: 'Different Company' });
  await assert.rejects(wrongName.service.read('quickbooks_query', { entity: 'Invoice' }), /QBO_COMPANY_MISMATCH/);
  assert.equal(wrongName.calls.length, 1);
});
test('every bridge accounting operation is a bounded read and reports its page or report parameters', async () => {
  const h = fixture();
  const result = await h.service.read('quickbooks_query', { entity: 'Invoice', page_size: 1 });
  assert.equal(result.read_only, true); assert.equal(result.more_may_exist, true); assert.equal(result.next_start_position, 2);
  assert.equal(result.company_name, 'BROCO Tech');
  const report = await h.service.read('quickbooks_report', { report: 'ProfitAndLoss', start_date: '2026-01-01', end_date: '2026-09-25', accounting_method: 'Accrual' });
  assert.equal(report.accounting_method, 'Accrual'); assert.equal(h.calls.every(call => call.operation.method === 'GET'), true);
  const count = h.calls.length; await assert.rejects(h.service.read('quickbooks_delete', {})); assert.equal(h.calls.length, count);
  await assert.rejects(readFinanceResponse(new Response('x'.repeat(120001))), /QBO_RESULT_TOO_LARGE/);
});
test('endpoint rejects user sessions, missing credentials and cross-purpose secrets before service calls', async () => {
  const calls = [], audits = [];
  const handler = createPatrickQuickBooksHandler({ env: { PAC_QUICKBOOKS_READ_KEY: key, CRON_SECRET: 'C'.repeat(43) },
    limiter: async () => true, auditImpl: async (...args) => audits.push(args), service: { read: async (...args) => { calls.push(args); return { status: 'connected' }; } } });
  async function run(method = 'POST', authorization, body = { name: 'quickbooks_connection_status', arguments: {} }) {
    let status, value;
    await handler({ method, headers: { authorization, cookie: 'owner-session-does-not-grant-bridge-access' }, body },
      { setHeader() {}, set statusCode(code) { status = code; }, end(data) { value = JSON.parse(data); } });
    return { status, value };
  }
  assert.equal((await run('POST')).status, 401);
  assert.equal((await run('POST', `Bearer ${'C'.repeat(43)}`)).status, 401);
  assert.equal((await run('GET', `Bearer ${key}`)).status, 401);
  assert.equal((await run('DELETE', `Bearer ${key}`)).status, 405); assert.equal(calls.length, 0);
  assert.equal((await run('POST', `Bearer ${key}`, { name: 'quickbooks_query', arguments: {}, token: 'injection' })).status, 400);
  assert.equal((await run('POST', `Bearer ${key}`)).status, 200);
  assert.equal((await run('GET', `Bearer ${'C'.repeat(43)}`)).status, 200);
  assert.equal(calls.length, 2); assert.equal(audits.every(row => row[0] === 'private-ai-core:patrick'), true);
});
