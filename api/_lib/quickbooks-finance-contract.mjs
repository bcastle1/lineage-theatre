// Shared read-only QuickBooks tool contract. Keep both service copies identical.
const DAY = 86400000;
const ENTITY_NAMES = ['Account', 'Bill', 'BillPayment', 'Budget', 'Class', 'CreditMemo',
  'Customer', 'Department', 'Deposit', 'Estimate', 'Invoice', 'Item', 'JournalEntry',
  'Payment', 'Purchase', 'PurchaseOrder', 'RefundReceipt', 'SalesReceipt', 'TaxCode',
  'TaxRate', 'Term', 'TimeActivity', 'Transfer', 'Vendor', 'VendorCredit'];
const REPORT_NAMES = ['ProfitAndLoss', 'BalanceSheet', 'CashFlow', 'TrialBalance',
  'GeneralLedger', 'CustomerBalance', 'VendorBalance', 'AgedReceivables', 'AgedPayables'];
const object = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const QUICKBOOKS_TOOLS = Object.freeze([
  { name: 'quickbooks_connection_status', description: 'Check whether Patrick can read the BROCO Tech QuickBooks company. Returns connection health and verification times; never credentials.', inputSchema: object() },
  { name: 'quickbooks_company_info', description: 'Read the connected BROCO Tech QuickBooks company identity and accounting settings.', inputSchema: object() },
  { name: 'quickbooks_query', description: 'Read a page of live BROCO Tech accounting records. Use an allowed entity and optional QuickBooks WHERE expression. Always report pagination and source time; never treat a partial page as a complete total.', inputSchema: object({
    entity: { type: 'string', enum: ENTITY_NAMES },
    where: { type: 'string', maxLength: 1500, description: 'Optional QuickBooks filter, e.g. Balance > 0 or TxnDate >= \'2026-09-01\'. No SELECT, paging, or ORDER BY clauses.' },
    start_position: { type: 'integer', minimum: 1, maximum: 1000000 },
    page_size: { type: 'integer', minimum: 1, maximum: 100 },
  }, ['entity']) },
  { name: 'quickbooks_report', description: 'Read a live BROCO Tech financial report for an explicit date period and accounting basis. State those parameters with the answer.', inputSchema: object({
    report: { type: 'string', enum: REPORT_NAMES }, start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, accounting_method: { type: 'string', enum: ['Cash', 'Accrual'] },
  }, ['report', 'start_date', 'end_date', 'accounting_method']) },
]);
export const QUICKBOOKS_TOOL_NAMES = Object.freeze(QUICKBOOKS_TOOLS.map(tool => tool.name));
export const isQuickbooksTool = name => QUICKBOOKS_TOOL_NAMES.includes(name);
const fail = code => { throw new Error(code); };
const stamp = time => new Date(time).toISOString();
export function validateQuickbooksArguments(name, args = {}) {
  const descriptor = QUICKBOOKS_TOOLS.find(tool => tool.name === name);
  if (!descriptor || !args || Object.getPrototypeOf(args) !== Object.prototype) fail('QBO_ARGUMENTS_INVALID');
  const schema = descriptor.inputSchema;
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => args[key] === undefined)) fail('QBO_ARGUMENTS_INVALID');
  if (name === 'quickbooks_query') {
    if (!ENTITY_NAMES.includes(args.entity)) fail('QBO_ENTITY_INVALID');
    for (const [key, max] of [['start_position', 1000000], ['page_size', 100]]) {
      if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 1 || args[key] > max)) fail('QBO_PAGINATION_INVALID');
    }
    if (args.where !== undefined && (typeof args.where !== 'string' || args.where.length > 1500
      || /[;\x00-\x1f]|--|\/\*|\*\/|\b(select|from|union|insert|update|delete|drop|startposition|maxresults|order\s+by)\b/i.test(args.where))) fail('QBO_FILTER_INVALID');
  }
  if (name === 'quickbooks_report') {
    if (!REPORT_NAMES.includes(args.report) || !['Cash', 'Accrual'].includes(args.accounting_method)) fail('QBO_REPORT_INVALID');
    for (const key of ['start_date', 'end_date']) {
      const value = args[key];
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || !Number.isFinite(Date.parse(value)) || stamp(Date.parse(value)).slice(0, 10) !== value) fail('QBO_DATE_INVALID');
    }
    if (args.start_date > args.end_date || Date.parse(args.end_date) - Date.parse(args.start_date) > 3660 * DAY) fail('QBO_DATE_INVALID');
  }
  return { ...args };
}
