import { createQuickBooksAccountingTransport } from './quickbooks.mjs';
import { validateQuickbooksArguments } from './quickbooks-finance-contract.mjs';

const fail = code => { throw new Error(code); };
const normalized = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export async function readFinanceResponse(response) {
  if (response.status === 429) fail('QBO_RATE_LIMITED');
  if (!response.ok) fail('QBO_PROVIDER_UNAVAILABLE');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 120000) { await reader.cancel(); fail('QBO_RESULT_TOO_LARGE'); } chunks.push(value); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.Fault) fail('QBO_RESPONSE_INVALID');
  return { data, request_id: response.headers.get('intuit_tid') || null };
}

export function createPatrickQuickBooks({ env = process.env,
  transport = createQuickBooksAccountingTransport({ env, financeReadOnly: true }), now = Date.now } = {}) {
  return { async read(name, input) {
    const args = validateQuickbooksArguments(name, input);
    const realm = env.PAC_QUICKBOOKS_REALM_ID;
    if (typeof realm !== 'string' || !/^\d{1,30}$/.test(realm)) fail('QBO_SETUP_REQUIRED');
    // Readiness does not renew or change the stored connection. Pin the intended
    // production company before a request can trigger the existing token manager.
    const { binding } = await transport.readiness();
    if (binding.environment !== 'production' || binding.realmId !== realm) fail('QBO_COMPANY_MISMATCH');
    const company = await readFinanceResponse(await transport.request(binding, { method: 'GET', path: `/companyinfo/${realm}` }));
    if (normalized(company.data.CompanyInfo?.CompanyName) !== 'brocotech') fail('QBO_COMPANY_MISMATCH');
    const base = { source: 'QuickBooks Online', integration: 'BROCOTech Private AI Core',
      company_name: company.data.CompanyInfo.CompanyName, read_only: true, retrieved_at: new Date(now()).toISOString() };
    if (name === 'quickbooks_connection_status') return { ...base, status: 'connected', connected: true, last_verified_at: base.retrieved_at };
    if (name === 'quickbooks_company_info') return { ...base, ...company };
    const operation = name === 'quickbooks_query' ? { method: 'GET', path: '/query', query: args }
      : { method: 'GET', path: `/reports/${args.report}`, query: args };
    const result = await readFinanceResponse(await transport.request(binding, operation));
    const records = result.data.QueryResponse?.[args.entity], count = Array.isArray(records) ? records.length : 0;
    return { ...base, retrieved_at: new Date(now()).toISOString(), ...result,
      ...(name === 'quickbooks_report' ? { report: args.report, start_date: args.start_date, end_date: args.end_date, accounting_method: args.accounting_method } : {
        start_position: args.start_position ?? 1, page_size: args.page_size ?? 50, returned_count: count,
        more_may_exist: count === (args.page_size ?? 50),
        next_start_position: count === (args.page_size ?? 50) ? (args.start_position ?? 1) + count : null,
      }) };
  } };
}
