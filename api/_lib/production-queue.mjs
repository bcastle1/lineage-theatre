import { randomUUID } from "node:crypto";
import { list } from "@vercel/blob";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { accessStatusForUser } from "./access.mjs";
import { filmProduction, productionJobPath, FilmProductionError } from "./film-production.mjs";
import { payments } from "./payments.mjs";
import { createProductionProgress } from "./production-progress.mjs";
import { FAL_RECIPE_VERSION } from "./fal-production.mjs";

const prefix = "production/queue/";
const automaticPrefix = "production/automatic-starts/";
const HEX = /^[a-f0-9]{64}$/;
const conflict = error => /precondition|already exists|etag|if.?match/i.test(`${error?.name} ${error?.message}`);
export function productionQueuePath(email, id) {
  // Reuse the film service's owner/reference validation.
  productionJobPath(email, id);
  return `${prefix}${digest(email)}/${id}.json`;
}
const blocked = () => new FilmProductionError("Film production is not available yet. Your saved plan is unchanged.", 503, "PRODUCTION_UNAVAILABLE");
function approved(actor, email = actor?.email) {
  if (!actor || actor.mustChangePassword || accessStatusForUser(actor) !== "approved"
    || typeof actor.email !== "string" || actor.email !== actor.email.toLowerCase().trim() || actor.email !== email)
    throw new FilmProductionError("Sign in with an approved account to produce this film.", 403, "PRODUCTION_ACCESS_REQUIRED");
  return actor;
}

// A queue ticket stays pending while shots are rendering. Only the confirmed
// progress stage can tell the customer that production is still waiting to start.
export function productionQueueMessage({ progress, ticket, automaticPending = false, health, now = Date.now() }) {
  if (progress?.stage !== "queued") return {};
  if (automaticPending) return {
    message: "Your paid film is scheduled. The studio is saving its place in the production queue and will retry automatically. You do not need to pay again.",
  };
  const checkedAt = typeof health?.checkedAt === "string" ? Date.parse(health.checkedAt) : NaN;
  const workerReady = health?.version === 1 && health.ready === true && health.model === "wan"
    && health.recipe === FAL_RECIPE_VERSION && Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt <= 180_000;
  return { workerReady, message: !workerReady
    ? "Your film is queued. The studio is waiting for the production worker to confirm it is available. Your payment is saved; you do not need to pay again."
    : ticket?.lastResult === "RETRYABLE_FAILURE"
      ? "Your film is queued while the studio retries a required production check. Your payment is saved; you do not need to pay again."
      : "Your film is queued. The studio will start rendering automatically after confirming your payment and saved film plan." };
}

// Queue entries contain references only; screenplay and media remain in the
// owner's private records. A worker restarts from these entries after a crash.
export function createProductionQueue({ read = readRecord, write = writeRecord, listBlobs = list,
  film = filmProduction, paymentService = payments, now = Date.now, uuid = randomUUID,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const progress = createProductionProgress({ read, write, now });
  async function currentAccount(email) {
    return approved((await read(userPath(email)))?.value, email);
  }
  async function enqueue({ actor, id, orderId }) {
    approved(actor);
    if (!/^[a-f0-9]{64}$/.test(orderId || "")) throw blocked();
    const path = productionQueuePath(actor.email, id);
    await currentAccount(actor.email);
    const job = await film.getPrepared({ email: actor.email, id });
    const old = await read(path);
    if (old) {
      if (old.value.email !== actor.email || old.value.id !== id || old.value.orderId !== orderId || old.value.manifestHash !== job.manifestHash)
        throw new FilmProductionError("This film already has a different production request.", 409, "PRODUCTION_CONFLICT");
      if (old.value.state === "attention" && job.status !== "failed") {
        if (film.readiness().available !== true) throw blocked();
        const grant = await paymentService.authorizeProduction({ email: actor.email, orderId, manifestHash: job.manifestHash, preparedId: id });
        if (grant?.allowed !== true || grant.manifestHash !== job.manifestHash) throw blocked();
        await currentAccount(actor.email);
        const { lease, ...value } = old.value;
        try { await write(path, { ...value, state: "pending", attempts: 0, nextAttemptAt: now(), lastResult: "RESUMED" }, old.etag); }
        catch (error) { if (!conflict(error)) throw error; }
      }
      return status({ email: actor.email, id });
    }
    if (film.readiness().available !== true) throw blocked();
    const grant = await paymentService.authorizeProduction({ email: actor.email, orderId, manifestHash: job.manifestHash, preparedId: id });
    if (grant?.allowed !== true || grant.manifestHash !== job.manifestHash) throw blocked();
    // Account access may change while payment and provider budgets are checked.
    await currentAccount(actor.email);
    const value = { version: 1, email: actor.email, id, orderId, manifestHash: job.manifestHash,
      state: "pending", attempts: 0, nextAttemptAt: now(), createdAt: new Date(now()).toISOString() };
    try { await write(path, value); }
    catch (error) {
      if (!conflict(error)) {
        // An acknowledged durable write can still lose its response.
        const saved = await read(path);
        if (!saved || saved.value.orderId !== orderId || saved.value.manifestHash !== job.manifestHash) throw error;
      }
      return enqueue({ actor, id, orderId });
    }
    return status({ email: actor.email, id });
  }
  // Payment confirmation must make a durable queue entry before slow live
  // refund scans and provider pricing. This method accepts only the exact
  // captured, production QuickBooks order with saved consent; runTicket still
  // obtains fresh payment/reversal/account/provider authorization before spend.
  async function enqueueAutomatic({ actor, id, orderId }) {
    approved(actor);
    if (!HEX.test(orderId || "")) throw blocked();
    const path = productionQueuePath(actor.email, id);
    await currentAccount(actor.email);
    const job = await film.getPrepared({ email: actor.email, id });
    const order = (await read(`payments/orders/${orderId}.json`))?.value;
    const paidAt = typeof order?.capturedAt === "string" ? Date.parse(order.capturedAt) : NaN;
    const consentAt = typeof order?.productionConsentAt === "string" ? Date.parse(order.productionConsentAt) : NaN;
    if (order?.id !== orderId || order.version !== 1 || order.provider !== "quickbooks"
      || order.checkoutMethod !== "quickbooks-hosted-invoice" || order.status !== "captured"
      || order.sandbox === true || order.merchantBinding?.environment !== "production"
      || order.confirmationSource !== "quickbooks-accounting" || order.productionConsent !== true
      || !Number.isFinite(paidAt) || paidAt > now() || !Number.isFinite(consentAt) || consentAt > now()
      || order.customerEmail !== actor.email || order.preparedId !== id || order.filmId !== job.filmId
      || order.manifestHash !== job.manifestHash || job.id !== id || job.mode !== "customer" || job.status === "failed"
      || job.ownerHash !== digest(actor.email) || !job.manifest || digest(JSON.stringify(job.manifest)) !== job.manifestHash
      || (order.refundedCents ?? 0) !== 0 || order.refundOperation
      || order.refunds && (!Array.isArray(order.refunds) || order.refunds.length > 0)) throw blocked();
    const old = await read(path);
    if (old) {
      if (old.value.email !== actor.email || old.value.id !== id || old.value.orderId !== orderId
        || old.value.manifestHash !== job.manifestHash)
        throw new FilmProductionError("This film already has a different production request.", 409, "PRODUCTION_CONFLICT");
      return status({ email: actor.email, id, orderId });
    }
    await currentAccount(actor.email);
    const value = { version: 1, email: actor.email, id, orderId, manifestHash: job.manifestHash,
      state: "pending", attempts: 0, nextAttemptAt: now(), createdAt: new Date(now()).toISOString() };
    try { await write(path, value); }
    catch (error) {
      const saved = await read(path);
      if (!saved || saved.value.email !== actor.email || saved.value.id !== id || saved.value.orderId !== orderId
        || saved.value.manifestHash !== job.manifestHash) {
        if (!conflict(error)) throw error;
        throw new FilmProductionError("The production queue could not confirm this request. Check the saved film status.", 503, "PRODUCTION_QUEUE_UNCONFIRMED");
      }
    }
    return status({ email: actor.email, id, orderId });
  }
  async function status({ email, id, orderId }) {
    const job = await film.status({ email, id });
    const ticket = await read(productionQueuePath(email, id));
    const validTicket = ticket?.value.email === email && ticket.value.id === id && ticket.value.manifestHash === job.manifestHash ? ticket.value : null;
    const saved = await film.getPrepared({ email, id });
    const reference = HEX.test(orderId || "") ? orderId : HEX.test(validTicket?.orderId || "") ? validTicket.orderId : null;
    const automatic = reference ? (await read(`${automaticPrefix}${reference}.json`))?.value : null;
    const validAutomatic = automatic?.version === 1 && automatic.id === reference && automatic.email === email
      && automatic.preparedId === id && automatic.manifestHash === job.manifestHash
      && ["pending", "queued"].includes(automatic.state) ? automatic : null;
    const automaticPending = !validTicket && saved.status === "prepared" && validAutomatic?.state === "pending";
    const queued = validTicket || (automaticPending ? { state: "pending" } : null);
    const snapshot = await progress.snapshot({ job: saved, email, queue: queued });
    const health = snapshot.stage === "queued" && !automaticPending ? (await read("production/worker-health.json"))?.value : undefined;
    const queueMessage = productionQueueMessage({ progress: snapshot, ticket: validTicket, automaticPending, health, now: now() });
    return { ...job, progress: snapshot,
      ...(job.status === "prepared" && ["creating", "finishing"].includes(snapshot.stage) ? { status: "processing", preparationOnly: false } : {}),
      ...(snapshot.stage === "attention" ? { needsAttention: true } : {}),
      ...(snapshot.stage === "queued" ? { status: "queued", preparationOnly: false } : {}),
      ...queueMessage,
      ...(validTicket?.state === "attention" ? { needsAttention: true, message: "Production needs administrator attention. Your payment and saved plan remain recorded." } : {}) };
  }
  async function claim(path) {
    const old = await read(path), value = old?.value;
    if (!value || value.version !== 1 || value.state !== "pending" || value.nextAttemptAt > now() || value.lease?.expiresAt > now()) return null;
    if (path !== productionQueuePath(value.email, value.id) || !/^[a-f0-9]{64}$/.test(value.orderId || "") || !/^[a-f0-9]{64}$/.test(value.manifestHash || "")) throw blocked();
    const token = uuid();
    // Assembly is local CPU work. Expired claims never publish a completion.
    const next = { ...value, attempts: value.attempts + 1, lease: { token, expiresAt: now() + 30 * 60_000 } };
    try { await write(path, next, old.etag); }
    catch (error) { if (!conflict(error)) throw error; return null; }
    const saved = await read(path);
    return saved?.value.lease?.token === token ? { path, token, value: saved.value } : null;
  }
  async function owns(ticket) {
    const saved = await read(ticket.path);
    return saved?.value.lease?.token === ticket.token && saved.value.lease.expiresAt > now();
  }
  async function renew(ticket) {
    const saved = await read(ticket.path);
    if (saved?.value.lease?.token !== ticket.token || saved.value.lease.expiresAt <= now()) return false;
    try {
      await write(ticket.path, { ...saved.value, lease: { token: ticket.token, expiresAt: now() + 30 * 60_000 } }, saved.etag);
      return true;
    } catch (error) { if (!conflict(error)) throw error; return false; }
  }
  async function finish(ticket, state, code) {
    const saved = await read(ticket.path);
    if (saved?.value.lease?.token !== ticket.token || saved.value.lease.expiresAt <= now()) return false;
    const { lease, ...rest } = saved.value;
    const next = { ...rest, state, attempts: code === "PROGRESS" ? 0 : rest.attempts, updatedAt: new Date(now()).toISOString(),
      nextAttemptAt: now() + (code === "PROGRESS" ? 5000 : Math.min(300_000, 5000 * 2 ** Math.min(rest.attempts, 6))),
      // Fixed codes only: never persist provider responses, signed URLs or errors.
      lastResult: code };
    try { await write(ticket.path, next, saved.etag); return true; }
    catch (error) { if (!conflict(error)) throw error; return false; }
  }
  async function runTicket(path, { assemble } = {}) {
    const ticket = await claim(path);
    if (!ticket) return { state: "skipped" };
    let renewal = Promise.resolve();
    const timer = setIntervalImpl(() => (renewal = renewal.then(() => renew(ticket)).catch(() => false)), 30_000);
    timer?.unref?.();
    const finishTicket = async (state, code) => { clearIntervalImpl(timer); await renewal; return finish(ticket, state, code); };
    try {
      const actor = await currentAccount(ticket.value.email);
      const input = { email: ticket.value.email, id: ticket.value.id };
      const job = await film.getPrepared(input);
      if (job.manifestHash !== ticket.value.manifestHash) throw blocked();
      if (job.status === "completed") { await finishTicket("completed", "COMPLETED"); return { state: "completed" }; }
      if (job.status === "failed") { await finishTicket("attention", "PROVIDER_FAILED"); return { state: "attention" }; }
      if (job.status === "awaiting-assembly") {
        if (typeof assemble !== "function") throw blocked();
        const artifact = await assemble({ ...input, job, stillOwned: () => owns(ticket) });
        if (!await owns(ticket)) return { state: "skipped" };
        await film.acceptAssembly({ ...input, manifestHash: job.manifestHash, artifact, stillOwned: () => owns(ticket) });
      } else {
        await film.advance({ ...input, actor, authorizationReference: ticket.value.orderId });
      }
      const result = await film.getPrepared(input);
      const uncertain = result.status === "uncertain";
      const state = result.status === "completed" ? "completed" : result.status === "failed" || (uncertain && ticket.value.attempts >= 10) ? "attention" : "pending";
      await finishTicket(state, state === "completed" ? "COMPLETED" : state === "attention" ? "REVIEW_REQUIRED" : uncertain ? "UNCERTAIN" : "PROGRESS");
      return { state };
    } catch (error) {
      const needsReview = error instanceof FilmProductionError || error?.code==='FILM_SPEECH_REVIEW_REQUIRED' || ticket.value.attempts >= 10;
      await finishTicket(needsReview ? "attention" : "pending", needsReview ? "REVIEW_REQUIRED" : "RETRYABLE_FAILURE");
      return { state: needsReview ? "attention" : "pending" };
    } finally { clearIntervalImpl(timer); await renewal; }
  }
  async function runBatch({ cursor, limit = 20, assemble } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Worker batch size must be 1–100.");
    const page = await listBlobs({ prefix, cursor, limit });
    const counts = { completed: 0, pending: 0, attention: 0, skipped: 0 };
    for (const blob of page.blobs) {
      try { counts[(await runTicket(blob.pathname, { assemble })).state]++; }
      catch { counts.attention++; }
    }
    return { ...counts, cursor: page.hasMore ? page.cursor : undefined };
  }
  return { enqueue, enqueueAutomatic, status, runTicket, runBatch };
}

export const productionQueue = createProductionQueue();
