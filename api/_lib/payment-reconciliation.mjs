import { randomUUID } from "node:crypto";
import { readRecord, writeRecord, userPath } from "./auth.mjs";
import { recordPage } from "./admin.mjs";
import { accessStatusForUser } from "./access.mjs";
import { createHostedCheckoutService } from "./hosted-checkout.mjs";
import { createQuickBooksAccountingTransport, createQuickBooksService } from "./quickbooks.mjs";
import { receiptDelivery } from "./receipt-delivery.mjs";

export const RECONCILIATION_STATE_PATH = "payments/reconciliation/state.json";
const HEX = /^[a-f0-9]{64}$/, NUMERIC = /^[0-9]{1,30}$/;
const PAGE_SIZE = 20, MAX_ORDERS = 3, MAX_PAGES = 2;
const RUN_MS = 150_000, START_RESERVE_MS = 90_000, PROVIDER_MS = 25_000, LEASE_MS = 300_000;
const unavailable = () => new Error("Payment reconciliation is temporarily unavailable.");
const validCursor = value => value === null || (typeof value === "string" && value.length > 0 && value.length <= 4096);
function stateValue(record) {
  if (!record) return { version: 1, cursor: null, pendingIds: [] };
  const value = record.value;
  if (!value || value.version !== 1 || !validCursor(value.cursor) || !Array.isArray(value.pendingIds)
    || value.pendingIds.length > PAGE_SIZE || value.pendingIds.some(id => !HEX.test(id))
    || new Set(value.pendingIds).size !== value.pendingIds.length || typeof record.etag !== "string"
    || (value.lease != null && (typeof value.lease.token !== "string" || !Number.isFinite(value.lease.expiresAt)))) throw unavailable();
  return value;
}
function candidate(value, id) {
  return Boolean(value && value.id === id && value.version === 1 && value.provider === "quickbooks"
    && value.checkoutMethod === "quickbooks-hosted-invoice" && value.sandbox !== true
    && value.merchantBinding?.environment === "production" && NUMERIC.test(value.invoiceId || "")
    && ["awaiting-payment", "uncertain", "captured"].includes(value.status)
    && typeof value.customerEmail === "string" && value.customerEmail.length <= 254
    && value.customerEmail === value.customerEmail.trim().toLowerCase()
    && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value.customerEmail));
}

// This adapter cannot create, send, update, or delete a QuickBooks transaction.
export function createReconciliationTransport({ transport, now = Date.now, deadline, stillOwned }) {
  let reads = 0;
  async function guard() {
    if (now() >= deadline || !await stillOwned()) throw unavailable();
    if (now() >= deadline) throw unavailable();
  }
  return {
    binding: async options => { await guard(); return transport.binding(options); },
    request: async (binding, operation) => {
      if (operation?.method !== "GET" || !/^\/(?:invoice|payment)\/[0-9]{1,30}$/.test(operation.path || "") || ++reads > 6) throw unavailable();
      await guard();
      return transport.request(binding, operation);
    },
  };
}

export function createPaymentReconciliationService({ read = readRecord, write = writeRecord, page = recordPage,
  receipts = receiptDelivery, now = Date.now, env = process.env, fetchImpl = fetch, makeHosted } = {}) {
  function hostedFor({ deadline, stillOwned }) {
    if (makeHosted) return makeHosted({ deadline, stillOwned });
    const boundedFetch = async (url, init = {}) => {
      if (now() >= deadline || !await stillOwned()) throw unavailable();
      const remaining = deadline - now();
      if (remaining <= 0) throw unavailable();
      const signal = AbortSignal.timeout(Math.min(15_000, remaining));
      return fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    };
    const connection = createQuickBooksService({ read, write, env, now, fetchImpl: boundedFetch });
    const transport = createReconciliationTransport({ now, deadline, stillOwned,
      transport: createQuickBooksAccountingTransport({ read, env, now, connection, fetchImpl: boundedFetch }) });
    return createHostedCheckoutService({ read, write, env, now, transport,
      receiptDelivery: { deliver: async () => ({ status: "skipped" }) } });
  }
  async function run() {
    const result = { status: "completed", examined: 0, checked: 0, receiptsAccepted: 0, receiptsPending: 0, skipped: 0, failed: 0, hasMore: false };
    const started = now(), deadline = started + RUN_MS, token = randomUUID();
    const previous = await read(RECONCILIATION_STATE_PATH), initial = stateValue(previous);
    if (initial.lease?.expiresAt > started) return { ...result, status: "locked" };
    try {
      await write(RECONCILIATION_STATE_PATH, { ...initial, lease: { token, expiresAt: started + LEASE_MS }, updatedAt: new Date(now()).toISOString() }, previous?.etag);
    } catch {
      // A failed or ambiguous claim never starts provider or email work.
      return { ...result, status: "locked" };
    }
    async function owned() {
      const record = await read(RECONCILIATION_STATE_PATH);
      return record?.value.lease?.token === token && record.value.lease.expiresAt > now() ? record : null;
    }
    async function checkpoint(change) {
      const record = await owned();
      if (!record) throw unavailable();
      const next = { ...stateValue(record), ...change, updatedAt: new Date(now()).toISOString() };
      await write(RECONCILIATION_STATE_PATH, next, record.etag);
      if (!await owned()) throw unavailable();
      return next;
    }
    let current, pages = 0, cycleEnded = false;
    try {
      const claimed = await owned();
      if (!claimed) return { ...result, status: "locked" };
      current = stateValue(claimed);
      while (!cycleEnded && result.examined < MAX_ORDERS && now() + START_RESERVE_MS <= deadline) {
        if (!current.pendingIds.length) {
          if (pages >= MAX_PAGES) break;
          const listed = await page("payments/orders/", { limit: PAGE_SIZE, ...(current.cursor ? { cursor: current.cursor } : {}) });
          pages++;
          if (!Array.isArray(listed?.records) || listed.records.length > PAGE_SIZE || !validCursor(listed.cursor ?? null)) throw unavailable();
          current = await checkpoint({ pendingIds: [...new Set(listed.records.map(value => value?.id).filter(id => typeof id === "string" && HEX.test(id)))], cursor: listed.cursor ?? null });
          if (!current.pendingIds.length) { if (!current.cursor) break; continue; }
        }
        const [id, ...remaining] = current.pendingIds;
        cycleEnded = !remaining.length && !current.cursor;
        // Persist forward progress before slow work. A crash retries this order
        // on the next complete scan without starving later records.
        current = await checkpoint({ pendingIds: remaining });
        result.examined++;
        try {
          const order = (await read(`payments/orders/${id}.json`))?.value;
          if (!candidate(order, id)) { result.skipped++; continue; }
          const actor = (await read(userPath(order.customerEmail)))?.value;
          if (!actor || actor.email !== order.customerEmail || actor.mustChangePassword
            || actor.status === "suspended" || accessStatusForUser(actor) !== "approved") { result.skipped++; continue; }
          if (!await owned()) throw unavailable();
          if (order.status !== "captured") {
            const hosted = hostedFor({ deadline: Math.min(deadline - 60_000, now() + PROVIDER_MS), stillOwned: async () => Boolean(await owned()) });
            await hosted.check(actor, { orderId: id });
            result.checked++;
          }
          const confirmed = (await read(`payments/orders/${id}.json`))?.value;
          if (!candidate(confirmed, id) || confirmed.status !== "captured") continue;
          const currentActor = (await read(userPath(confirmed.customerEmail)))?.value;
          if (confirmed.customerEmail !== order.customerEmail || !currentActor || currentActor.email !== confirmed.customerEmail
            || currentActor.mustChangePassword || currentActor.status === "suspended" || accessStatusForUser(currentActor) !== "approved") { result.skipped++; continue; }
          if (!await owned() || now() > deadline - 60_000) throw unavailable();
          const delivered = await receipts.deliver({ id });
          if (delivered?.status === "accepted") result.receiptsAccepted++;
          else if (delivered?.status !== "skipped") result.receiptsPending++;
        } catch { result.failed++; }
      }
      result.hasMore = Boolean(current.pendingIds.length || current.cursor);
      return result;
    } finally {
      const record = await owned();
      if (record) {
        try { await write(RECONCILIATION_STATE_PATH, { ...stateValue(record), lease: null, updatedAt: new Date(now()).toISOString() }, record.etag); }
        catch { /* The bounded lease remains the recovery barrier. */ }
      }
    }
  }
  return { run };
}

export const paymentReconciliation = createPaymentReconciliationService();
