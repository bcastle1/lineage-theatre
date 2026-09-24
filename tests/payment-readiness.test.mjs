import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createPaymentReadiness, paymentReviewPath, PAYMENT_REVIEW_AUDIENCE } from "../api/_lib/payment-readiness.mjs";
import { createPaymentsService } from "../api/_lib/payments.mjs";
import { createQuickBooksPaymentsTransport, encryptQuickBooksTokens, quickbooksConfig, QUICKBOOKS_CONNECTION_PATH, QUICKBOOKS_SCOPES } from "../api/_lib/quickbooks.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

// Every signer, grant, review and provider response in this file is fabricated
// in memory. Nothing here is a deployable approval or an actual transaction.
const NOW = Date.parse("2026-09-20T12:00:00.000Z"), REVISION = "c".repeat(40);
const OWNER = { email: OWNER_EMAIL, role: "owner", status: "active", passwordHash: "synthetic-password" };
const CUSTOMER = { email: "customer@example.invalid", role: "customer", status: "active", approvedAt: "2026-09-01T00:00:00.000Z", approvedBy: OWNER_EMAIL };
const ADMIN = { email: "admin@example.invalid", role: "admin", status: "active" };
const stamp = value => new Date(value).toISOString();
function fixture(environment = "sandbox") {
  let time = NOW, sequence = 0;
  const keys = generateKeyPairSync("ed25519"), records = new Map(), requests = [];
  const env = { QUICKBOOKS_ENVIRONMENT: environment, VERCEL_GIT_COMMIT_SHA: REVISION,
    QUICKBOOKS_CLIENT_ID: "synthetic-client", QUICKBOOKS_CLIENT_SECRET: "synthetic-secret",
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PAYMENT_REVIEW_TRUSTED_KEYS: JSON.stringify({ fixture: { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }), reviewer: "synthetic-reviewer", environments: [environment] } }) };
  const config = quickbooksConfig(env), realm = "123456789", attempt = "synthetic-authorization";
  const binding = { environment, grantId: digest(`${config.credentialVersion}:${realm}:${attempt}`) };
  const put = (path, value) => records.set(path, { value: structuredClone(value), etag: `revision-${++sequence}` });
  const read = async path => records.has(path) ? structuredClone(records.get(path)) : null;
  const write = async (path, value, etag) => {
    if (records.get(path)?.etag !== etag) throw new Error("Synthetic storage conflict");
    put(path, value); return read(path);
  };
  put(userPath(OWNER.email), OWNER); put(userPath(CUSTOMER.email), CUSTOMER);
  put(QUICKBOOKS_CONNECTION_PATH, { status: "authorized", revision: 1, fingerprint: config.fingerprint,
    credentialVersion: config.credentialVersion, connectedBy: OWNER_EMAIL, authorizationAttemptId: attempt,
    encryptedTokens: encryptQuickBooksTokens({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", realmId: realm,
      accessTokenExpiresAt: stamp(NOW + 3600_000), grantedScopes: [...QUICKBOOKS_SCOPES] }, config) });
  const readiness = createPaymentReadiness({ read, env, now: () => time });
  function value(kind = "operations", changes = {}) {
    const types = kind === "card-entry" ? environment === "production" ? ["card-entry-review", "pci-responsibilities"] : ["card-entry-review", "fictional-card-only"]
      : environment === "production" ? ["intuit-production-approval", "merchant-activation", "payments-scope", "sandbox-lifecycle", "commercial-terms"]
        : ["sandbox-company", "payments-scope", "owner-test-authorization"];
    return { version: 1, audience: PAYMENT_REVIEW_AUDIENCE, kind, ...binding, applicationRevision: REVISION,
      reviewer: "synthetic-reviewer", reviewedAt: stamp(NOW), expiresAt: stamp(NOW + 3600_000),
      operations: kind === "card-entry" ? ["card-entry"] : ["quote", "charge", "refund", "read", "render", "refresh"],
      subjectEmail: environment === "sandbox" ? OWNER_EMAIL : null, fictionalOnly: environment === "sandbox",
      evidence: types.map(type => ({ type, reference: `synthetic-memory:${type}`, sha256: digest(`fabricated-${type}`), observedAt: stamp(NOW - 1000) })), ...changes };
  }
  function save(kind = "operations", changes = {}, privateKey = keys.privateKey) {
    const payload = Buffer.from(JSON.stringify(value(kind, changes)));
    const envelope = { keyId: "fixture", payload: payload.toString("base64url"), signature: sign(null, payload, privateKey).toString("base64url") };
    put(paymentReviewPath(environment, kind), envelope); return envelope;
  }
  const transport = createQuickBooksPaymentsTransport({ read, env, now: () => time,
    authorizeProduction: readiness.authorizeTransport, authorizeSandbox: readiness.authorizeTransport,
    fetchImpl: async (...args) => { requests.push(args); return new Response("{}", { status: 200 }); } });
  const provider = { binding: options => transport.binding(options) };
  const payments = createPaymentsService({ read, now: () => time, provider, readiness: readiness.readiness });
  return { env, binding, records, requests, put, read, write, readiness, transport, payments, save, value, keys, advance: ms => { time += ms; } };
}

test("credentials, trust key, booleans and unsigned documents cannot enable either payment environment", async () => {
  for (const environment of ["sandbox", "production"]) {
    const h = fixture(environment), path = paymentReviewPath(environment, "operations");
    assert.deepEqual(await h.readiness.readiness({ actor: OWNER }), {});
    h.put(path, { ...h.value(), sandboxEnabled: true, merchantVerified: true });
    assert.deepEqual(await h.readiness.readiness({ actor: OWNER }), {});
    assert.equal(await h.readiness.authorizeTransport({ binding: h.binding, operation: "charge" }), null);
    assert.deepEqual(await h.payments.checkoutConfiguration(OWNER), { available: false });
    assert.equal(h.requests.length, 0);
  }
});

test("signed sandbox reviews allow only the designated current owner, including worker subjects", async () => {
  const h = fixture(); h.save(); h.save("card-entry");
  assert.equal((await h.readiness.readiness({ actor: OWNER })).authorization.environment, "sandbox");
  assert.equal((await h.readiness.readiness({ subjectEmail: OWNER_EMAIL, operation: "render" })).authorization.operations[0], "render");
  for (const actor of [CUSTOMER, { ...CUSTOMER, role: "owner" }]) {
    assert.deepEqual(await h.readiness.readiness({ actor }), {});
    assert.deepEqual(await h.payments.checkoutConfiguration(actor), { available: false });
  }
  assert.deepEqual(await h.readiness.readiness({ actor: { email: "missing@example.invalid", role: "owner" } }), {});
  assert.deepEqual(await h.readiness.readiness({ subjectEmail: CUSTOMER.email, operation: "render" }), {});
  assert.equal((await h.payments.checkoutConfiguration(OWNER)).environment, "sandbox");
  h.put(userPath(OWNER_EMAIL), { ...OWNER, status: "suspended" });
  assert.deepEqual(await h.readiness.readiness({ actor: OWNER }), {});
  await assert.rejects(h.transport.binding()); assert.equal(h.requests.length, 0);
});

test("signed readiness uses persisted legacy owner approval and still requires current reviews and account access", async () => {
  const legacy = { email: OWNER_EMAIL, role: "owner" };
  for (const environment of ["sandbox", "production"]) {
    const h = fixture(environment);
    h.put(userPath(OWNER_EMAIL), legacy);
    assert.deepEqual(await h.readiness.readiness({ actor: legacy }), {});
    h.save(); h.save("card-entry");
    assert.equal((await h.readiness.readiness({ actor: legacy })).authorization.environment, environment);
    assert.equal((await h.readiness.readiness({ subjectEmail: OWNER_EMAIL, operation: "render" })).authorization.environment, environment);
    assert.equal((await h.payments.checkoutConfiguration(legacy)).environment, environment);
    for (const account of [{ email: OWNER_EMAIL }, { ...legacy, role: "customer" },
      { ...legacy, status: "suspended" }, { ...legacy, mustChangePassword: true }]) {
      h.put(userPath(OWNER_EMAIL), account);
      assert.deepEqual(await h.readiness.readiness({ actor: legacy }), {});
      assert.deepEqual(await h.readiness.readiness({ subjectEmail: OWNER_EMAIL, operation: "render" }), {});
    }
    assert.equal(h.requests.length, 0);
  }
});

test("card entry needs its own review in addition to payment operations, on the same grant", async () => {
  const h = fixture("production"); h.save();
  assert.equal((await h.readiness.readiness({ actor: CUSTOMER, operation: "charge" })).authorization.environment, "production");
  assert.deepEqual(await h.payments.checkoutConfiguration(CUSTOMER), { available: false });
  h.save("card-entry", { grantId: "f".repeat(64) });
  assert.deepEqual(await h.payments.checkoutConfiguration(CUSTOMER), { available: false });
  h.save("card-entry");
  assert.deepEqual(await h.payments.checkoutConfiguration(CUSTOMER), { available: true, environment: "production",
    tokenization: { method: "intuit-browser-direct", url: "https://api.intuit.com/quickbooks/v4/payments/tokens" } });
  h.records.delete(paymentReviewPath("production", "operations"));
  assert.deepEqual(await h.payments.checkoutConfiguration(CUSTOMER), { available: false });
  assert.equal(h.requests.length, 0);
});

test("owner-only production checks the persisted account for every operation and worker subject", async () => {
  const h = fixture("production"); h.env.LINEAGE_PAYMENT_ACCESS = "owner"; h.save(); h.save("card-entry");
  h.put(userPath(ADMIN.email), ADMIN);
  const legacyOwner = { email: OWNER_EMAIL, role: "owner" };
  h.put(userPath(OWNER_EMAIL), legacyOwner);
  const operations = ["quote", "charge", "refund", "read", "render", "refresh", "card-entry"];
  for (const operation of operations) {
    assert.equal((await h.readiness.readiness({ actor: legacyOwner, operation })).authorization.environment, "production", operation);
    for (const actor of [CUSTOMER, ADMIN, { ...CUSTOMER, role: "owner" }, { email: "missing@example.invalid", role: "owner" }]) {
      assert.deepEqual(await h.readiness.readiness({ actor, operation }), {}, `${actor.email}: ${operation}`);
    }
    for (const subjectEmail of [CUSTOMER.email, ADMIN.email]) {
      assert.deepEqual(await h.readiness.readiness({ subjectEmail, operation }), {}, `${subjectEmail}: ${operation}`);
    }
  }
  assert.equal((await h.readiness.readiness({ subjectEmail: OWNER_EMAIL, operation: "render" })).authorization.environment, "production");
  assert.equal((await h.payments.checkoutConfiguration(legacyOwner)).available, true);
  assert.equal((await h.payments.prepareCheckout(legacyOwner)).available, true);
  for (const actor of [CUSTOMER, ADMIN]) {
    assert.deepEqual(await h.payments.checkoutConfiguration(actor), { available: false });
    assert.deepEqual(await h.payments.prepareCheckout(actor), { available: false });
  }
  for (const current of [null, { email: OWNER_EMAIL }, { ...legacyOwner, role: "admin" },
    { ...legacyOwner, status: "suspended" }, { ...legacyOwner, mustChangePassword: true }]) {
    if (current) h.put(userPath(OWNER_EMAIL), current); else h.records.delete(userPath(OWNER_EMAIL));
    for (const operation of operations) {
      assert.deepEqual(await h.readiness.readiness({ actor: legacyOwner, operation }), {}, `${JSON.stringify(current)}: ${operation}`);
    }
    assert.deepEqual(await h.readiness.readiness({ subjectEmail: OWNER_EMAIL, operation: "render" }), {});
    assert.deepEqual(await h.payments.prepareCheckout(legacyOwner), { available: false });
  }
  h.put(userPath(OWNER_EMAIL), legacyOwner);
  h.records.delete(paymentReviewPath("production", "operations"));
  assert.deepEqual(await h.readiness.readiness({ actor: legacyOwner }), {});
  assert.deepEqual(await h.payments.checkoutConfiguration(legacyOwner), { available: false });
  assert.deepEqual(await h.payments.prepareCheckout(legacyOwner), { available: false });
  assert.equal(h.requests.length, 0);
});

test("approved access remains the production default, and invalid supplied modes cannot broaden access", async () => {
  const h = fixture("production"); h.save(); h.save("card-entry"); h.put(userPath(ADMIN.email), ADMIN);
  for (const mode of [undefined, "approved"]) {
    if (mode === undefined) delete h.env.LINEAGE_PAYMENT_ACCESS; else h.env.LINEAGE_PAYMENT_ACCESS = mode;
    for (const actor of [CUSTOMER, ADMIN, OWNER]) {
      assert.equal((await h.readiness.readiness({ actor, operation: "charge" })).authorization.environment, "production");
      assert.equal((await h.payments.checkoutConfiguration(actor)).available, true);
      assert.equal((await h.payments.prepareCheckout(actor)).available, true);
    }
    assert.equal((await h.readiness.readiness({ subjectEmail: CUSTOMER.email, operation: "render" })).authorization.environment, "production");
  }
  for (const mode of ["", "Owner", "owner ", "everyone"]) {
    h.env.LINEAGE_PAYMENT_ACCESS = mode;
    assert.deepEqual(await h.readiness.readiness({ actor: OWNER }), {}, mode);
    assert.deepEqual(await h.payments.checkoutConfiguration(OWNER), { available: false }, mode);
    assert.deepEqual(await h.payments.prepareCheckout(OWNER), { available: false }, mode);
    assert.equal(await h.readiness.authorizeTransport({ binding: h.binding, operation: "charge" }), null, mode);
  }
  const sandbox = fixture(); sandbox.save(); sandbox.env.LINEAGE_PAYMENT_ACCESS = "approved";
  assert.deepEqual(await sandbox.readiness.readiness({ actor: CUSTOMER }), {});
  assert.equal((await sandbox.readiness.readiness({ actor: OWNER })).authorization.environment, "sandbox");
  assert.equal(h.requests.length, 0);
});

test("owner mode gates service provider actions while preserving stored outcomes and owner recovery", async () => {
  const h = fixture("production"), calls = [];
  h.save(); h.save("card-entry"); h.put(userPath(ADMIN.email), ADMIN);
  const provider = { binding: options => h.transport.binding(options),
    charge: async (_binding, input) => { calls.push("charge"); return { verified: true, id: `synthetic-charge-${calls.length}`, status: "CAPTURED", amountCents: input.amountCents, currency: "USD" }; },
    refund: async (_binding, input) => { calls.push("refund"); return { verified: true, id: "synthetic-refund", status: "ISSUED", amountCents: input.amountCents, currency: "USD" }; },
    readCharge: async () => { calls.push("readCharge"); throw new Error("Unexpected synthetic read"); },
    readRefund: async () => { calls.push("readRefund"); throw new Error("Unexpected synthetic read"); } };
  const service = createPaymentsService({ read: h.read, write: h.write, now: () => NOW, provider, readiness: h.readiness.readiness,
    pricingSettings: async () => ({ markupBasisPoints: 5000, revision: 0 }),
    quoteProvider: async project => { calls.push("quote"); return { preparedId: "synthetic-prepared-film", filmId: project.id, filmTitle: "Synthetic fixture",
      manifestHash: digest(project.id), quoteReference: "synthetic-quote", environment: "production", currency: "USD", providerCostCents: 100,
      expiresAt: stamp(NOW + 300_000), apiVerified: true, qualityVerified: true, commercialTermsVerified: true }; } });
  const quoteBody = id => ({ project: { id }, idempotencyKey: `synthetic-quote-key-${id}` });
  const checkoutBody = quote => ({ quoteId: quote.id, idempotencyKey: `synthetic-checkout-${quote.id}`, paymentToken: "synthetic-token", consent: true });
  const customerQuote = await service.quote(CUSTOMER, quoteBody("prior-customer"));
  const priorOrder = await service.checkout(CUSTOMER, checkoutBody(customerQuote));
  const pendingQuote = await service.quote(CUSTOMER, quoteBody("pending-customer"));
  assert.equal(priorOrder.status, "captured");
  h.env.LINEAGE_PAYMENT_ACCESS = "owner"; calls.length = 0;
  const snapshot = structuredClone([...h.records]);
  const unavailable = error => error.status === 503 && error.code === "PRODUCTION_UNAVAILABLE";
  for (const actor of [CUSTOMER, ADMIN, { ...CUSTOMER, role: "owner" }]) {
    await assert.rejects(service.quote(actor, quoteBody("restricted-customer")), unavailable);
    assert.deepEqual(await service.checkoutConfiguration(actor), { available: false });
    assert.deepEqual(await service.prepareCheckout(actor), { available: false });
  }
  await assert.rejects(service.checkout(CUSTOMER, checkoutBody(pendingQuote)), unavailable);
  await assert.rejects(service.reconcile(ADMIN, { orderId: priorOrder.id }), unavailable);
  const refundBody = { orderId: priorOrder.id, amountCents: priorOrder.amountCents, reason: "Synthetic recovery", idempotencyKey: "synthetic-refund-key" };
  await assert.rejects(service.refund(ADMIN, refundBody), unavailable);
  await assert.rejects(service.authorizeProduction({ email: CUSTOMER.email, orderId: priorOrder.id,
    manifestHash: customerQuote.manifestHash, preparedId: customerQuote.preparedId }), unavailable);
  assert.deepEqual(calls, []); assert.deepEqual([...h.records], snapshot);
  assert.equal((await service.order(CUSTOMER, priorOrder.id)).status, "captured");
  assert.equal((await service.receipt(CUSTOMER, priorOrder.id)).amountCents, 150);
  assert.equal((await service.adminDiagnostics(ADMIN, priorOrder.id)).orderId, priorOrder.id);
  assert.equal((await service.accountingExport(ADMIN, priorOrder.id)).orderId, priorOrder.id);
  await assert.rejects(service.order({ ...CUSTOMER, email: "other@example.invalid" }, priorOrder.id), error => error.status === 404);
  assert.equal((await service.checkoutConfiguration(OWNER)).available, true);
  assert.equal((await service.prepareCheckout(OWNER)).available, true);
  const ownerQuote = await service.quote(OWNER, quoteBody("owner-film"));
  const ownerBody = checkoutBody(ownerQuote), ownerOrder = await service.checkout(OWNER, ownerBody);
  assert.equal(ownerOrder.status, "captured"); assert.equal(ownerOrder.amountCents, 150); assert.equal(ownerOrder.sandbox, false);
  assert.deepEqual(await service.checkout(OWNER, ownerBody), ownerOrder);
  assert.equal((await service.authorizeProduction({ email: OWNER.email, orderId: ownerOrder.id,
    manifestHash: ownerQuote.manifestHash, preparedId: ownerQuote.preparedId })).allowed, true);
  assert.equal((await service.reconcile(OWNER, { orderId: priorOrder.id })).status, "captured");
  assert.equal((await service.refund(OWNER, refundBody)).status, "refunded");
  // Replaying an issued refund only reads its saved outcome, even for another admin.
  assert.equal((await service.refund(ADMIN, refundBody)).status, "refunded");
  assert.deepEqual(calls, ["quote", "charge", "refund"]); assert.equal(h.requests.length, 0);
});

test("review signature, reviewer trust, audience, deployment, grant, operation and lifetime all fail closed", async () => {
  const changes = [ { audience: "https://example.invalid" }, { applicationRevision: "d".repeat(40) },
    { reviewer: "someone-else" }, { reviewedAt: stamp(NOW + 1) }, { expiresAt: stamp(NOW) },
    { expiresAt: stamp(NOW - 1) }, { operations: ["charge", "arbitrary"] },
    { subjectEmail: CUSTOMER.email }, { fictionalOnly: false }, { evidence: [] },
    { unrecognizedClaim: true } ];
  for (const change of changes) {
    const h = fixture(); h.save("operations", change);
    assert.deepEqual(await h.readiness.readiness({ actor: OWNER, operation: "charge" }), {}, JSON.stringify(change));
  }
  const h = fixture(); h.save("operations", {}, generateKeyPairSync("ed25519").privateKey);
  assert.deepEqual(await h.readiness.readiness({ actor: OWNER }), {});
  const envelope = h.save(); envelope.payload = Buffer.from(JSON.stringify(h.value("operations", { grantId: "f".repeat(64) }))).toString("base64url");
  h.put(paymentReviewPath("sandbox", "operations"), envelope);
  assert.deepEqual(await h.readiness.readiness({ actor: OWNER }), {});
  h.save();
  assert.equal(await h.readiness.authorizeTransport({ binding: { ...h.binding, grantId: "f".repeat(64) }, operation: "charge" }), null);
  h.save("operations", { operations: ["read"] });
  assert.equal(await h.readiness.authorizeTransport({ binding: h.binding, operation: "charge" }), null);
  assert.ok(await h.readiness.authorizeTransport({ binding: h.binding, operation: "read" }));
  h.advance(3600_000); assert.equal(await h.readiness.authorizeTransport({ binding: h.binding, operation: "read" }), null);
});

test("reviewer-selected evidence lifetimes mint fresh five-minute authorizations without extending either review", async () => {
  const h = fixture("production"), selectedExpiry = NOW + 7 * 24 * 3600_000;
  h.save("operations", { expiresAt: stamp(selectedExpiry) });
  h.save("card-entry", { expiresAt: stamp(selectedExpiry - 60_000) });
  h.advance(2 * 24 * 3600_000);
  const current = NOW + 2 * 24 * 3600_000;
  const ready = await h.readiness.readiness({ actor: CUSTOMER, operation: "card-entry" });
  assert.equal(ready.authorization.validatedAt, stamp(current));
  assert.equal(ready.authorization.expiresAt, stamp(current + 5 * 60_000));
  h.advance(5 * 24 * 3600_000 - 120_000);
  const bounded = await h.readiness.readiness({ actor: CUSTOMER, operation: "card-entry" });
  assert.equal(bounded.authorization.validatedAt, stamp(selectedExpiry - 120_000));
  assert.equal(bounded.authorization.expiresAt, stamp(selectedExpiry - 60_000));
  h.advance(60_000);
  assert.deepEqual(await h.readiness.readiness({ actor: CUSTOMER, operation: "card-entry" }), {});
  // Operations have their own remaining review validity; entry expiration does
  // not renew it, and removing the signed record revokes new authorizations.
  assert.equal((await h.readiness.readiness({ actor: CUSTOMER, operation: "read" })).authorization.expiresAt, stamp(selectedExpiry));
  h.records.delete(paymentReviewPath("production", "operations"));
  assert.deepEqual(await h.readiness.readiness({ actor: CUSTOMER, operation: "read" }), {});
});

test("a sandbox-only trust key cannot sign a production review; absent required evidence is rejected", async () => {
  const h = fixture("production");
  for (const type of h.value().evidence.map(item => item.type)) {
    h.save("operations", { evidence: h.value().evidence.filter(item => item.type !== type) });
    assert.deepEqual(await h.readiness.readiness({ actor: CUSTOMER }), {}, type);
  }
  h.save();
  const keys = JSON.parse(h.env.PAYMENT_REVIEW_TRUSTED_KEYS); keys.fixture.environments = ["sandbox"];
  h.env.PAYMENT_REVIEW_TRUSTED_KEYS = JSON.stringify(keys);
  assert.deepEqual(await h.readiness.readiness({ actor: CUSTOMER }), {});
});

test("real transport rechecks signed evidence and encrypted grant immediately before any provider request", async () => {
  for (const environment of ["sandbox", "production"]) {
    const h = fixture(environment); h.save();
    const binding = await h.transport.binding();
    h.records.delete(paymentReviewPath(environment, "operations"));
    const operation = { method: "GET", path: "/charges/synthetic-charge", requestId: "synthetic-request-123456" };
    await assert.rejects(h.transport.request(binding, operation)); assert.equal(h.requests.length, 0);
    h.save();
    h.put(QUICKBOOKS_CONNECTION_PATH, { ...h.records.get(QUICKBOOKS_CONNECTION_PATH).value, authorizationAttemptId: "replacement" });
    await assert.rejects(h.transport.request(binding, operation)); assert.equal(h.requests.length, 0);
  }
});

test("server verifier handles unavailable storage and malformed trust configuration without exposing evidence", async () => {
  const h = fixture(); h.save();
  h.env.PAYMENT_REVIEW_TRUSTED_KEYS = "not-json";
  assert.deepEqual(await h.readiness.readiness({ actor: OWNER }), {});
  const broken = createPaymentReadiness({ env: { ...h.env, PAYMENT_REVIEW_TRUSTED_KEYS: "{}" }, read: async () => { throw new Error("private diagnostic"); } });
  assert.deepEqual(await broken.readiness({ actor: OWNER }), {});
  assert.equal(await broken.authorizeTransport({ binding: h.binding, operation: "charge" }), null);
});
