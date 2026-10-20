import { list } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { digest, readRecord, writeRecord } from './auth.mjs';

export const FAL_FUNDING_PATH = 'production/fal/funding-reservations-v1.json';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_ORDERS = 1000, MAX_BYTES = 64 * 1024;
const activeStatuses = new Set(['submitting', 'uncertain', 'awaiting-payment', 'captured', 'partially-refunded', 'refunded']);
const cents = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
const unavailable = () => Object.assign(new Error('Production funding could not be reserved.'), { code: 'FAL_FUNDING_UNAVAILABLE' });
const requireValue = value => { if (!value) throw unavailable(); };
const identityFields = ['orderId', 'ownerHash', 'preparedId', 'manifestHash', 'quoteId'];
const sameIdentity = (a, b) => identityFields.every(field => a[field] === b[field]);
const same = (a, b) => sameIdentity(a, b) && a.maximumCostCents === b.maximumCostCents;
const releasePath = entry => `production/fal/funding-releases/${entry.orderId}/${entry.quoteId}.json`;

async function boundedJson(response) {
  requireValue(response.body);
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength; requireValue(length <= MAX_BYTES); chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

// The key is billing:usage:read only, on the same fal account as generation.
// No wallet amount, provider response or credential is returned to a customer.
export async function readFalCreditCents({ env = process.env, fetchImpl = fetch } = {}) {
  try {
    requireValue(typeof env.FAL_BILLING_KEY === 'string' && env.FAL_BILLING_KEY.length > 0
      && typeof env.FAL_BILLING_ACCOUNT === 'string' && /^[\w.-]{1,100}$/.test(env.FAL_BILLING_ACCOUNT));
    const response = await fetchImpl('https://api.fal.ai/v1/account/billing?expand=credits', {
      method: 'GET', headers: { Authorization: `Key ${env.FAL_BILLING_KEY}`, Accept: 'application/json' },
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    const body = await boundedJson(response), balance = body.credits?.current_balance;
    requireValue(body.username === env.FAL_BILLING_ACCOUNT && body.credits?.currency === 'USD'
      && typeof balance === 'number' && Number.isFinite(balance) && balance >= 0 && balance <= 10_000_000);
    // Round available funds down. A fractional cent cannot fund a whole cent.
    return Math.floor(balance * 100);
  } catch { throw unavailable(); }
}

function entryFor(input) {
  requireValue(input && HASH.test(input.orderId || '') && UUID.test(input.preparedId || '')
    && HASH.test(input.manifestHash || '') && HASH.test(input.quoteId || '') && cents(input.maximumCostCents)
    && typeof input.customerEmail === 'string' && input.customerEmail.length <= 254
    && input.customerEmail === input.customerEmail.trim().toLowerCase()
    && /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(input.customerEmail));
  return { orderId: input.orderId, ownerHash: digest(input.customerEmail), preparedId: input.preparedId,
    manifestHash: input.manifestHash, quoteId: input.quoteId, maximumCostCents: input.maximumCostCents };
}
function validEntry(value) {
  return value && HASH.test(value.orderId || '') && HASH.test(value.ownerHash || '')
    && UUID.test(value.preparedId || '') && HASH.test(value.manifestHash || '') && HASH.test(value.quoteId || '') && cents(value.maximumCostCents)
    && Number.isFinite(Date.parse(value.createdAt));
}
function orderEntry(value) {
  return entryFor({ orderId: value.id, customerEmail: value.customerEmail, preparedId: value.preparedId,
    manifestHash: value.manifestHash, quoteId: value.quoteId, maximumCostCents: value.providerCostCents ?? value.providerCostEstimateCents });
}
export function fundingCycleCanExpire(value, at = Date.now()) {
  const absent = field => value?.[field] === null || value?.[field] === undefined;
  return Boolean(value && value.checkoutMethod === 'quickbooks-hosted-invoice' && value.merchantBinding?.environment === 'production'
    && ['submitting', 'uncertain'].includes(value.status)
    && ['invoiceAttemptedAt', 'invoiceId', 'invoiceNumber', 'invoiceUrl', 'capturedAt', 'providerChargeId'].every(absent)
    && (!value.accountingPayments || Array.isArray(value.accountingPayments) && value.accountingPayments.length === 0)
    && (!value.paymentIds || Array.isArray(value.paymentIds) && value.paymentIds.length === 0)
    && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) <= at);
}
function releaseMatches(value, entry) {
  return value?.version === 1 && value.kind === 'unattempted-funding-cycle-release' && sameIdentity(value, entry)
    && UUID.test(value.releaseId || '') && typeof value.releasedAt === 'string' && Number.isFinite(Date.parse(value.releasedAt));
}
async function batches(values, callback) {
  const results = [];
  for (let index = 0; index < values.length; index += 8) results.push(...await Promise.all(values.slice(index, index + 8).map(callback)));
  return results;
}

// Reserve the entire quoted budget before opening a payable invoice. A shared
// conditional-write ledger serializes concurrent checkouts. Existing open
// production orders are also counted, including orders from before this guard.
// Holds never expire merely because a quote or external payment link is old.
export function createFalFunding({ env = process.env, read = readRecord, write = writeRecord,
  listBlobs = list, fetchImpl = fetch, now = Date.now } = {}) {
  async function wasReleased(order) {
    try {
      const entry = orderEntry(order), fence = order.fundingRelease;
      if (!fundingCycleCanExpire(order, now()) || !releaseMatches(fence, entry)) return false;
      const receipt = (await read(releasePath(entry)))?.value;
      return releaseMatches(receipt, entry) && receipt.releaseId === fence.releaseId && receipt.releasedAt === fence.releasedAt;
    } catch { return false; }
  }
  async function releaseExpiredOrder(orderId, expectedQuoteId) {
    try {
      requireValue(HASH.test(orderId || '') && HASH.test(expectedQuoteId || ''));
      const path = `payments/orders/${orderId}.json`;
      for (let attempt = 0; attempt < 3; attempt++) {
        let record = await read(path), value = record?.value;
        requireValue(record?.etag && value?.id === orderId && value.quoteId === expectedQuoteId && fundingCycleCanExpire(value, now()));
        const entry = orderEntry(value);
        if (!releaseMatches(value.fundingRelease, entry)) {
          const fence = { version: 1, kind: 'unattempted-funding-cycle-release',
            ...Object.fromEntries(identityFields.map(field => [field, entry[field]])),
            releaseId: randomUUID(), releasedAt: new Date(now()).toISOString() };
          const next = { ...value, status: 'uncertain', checkoutBlock: 'production-funding',
            fundingRelease: fence, changeId: randomUUID(), updatedAt: fence.releasedAt };
          // Fencing the order first invalidates every in-flight invoice claimant's
          // old ETag. A release receipt can never precede that durable fence.
          try { await write(path, next, record.etag); } catch { continue; }
          record = await read(path);
          if (!record?.value || digest(JSON.stringify(record.value)) !== digest(JSON.stringify(next))) continue;
          value = record.value;
        }
        const receiptPath = releasePath(entry), receipt = value.fundingRelease;
        let saved = await read(receiptPath);
        if (!saved) {
          try { await write(receiptPath, receipt); } catch { /* An uncertain immutable write requires exact readback. */ }
          saved = await read(receiptPath);
        }
        requireValue(saved?.value && digest(JSON.stringify(saved.value)) === digest(JSON.stringify(receipt)));
        return record;
      }
      throw unavailable();
    } catch { throw unavailable(); }
  }
  async function reserveAttempt(input) {
    const wanted = entryFor(input);
    requireValue(typeof env.FAL_BILLING_KEY === 'string' && env.FAL_BILLING_KEY.length > 0
      && typeof env.FAL_BILLING_ACCOUNT === 'string' && /^[\w.-]{1,100}$/.test(env.FAL_BILLING_ACCOUNT));
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await read(FAL_FUNDING_PATH), ledger = saved?.value;
      requireValue(!saved || typeof saved.etag === 'string' && ledger?.version === 1
        && ledger.account === env.FAL_BILLING_ACCOUNT && Array.isArray(ledger.entries)
        && Number.isSafeInteger(ledger.revision) && ledger.revision > 0 && ledger.revision < Number.MAX_SAFE_INTEGER
        && ledger.entries.length <= MAX_ORDERS && ledger.entries.every(validEntry)
        && new Set(ledger.entries.map(entry => entry.orderId)).size === ledger.entries.length);
      const holds = new Map((ledger?.entries || []).map(entry => [entry.orderId, entry]));
      // Immutable receipts remain valid after a newer checkout cycle replaces
      // the unattempted order. They cannot release that newer quote's budget.
      await batches([...holds.values()], async entry => {
        if (releaseMatches((await read(releasePath(entry)))?.value, entry)) holds.delete(entry.orderId);
      });
      const existing = holds.get(wanted.orderId);
      const paths = [], cursors = new Set();
      let cursor;
      do {
        const page = await listBlobs({ prefix: 'payments/orders/', limit: Math.min(1000, MAX_ORDERS - paths.length), ...(cursor ? { cursor } : {}) });
        requireValue(page && Array.isArray(page.blobs));
        for (const blob of page.blobs) {
          requireValue(/^payments\/orders\/[a-f0-9]{64}\.json$/.test(blob.pathname || ''));
          paths.push(blob.pathname);
        }
        requireValue(paths.length <= MAX_ORDERS && (!page.hasMore || page.blobs.length > 0
          && paths.length < MAX_ORDERS && typeof page.cursor === 'string' && page.cursor.length > 0 && !cursors.has(page.cursor)));
        if (page.hasMore) cursors.add(page.cursor);
        cursor = page.hasMore ? page.cursor : null;
      } while (cursor);
      requireValue(new Set(paths).size === paths.length);
      const orders = await batches(paths, async path => {
        const value = (await read(path))?.value;
        requireValue(value && path === `payments/orders/${value.id}.json`);
        if (value.merchantBinding?.environment === 'sandbox') return null;
        requireValue(value.merchantBinding?.environment === 'production');
        if (['declined', 'cancelled'].includes(value.status)) return null;
        requireValue(activeStatuses.has(value.status) && value.currency === 'USD');
        const budget = value.providerCostCents ?? value.providerCostEstimateCents;
        const entry = orderEntry(value);
        if (fundingCycleCanExpire(value, now())) {
          await releaseExpiredOrder(value.id, value.quoteId);
          if (holds.get(entry.orderId)?.quoteId === entry.quoteId) holds.delete(entry.orderId);
          return null;
        }
        const held = holds.get(entry.orderId);
        // A saved allowance may exceed the customer's original provider cost.
        const allowance = (await read(`production/allowances/${entry.orderId}.json`))?.value;
        if (allowance) {
          requireValue(allowance.orderId === entry.orderId && allowance.customerEmail === value.customerEmail
            && allowance.preparedId === entry.preparedId && allowance.manifestHash === entry.manifestHash
            && cents(allowance.maximumCostCents) && allowance.maximumCostCents >= budget);
          entry.maximumCostCents = allowance.maximumCostCents;
        }
        requireValue(!held || sameIdentity(held, entry));
        entry.maximumCostCents = Math.max(entry.maximumCostCents, held?.maximumCostCents || 0);
        return { ...entry, createdAt: held?.createdAt || new Date(now()).toISOString() };
      });
      for (const entry of orders.filter(Boolean)) holds.set(entry.orderId, entry);
      // Release only exact, completed private films. Failed, uncertain,
      // unpaid, refunded and missing-job commitments remain held for review.
      const completed = await batches([...holds.values()], async entry => {
        const job = (await read(`production/jobs/${entry.ownerHash}/${entry.preparedId}.json`))?.value;
        return job?.status === 'completed' && job.id === entry.preparedId && job.ownerHash === entry.ownerHash
          && job.manifestHash === entry.manifestHash && digest(JSON.stringify(job.manifest)) === entry.manifestHash
          && HASH.test(job.media?.sha256 || '') && job.media.contentType === 'video/mp4'
          && job.media.pathname === `production/media/${entry.ownerHash}/${entry.preparedId}/${job.media.sha256}.mp4`
          ? entry.orderId : null;
      });
      for (const orderId of completed.filter(Boolean)) holds.delete(orderId);
      requireValue(!completed.includes(wanted.orderId));
      requireValue(!releaseMatches((await read(releasePath(wanted)))?.value, wanted));
      const current = holds.get(wanted.orderId);
      requireValue(!current || same(current, wanted));
      holds.set(wanted.orderId, { ...wanted, createdAt: existing?.createdAt || new Date(now()).toISOString() });
      requireValue(holds.size <= MAX_ORDERS);
      const required = [...holds.values()].reduce((total, entry) => total + entry.maximumCostCents, 0);
      requireValue(Number.isSafeInteger(required) && required <= await readFalCreditCents({ env, fetchImpl }));
      const next = { version: 1, account: env.FAL_BILLING_ACCOUNT, revision: (ledger?.revision || 0) + 1,
        checkedAt: new Date(now()).toISOString(), entries: [...holds.values()].sort((a, b) => a.orderId.localeCompare(b.orderId)) };
      try {
        await write(FAL_FUNDING_PATH, next, saved?.etag);
        // An uncertain write cannot authorize an invoice. Read back this exact
        // ledger version; another writer forces the next full balance check.
        const confirmed = await read(FAL_FUNDING_PATH);
        if (confirmed?.value && digest(JSON.stringify(confirmed.value)) === digest(JSON.stringify(next)))
          return { recheck: async () => { await reserve(input); return true; } };
      } catch { /* Conditional conflict: bounded reread, never invoice here. */ }
    }
    throw unavailable();
  }
  async function reserve(input) {
    try { return await reserveAttempt(input); } catch { throw unavailable(); }
  }
  return { reserve, releaseExpiredOrder, wasReleased };
}
