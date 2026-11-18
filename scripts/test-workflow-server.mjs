/**
 * SYNTHETIC LOCAL TEST ONLY. Never deploy this server or load production credentials.
 * Start: node scripts/test-workflow-server.mjs
 * Route proof, then exit: node scripts/test-workflow-server.mjs --check
 * Checkout UI fixtures: node scripts/test-workflow-server.mjs --checkout-fixtures
 * Checkout route proof: node scripts/test-workflow-server.mjs --checkout-fixtures --check
 * Finished-film playback fixture: node scripts/test-workflow-server.mjs --delivery-fixture
 * Private media route proof: node scripts/test-workflow-server.mjs --delivery-fixture --check
 * Owner review UI fixture: node scripts/test-workflow-server.mjs --generation-review-fixture
 * Owner review route proof: node scripts/test-workflow-server.mjs --generation-review-fixture --check
 * URL: http://127.0.0.1:5178
 * Route checks use an ephemeral loopback port so browser QA can remain open.
 * CI runs all four --check modes (.github/workflows/deploy-pages.yml).
 * Strictly offline: only loopback sockets may connect; fetch, UDP and remote
 * DNS are refused. fal pricing, fal funding, the worker heartbeat and
 * QuickBooks Accounting are in-process fakes driving the real services.
 * Customer: customer@example.invalid / Cedar lantern rivers wander
 * Owner fixture: erik@brocotech.ai / Copper forest windmills travel
 * Agreement QA: registration loads the real public agreement handler; edit it
 * in owner Administration to test stale acceptance in a second browser tab.
 * The owner address is the app's reserved identifier, backed here ONLY by a fictional
 * in-memory record. These passwords are public test fixtures, never real credentials.
 * All records disappear on exit. Browser fixture drafts stay on this local origin.
 */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";

// Egress guard, installed before any application module loads. Every TCP or
// TLS socket (node:http, node:https, node:net, node:tls, undici) passes through
// net.Socket#connect; only loopback hosts and local IPC paths may connect.
// UDP and non-loopback DNS lookups are refused too. Global fetch is replaced
// below and refuses every request, loopback included.
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);
const isLoopback = host => loopbackHosts.has(String(host ?? "localhost").replace(/^\[|\]$/g, "").toLowerCase());
let blockedConnections = 0;
const egressError = target => Object.assign(new Error(`Synthetic workflow server forbids outbound network access (${target}).`), { code: "SYNTHETIC_EGRESS_BLOCKED" });
const realSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === "object" ? first : typeof first === "string" && !/^\d+$/.test(first) ? { path: first } : { host: typeof args[1] === "string" ? args[1] : undefined };
  if (!options.path && !isLoopback(options.host)) {
    blockedConnections++;
    const error = egressError(String(options.host));
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return realSocketConnect.apply(this, args);
};
for (const method of ["send", "connect"]) {
  dgram.Socket.prototype[method] = function guardedDatagram() { blockedConnections++; throw egressError(`udp ${method}`); };
}
for (const target of [dns, dns.promises]) {
  for (const name of Object.keys(target).filter(key => /^(?:lookup|lookupService|resolve\w*|reverse)$/.test(key))) {
    const real = target[name];
    target[name] = function guardedDns(host, ...rest) {
      if (name === "lookup" && isLoopback(host)) return real.call(this, host, ...rest);
      blockedConnections++;
      const error = egressError(`dns ${name} ${host}`), callback = rest.findLast?.(value => typeof value === "function");
      if (target === dns.promises) return Promise.reject(error);
      if (callback) { process.nextTick(() => callback(error)); return undefined; }
      throw error;
    };
  }
}

const HOST = "127.0.0.1";
let PORT = 5178, origin = `http://${HOST}:${PORT}`;
const root = fileURLToPath(new URL("../", import.meta.url));
const checkOnly = process.argv.includes("--check");
const checkoutFixtures = process.argv.includes("--checkout-fixtures");
const deliveryFixture = process.argv.includes("--delivery-fixture");
const generationReviewFixture = process.argv.includes("--generation-review-fixture");
if ([checkoutFixtures, deliveryFixture, generationReviewFixture].filter(Boolean).length > 1) throw new Error("Choose only one synthetic fixture mode for this local run.");
if (process.argv.some(argument => argument.startsWith("--env-file"))) throw new Error("Test server must not load environment files.");

// Remove inherited provider settings before importing application services.
for (const name of Object.keys(process.env)) {
  if (/^(?:OPENAI_|MAGICLIGHT_|QUICKBOOKS_|PAYMENT_|RECAPTCHA_|BLOB_|LINEAGE_|MICROSOFT_|GRAPH_|VERCEL_|VITE_|GITHUB_|FAL_|KLING_|CRON_|RESEND_|SMTP_)/.test(name)) delete process.env[name];
}
process.env.LINEAGE_SESSION_SECRET = "synthetic-workflow-session-key-local-only-never-production";
process.env.LINEAGE_MFA_ENCRYPTION_KEY = "cd".repeat(32);
process.env.NODE_ENV = "development";
let blockedExternalCalls = 0;
globalThis.fetch = async () => {
  blockedExternalCalls++;
  throw new Error("Synthetic workflow server forbids outbound fetch requests.");
};

const [{ createAuthHandler }, { createStudioHandler, connections: studioConnections }, { createAdminHandler }, auth,
  { OWNER_EMAIL }, { createFilmProductionService, fictionalOperatorProject, productionJobPath },
  { createPaymentsService }, securityHelpers, { parseRange },
  { readPricingSettings }, { createFilmPricingService },
  { createFalProductionAdapter, FAL_RECIPE_VERSION }, { FAL_MODELS }, { createFalFunding, FAL_FUNDING_PATH },
  { createHostedCheckoutService, HOSTED_CHECKOUT_SETTINGS_PATH }, { createAutomaticProduction, automaticProductionPath }] = await Promise.all([
  import("../api/auth.mjs"), import("../api/studio.mjs"), import("../api/admin.mjs"),
  import("../api/_lib/auth.mjs"), import("../api/_lib/access.mjs"),
  import("../api/_lib/film-production.mjs"), import("../api/_lib/payments.mjs"),
  import("../api/_lib/auth-security.mjs"),
  import("../api/_lib/archive.mjs"),
  import("../api/_lib/admin.mjs"), import("../api/_lib/film-pricing.mjs"),
  import("../api/_lib/fal-production.mjs"), import("../api/_lib/fal-client.mjs"), import("../api/_lib/fal-funding.mjs"),
  import("../api/_lib/hosted-checkout.mjs"), import("../api/_lib/automatic-production.mjs"),
]);
const records = new Map();
let revision = 0;
const read = async path => records.has(path) ? structuredClone(records.get(path)) : null;
const write = async (path, value, etag) => {
  const previous = records.get(path);
  if (previous ? etag !== previous.etag : Boolean(etag)) {
    const error = new Error("Synthetic Blob precondition failed: record ETag changed.");
    error.name = "BlobPreconditionFailedError"; throw error;
  }
  const next = { value: structuredClone(value), etag: `"synthetic-${++revision}"` };
  records.set(path, next);
  return { etag: next.etag };
};
// Real verification/proof logic, explicitly injected fake Google transport and
// memory storage. No application environment flag can enable this fixture.
const { createCaptchaService } = await import("../api/_lib/captcha.mjs");
const fixtureCaptchaToken = action => `synthetic_captcha_${action}_${randomUUID()}`;
const seenCaptchaTokens = new Set();
const captcha = createCaptchaService({ read, write,
  env: { RECAPTCHA_SITE_KEY: "synthetic-site-key-local-only", RECAPTCHA_SECRET_KEY: "synthetic-secret-local-only", RECAPTCHA_ALLOWED_HOSTNAMES: HOST },
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://www.google.com/recaptcha/api/siteverify");
    const token = options.body.get("response"), match = /^synthetic_captcha_(login|register|mfa|checkout)_/.exec(token || "");
    const valid = Boolean(match) && !seenCaptchaTokens.has(token);
    seenCaptchaTokens.add(token);
    return new Response(JSON.stringify({ success: valid, action: match?.[1], hostname: HOST, score: 0.9, challenge_ts: new Date().toISOString() }));
  },
});
const limit = async (key, maximum, windowMs) => {
  const path = `limits/${auth.digest(key)}-${Math.floor(Date.now() / windowMs)}.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await read(path), count = previous?.value.count || 0;
    if (count >= maximum) return false;
    try { await write(path, { count: count + 1 }, previous?.etag); return true; }
    catch (error) { if (attempt === 3) throw error; }
  }
  return false;
};
const session = (req, allowSetup) => auth.getSession(req, allowSetup, { readRecordImpl: read, writeRecordImpl: write });
const pricingSettings = () => readPricingSettings(read);
const registrationPolicy = async () => (await read("settings/registration.json"))?.value || { approvalRequired: true, revision: 0, updatedAt: null, updatedBy: null };
const refuseProvider = async () => { throw new Error("Synthetic test cannot call an external provider."); };
const listRecords = async ({ prefix, cursor, limit: size = 30 }) => {
  const paths = [...records.keys()].filter(key => key.startsWith(prefix)).sort(), offset = Number(cursor || 0);
  return { blobs: paths.slice(offset, offset + size).map(pathname => ({ pathname })), hasMore: offset + size < paths.length, cursor: String(offset + size) };
};

// Default and checkout modes price films exactly as production does since
// 2026-10-18: the real Kling adapter, its live-rate check, the self-hosted
// worker heartbeat and fal funding. Each of those is served here by an
// in-process fake. The fake answers only the two fal read endpoints the
// pricing and funding code use; it can never submit, poll or download.
const syntheticProvider = !deliveryFixture && !generationReviewFixture;
let syntheticFalReads = 0, syntheticFalBalanceCents = 10_000, syntheticWorkerReady = true;
const syntheticFalBillingAccount = "synthetic-billing-account-local-only";
const syntheticFalFetch = async (url, options = {}) => {
  const target = new URL(url);
  assert.equal(target.origin, "https://api.fal.ai", "The synthetic fal service answers only fal API reads.");
  assert.equal(options.method ?? "GET", "GET");
  syntheticFalReads++;
  if (target.pathname === "/v1/models/pricing") {
    assert.deepEqual(target.searchParams.getAll("endpoint_id"), [FAL_MODELS.kling, FAL_MODELS.reference]);
    // The reviewed public list prices that api/_lib/fal-pricing.mjs accepts.
    return new Response(JSON.stringify({ prices: [
      { endpoint_id: FAL_MODELS.kling, currency: "USD", unit: "seconds", unit_price: 0.14 },
      { endpoint_id: FAL_MODELS.reference, currency: "USD", unit: "images", unit_price: 0.15 } ] }), { status: 200 });
  }
  if (target.pathname === "/v1/account/billing" && target.searchParams.get("expand") === "credits")
    return new Response(JSON.stringify({ username: syntheticFalBillingAccount,
      credits: { currency: "USD", current_balance: syntheticFalBalanceCents / 100 } }), { status: 200 });
  return new Response("{}", { status: 404 });
};
const syntheticFalAdapter = createFalProductionAdapter({ model: "kling", requireWorker: true, read, fetchImpl: syntheticFalFetch,
  key: () => "synthetic-fal-key-local-only", client: { get: refuseProvider, poll: refuseProvider, submit: refuseProvider },
  validateStartFrame: refuseProvider, verifyStartFrame: refuseProvider, normalizeReference: refuseProvider,
  normalizeKlingReference: refuseProvider, selectedPhoto: refuseProvider });
// Same record shape scripts/production-worker.mjs writes every cycle. Pricing
// refuses a heartbeat older than three minutes, so it is refreshed while open.
const writeWorkerHeartbeat = async (checkedAt = new Date()) => {
  const previous = await read("production/worker-health.json");
  await write("production/worker-health.json", { version: 1, ready: syntheticWorkerReady, model: "kling", recipe: FAL_RECIPE_VERSION,
    referencePhotoVersion: 1, deliveryChecksVersion: 1, visualChecksVersion: 1, characterBindingVersion: 3,
    checkedAt: checkedAt.toISOString(), syntheticFixture: { memoryOnly: true, workerRunning: false } }, previous?.etag);
};
if (syntheticProvider) {
  await writeWorkerHeartbeat();
  setInterval(() => { if (syntheticWorkerReady) void writeWorkerHeartbeat(); }, 60_000).unref();
}
const filmProduction = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, ...(syntheticProvider ? { adapter: syntheticFalAdapter } : {}) });
const filmPricing = createFilmPricingService({ filmProduction, pricingSettings, env: {} });
// The studio's own readiness summary (production from the film service,
// billing from the hosted checkout configuration) with story calls disabled.
const connections = async (options = {}) => {
  const ready = await studioConnections({ pricingSettings: await pricingSettings(), ...options, filmService: filmProduction, key: "", fetchImpl: refuseProvider });
  return { ...ready, story: false, connections: { ...ready.connections,
    story: { available: false, reason: "SYNTHETIC LOCAL TEST: story provider calls are disabled." } } };
};

// QuickBooks-hosted invoice checkout, the only customer checkout in
// production, with the real service and an in-process Accounting fake. The
// default mode leaves it unconfigured (billing disabled); --checkout-fixtures
// configures a fictional production company so the whole paid path runs.
const syntheticQuickBooksBinding = { environment: "production", grantId: "e".repeat(64), realmId: "9130000000000001" };
const syntheticQuickBooks = { customers: new Map(), invoices: new Map(), payments: new Map(), invoiceRequests: new Map(), invoicePosts: 0, requests: 0 };
const qbReply = (status, body) => new Response(JSON.stringify(body), { status });
const syntheticQuickBooksTransport = {
  binding: async () => structuredClone(syntheticQuickBooksBinding),
  request: async (binding, operation) => {
    assert.deepEqual(binding, syntheticQuickBooksBinding);
    syntheticQuickBooks.requests++;
    const { method, path } = operation;
    if (method === "GET" && path === "/query" && operation.query?.entity === "Item")
      return qbReply(200, { QueryResponse: { Item: [{ Id: "2", Name: "SYNTHETIC film production", Active: true, Type: "Service", Taxable: false }] } });
    if (method === "GET" && path === "/item/2") return qbReply(200, { Item: { Id: "2", Name: "SYNTHETIC film production", Active: true, Type: "Service", Taxable: false } });
    if (method === "GET" && path === "/query" && operation.query?.entity === "Customer")
      return qbReply(200, { QueryResponse: { Customer: [...syntheticQuickBooks.customers.values()].filter(customer => customer.DisplayName === operation.query.where?.value) } });
    if (method === "POST" && path === "/customer") {
      const customer = { ...structuredClone(operation.body), Id: String(100 + syntheticQuickBooks.customers.size), Active: true };
      syntheticQuickBooks.customers.set(customer.Id, customer); return qbReply(200, { Customer: customer });
    }
    if (method === "GET" && /^\/customer\/\d+$/.test(path)) return qbReply(syntheticQuickBooks.customers.has(path.slice(10)) ? 200 : 404, { Customer: syntheticQuickBooks.customers.get(path.slice(10)) });
    if (method === "POST" && path === "/invoice") {
      // Accounting honours the request id; a repeated POST returns the same invoice.
      if (syntheticQuickBooks.invoiceRequests.has(operation.requestId)) return qbReply(200, { Invoice: syntheticQuickBooks.invoices.get(syntheticQuickBooks.invoiceRequests.get(operation.requestId)) });
      syntheticQuickBooks.invoicePosts++;
      const id = String(500 + syntheticQuickBooks.invoices.size), amount = operation.body.Line[0].Amount;
      const invoice = { ...structuredClone(operation.body), Id: id, DocNumber: `SYNTHETIC-${id}`, TotalAmt: amount, Balance: amount, LinkedTxn: [],
        InvoiceLink: `https://connect.intuit.com/portal/app/synthetic-local-fixture-invoice-${id}` };
      syntheticQuickBooks.invoices.set(id, invoice); syntheticQuickBooks.invoiceRequests.set(operation.requestId, id);
      return qbReply(200, { Invoice: invoice });
    }
    if (method === "GET" && /^\/invoice\/\d+$/.test(path)) return qbReply(syntheticQuickBooks.invoices.has(path.slice(9)) ? 200 : 404, { Invoice: syntheticQuickBooks.invoices.get(path.slice(9)) });
    if (method === "GET" && /^\/payment\/\d+$/.test(path)) return qbReply(syntheticQuickBooks.payments.has(path.slice(9)) ? 200 : 404, { Payment: syntheticQuickBooks.payments.get(path.slice(9)) });
    return qbReply(400, { Fault: { Error: [{ Message: "Synthetic QuickBooks fake does not support this operation." }] } });
  },
};
// Stands in for the customer paying on the hosted page: Accounting then
// shows one Payment linked to the invoice and a zero balance.
function recordSyntheticInvoicePayment(invoiceId) {
  const invoice = syntheticQuickBooks.invoices.get(invoiceId);
  assert.ok(invoice && invoice.Balance > 0, "Only an open synthetic invoice can be paid.");
  const id = String(900 + syntheticQuickBooks.payments.size);
  syntheticQuickBooks.payments.set(id, { Id: id, CustomerRef: invoice.CustomerRef, CurrencyRef: { value: "USD" }, TotalAmt: invoice.TotalAmt,
    TxnDate: new Date().toISOString().slice(0, 10), Line: [{ Amount: invoice.TotalAmt, LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }] });
  Object.assign(invoice, { Balance: 0, LinkedTxn: [{ TxnId: id, TxnType: "Payment" }] });
  return id;
}
if (checkoutFixtures) await write(HOSTED_CHECKOUT_SETTINGS_PATH, { revision: 1, enabled: true, serviceItemId: "2", serviceItemName: "SYNTHETIC film production",
  taxCode: "NON", deliveryTerms: "SYNTHETIC LOCAL TEST: no film will be delivered.", refundTerms: "SYNTHETIC LOCAL TEST: no payment exists to refund.",
  merchantConfirmed: true, pciAcknowledged: true, automaticInvoiceEmailDisabled: true, merchantBinding: syntheticQuickBooksBinding, updatedBy: OWNER_EMAIL });
const syntheticReceipts = [], syntheticQueue = [];
// The real payment-to-production outbox; its queue hand-off is recorded here
// instead of reaching the production worker.
const automaticProduction = createAutomaticProduction({ read, write, listBlobs: listRecords,
  queue: { enqueueAutomatic: async input => { syntheticQueue.push({ email: input.actor.email, id: input.id, orderId: input.orderId }); return { queued: true }; } } });
const hostedCheckout = createHostedCheckoutService({ read, write, transport: syntheticQuickBooksTransport, pricingSettings,
  env: checkoutFixtures ? { QUICKBOOKS_ENVIRONMENT: "production", LINEAGE_PAYMENT_ACCESS: "approved" } : {},
  receiptDelivery: { deliver: async order => { syntheticReceipts.push(order.id); } }, productionAutomation: automaticProduction,
  quoteProvider: (...args) => filmPricing.quoteForPayment(...args), productionQuote: input => filmProduction.quoteForProductionBudget(input),
  verifyReversals: refuseProvider,
  funding: createFalFunding({ read, write, listBlobs: listRecords, fetchImpl: syntheticFalFetch,
    env: { FAL_BILLING_KEY: "synthetic-billing-key-local-only", FAL_BILLING_ACCOUNT: syntheticFalBillingAccount } }) });
let deliveryMedia, deliveryProject, generationProject;
let deliveryBlobReads = 0;
const getDeliveryBlob = async (pathname, options) => {
  assert.equal(deliveryFixture || generationReviewFixture, true);
  assert.equal(options.access, "private");
  assert.equal(options.useCache, false);
  deliveryBlobReads++;
  if (!deliveryMedia || pathname !== deliveryMedia.pathname) return null;
  const range = parseRange(options.headers?.Range, deliveryMedia.bytes.length);
  const bytes = range ? deliveryMedia.bytes.subarray(range.start, range.end + 1) : deliveryMedia.bytes;
  return { statusCode: 200, stream: new Response(bytes).body,
    headers: new Headers({ "content-type": "video/mp4", "content-length": String(bytes.length), ...(range ? { "content-range": range.contentRange } : {}) }),
    blob: { pathname, contentType: "video/mp4", size: bytes.length } };
};
const simulatedBinding = { environment: "sandbox", grantId: "c".repeat(64) };
// The retired direct-card service still reads older saved orders (the delivery
// fixture uses one). It is never configured here and cannot charge anything.
const payments = createPaymentsService({ read, write, pricingSettings,
  quoteProvider: (...args) => filmPricing.quoteForPayment(...args),
  readiness: async () => ({ sandboxEnabled: false, merchantVerified: false }),
  provider: { binding: refuseProvider, charge: refuseProvider, readCharge: refuseProvider, refund: refuseProvider, readRefund: refuseProvider } });
const audit = async (actor, action, target, details = {}) => {
  const id = randomUUID(), event = { id, actor, action, target, details, at: new Date().toISOString() };
  await write(`admin/audit/${id}.json`, event); return event;
};
const recordPage = async (prefix, { cursor, limit: size = 50 } = {}) => {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid synthetic page cursor.");
  const all = [...records.entries()].filter(([path]) => path.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
  const page = all.slice(offset, offset + size).map(([, record]) => structuredClone(record.value));
  return { records: page, ...(offset + size < all.length ? { cursor: String(offset + size) } : {}) };
};
const shared = { getSession: session, readRecord: read, writeRecord: write, limitAction: limit,
  connections, readPricingSettings: pricingSettings, readRegistrationPolicy: registrationPolicy, filmProduction, filmPricing, payments, captcha };
const [{ createPaidFilmGenerationService, paidFilmGenerationPath }, { createPaidFilmGenerationReviewService, paidFilmReviewPath }] = await Promise.all([
  import("../api/_lib/paid-film-generation.mjs"), import("../api/_lib/paid-film-generation-review.mjs"),
]);
let generationPaymentChecks = 0;
const generationFixtureOrder = async (actor, id) => {
  assert.equal(generationReviewFixture, true);
  const value = (await read(`payments/orders/${id}.json`))?.value;
  if (actor?.email !== OWNER_EMAIL || actor?.role !== "owner" || !value || value.customerEmail !== actor.email) {
    const error = new Error("Synthetic review order not found."); error.status = 404; throw error;
  }
  return { id: value.id, quoteId: value.quoteId, preparedId: value.preparedId, filmId: value.filmId, filmTitle: value.filmTitle,
    status: value.status, currency: value.currency, amountCents: value.amountCents, refundedCents: value.refundedCents,
    charged: true, requiresReview: false, receiptAvailable: true, createdAt: value.createdAt, updatedAt: value.updatedAt,
    sandbox: false, checkoutMethod: value.checkoutMethod, confirmationSource: value.confirmationSource, invoiceUrl: null, invoiceNumber: "SYNTHETIC-ONLY" };
};
const generationFixturePaymentCheck = async (actor, { orderId }) => { generationPaymentChecks++; return generationFixtureOrder(actor, orderId); };
const generationFixtureService = createPaidFilmGenerationService({ read, write, env: {},
  getPrepared: input => filmProduction.getPrepared(input), checkPayment: generationFixturePaymentCheck, clientFactory: refuseProvider });
const generationReviewService = createPaidFilmGenerationReviewService({ read, write, getBlob: getDeliveryBlob, checkPayment: generationFixturePaymentCheck });
const handlers = {
  "/api/auth": createAuthHandler({ ...shared,
    verificationMail: { available: () => false, send: refuseProvider } }),
  "/api/studio": createStudioHandler({ ...shared, generateStory: refuseProvider, ...((deliveryFixture || generationReviewFixture) ? { getBlob: getDeliveryBlob } : {}),
    ...(generationReviewFixture ? {
      paidFilmGeneration: { ...generationFixtureService, start: refuseProvider,
        availableFor: actor => actor?.email === OWNER_EMAIL && actor?.role === "owner" && actor?.mustChangePassword !== true },
      paidFilmGenerationReview: generationReviewService,
      hostedCheckout: { configuration: async () => ({ available: false }), ownsOrder: async id => Boolean((await read(`payments/orders/${id}.json`))?.value?.checkoutMethod),
        order: generationFixtureOrder, check: generationFixturePaymentCheck, prepareCheckout: refuseProvider, quote: refuseProvider, checkout: refuseProvider, receipt: refuseProvider },
    } : {}), ...(syntheticProvider ? { hostedCheckout } : {}) }),
  "/api/admin": createAdminHandler({ ...shared, audit, recordPage }),
};

// Website-export delivery uses the real services with only local transport and
// storage injected. No provider or production credential can reach this fixture.
const [{ createFilmDeliveryService }, { createFilmDeliveryHandler }, { createArchiveService },
  { createArchiveHandler }, { createFilmLibraryService }, { createLibraryHandler }] = await Promise.all([
  import("../api/_lib/film-delivery.mjs"), import("../api/film-delivery.mjs"), import("../api/_lib/archive.mjs"),
  import("../api/archive.mjs"), import("../api/_lib/film-library.mjs"), import("../api/library.mjs"),
]);
const websiteCopies = new Map();
const websiteBytes = await readFile(new URL("../public/assets/the-journey-of-thomas-wilson.mp4", import.meta.url));
const websiteList = listRecords;
const websiteGet = async (pathname, options) => {
  const bytes = websiteCopies.get(pathname); if (!bytes) return null;
  const range = parseRange(options?.headers?.Range, bytes.length), part = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  return { stream: new Response(part).body, blob: { pathname, contentType: "video/mp4", size: part.length },
    headers: new Headers(range ? { "content-range": range.contentRange } : {}) };
};
const websiteArchive = createArchiveService({ readRecord: read, writeRecord: write, listBlobs: websiteList, getBlob: websiteGet,
  headBlob: async pathname => ({ pathname, contentType: "video/mp4", size: websiteCopies.get(pathname)?.length, etag: "fixture-video" }) });
const websiteDelivery = createFilmDeliveryService({ read, write, listBlobs: websiteList, deleteBlob: async key => records.delete(key), archiveService: websiteArchive,
  fetchImpl: async () => new Response(null, { headers: { "content-type": "video/mp4", "content-length": String(websiteBytes.length) } }),
  copy: async (_job, pathname) => { websiteCopies.set(pathname, websiteBytes); return { sizeBytes: websiteBytes.length, sha256: auth.digest(websiteBytes) }; } });
handlers["/api/film-delivery"] = createFilmDeliveryHandler({ service: websiteDelivery, sessionFor: session, limiter: limit, env: {} });
handlers["/api/archive"] = createArchiveHandler({ archive: websiteArchive, getSession: session, limitAction: limit, getBlob: websiteGet });
handlers["/api/library"] = createLibraryHandler({ service: createFilmLibraryService({ read, write, listBlobs: websiteList }), sessionFor: session, limiter: limit });

const accounts = [
  { email: "customer@example.invalid", name: "SAMPLE ONLY - FICTIONAL CUSTOMER", role: "customer", password: "Cedar lantern rivers wander" },
  { email: OWNER_EMAIL, name: "SAMPLE ONLY - FICTIONAL OWNER", role: "owner", password: "Copper forest windmills travel" },
  { email: "second-customer@example.invalid", name: "SAMPLE ONLY - SECOND FICTIONAL CUSTOMER", role: "customer", password: "Orchard mountain copper lantern" },
  { email: "waiting@example.invalid", name: "SAMPLE ONLY - WAITING CUSTOMER", role: "customer", pending: true, password: "Birch harvest lantern sunset" },
  { email: "admin@example.invalid", name: "SAMPLE ONLY - FICTIONAL ADMIN", role: "admin", password: "Silver fountain cedar twilight" },
];
for (const account of accounts) {
  const { password, pending, ...user } = account;
  await write(auth.userPath(user.email), { ...user, passwordHash: auth.hashPassword(password),
    status: pending ? "pending" : "active", mustChangePassword: false, emailVerified: false, createdAt: new Date().toISOString(),
    ...(!pending ? { approvedAt: new Date().toISOString(), approvedBy: OWNER_EMAIL } : {}) });
}
const fixture = fictionalOperatorProject();
fixture.scenes = fixture.scenes.map((scene, index) => ({ ...scene, id: `synthetic-scene-${index + 1}` }));
fixture.selectedThemes = fixture.selectedThemes.map((theme, index) => ({ ...theme, id: `synthetic-theme-${index + 1}` }));
fixture.themes = structuredClone(fixture.selectedThemes);
fixture.sources = fixture.sources.map(source => ({ ...source, size: Buffer.byteLength(source.text), extraction: "Synthetic fixture text" }));
Object.assign(fixture, { providerId: "magiclight", quality: "highest", generatedBy: "Lineage Theatre", updatedAt: new Date().toISOString() });
const checkoutProjects = ["paid", "unpaid", "funding-blocked"].map((scenario, index) => ({ ...structuredClone(fixture), id: `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`, title: `SAMPLE ONLY - ${scenario} invoice: The shared garden` }));
if (deliveryFixture) {
  // Exercise delivery of an existing public illustration, never claim this is
  // provider-generated output of the fictional screenplay or a paid transaction.
  const bytes = await readFile(new URL("../public/assets/the-journey-of-thomas-wilson.mp4", import.meta.url));
  const sha256 = auth.digest(bytes);
  assert.equal(sha256, "68f017454bf2619b972db7b062badf765829e85f0d8f315ca0f674d763bc708d");
  assert.equal(bytes.length, 17_193_754);
  const { default: ts } = await import("typescript");
  const modelSource = await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(modelSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { normalizeFilm, productionPreparationInput, productionInputHash } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  deliveryProject = normalizeFilm({ ...structuredClone(fixture), id: "00000000-0000-4000-8000-000000000021", duration: 79,
    title: "SAMPLE ONLY - illustrative playback fixture",
    logline: "Fictional garden screenplay. Playback reuses the existing Thomas Wilson demonstration video solely to verify private delivery; it is not a generated result of this plan." });
  const requestId = randomUUID();
  const prepared = await filmProduction.prepare({ email: accounts[0].email, project: deliveryProject, idempotencyKey: requestId, preparationConsent: true });
  const path = productionJobPath(accounts[0].email, prepared.id), record = await read(path);
  const timestamp = new Date().toISOString();
  deliveryMedia = { bytes, pathname: `production/media/${auth.digest(accounts[0].email)}/${prepared.id}/${sha256}.mp4`, sha256 };
  // These production-shaped records exist only in this local memory map to
  // exercise the real delivery gate. No provider ran and no real payment exists.
  await write(path, { ...record.value, status: "completed", updatedAt: timestamp,
    authorization: { manifestHash: prepared.manifestHash, environment: "production", budgetCents: 100,
      quoteReference: "synthetic-delivery-only-no-provider", authorizedAt: timestamp },
    shots: record.value.shots.map(shot => ({ ...shot, status: "completed" })),
    media: { pathname: deliveryMedia.pathname, sha256, contentType: "video/mp4", sizeBytes: bytes.length, durationSeconds: 78.506 },
    syntheticFixture: { purpose: "existing-sample-playback-only", providerGenerated: false },
  }, record.etag);
  const quoteId = auth.digest("synthetic-delivery-fixture-quote"), orderId = auth.digest(`${accounts[0].email}:production:${prepared.manifestHash}`);
  await write(`payments/orders/${orderId}.json`, { id: orderId, quoteId, preparedId: prepared.id, manifestHash: prepared.manifestHash,
    customerEmail: accounts[0].email, filmId: deliveryProject.id, filmTitle: deliveryProject.title, status: "captured",
    currency: "USD", amountCents: 100, refundedCents: 0, createdAt: timestamp, updatedAt: timestamp, capturedAt: timestamp,
    provider: "quickbooks", merchantBinding: { ...simulatedBinding, environment: "production" },
    providerChargeId: "synthetic_delivery_only_no_charge", syntheticFixture: { memoryOnly: true, realPayment: false },
  });
  deliveryProject.productionPreparation = { ...prepared, inputHash: await productionInputHash(JSON.stringify(productionPreparationInput(deliveryProject))),
    requestId, status: "completed", issues: [] };
  deliveryProject.paymentReference = { preparedId: prepared.id, manifestHash: prepared.manifestHash, quoteId, orderId,
    checkoutKey: "synthetic-delivery-checkout", submittedAt: timestamp, sandbox: false };
  assert.deepEqual(normalizeFilm(deliveryProject).paymentReference, deliveryProject.paymentReference);
  assert.equal(normalizeFilm(deliveryProject).productionPreparation.inputHash, deliveryProject.productionPreparation.inputHash);
}
if (generationReviewFixture) {
  // Deliberately fabricated review metadata around an existing public MP4.
  // This does not exercise a provider, worker verification, or real payment.
  const bytes = websiteBytes, sha256 = auth.digest(bytes);
  assert.equal(sha256, "68f017454bf2619b972db7b062badf765829e85f0d8f315ca0f674d763bc708d");
  assert.equal(bytes.length, 17_193_754);
  const { default: ts } = await import("typescript");
  const source = await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { normalizeFilm, productionPreparationInput, productionInputHash } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  generationProject = normalizeFilm({ ...structuredClone(fixture), id: "00000000-0000-4000-8000-000000000022", duration: 79,
    title: "SYNTHETIC ONLY - generated-film review workflow",
    logline: "Local review controls using the existing Thomas Wilson demonstration MP4. This is not generated output of the fictional screenplay and no real payment exists." });
  const requestId = randomUUID(), prepared = await filmProduction.prepare({ email: OWNER_EMAIL, project: generationProject, idempotencyKey: requestId, preparationConsent: true });
  const timestamp = new Date(Date.now() - 1000).toISOString(), taskId = "SYNTHETIC_REVIEW_TASK_ONLY";
  // A reserved documentation host satisfies the saved URL shape; it is never fetched.
  const outputUrl = "https://example.com/synthetic-existing-demonstration.mp4";
  const quoteId = auth.digest("synthetic-generation-review-quote"), orderId = auth.digest(`${OWNER_EMAIL}:production:${prepared.manifestHash}`);
  deliveryMedia = { bytes, pathname: `production/media/${auth.digest(OWNER_EMAIL)}/${prepared.id}/${sha256}.mp4`, sha256 };
  const attempt = { version: 1, id: prepared.id, ownerEmail: OWNER_EMAIL, filmId: generationProject.id, manifestHash: prepared.manifestHash,
    orderId, status: "verifying", submissionCount: 1, taskId, outputUrl, submittedAt: timestamp, updatedAt: timestamp, checkedAt: timestamp,
    promptHash: auth.digest("synthetic-screenplay-request-not-sent"), keyFingerprint: auth.digest("no-provider-key-exists"), changeId: randomUUID(),
    syntheticFixture: { memoryOnly: true, providerGenerated: false } };
  await write(paidFilmGenerationPath(OWNER_EMAIL, prepared.id), attempt);
  await write(paidFilmReviewPath(OWNER_EMAIL, prepared.id), { version: 1, id: prepared.id, ownerEmail: OWNER_EMAIL,
    filmId: generationProject.id, manifestHash: prepared.manifestHash, orderId, taskHash: auth.digest(taskId), sourceHash: auth.digest(outputUrl),
    submittedAt: timestamp, promptHash: attempt.promptHash, status: "awaiting-review", changeId: randomUUID(), verifiedAt: timestamp,
    artifact: { pathname: deliveryMedia.pathname, sha256, sizeBytes: bytes.length, contentType: "video/mp4", durationSeconds: 78.506,
      width: 1280, height: 720, frameRate: 24, hasAudio: true, playable: true, technicalSample: false, manifestHash: prepared.manifestHash,
      verification: "full-video-and-audio-decode", contentReviewed: false },
    syntheticFixture: { memoryOnly: true, verificationSimulated: true, providerGenerated: false } });
  await write(`payments/orders/${orderId}.json`, { id: orderId, quoteId, customerEmail: OWNER_EMAIL, preparedId: prepared.id,
    filmId: generationProject.id, filmTitle: generationProject.title, manifestHash: prepared.manifestHash, status: "captured", capturedAt: timestamp,
    currency: "USD", amountCents: 100, refundedCents: 0, createdAt: timestamp, updatedAt: timestamp, provider: "quickbooks", checkoutMethod: "quickbooks-hosted-invoice",
    merchantBinding: { environment: "production", grantId: "b".repeat(64), realmId: "12345" }, confirmationSource: "quickbooks-accounting",
    invoiceId: "100", balanceCents: 0, accountingCheckedAt: timestamp, accountingPayments: [{ id: "101", allocatedCents: 100 }],
    syntheticFixture: { memoryOnly: true, realPayment: false } });
  generationProject.productionPreparation = { ...prepared, inputHash: await productionInputHash(JSON.stringify(productionPreparationInput(generationProject))),
    requestId, status: "prepared", issues: [] };
  generationProject.paymentReference = { preparedId: prepared.id, manifestHash: prepared.manifestHash, quoteId, orderId,
    checkoutKey: "synthetic-generation-review", submittedAt: timestamp, sandbox: false };
  assert.deepEqual(normalizeFilm(generationProject).paymentReference, generationProject.paymentReference);
}
const seedMarker = `lineage-${generationReviewFixture ? "generation-review" : deliveryFixture ? "delivery" : "checkout"}-fixture:${randomUUID()}`;
const seedScript = generationReviewFixture ? `// SYNTHETIC REVIEW ONLY: no generated output, real payment, or technical verification claim.
if(!localStorage.getItem(${JSON.stringify(seedMarker)})) {
  for(const email of ${JSON.stringify(accounts.map(account=>account.email))}) localStorage.setItem('lineage-studio-v3:'+email,JSON.stringify(email===${JSON.stringify(OWNER_EMAIL)}?[${JSON.stringify(generationProject)}]:[${JSON.stringify(fixture)}]));
  localStorage.setItem(${JSON.stringify(seedMarker)},'seeded');
}
const originalFetch=window.fetch.bind(window);
window.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin) throw new Error('Synthetic review fixture forbids external fetch requests.');
  return originalFetch(input,options);
};` : deliveryFixture ? `// SYNTHETIC PLAYBACK ONLY: existing illustrative sample, no new render or charge.
if(!localStorage.getItem(${JSON.stringify(seedMarker)})) {
  for(const email of ${JSON.stringify(accounts.map(account=>account.email))}) localStorage.setItem('lineage-studio-v3:'+email,JSON.stringify(email===${JSON.stringify(accounts[0].email)}?[${JSON.stringify(deliveryProject)}]:[${JSON.stringify(fixture)}]));
  localStorage.setItem(${JSON.stringify(seedMarker)},'seeded');
}
const originalFetch=window.fetch.bind(window);
window.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin) throw new Error('Synthetic playback fixture forbids external fetch requests.');
  return originalFetch(input,options);
};` : checkoutFixtures ? `// SYNTHETIC LOCAL TEST ONLY. This script is never in an application build.
if(!localStorage.getItem(${JSON.stringify(seedMarker)})) {
  for(const email of ${JSON.stringify(accounts.map(account=>account.email))}) localStorage.setItem('lineage-studio-v3:'+email,${JSON.stringify(JSON.stringify(checkoutProjects))});
  localStorage.setItem(${JSON.stringify(seedMarker)},'seeded');
}
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin) throw new Error('Synthetic browser fixture forbids all external fetch requests.');
  return originalFetch(input,options);
};
// The fake invoice link has the real Intuit shape so the app accepts it. The
// payment tab is redirected to the local fake invoice page instead.
const originalOpen=window.open.bind(window);
window.open=(url,target,features)=>{
  const tab=originalOpen('about:blank',target,features);
  if(!tab) return null;
  const local=next=>String(next).startsWith('https://connect.intuit.com/')?'/__workflow/invoice?link='+encodeURIComponent(String(next)):String(next).startsWith(location.origin+'/')?String(next):'/__workflow';
  return {get document(){return tab.document;},get closed(){return tab.closed;},close(){tab.close();},location:{replace(next){tab.location.replace(local(next));}}};
};` : `// SYNTHETIC LOCAL TEST ONLY\nconst fixture=${JSON.stringify(fixture)};\nfor(const email of ${JSON.stringify(accounts.map(account=>account.email))}){const key='lineage-studio-v3:'+email;if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify([fixture]));}`;

let vite;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
      res.statusCode = 403; return res.end("This synthetic server accepts only its local origin.");
    }
    const url = new URL(req.url, origin), path = url.pathname;
    res.setHeader("Cache-Control", "no-store");
    if (handlers[path]) return await handlers[path](req, res);
    if (path.startsWith("/api/")) return auth.json(res, 503, {
      code: "SYNTHETIC_SERVICE_DISABLED", message: "This service is disabled in the synthetic local workflow test." });
    if (path === "/__workflow/status") return auth.json(res, 200, {
      synthetic: true, memoryOnly: true, providersEnabled: false, mailEnabled: false,
      blockedExternalCalls, blockedConnections, recordCount: records.size, checkoutFixtures, deliveryFixture, generationReviewFixture, deliveryBlobReads,
      syntheticProvider, syntheticFalReads, syntheticInvoices: syntheticQuickBooks.invoicePosts, syntheticPayments: syntheticQuickBooks.payments.size,
      syntheticProductionQueue: syntheticQueue.length,
      ...(deliveryFixture ? { deliveryPreparedId: deliveryProject.productionPreparation.id, illustrativePlaybackOnly: true } : {}),
      ...(generationReviewFixture ? { generationPreparedId: generationProject.productionPreparation.id, generationPaymentChecks, reviewVerificationSimulated: true,
        generationStatusLink: `/#library?film=${generationProject.productionPreparation.id}`, illustrativePlaybackOnly: true } : {}),
      preparedFilms: [...records.keys()].filter(key=>key.startsWith("production/jobs/")).length,
    });
    if (path === "/__workflow/fixture") return auth.json(res, 200, { synthetic: true, project: generationReviewFixture ? generationProject : deliveryFixture ? deliveryProject : fixture });
    if (path === "/__workflow/seed.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8"); return res.end(seedScript);
    }
    if (path === "/__workflow/captcha.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      return res.end('/* SYNTHETIC LOCAL TEST ONLY: no Google service call. */ window.grecaptcha={ready:callback=>callback(),execute:async(_key,{action})=>"synthetic_captcha_"+action+"_"+crypto.randomUUID()};');
    }
    if (checkoutFixtures && path === "/__workflow/invoice" && req.method === "GET") {
      const match = /synthetic-local-fixture-invoice-(\d+)$/.exec(url.searchParams.get("link") || ""), invoice = match && syntheticQuickBooks.invoices.get(match[1]);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (!invoice) { res.statusCode = 404; return res.end("<!doctype html><title>Synthetic invoice</title><p>No synthetic invoice matches this link.</p>"); }
      return res.end(`<!doctype html><html><head><title>Synthetic invoice ${invoice.DocNumber}</title></head><body><h1>SYNTHETIC QUICKBOOKS INVOICE · NOT A REAL PAYMENT PAGE</h1><p>Invoice ${invoice.DocNumber} for $${invoice.TotalAmt.toFixed(2)}. Balance $${invoice.Balance.toFixed(2)}. This page stands in for the Intuit payment page; nothing leaves this computer.</p>${invoice.Balance > 0 ? `<form method="post" action="/__workflow/pay-invoice"><input type="hidden" name="invoiceId" value="${invoice.Id}"><button type="submit">Record synthetic payment in the fake QuickBooks</button></form>` : "<p>Paid in the fake QuickBooks. Return to Lineage Theatre and check the payment.</p>"}</body></html>`);
    }
    if (checkoutFixtures && path === "/__workflow/pay-invoice" && req.method === "POST") {
      if (req.headers.origin !== origin) { res.statusCode = 403; return res.end("Same-origin form only."); }
      let text = ""; for await (const chunk of req) { text += chunk; if (text.length > 1000) throw new Error("Too large."); }
      const invoiceId = new URLSearchParams(text).get("invoiceId"), invoice = syntheticQuickBooks.invoices.get(invoiceId);
      if (invoice?.Balance > 0) recordSyntheticInvoicePayment(invoiceId);
      res.statusCode = 303; res.setHeader("Location", `/__workflow/invoice?link=${encodeURIComponent(invoice?.InvoiceLink || "")}`); return res.end();
    }
    if (path === "/__workflow") {
      // This helper exposes only the intentionally public fixture accounts, never real users.
      const visible = [];
      for (const account of accounts) {
        const saved = await read(auth.userPath(account.email)), pending = await read(`auth/mfa-enrollments/${auth.digest(account.email)}.json`);
        const encrypted = saved?.value.mfa?.enabled ? saved.value.mfa.secret : pending?.value.secret;
        const code = encrypted ? securityHelpers.totpCode(securityHelpers.decryptMfaSecret(encrypted, account.email), Math.floor(Date.now()/30000)) : "Enroll first";
        visible.push(`<tr><td>${account.email}</td><td>${account.password}</td><td>${code}</td></tr>`);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (generationReviewFixture) return res.end(`<!doctype html><html><head><title>Synthetic generated-film review fixture</title></head><body><h1>SYNTHETIC GENERATION REVIEW FIXTURE ONLY</h1><p>This local fixture reuses the existing Thomas Wilson demonstration MP4. It is not a newly generated film, does not match the fictional garden screenplay, and represents no real payment. Technical verification metadata is deliberately simulated to test the review interface; the worker and provider do not run.</p><p>Sign in as the fictional owner erik@brocotech.ai using its public password below. Open the saved film link, preview the demonstration, then approve only as a synthetic interface test. Every record disappears on exit.</p><table><tr><th>Account</th><th>Public test password</th><th>Current fixture authenticator code</th></tr>${visible.join("")}</table><p><a href="/#library?film=${generationProject.productionPreparation.id}">Open synthetic review film</a> · <a href="/__workflow/status">Read test status</a> · <a href="/__workflow">Refresh authenticator codes</a></p></body></html>`);
      if (deliveryFixture) return res.end(`<!doctype html><html><head><title>Illustrative private playback fixture</title></head><body><h1>SYNTHETIC PLAYBACK FIXTURE ONLY</h1><p>This local fixture reuses the existing Thomas Wilson demonstration MP4 to exercise private delivery. It is not a newly generated film, does not depict the fictional garden screenplay, and represents no real payment.</p><p>Sign in with customer@example.invalid and the public fixture password below, then open Create &amp; watch. The prepared job and fabricated confirmed payment use the live record format solely to test payment-gated delivery. Every record exists only in memory; there is no real transaction, production credential, or external provider call.</p><table><tr><th>Account</th><th>Public test password</th><th>Current fixture authenticator code</th></tr>${visible.join("")}</table><p><a href="/">Open app</a> · <a href="/__workflow/status">Read test status</a></p></body></html>`);
      return res.end(`<!doctype html><html><head><title>Synthetic workflow test</title></head><body><h1>SYNTHETIC LOCAL TEST ONLY</h1><p>Public test credentials and authenticator codes. Every account is fictional and stored in memory. No external provider or email can be called.</p><table><tr><th>Account</th><th>Public test password</th><th>Current fixture authenticator code</th></tr>${visible.join("")}</table>${checkoutFixtures ? `<h2>Fake QuickBooks-hosted invoice checkout</h2><p>Each preloaded film can be priced, quoted and checked out. Pricing uses the real Kling adapter against an in-process fake of fal's price list and a fake worker heartbeat; checkout reserves fake fal funding and creates an invoice in an in-process fake QuickBooks company. The payment tab opens a local fake invoice page with a button that records a synthetic payment. Then use the app's payment check: production is handed to a recording queue, never to the worker or a provider. No request leaves this computer.</p><table><tr><th>Fake invoice</th><th>Amount</th><th>Balance</th></tr>${[...syntheticQuickBooks.invoices.values()].map(invoice => `<tr><td><a href="/__workflow/invoice?link=${encodeURIComponent(invoice.InvoiceLink)}">${invoice.DocNumber}</a></td><td>$${invoice.TotalAmt.toFixed(2)}</td><td>$${invoice.Balance.toFixed(2)}</td></tr>`).join("")}</table>` : ''}<p><a href="/">Open app</a> · <a href="/__workflow/status">Read test status</a> · <a href="/__workflow">Refresh authenticator codes</a></p></body></html>`);
    }
    if (checkOnly) { res.statusCode = 404; return res.end("Synthetic route-check mode."); }
    vite.middlewares(req, res);
  } catch {
    auth.json(res, 500, { code: "SYNTHETIC_SERVER_ERROR", message: "The local synthetic test request failed." });
  }
});

if (!checkOnly) {
  const [{ createServer: createViteServer }, { default: react }] = await Promise.all([import("vite"), import("@vitejs/plugin-react")]);
  vite = await createViteServer({ root, configFile: false, envFile: false, appType: "spa",
    define: { __BUILD_COMMIT__: JSON.stringify("synthetic-local-test") },
    plugins: [react(), { name: "synthetic-workflow-label",
    transform(code, id) {
      if (id.replaceAll("\\", "/").endsWith("/src/lib/captcha.ts"))
        return code.replace("https://www.google.com/recaptcha/api.js?render=", "/__workflow/captcha.js?render=");
    },
    transformIndexHtml(html) {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: ws://${HOST}:${PORT}">`)
        .replace("</head>", '<script src="/__workflow/seed.js"></script></head>')
        .replace("<body>", `<body style="padding-bottom:38px"><div role="note" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#641c24;color:white;padding:9px 16px;text-align:center;font:13px Arial,sans-serif">${generationReviewFixture ? "SYNTHETIC REVIEW FIXTURE · EXISTING SAMPLE VIDEO · VERIFICATION SIMULATED · NO GENERATION OR REAL PAYMENT · MEMORY ONLY" : deliveryFixture ? "SYNTHETIC PLAYBACK FIXTURE · EXISTING DEMONSTRATION VIDEO · NO NEW RENDER OR REAL CHARGE · MEMORY ONLY" : "SYNTHETIC LOCAL TEST · FICTIONAL DATA · MEMORY-ONLY STORAGE · EMAIL, AI, VIDEO AND PAYMENTS DISABLED"}</div>`);
    } }],
    server: { middlewareMode: true, host: HOST, hmr: { server }, fs: { strict: true, allow: [root] } },
  });
}
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(checkOnly ? 0 : PORT, HOST, resolve); });
PORT = server.address().port;
origin = `http://${HOST}:${PORT}`;
async function close() {
  await vite?.close();
  await new Promise(resolve => server.close(resolve));
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

function route(path, { body, cookie, suppliedOrigin = origin } = {}) {
  return new Promise((resolve, reject) => {
    if (["login", "register", "mfaChallenge"].includes(body?.action))
      body = { ...body, captchaToken: fixtureCaptchaToken(body.action === "mfaChallenge" ? "mfa" : body.action) };
    const data = body ? JSON.stringify(body) : null;
    const req = httpRequest(`${origin}${path}`, { method: data ? "POST" : "GET",
      headers: { Origin: suppliedOrigin, ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", value => { text += value; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text), cookies: res.headers["set-cookie"] || [] }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const login = async account => {
  const result = await route("/api/auth", { body: { action: "login", email: account.email, password: account.password } });
  assert.equal(result.status, 200); assert.equal(result.body.user.email, account.email);
  return result.cookies.find(cookie=>cookie.startsWith("lineage_session=")).split(";")[0];
};
async function currentAgreementConsent() {
  const response = await route("/api/auth?action=agreement");
  assert.equal(response.status, 200);
  const agreement = response.body.agreement;
  assert.ok(agreement && typeof agreement.body === "string" && agreement.body.length > 0);
  return { sourceAgreementAccepted: true, sourceAgreementVersion: agreement.version, sourceAgreementHash: agreement.contentHash };
}
// Pricing has used a live provider quote since 2026-10-18 (a485316). The
// fictional garden plans as three Kling shots of 5.5, 5.0 and 4.5 seconds,
// billed as 6 + 5 + 5 = 16 seconds at the reviewed $0.15/second, plus seven
// $0.30 reference images (two cast references, two cast elements and three
// start frames for character binding v3): 240 + 210 = 450 cents provider cost,
// plus the default 50% markup (225 cents) = 675 cents.
const expectedProviderCostCents = 450, expectedFixturePriceCents = 675;
function assertProviderQuotePrice(price, prepared) {
  assert.equal(price.status, 200, JSON.stringify(price.body));
  assert.equal(price.body.preparedId, prepared.id);
  assert.equal(price.body.manifestHash, prepared.manifestHash);
  assert.equal(price.body.currency, "USD");
  assert.equal(price.body.amountCents, expectedFixturePriceCents);
  assert.equal(price.body.kind, "confirmed");
  assert.equal(price.body.pricingBasis, "provider-quote");
  assert.equal(price.body.sandbox, false);
  assert.ok(Date.parse(price.body.expiresAt) > Date.now());
  assert.match(price.body.note, /fixed price/i);
  assert.doesNotMatch(JSON.stringify(price.body), /providerCostCents|quoteReference|planningCreditsPerClip|markupBasisPoints|apiVerified/);
}
// The production adapter refuses to price while the worker heartbeat is stale.
async function withStaleWorker(callback) {
  await writeWorkerHeartbeat(new Date(Date.now() - 10 * 60_000)); syntheticWorkerReady = false;
  try { return await callback(); } finally { syntheticWorkerReady = true; await writeWorkerHeartbeat(); }
}
async function checkEgressGuard() {
  // Runs last: nothing above may have attempted a non-loopback connection.
  assert.equal(blockedExternalCalls, 0, "No application code may call global fetch");
  assert.equal(blockedConnections, 0, "No application code may open a non-loopback connection");
  const refused = (start, label) => new Promise(resolve => {
    const done = error => { assert.equal(error?.code, "SYNTHETIC_EGRESS_BLOCKED", `${label}: ${error?.message}`); resolve(); };
    try { const request = start(); request.on("error", done); request.on("response", () => assert.fail(`${label} connected`)); request.end?.(); }
    catch (error) { done(error); }
  });
  await refused(() => httpRequest("http://192.0.2.10/"), "http to TEST-NET address");
  await refused(() => httpsRequest("https://api.fal.ai/v1/models/pricing"), "https by hostname");
  await refused(() => httpsRequest("https://quickbooks.api.intuit.com/"), "QuickBooks host");
  await refused(() => net.connect({ host: "203.0.113.7", port: 443 }), "raw TCP");
  await refused(() => net.connect(443, "lineagetheater.com"), "raw TCP by port, host");
  await assert.rejects(fetch("https://lineagetheater.com/"), /forbids outbound fetch/);
  await assert.rejects(fetch(`${origin}/__workflow/status`), /forbids outbound fetch/, "fetch is refused even for loopback");
  await assert.rejects(dns.promises.lookup("example.com"), error => error.code === "SYNTHETIC_EGRESS_BLOCKED");
  assert.throws(() => dgram.createSocket("udp4").send("x", 53, "192.0.2.53"), error => error.code === "SYNTHETIC_EGRESS_BLOCKED");
  assert.equal(blockedConnections, 7); assert.equal(blockedExternalCalls, 2);
  const loopback = await route("/__workflow/status");
  assert.equal(loopback.status, 200, "Loopback connections still work");
}
async function check() {
  assert.equal((await route("/api/studio?action=capabilities")).status, 401);
  const customer = await login(accounts[0]), owner = await login(accounts[1]), other = await login(accounts[2]);
  assert.equal((await route("/api/admin?action=overview", { cookie: customer })).status, 403);
  assert.equal((await route("/api/admin?action=overview", { cookie: owner })).status, 200);
  const capabilities = await route("/api/studio?action=capabilities", { cookie: customer });
  // The synthetic Kling adapter, price list and worker make production configured; billing stays off.
  assert.equal(capabilities.body.production, true); assert.equal(capabilities.body.productionProvider, "kling");
  assert.equal(capabilities.body.billing, false);
  assert.deepEqual(await pricingSettings(), { markupBasisPoints: 5000, planningCreditsPerClip: 286,
    planningSecondsPerClip: 6, planningRendersPerClip: 1, revision: 0, updatedAt: null, updatedBy: null });
  const prepare = { action: "prepare", project: fixture, idempotencyKey: "synthetic-workflow-prepare-001", preparationConsent: true };
  assert.equal((await route("/api/studio", { cookie: customer, body: { ...prepare, preparationConsent: false } })).status, 400);
  assert.equal((await route("/api/studio", { cookie: customer, body: prepare, suppliedOrigin: "https://other.example.invalid" })).status, 403);
  const first = await route("/api/studio", { cookie: customer, body: prepare });
  assert.equal(first.status, 201);
  const job = first.body.production || first.body.job || first.body;
  assert.equal(job.status, "prepared");
  const repeated = await route("/api/studio", { cookie: customer, body: prepare });
  assert.deepEqual(repeated.body, first.body);
  assert.equal((await route(`/api/studio?action=productionStatus&id=${job.id}`, { cookie: customer })).status, 200);
  assert.equal((await route(`/api/studio?action=manifest&id=${job.id}`, { cookie: customer })).status, 200);
  assert.equal((await route(`/api/studio?action=productionStatus&id=${job.id}`, { cookie: other })).status, 404);
  const priceBody = { action: "price", project: fixture, preparedId: job.id, idempotencyKey: "synthetic-workflow-price-001" };
  const stale = await withStaleWorker(() => route("/api/studio", { cookie: customer, body: priceBody }));
  // The adapter's worker check throws a plain error, so the studio answers its generic 503.
  assert.equal(stale.status, 503, "A stale worker heartbeat must block pricing"); assert.equal(stale.body.amountCents, undefined);
  const readsBeforePrice = syntheticFalReads;
  const priced = await route("/api/studio", { cookie: customer, body: priceBody });
  assertProviderQuotePrice(priced, job);
  assert.ok(syntheticFalReads > readsBeforePrice, "Pricing reads the (fake) fal price list");
  assert.equal((await route("/api/studio", { cookie: other, body: { ...priceBody, idempotencyKey: "synthetic-workflow-price-002" } })).status, 404,
    "Another account cannot price this saved plan");
  assert.equal((await route("/api/studio?action=checkoutConfiguration", { cookie: customer })).body.available, false);
  assert.equal(syntheticQuickBooks.requests, 0);
  assert.equal([...records.keys()].some(path => path.startsWith("payments/")), false, "Pricing cannot create a payment quote or order");
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "quote", project: fixture, preparedId: job.id, idempotencyKey: "synthetic-workflow-quote-001" } })).status, 503);
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "checkout", quoteId: "a".repeat(64), idempotencyKey: "synthetic-workflow-pay-001", consent: true, productionConsent: true } })).status, 403);
  assert.equal(syntheticQuickBooks.requests, 0, "Billing is disabled: QuickBooks is never contacted");
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "generate" } })).status, 503);
  assert.equal((await route("/api/admin", { cookie: customer, body: { action: "prepareProductionTest", idempotencyKey: "synthetic-operator-test-001" } })).status, 403);
  assert.equal((await route("/api/admin", { cookie: owner, body: { action: "prepareProductionTest", idempotencyKey: "synthetic-operator-test-001" } })).status, 201);
  await checkSourceAgreement(owner, customer);
  await checkRegistrationAccess(owner);
  assert.equal((await route("/api/auth", { cookie: customer, body: { action: "logout" } })).status, 200);
  assert.equal((await route("/api/studio?action=capabilities", { cookie: customer })).status, 401);
  assert.equal(syntheticQueue.length, 0);
  await checkEgressGuard();
  console.log("PASS: real-handler synthetic workflow, $6.75 provider-quote price (fake fal price list, fake worker heartbeat; a stale heartbeat blocks pricing) with 50% markup while billing is disabled, required versioned source agreement and administrator edits, registration approval and policy changes, shared payment/film access, consent, idempotency, ownership, no generation, and logout replay; zero outbound calls, egress guard verified.");
}
async function checkSourceAgreement(owner, customer) {
  const published = await route("/api/auth?action=agreement");
  assert.equal(published.status, 200);
  const initial = published.body.agreement;
  assert.match(initial.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(typeof initial.version, "string");
  assert.ok(initial.title && initial.body && initial.consentLabel);
  assert.equal((await route("/api/auth?action=acceptedAgreement")).status, 401);
  assert.equal((await route("/api/auth?action=acceptedAgreement", { cookie: customer })).body.acceptance, null,
    "Existing accounts must not be treated as having accepted the new agreement");
  assert.equal((await route("/api/admin?action=agreement", { cookie: customer })).status, 403);
  assert.deepEqual((await route("/api/admin?action=agreement", { cookie: owner })).body.agreement, initial);
  const consent = { sourceAgreementAccepted: true, sourceAgreementVersion: initial.version, sourceAgreementHash: initial.contentHash };
  const registration = email => ({ action: "register", name: "Fictional Agreement Signer", email,
    password: "Meadow lantern copper hillside", termsAccepted: true, ...consent });
  const invalidAcceptance = [
    { sourceAgreementAccepted: false },
    { sourceAgreementHash: undefined },
    { sourceAgreementHash: "0".repeat(64) },
  ];
  for (const [index, invalid] of invalidAcceptance.entries()) {
    const email = `agreement-rejected-${index}@example.invalid`;
    const result = await route("/api/auth", { body: { ...registration(email), ...invalid } });
    assert.ok([400, 409].includes(result.status), `Invalid agreement acceptance must be denied, got ${result.status}`);
    assert.equal(await read(auth.userPath(email)), null, "Rejected consent cannot create an account");
    assert.equal(result.cookies.length, 0, "Rejected consent cannot create a session");
  }
  const email = "agreement-accepted@example.invalid";
  const accepted = await route("/api/auth", { body: registration(email) });
  assert.equal(accepted.status, 201);
  assert.equal(Object.hasOwn(accepted.body.user, "sourceAgreementAcceptance"), false);
  const user = (await read(auth.userPath(email))).value;
  const acceptance = structuredClone(user.sourceAgreementAcceptance);
  assert.deepEqual(acceptance.agreement, initial);
  assert.equal(acceptance.accountEmail, email);
  assert.equal(acceptance.signedName, "Fictional Agreement Signer");
  assert.equal(acceptance.signatureMethod, "account-name-checkbox");
  assert.ok(Number.isFinite(Date.parse(acceptance.acceptedAt)));
  const acceptedCookie = accepted.cookies.find(cookie => cookie.startsWith("lineage_session=")).split(";")[0];
  assert.deepEqual((await route("/api/auth?action=acceptedAgreement", { cookie: acceptedCookie })).body.acceptance, acceptance);
  assert.equal((await route(`/api/auth?action=acceptedAgreement&email=${encodeURIComponent(email)}`, { cookie: customer })).body.acceptance, null,
    "An account cannot request another person's signature record");
  const update = { action: "updateAgreement", revision: initial.revision, title: initial.title,
    body: `${initial.body}\n\nSYNTHETIC LOCAL TEST: this new revision exercises consent refresh.`, consentLabel: initial.consentLabel };
  assert.equal((await route("/api/admin", { cookie: customer, body: update })).status, 403);
  assert.equal((await route("/api/admin", { cookie: owner, body: update, suppliedOrigin: "https://other.example.invalid" })).status, 403);
  assert.deepEqual((await route("/api/auth?action=agreement")).body.agreement, initial);
  const changed = await route("/api/admin", { cookie: owner, body: update });
  assert.equal(changed.status, 200);
  const current = changed.body.agreement;
  assert.equal(current.revision, initial.revision + 1);
  assert.notEqual(current.version, initial.version);
  assert.notEqual(current.contentHash, initial.contentHash);
  assert.equal(current.body, update.body);
  assert.deepEqual((await route("/api/auth?action=agreement")).body.agreement, current);
  assert.equal((await route("/api/admin", { cookie: owner, body: update })).status, 409, "A stale editor cannot overwrite a new agreement");
  assert.deepEqual((await route(`/api/auth?action=agreement&version=${encodeURIComponent(initial.version)}`)).body.agreement, initial);
  assert.deepEqual((await read(auth.userPath(email))).value.sourceAgreementAcceptance, acceptance, "Editing an agreement cannot rewrite existing consent");
  const staleEmail = "agreement-stale@example.invalid";
  assert.equal((await route("/api/auth", { body: registration(staleEmail) })).status, 409);
  assert.equal(await read(auth.userPath(staleEmail)), null);
  const refreshed = await route("/api/auth", { body: { ...registration(staleEmail), ...await currentAgreementConsent() } });
  assert.equal(refreshed.status, 201);
  assert.deepEqual((await read(auth.userPath(staleEmail))).value.sourceAgreementAcceptance.agreement, current);
}
async function checkRegistrationAccess(owner) {
  const waiting = await login(accounts[3]), administrator = await login(accounts[4]);
  assert.equal((await route("/api/auth", { cookie: waiting })).body.user.accessStatus, "pending");
  assert.equal((await route("/api/auth?action=security", { cookie: waiting })).status, 200);
  for (const action of ["prepare", "price", "quote", "checkout", "generate"]) {
    assert.equal((await route("/api/studio", { cookie: waiting, body: { action } })).status, 401, `Pending ${action}`);
  }
  assert.equal((await route("/api/admin", { cookie: waiting, body: { action: "approve", email: accounts[3].email } })).status, 401);
  const approval = await route("/api/admin", { cookie: administrator, body: { action: "approve", email: accounts[3].email } });
  assert.equal(approval.status, 200);
  assert.equal(approval.body.user.accessStatus, "approved");
  assert.equal(approval.body.user.role, "customer");
  // The existing cookie must pick up the persisted approval without granting admin rights.
  assert.equal((await route("/api/auth", { cookie: waiting })).body.user.accessStatus, "approved");
  assert.equal((await route("/api/admin?action=overview", { cookie: waiting })).status, 403);
  for (const cookie of [owner, administrator, waiting]) {
    const capabilities = await route("/api/studio?action=capabilities", { cookie });
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.production, true);
    assert.equal(capabilities.body.billing, false);
    assert.equal((await route("/api/studio", { cookie, body: { action: "generate" } })).status, 503);
    assert.equal((await route("/api/studio", { cookie, body: { action: "quote", project: fixture, idempotencyKey: "synthetic-same-workflow-quote" } })).status, 503);
  }
  const initial = await route("/api/admin?action=registrationPolicy", { cookie: administrator });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.approvalRequired, true);
  assert.equal((await route("/api/admin", { cookie: waiting, body: { action: "updateRegistrationPolicy", approvalRequired: false, expectedRevision: initial.body.revision } })).status, 403);
  const register = async email => route("/api/auth", { body: { action: "register", name: "Fictional registration policy check", email,
    password: "Meadow lantern copper hillside", termsAccepted: true, ...await currentAgreementConsent() } });
  const pending = await register("new-waiting@example.invalid");
  assert.equal(pending.status, 201);
  assert.equal(pending.body.user.accessStatus, "pending");
  const disabled = await route("/api/admin", { cookie: administrator, body: { action: "updateRegistrationPolicy", approvalRequired: false, expectedRevision: initial.body.revision } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.approvalRequired, false);
  const automatic = await register("automatic@example.invalid");
  assert.equal(automatic.status, 201);
  assert.equal(automatic.body.user.accessStatus, "approved");
  assert.equal(automatic.body.user.role, "customer");
  const waitingCookie = pending.cookies.find(cookie=>cookie.startsWith("lineage_session=")).split(";")[0];
  assert.equal((await route("/api/auth", { cookie: waitingCookie })).body.user.accessStatus, "pending");
  const enabled = await route("/api/admin", { cookie: administrator, body: { action: "updateRegistrationPolicy", approvalRequired: true, expectedRevision: disabled.body.revision } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.approvalRequired, true);
  const automaticCookie = automatic.cookies.find(cookie=>cookie.startsWith("lineage_session=")).split(";")[0];
  assert.equal((await route("/api/auth", { cookie: automaticCookie })).body.user.accessStatus, "approved");
  assert.equal((await register("waiting-again@example.invalid")).body.user.accessStatus, "pending");
}
async function checkCheckout() {
  // Current equivalent of the retired direct-card fixture: the QuickBooks-hosted
  // invoice path production uses, with fake fal pricing, worker and funding.
  const customer = await login(accounts[0]), other = await login(accounts[2]);
  const configuration = await route("/api/studio?action=checkoutConfiguration", { cookie: customer });
  assert.equal(configuration.status, 200);
  assert.equal(configuration.body.available, true);
  assert.equal(configuration.body.method, "quickbooks-hosted-invoice");
  assert.equal(configuration.body.environment, "production");
  const capabilities = await route("/api/studio?action=capabilities", { cookie: customer });
  assert.equal(capabilities.body.production, true); assert.equal(capabilities.body.billing, true);
  async function prepareAndQuote(index) {
    const project = checkoutProjects[index];
    const prepared = await route("/api/studio", { cookie: customer, body: { action: "prepare", project, preparationConsent: true, idempotencyKey: `checkout-fixture-prepare-${index}` } });
    assert.equal(prepared.status, 201);
    const priced = await route("/api/studio", { cookie: customer, body: { action: "price", project, preparedId: prepared.body.id, idempotencyKey: `checkout-fixture-price-${index}` } });
    assertProviderQuotePrice(priced, prepared.body);
    assert.equal([...records.values()].filter(record => record.value?.filmId === project.id && record.value?.merchantBinding).length, 0,
      "Viewing the film price cannot create a billable quote or order");
    const quoted = await route("/api/studio", { cookie: customer, body: { action: "quote", project, preparedId: prepared.body.id, idempotencyKey: `checkout-fixture-quote-${index}` } });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.equal(quoted.body.preparedId, prepared.body.id);
    assert.equal(quoted.body.manifestHash, prepared.body.manifestHash);
    assert.equal(quoted.body.amountCents, priced.body.amountCents, "The displayed fixed price is the quoted amount");
    assert.equal(quoted.body.sandbox, false); assert.equal(quoted.body.method, "quickbooks-hosted-invoice");
    assert.match(quoted.body.orderId, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(quoted.body), /providerCost|grantId|markupCents|quoteReference/);
    return { project, prepared: prepared.body, quoted: quoted.body };
  }
  async function checkoutBody(quoted, idempotencyKey, extra = {}) {
    const preflight = await route("/api/studio", { cookie: customer, body: { action: "checkoutCheck", quoteId: quoted.id, captchaToken: fixtureCaptchaToken("checkout") } });
    assert.equal(preflight.status, 200);
    return { action: "checkout", quoteId: quoted.id, checkoutProof: preflight.body.checkoutProof, idempotencyKey, consent: true, productionConsent: true, ...extra };
  }
  const pay = body => route("/api/studio", { cookie: customer, body });
  const checkPayment = async (orderId, expectedQuoteId) => {
    const result = await route("/api/studio", { cookie: customer, body: { action: "checkPayment", orderId, expectedQuoteId } });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };

  // 1. Paid film: one invoice, a payment recorded in the fake QuickBooks,
  // verified capture, receipt, and the automatic production hand-off.
  const paid = await prepareAndQuote(0);
  const noConsent = await pay(await checkoutBody(paid.quoted, "checkout-fixture-pay-0", { productionConsent: false }));
  assert.equal(noConsent.status, 400); assert.equal(noConsent.body.code, "PRODUCTION_CONSENT_REQUIRED");
  const stale = await withStaleWorker(async () => pay(await checkoutBody(paid.quoted, "checkout-fixture-pay-0")));
  assert.equal(stale.status, 503); assert.equal(stale.body.code, "PRODUCTION_UNAVAILABLE", "A stale worker heartbeat must block a new invoice");
  assert.equal(syntheticQuickBooks.invoicePosts, 0); assert.equal(await read(`payments/orders/${paid.quoted.orderId}.json`), null);
  const firstBody = await checkoutBody(paid.quoted, "checkout-fixture-pay-0");
  const invoiced = await pay(firstBody);
  assert.equal(invoiced.status, 200, JSON.stringify(invoiced.body));
  assert.equal(invoiced.body.id, paid.quoted.orderId); assert.equal(invoiced.body.status, "awaiting-payment");
  assert.equal(invoiced.body.charged, false); assert.equal(invoiced.body.sandbox, false);
  assert.equal(invoiced.body.amountCents, expectedFixturePriceCents);
  assert.match(invoiced.body.invoiceUrl, /^https:\/\/connect\.intuit\.com\/portal\/app\/synthetic-local-fixture-invoice-\d+$/);
  assert.equal(syntheticQuickBooks.invoicePosts, 1);
  const invoice = [...syntheticQuickBooks.invoices.values()][0];
  assert.equal(invoice.TotalAmt, expectedFixturePriceCents / 100, "The displayed fixed price reaches QuickBooks unchanged");
  assert.equal(invoice.BillEmail.Address, accounts[0].email); assert.equal(invoice.EmailStatus, "NotSet");
  assert.equal(invoice.Line[0].SalesItemLineDetail.ItemRef.value, "2"); assert.equal(invoice.Line[0].SalesItemLineDetail.TaxCodeRef.value, "NON");
  const ledger = (await read(FAL_FUNDING_PATH)).value;
  assert.deepEqual(ledger.entries.map(entry => [entry.orderId, entry.maximumCostCents]), [[paid.quoted.orderId, expectedProviderCostCents]],
    "The full provider budget is reserved against fal funding before the invoice");
  assert.equal((await pay(firstBody)).status, 403, "A consumed CAPTCHA proof cannot be replayed");
  const recovered = await pay(await checkoutBody(paid.quoted, "checkout-fixture-pay-0"));
  assert.equal(recovered.status, 200); assert.equal(recovered.body.id, paid.quoted.orderId); assert.equal(recovered.body.status, "awaiting-payment");
  assert.equal(syntheticQuickBooks.invoicePosts, 1, "Retrying a checkout key never opens a second invoice");
  for (let readNumber = 0; readNumber < 2; readNumber++) {
    const order = await route(`/api/studio?action=order&id=${paid.quoted.orderId}`, { cookie: customer });
    assert.equal(order.status, 200); assert.equal(order.body.status, "awaiting-payment");
  }
  assert.equal((await route(`/api/studio?action=order&id=${paid.quoted.orderId}`, { cookie: other })).status, 404);
  assert.equal((await route(`/api/studio?action=receipt&id=${paid.quoted.orderId}`, { cookie: customer })).status, 409);
  assert.equal((await checkPayment(paid.quoted.orderId, paid.quoted.id)).status, "awaiting-payment");
  assert.equal(syntheticQueue.length, 0, "Nothing is produced before payment");
  const paymentId = recordSyntheticInvoicePayment(invoice.Id), requestsAfterPayment = syntheticQuickBooks.requests;
  assert.equal((await route(`/api/studio?action=order&id=${paid.quoted.orderId}`, { cookie: customer })).body.status, "awaiting-payment",
    "Reading an order is not a payment check");
  assert.equal(syntheticQuickBooks.requests, requestsAfterPayment);
  const captured = await checkPayment(paid.quoted.orderId, paid.quoted.id);
  assert.equal(captured.status, "captured"); assert.equal(captured.charged, true); assert.equal(captured.receiptAvailable, true);
  assert.equal(captured.confirmationSource, "quickbooks-accounting"); assert.equal(captured.invoiceUrl, null);
  const receipt = await route(`/api/studio?action=receipt&id=${paid.quoted.orderId}`, { cookie: customer });
  assert.equal(receipt.status, 200); assert.equal(receipt.body.amountCents, expectedFixturePriceCents);
  assert.equal(receipt.body.sandbox, false); assert.equal(receipt.body.transactionId, paymentId);
  assert.deepEqual(syntheticReceipts, [paid.quoted.orderId]);
  assert.deepEqual(syntheticQueue, [{ email: accounts[0].email, id: paid.prepared.id, orderId: paid.quoted.orderId }],
    "Verified payment hands exactly this film to the production queue");
  assert.equal((await read(automaticProductionPath(paid.quoted.orderId))).value.state, "queued");
  assert.equal((await checkPayment(paid.quoted.orderId, paid.quoted.id)).status, "captured");
  assert.equal(syntheticQueue.length, 1, "Checking again does not queue the film twice");

  // 2. An unpaid invoice stays awaiting payment and never reaches production.
  const unpaid = await prepareAndQuote(1);
  const open = await pay(await checkoutBody(unpaid.quoted, "checkout-fixture-pay-1"));
  assert.equal(open.status, 200); assert.equal(open.body.status, "awaiting-payment"); assert.equal(syntheticQuickBooks.invoicePosts, 2);
  assert.equal((await checkPayment(unpaid.quoted.orderId, unpaid.quoted.id)).status, "awaiting-payment");
  assert.equal((await route(`/api/studio?action=receipt&id=${unpaid.quoted.orderId}`, { cookie: customer })).status, 409);
  assert.equal(syntheticQueue.length, 1);

  // 3. Short fal funding blocks the invoice before QuickBooks is asked; the
  // same checkout succeeds once funding covers every open production budget.
  const blocked = await prepareAndQuote(2);
  syntheticFalBalanceCents = 3 * expectedProviderCostCents - 1;
  const short = await pay(await checkoutBody(blocked.quoted, "checkout-fixture-pay-2"));
  assert.equal(short.status, 503); assert.equal(short.body.code, "PRODUCTION_FUNDING_UNAVAILABLE");
  assert.equal(syntheticQuickBooks.invoicePosts, 2, "No invoice is requested without funding");
  const held = await route(`/api/studio?action=order&id=${blocked.quoted.orderId}`, { cookie: customer });
  assert.equal(held.body.status, "uncertain"); assert.equal(held.body.checkoutBlock, "production-funding"); assert.equal(held.body.invoiceUrl, null);
  syntheticFalBalanceCents = 3 * expectedProviderCostCents;
  const funded = await pay(await checkoutBody(blocked.quoted, "checkout-fixture-pay-2"));
  assert.equal(funded.status, 200, JSON.stringify(funded.body)); assert.equal(funded.body.status, "awaiting-payment");
  assert.equal(syntheticQuickBooks.invoicePosts, 3);
  assert.equal((await read(FAL_FUNDING_PATH)).value.entries.length, 3);

  assert.equal(syntheticQueue.length, 1);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /synthetic-fal-key-local-only|synthetic-billing-key-local-only|"cvc"/,
    "Provider keys and card data are never stored");
  await checkEgressGuard();
  console.log("PASS: actual-handler QuickBooks-hosted invoice checkout against in-process fakes of QuickBooks, fal pricing, fal funding and the worker heartbeat: fixed $6.75 provider-quote price reaches the invoice unchanged; production consent required; stale worker and short funding block the invoice; one invoice per checkout key; CAPTCHA replay refused; GET-only order reads; verified capture, receipt and a single automatic production hand-off; unpaid invoices never produce; ownership; zero outbound calls, egress guard verified.");
}
function mediaRoute(path, { cookie, method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      const chunks = [];
      res.on("data", value => chunks.push(value));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}
async function checkDelivery() {
  const customer = await login(accounts[0]), other = await login(accounts[2]);
  const preparation = deliveryProject.productionPreparation, payment = deliveryProject.paymentReference;
  const statusUrl = `/api/studio?action=productionStatus&id=${preparation.id}`;
  const mediaUrl = `/api/studio?action=productionMedia&id=${preparation.id}`;
  const status = await route(statusUrl, { cookie: customer });
  assert.equal(status.status, 200); assert.equal(status.body.id, preparation.id);
  assert.equal(status.body.manifestHash, preparation.manifestHash);
  assert.equal(status.body.status, "completed"); assert.equal(status.body.mediaReady, true);
  assert.equal(status.body.completedShots, status.body.shotCount);
  assert.doesNotMatch(JSON.stringify(status.body), /production\/media|vercel-storage|providerJobId/);
  const order = await route(`/api/studio?action=order&id=${payment.orderId}`, { cookie: customer });
  assert.equal(order.status, 200); assert.equal(order.body.status, "captured");
  assert.equal(order.body.preparedId, preparation.id); assert.equal(order.body.quoteId, payment.quoteId);
  assert.equal(order.body.receiptAvailable, true); assert.equal(order.body.sandbox, false);
  assert.equal((await route(`/api/studio?action=receipt&id=${payment.orderId}`, { cookie: customer })).body.sandbox, false);
  assert.equal((await route(statusUrl, { cookie: other })).status, 404);
  const reads = deliveryBlobReads;
  assert.equal((await mediaRoute(mediaUrl)).status, 401);
  assert.equal((await mediaRoute(mediaUrl, { cookie: other })).status, 404);
  assert.equal(deliveryBlobReads, reads, "Unauthorized requests must never reach private media storage");
  const paymentPath = `payments/orders/${payment.orderId}.json`, confirmed = (await read(paymentPath)).value;
  assert.equal(confirmed.syntheticFixture.realPayment, false, "The live-shaped record is fabricated test data, not a real payment");
  for (const patch of [{ status: "awaiting-payment", capturedAt: null }, { status: "uncertain" }, { merchantBinding: simulatedBinding }]) {
    await write(paymentPath, { ...confirmed, ...patch }, (await read(paymentPath)).etag);
    const denied = await mediaRoute(`${mediaUrl}&download=1&paid=true&orderId=${payment.orderId}`, { cookie: customer });
    assert.equal(denied.status, 402); assert.equal(deliveryBlobReads, reads, "Unpaid, uncertain and sandbox payments cannot read generated media");
  }
  await write(paymentPath, confirmed, (await read(paymentPath)).etag);
  const partial = await mediaRoute(mediaUrl, { cookie: customer, headers: { Range: "bytes=0-63" } });
  assert.equal(partial.status, 206); assert.deepEqual(partial.bytes, deliveryMedia.bytes.subarray(0, 64));
  assert.equal(partial.headers["content-range"], `bytes 0-63/${deliveryMedia.bytes.length}`);
  assert.equal(partial.headers["content-length"], "64"); assert.equal(partial.headers["content-type"], "video/mp4");
  assert.equal(partial.headers["cache-control"], "private, no-store"); assert.equal(partial.headers.vary, "Cookie");
  const head = await mediaRoute(mediaUrl, { cookie: customer, method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  assert.equal(head.headers["content-length"], String(deliveryMedia.bytes.length));
  const invalid = await mediaRoute(mediaUrl, { cookie: customer, headers: { Range: "bytes=0-1,3-4" } });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers["content-range"], `bytes */${deliveryMedia.bytes.length}`);
  const download = await mediaRoute(`${mediaUrl}&download=1`, { cookie: customer });
  assert.equal(download.status, 200); assert.equal(auth.digest(download.bytes), deliveryMedia.sha256);
  assert.equal(download.headers["content-disposition"], `attachment; filename="${preparation.id}.mp4"`);
  assert.equal(syntheticQuickBooks.requests, 0); assert.equal(syntheticFalReads, 0);
  await checkEgressGuard();
  console.log("PASS: actual-handler completed status, synthetic confirmed live-format payment, unpaid/uncertain/sandbox denial, private MP4 playback/ranges, HEAD, verified download bytes, ownership denial, and zero outbound calls or charges. Media and payment are local fixtures, not new provider output or a real transaction.");
}
async function checkGenerationReview() {
  const owner = await login(accounts[1]), customer = await login(accounts[0]);
  const { productionPreparation: prepared, paymentReference: payment } = generationProject;
  const reviewUrl = `/api/studio?action=generationReview&id=${prepared.id}`;
  const libraryUrl = `/api/library?action=detail&kind=plan&id=${prepared.id}`;
  const mediaUrl = `/api/studio?action=productionMedia&id=${prepared.id}`;
  const capability = await route("/api/studio?action=capabilities", { cookie: owner });
  // Owner-started generation attempts are retired (requestFilmGeneration and
  // replaceFilmGeneration answer 410; paid films use automatic production), so
  // capabilities no longer advertise them to anyone. A saved attempt stays
  // readable and reviewable, which is what this fixture exercises.
  assert.equal(capability.status, 200);
  assert.equal(capability.body.generationAttempt, undefined); assert.equal(capability.body.production, false);
  assert.equal((await route("/api/studio?action=capabilities", { cookie: customer })).body.generationAttempt, undefined);
  for (const action of ["requestFilmGeneration", "replaceFilmGeneration"])
    assert.equal((await route("/api/studio", { cookie: owner, body: { action, preparedId: prepared.id, orderId: payment.orderId, consent: true } })).status, 410);
  assert.equal((await route(reviewUrl)).status, 401); assert.equal((await route(reviewUrl, { cookie: customer })).status, 403);
  const status = await route(`/api/studio?action=generationAttempt&id=${prepared.id}`, { cookie: owner });
  assert.equal(status.status, 200); assert.equal(status.body.status, "verifying"); assert.equal(status.body.orderId, payment.orderId);
  const before = await route(libraryUrl, { cookie: owner });
  assert.equal(before.status, 200); assert.equal(before.body.entry.production.mediaReady, false);
  // Since the paid-soundtrack/automatic-production work (merged 2026-10-19) the library
  // shows a prepared plan whose saved video awaits review as in progress.
  assert.equal(before.body.entry.production.status, "processing"); assert.ok(["creating", "finishing"].includes(before.body.entry.production.progress.stage));
  assert.equal(before.body.entry.payments[0].status, "captured"); assert.equal(before.body.entry.payments[0].sandbox, false);
  assert.equal((await mediaRoute(mediaUrl, { cookie: owner })).status, 409);
  const review = await route(reviewUrl, { cookie: owner });
  assert.equal(review.status, 200); assert.equal(review.body.status, "awaiting-review"); assert.equal(review.body.artifactSha256, deliveryMedia.sha256);
  assert.equal(review.body.previewUrl, `/api/studio?action=reviewVideo&id=${prepared.id}&artifact=${deliveryMedia.sha256}`);
  const preview = await mediaRoute(review.body.previewUrl, { cookie: owner, headers: { Range: "bytes=0-63" } });
  assert.equal(preview.status, 206); assert.deepEqual(preview.bytes, deliveryMedia.bytes.subarray(0, 64));
  assert.equal((await mediaRoute(review.body.previewUrl.replace(deliveryMedia.sha256, "f".repeat(64)), { cookie: owner })).status, 409);
  assert.equal((await mediaRoute(review.body.previewUrl, { cookie: customer })).status, 403);
  const approve = { action: "approveGeneration", preparedId: prepared.id, artifactSha256: deliveryMedia.sha256, consent: true };
  assert.equal((await route("/api/studio", { cookie: owner, body: { ...approve, consent: false } })).status, 400);
  assert.equal((await route("/api/studio", { cookie: customer, body: approve })).status, 403);
  const result = await route("/api/studio", { cookie: owner, body: approve });
  assert.equal(result.status, 200); assert.equal(result.body.status, "approved"); assert.equal(result.body.artifactSha256, deliveryMedia.sha256);
  const after = await route(libraryUrl, { cookie: owner });
  assert.equal(after.status, 200); assert.equal(after.body.entry.production.mediaReady, true); assert.equal(after.body.entry.production.status, "completed");
  assert.equal(after.body.entry.mediaUrl, mediaUrl); assert.equal(after.body.entry.downloadUrl, `${mediaUrl}&download=1`);
  const download = await mediaRoute(after.body.entry.downloadUrl, { cookie: owner });
  assert.equal(download.status, 200); assert.equal(auth.digest(download.bytes), deliveryMedia.sha256);
  assert.equal((await route(reviewUrl, { cookie: owner })).body.status, "approved");
  assert.equal((await route(libraryUrl, { cookie: customer })).status, 404);
  assert.equal(generationPaymentChecks, 1); assert.equal(syntheticQuickBooks.requests, 0); assert.equal(syntheticFalReads, 0);
  await checkEgressGuard();
  console.log("PASS: SYNTHETIC owner review fixture; exact artifact-bound private preview, approval gating, confirmed readback, finished library playback/download, foreign-account denial, and zero outbound calls or charges. Existing demonstration MP4 and simulated verification/payment metadata prove interface behavior only, not real generation or worker verification.");
}
if (checkOnly) {
  try { if (generationReviewFixture) await checkGenerationReview(); else if (deliveryFixture) await checkDelivery(); else if (checkoutFixtures) await checkCheckout(); else await check(); } finally { await close(); }
} else {
  console.log(`Synthetic ${generationReviewFixture ? "generated-film review fixture" : deliveryFixture ? "illustrative playback fixture" : "workflow test"} running at ${origin}. Fictional account helpers: ${origin}/__workflow . No production data or provider calls.`);
}
