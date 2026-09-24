import test from "node:test";
import assert from "node:assert/strict";
import { createReceiptDeliveryService, RECEIPT_SETTINGS_PATH, DEFAULT_MERCHANT_RECEIPT_EMAIL } from "../api/_lib/receipt-delivery.mjs";
import { createAdminHandler } from "../api/admin.mjs";
import { digest } from "../api/_lib/auth.mjs";

const at = Date.parse("2026-09-24T02:00:00.000Z");
const admin = { email: "admin@example.invalid", role: "admin", status: "active" };
const order = (changes = {}) => ({ id: "a".repeat(64), version: 1, provider: "quickbooks", checkoutMethod: "quickbooks-hosted-invoice",
  status: "captured", customerEmail: "customer@example.invalid", customerId: "31", invoiceId: "45", invoiceNumber: "INV-45",
  currency: "USD", amountCents: 330, balanceCents: 0, merchantBinding: { environment: "production", realmId: "123", grantId: "b".repeat(64) },
  confirmationSource: "quickbooks-accounting", capturedAt: new Date(at).toISOString(), accountingCheckedAt: new Date(at).toISOString(),
  paymentIds: ["19"], accountingPayments: [{ id: "19", allocatedCents: 330, transactionDate: "2026-09-23" }],
  filmTitle: "PRIVATE FAMILY DETAILS", sourceContent: "PRIVATE SOURCE", cardNumber: "NEVER SEND", ...changes });
const orderPath = id => `payments/orders/${id}.json`;
const claimPath = (id, email) => `payments/receipt-deliveries/${id}/${digest(email)}.json`;
const code = (status, value) => error => error.status === status && error.code === value;

function harness(hooks = {}) {
  const records = new Map(), writes = [], sent = [], prepared = [];
  let serial = 0, configured = hooks.configured !== false;
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `etag-${++serial}` });
  const read = async path => { await hooks.beforeRead?.(path); return records.has(path) ? structuredClone(records.get(path)) : null; };
  const write = async (path, value, etag) => {
    await hooks.beforeWrite?.(path, value, etag);
    const old = records.get(path);
    if (old ? old.etag !== etag : etag !== undefined) throw new Error("Conditional write failed");
    seed(path, value); writes.push({ path, value: structuredClone(value), etag });
    await hooks.afterWrite?.(path, value);
    return { etag: records.get(path).etag };
  };
  const mail = { available: () => configured, prepare: async input => {
    prepared.push(structuredClone(input)); await hooks.prepare?.(input);
    return async () => { sent.push(structuredClone(input)); return hooks.send ? hooks.send(input) : { accepted: true, deliveryVerified: false }; };
  } };
  seed(orderPath(order().id), order());
  const service = createReceiptDeliveryService({ read, write, mail, now: () => at });
  return { records, writes, sent, prepared, seed, read, write, service, configure: value => { configured = value; } };
}

test("receipt settings default to info and honestly expose missing mail without delivering", async () => {
  const h = harness({ configured: false }), settings = await h.service.settings(admin);
  assert.equal(settings.merchantReceiptEmail, "info@brocotech.ai");
  assert.equal(settings.revision, 0); assert.equal(settings.mailConfigured, false);
  assert.match(settings.mailStatus, /not set up/);
  assert.equal((await h.service.deliver(order())).status, "configuration-required");
  assert.equal(h.writes.length, 0); assert.equal(h.prepared.length, 0); assert.equal(h.sent.length, 0);
  const saved = await h.service.saveSettings(admin, { expectedRevision: 0, merchantReceiptEmail: " Finance@Example.invalid " });
  assert.equal(saved.merchantReceiptEmail, "finance@example.invalid"); assert.equal(saved.mailConfigured, false);
  h.configure(true); await h.service.deliver(order());
  assert.deepEqual(h.sent.map(item => item.to), [order().customerEmail, "finance@example.invalid"]);
});

test("approved administrators can save and read back recipient revisions; stale updates conflict", async () => {
  const h = harness(), first = await h.service.saveSettings(admin, { expectedRevision: 0, merchantReceiptEmail: "receipts@example.invalid" });
  assert.equal(first.revision, 1); assert.equal(first.updatedBy, admin.email);
  assert.deepEqual(await h.service.settings(admin), first);
  const prior = await h.read(RECEIPT_SETTINGS_PATH);
  const second = await h.service.saveSettings(admin, { expectedRevision: 1, merchantReceiptEmail: DEFAULT_MERCHANT_RECEIPT_EMAIL });
  assert.equal(second.revision, 2);
  assert.equal(h.writes.at(-1).etag, prior.etag);
  await assert.rejects(h.service.saveSettings(admin, { expectedRevision: 0, merchantReceiptEmail: "stale@example.invalid" }), code(409, "RECEIPT_SETTINGS_CONFLICT"));
  assert.equal((await h.service.settings(admin)).merchantReceiptEmail, DEFAULT_MERCHANT_RECEIPT_EMAIL);
});

test("receipt settings deny customers, suspended admins and password-setup sessions", async () => {
  const h = harness();
  for (const actor of [null, { ...admin, role: "customer" }, { ...admin, status: "suspended" }, { ...admin, mustChangePassword: true }]) {
    await assert.rejects(h.service.settings(actor), code(403, "RECEIPT_FORBIDDEN"));
    await assert.rejects(h.service.saveSettings(actor, { expectedRevision: 0, merchantReceiptEmail: "recipient@example.invalid" }), code(403, "RECEIPT_FORBIDDEN"));
  }
  for (const input of [null, { expectedRevision: 0, merchantReceiptEmail: "a@example.invalid,b@example.invalid" },
    { expectedRevision: 0, merchantReceiptEmail: "a@example.invalid\r\nBcc:b@example.invalid" },
    { expectedRevision: 0, merchantReceiptEmail: "a@example.invalid", template: "arbitrary message" }]) {
    await assert.rejects(h.service.saveSettings(admin, input), code(400, "RECEIPT_SETTINGS_INVALID"));
  }
  assert.equal(h.writes.length, 0);
});

test("concurrent receipt settings use conditional writes and do not overwrite the winning administrator", async () => {
  const h = harness();
  const results = await Promise.allSettled(["one@example.invalid", "two@example.invalid"].map(merchantReceiptEmail => h.service.saveSettings(admin, { expectedRevision: 0, merchantReceiptEmail })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected")[0].reason.status, 409);
  assert.equal((await h.service.settings(admin)).revision, 1);
  assert.equal(h.writes.length, 1);
});

test("persisted confirmed payment sends exactly one separate minimal receipt per customer and merchant", async () => {
  const h = harness();
  const result = await h.service.deliver({ ...order(), customerEmail: "forged@example.invalid", amountCents: 1 });
  assert.equal(result.status, "accepted"); assert.equal(result.deliveryVerified, false);
  assert.deepEqual(h.sent.map(item => item.to), [order().customerEmail, DEFAULT_MERCHANT_RECEIPT_EMAIL]);
  for (const item of h.sent) {
    assert.equal(item.receipt.amountCents, 330); assert.equal(item.receipt.invoiceNumber, "INV-45");
    assert.deepEqual(item.receipt.paymentDates, ["2026-09-23"]);
    assert.doesNotMatch(JSON.stringify(item.receipt), /PRIVATE|NEVER SEND|customerEmail|merchantReceiptEmail|token|secret/i);
    const record = h.records.get(claimPath(order().id, item.to)).value;
    assert.equal(record.status, "accepted"); assert.equal(record.deliveryVerified, false); assert.ok(record.attemptedAt); assert.ok(record.acceptedAt);
  }
  await h.service.deliver(order());
  assert.equal(h.sent.length, 2); assert.equal(h.prepared.length, 2);
});

test("unconfirmed, sandbox, unallocated, duplicated and forged records never send a receipt", async () => {
  for (const change of [{ status: "uncertain" }, { status: "awaiting-payment" }, { sandbox: true },
    { merchantBinding: { ...order().merchantBinding, environment: "sandbox" } }, { confirmationSource: "browser" },
    { accountingPayments: [] }, { accountingPayments: [{ id: "19", allocatedCents: 329 }] },
    { accountingPayments: [{ id: "19", allocatedCents: 165 }, { id: "19", allocatedCents: 165 }], paymentIds: ["19", "19"] },
    { paymentIds: ["20"] }, { balanceCents: 330 }, { accountingCheckedAt: null }, { currency: "EUR" }, { capturedAt: null },
    { customerEmail: "victim@example.invalid\nBcc:bad@example.invalid" }, { checkoutMethod: "other-provider" }]) {
    const h = harness(); h.seed(orderPath(order().id), order(change));
    assert.equal((await h.service.deliver(order())).status, "skipped", JSON.stringify(change));
    assert.equal(h.sent.length, 0); assert.equal(h.writes.length, 0);
  }
  const h = harness();
  assert.equal((await h.service.deliver({ id: "f".repeat(64), status: "captured" })).status, "skipped");
});

test("concurrent checks and background runs cannot duplicate either receipt", async () => {
  const h = harness();
  await Promise.all(Array.from({ length: 8 }, () => h.service.deliver(order())));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent.filter(item => item.to === order().customerEmail).length, 1);
  assert.equal(h.sent.filter(item => item.to === DEFAULT_MERCHANT_RECEIPT_EMAIL).length, 1);
  assert.equal(h.writes.filter(item => item.value.status === "attempted").length, 2);
});

test("send timeout and non-acceptance remain uncertain and never retry automatically", async () => {
  for (const send of [async () => { throw new Error("private provider details"); }, async () => ({ accepted: false })]) {
    const h = harness({ send }), result = await h.service.deliver(order());
    assert.equal(result.status, "pending-review");
    assert.ok(result.recipients.every(item => item.status === "uncertain"));
    await h.service.deliver(order());
    assert.equal(h.sent.length, 2); assert.equal(h.prepared.length, 2);
    assert.doesNotMatch(JSON.stringify([...h.records.values()]), /private provider details/);
  }
});

test("lost claim-write response never sends and the durable attempted claim prevents later sends", async () => {
  const h = harness({ afterWrite: async (_path, value) => { if (value.status === "attempted") throw new Error("lost response"); } });
  const result = await h.service.deliver(order());
  assert.ok(result.recipients.every(item => item.status === "attempted"));
  assert.equal(h.sent.length, 0);
  await h.service.deliver(order()); assert.equal(h.sent.length, 0);
});

test("lost final save cannot cause automatic retry after mail was accepted", async () => {
  const h = harness({ beforeWrite: async (_path, value) => { if (value.status === "accepted") throw new Error("storage unavailable"); } });
  const result = await h.service.deliver(order());
  assert.ok(result.recipients.every(item => item.status === "attempted"));
  assert.equal(h.sent.length, 2);
  await h.service.deliver(order()); assert.equal(h.sent.length, 2);
});

test("pre-send authentication failure can recover without changing the queued merchant recipient", async () => {
  let failMerchant = true;
  const h = harness({ prepare: async input => { if (input.to === DEFAULT_MERCHANT_RECEIPT_EMAIL && failMerchant) throw new Error("auth unavailable"); } });
  const first = await h.service.deliver(order());
  assert.deepEqual(first.recipients.map(item => item.status), ["accepted", "pending"]);
  await h.service.saveSettings(admin, { expectedRevision: 0, merchantReceiptEmail: "new@example.invalid" });
  failMerchant = false; await h.service.deliver(order());
  assert.deepEqual(h.sent.map(item => item.to), [order().customerEmail, DEFAULT_MERCHANT_RECEIPT_EMAIL]);
  const next = order({ id: "c".repeat(64), invoiceId: "46" }); h.seed(orderPath(next.id), next); await h.service.deliver(next);
  assert.deepEqual(h.sent.slice(2).map(item => item.to), [order().customerEmail, "new@example.invalid"]);
});

test("a customer who is also the merchant recipient receives only one email", async () => {
  const h = harness();
  await h.service.saveSettings(admin, { expectedRevision: 0, merchantReceiptEmail: order().customerEmail });
  const result = await h.service.deliver(order());
  assert.equal(h.sent.length, 1); assert.deepEqual(result.recipients[0].roles, ["customer", "merchant"]);
});

test("payment regression during mail authentication prevents a receipt send", async () => {
  let h;
  h = harness({ prepare: async () => { h.seed(orderPath(order().id), order({ status: "uncertain" })); } });
  const result = await h.service.deliver(order());
  assert.ok(result.recipients.every(item => item.status === "payment-changed"));
  assert.equal(h.sent.length, 0);
});

test("admin routes expose current setup, accept administrator edits and record an audit event", async () => {
  const h = harness({ configured: false }), events = [];
  const handler = createAdminHandler({ getSession: async () => ({ user: admin }), receiptDelivery: h.service,
    limitAction: async () => true, audit: async (...args) => events.push(args) });
  const run = async (method, body, origin = "https://lineagetheater.com") => {
    let status, result;
    await handler({ method, url: "/api/admin?action=receiptSettings", headers: { host: "lineagetheater.com", origin }, ...(body ? { body } : {}) },
      { set statusCode(value) { status = value; }, setHeader() {}, end(value) { result = JSON.parse(value); } });
    return { status, body: result };
  };
  assert.equal((await run("GET")).body.merchantReceiptEmail, DEFAULT_MERCHANT_RECEIPT_EMAIL);
  const input = { action: "saveReceiptSettings", expectedRevision: 0, merchantReceiptEmail: "merchant@example.invalid" };
  assert.equal((await run("POST", input, "https://other.example.invalid")).status, 403);
  const saved = await run("POST", input); assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
  assert.deepEqual(events, [[admin.email, "payment.receipts.updated", "merchant-receipt-email", { revision: 1, merchantReceiptEmail: "merchant@example.invalid" }]]);
  assert.equal((await run("POST", input)).status, 409);
  assert.equal((await run("POST", { ...input, expectedRevision: 1, merchantReceiptEmail: "invalid" })).status, 400);
  assert.equal((await run("GET")).body.mailConfigured, false);
  assert.equal(h.sent.length, 0);
});
