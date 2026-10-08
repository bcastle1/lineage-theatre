import { readRecord, writeRecord, digest, userPath } from "./auth.mjs";
import { list } from "@vercel/blob";
import { accessStatusForUser } from "./access.mjs";
import { productionQueue } from "./production-queue.mjs";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PREFIX = "production/automatic-starts/";
export const automaticProductionPath = id => {
  if (!HASH.test(id || "")) throw new Error("Choose a saved payment.");
  return `${PREFIX}${id}.json`;
};

// This durable outbox connects recorded payment to the existing, independently
// authorized production queue. It never submits to a provider or changes money.
export function createAutomaticProduction({ read = readRecord, write = writeRecord,
  listBlobs = list, queue = productionQueue, now = Date.now } = {}) {
  function eligible(order, id) {
    return order?.id === id && order.version === 1 && order.provider === "quickbooks"
      && order.checkoutMethod === "quickbooks-hosted-invoice" && order.status === "captured"
      && order.sandbox !== true && order.merchantBinding?.environment === "production"
      && order.confirmationSource === "quickbooks-accounting" && order.productionConsent === true
      && typeof order.productionConsentAt === "string" && Date.parse(order.productionConsentAt) <= now()
      && typeof order.capturedAt === "string" && Date.parse(order.capturedAt) <= now()
      && (order.refundedCents ?? 0) === 0 && !order.refundOperation
      && (!order.refunds || Array.isArray(order.refunds) && order.refunds.length === 0)
      && UUID.test(order.preparedId || "") && HASH.test(order.manifestHash || "")
      && typeof order.customerEmail === "string" && order.customerEmail === order.customerEmail.trim().toLowerCase()
      && /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(order.customerEmail);
  }
  async function context(id) {
    const order = (await read(`payments/orders/${id}.json`))?.value;
    if (!eligible(order, id)) return null;
    const actor = (await read(userPath(order.customerEmail)))?.value;
    if (!actor || actor.email !== order.customerEmail || actor.mustChangePassword || accessStatusForUser(actor) !== "approved") return null;
    const job = (await read(`production/jobs/${digest(actor.email)}/${order.preparedId}.json`))?.value;
    if (!job || job.id !== order.preparedId || job.ownerHash !== digest(actor.email)
      || job.filmId !== order.filmId || job.manifestHash !== order.manifestHash
      || !job.manifest || digest(JSON.stringify(job.manifest)) !== order.manifestHash) return null;
    return { order, actor };
  }
  function matches(ticket, order) {
    return ticket?.version === 1 && ticket.id === order.id && ticket.email === order.customerEmail
      && ticket.preparedId === order.preparedId && ticket.manifestHash === order.manifestHash;
  }
  async function schedule({ id }) {
    const path = automaticProductionPath(id), current = await context(id);
    if (!current) return { state: "skipped" };
    const old = await read(path);
    if (old) {
      if (!matches(old.value, current.order)) throw new Error("The saved production assignment changed.");
      return { state: old.value.state };
    }
    const ticket = { version: 1, id, email: current.actor.email, preparedId: current.order.preparedId,
      manifestHash: current.order.manifestHash, state: "pending", createdAt: new Date(now()).toISOString() };
    try { await write(path, ticket); }
    catch {
      const saved = await read(path);
      if (!matches(saved?.value, current.order)) throw new Error("Production scheduling could not be confirmed.");
      return { state: saved.value.state };
    }
    return { state: "pending" };
  }
  async function advance(id) {
    const path = automaticProductionPath(id), old = await read(path);
    if (!old || old.value.state !== "pending") return { state: "skipped" };
    const current = await context(id);
    if (!current || !matches(old.value, current.order)) return { state: "skipped" };
    // enqueue rechecks live payment/reversals, provider readiness and the exact
    // paid manifest. Its create-only queue identity prevents duplicate work.
    await queue.enqueue({ actor: current.actor, id: current.order.preparedId, orderId: id });
    try { await write(path, { ...old.value, state: "queued", queuedAt: new Date(now()).toISOString() }, old.etag); }
    catch {
      const saved = await read(path);
      if (!matches(saved?.value, current.order) || saved.value.state !== "queued") throw new Error("Production queue receipt could not be saved.");
    }
    return { state: "queued" };
  }
  async function run() {
    const result = { queued: 0, pending: 0, skipped: 0 };
    const cursorPath = "production/automatic-start-cursor.json", old = await read(cursorPath);
    // Live payment/reversal verification can take a minute. Start at most one
    // order per invocation within the shared function's 180-second budget.
    const page = await listBlobs({ prefix: PREFIX, limit: 1, ...(old?.value.cursor ? { cursor: old.value.cursor } : {}) });
    for (const blob of page.blobs) {
      const id = blob.pathname.startsWith(PREFIX) ? blob.pathname.slice(PREFIX.length, -5) : "";
      if (!HASH.test(id) || blob.pathname !== automaticProductionPath(id)) { result.skipped++; continue; }
      try { result[(await advance(id)).state]++; } catch { result.pending++; }
    }
    try { await write(cursorPath, { cursor: page.hasMore ? page.cursor : null }, old?.etag); } catch { /* Next scan is safe to repeat. */ }
    return result;
  }
  return { schedule, advance, run };
}

export const automaticProduction = createAutomaticProduction();
