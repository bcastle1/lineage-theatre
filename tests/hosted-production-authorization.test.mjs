import test from "node:test";
import assert from "node:assert/strict";
import { createHostedCheckoutService, HOSTED_CHECKOUT_SETTINGS_PATH } from "../api/_lib/hosted-checkout.mjs";
import { createPaymentsService } from "../api/_lib/payments.mjs";
import { createFilmProductionService, fictionalOperatorProject, productionJobPath } from "../api/_lib/film-production.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { productionQueuePath } from "../api/_lib/production-queue.mjs";
import { createProductionWorker } from "../scripts/production-worker.mjs";

const NOW = Date.parse("2026-09-23T18:00:00Z"), EMAIL = "customer@example.invalid";
const BINDING = { environment: "production", grantId: "a".repeat(64), realmId: "1234" };
const ACTOR = { email: EMAIL, status: "active", role: "customer", approvedAt: "2026-09-01T00:00:00Z", approvedBy: OWNER_EMAIL };
const SETTINGS = { revision: 1, enabled: true, serviceItemId: "2", serviceItemName: "Film production", taxCode: "NON",
  deliveryTerms: "Your finished film will be delivered within 24 hours after payment.", refundTerms: "Contact the administrator for a refund.",
  merchantConfirmed: true, pciAcknowledged: true, automaticInvoiceEmailDisabled: true, merchantBinding: BINDING };
const json = value => new Response(JSON.stringify(value), { status: 200 });
const denied = promise => assert.rejects(promise, error => Boolean(error.code));

async function fixture(options = {}) {
  const actor = options.actor || ACTOR, email = actor.email;
  let serial = 0, time = NOW, binding = structuredClone(BINDING), invoice, customer, quoteCount = 0;
  let productionEffect, transportEffect, writeEffect, bindingEffect, reversalEffect;
  const records = new Map(), requests = [], quoteCalls = [];
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `etag-${++serial}` });
  const read = async path => structuredClone(records.get(path) || null);
  const mutate = (path, change) => { const value = structuredClone(records.get(path).value); change(value); seed(path, value); };
  const write = async (path, value, etag) => {
    await writeEffect?.(path, value);
    if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw Error("precondition failed");
    seed(path, value); return read(path);
  };
  seed(userPath(email), actor); seed(HOSTED_CHECKOUT_SETTINGS_PATH, SETTINGS);
  const adapter = { id: "magiclight", environment: "production", available: true,
    evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true }, outputHosts: ["media.example.invalid"],
    validateManifest: async () => ({ ready: true, maximumCostCents: 280, ...options.validation }),
    quote: async request => {
      quoteCalls.push(request); const number = ++quoteCount;
      await productionEffect?.();
      return { manifestHash: request.manifestHash, currency: "USD", providerCostCents: 260, quoteReference: `actual-film-${number}`,
        expiresAt: new Date(time + 5 * 60_000).toISOString(), ...options.productionQuote };
    },
    submitShot: async () => assert.fail("Authorization must not submit media"),
    pollShot: async () => assert.fail("Authorization must not poll media"),
    reconcileShot: async () => assert.fail("Authorization must not reconcile media"),
  };
  const film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now: () => time, ...(options.missingAdapter ? {} : { adapter }) });
  const plan = await film.prepare({ email, project: fictionalOperatorProject(), preparationConsent: true, idempotencyKey: "fictional-hosted-prepare" });
  const planPath = productionJobPath(email, plan.id);
  const payment = { Id: "40", CustomerRef: { value: "20" }, CurrencyRef: { value: "USD" }, TotalAmt: 4.5,
    Line: [{ Amount: 4.5, LinkedTxn: [{ TxnId: "30", TxnType: "Invoice" }] }] };
  const transport = {
    binding: async request => { await bindingEffect?.(request); return structuredClone(binding); },
    request: async (expected, operation) => {
      assert.deepEqual(expected, binding); requests.push(structuredClone(operation));
      const reply = await transportEffect?.(operation); if (reply !== undefined) return reply;
      if (operation.path === "/query") return json({ QueryResponse: { Customer: customer ? [customer] : [] } });
      if (operation.path === "/item/2") return json({ Item: { Id: "2", Name: "Film production", Type: "Service", Active: true } });
      if (operation.path === "/customer") { customer = { Id: "20", Active: true, ...operation.body }; return json({ Customer: customer }); }
      if (operation.path === "/invoice") {
        invoice = { ...structuredClone(operation.body), Id: "30", TotalAmt: 4.5, Balance: 4.5, LinkedTxn: [], InvoiceLink: "https://connect.intuit.com/portal/app/fictional" };
        return json({ Invoice: invoice });
      }
      if (operation.path === "/invoice/30") return json({ Invoice: invoice });
      if (operation.path === "/payment/40") return json({ Payment: payment });
      assert.fail(`Unexpected operation: ${operation.path}`);
    },
  };
  const env = { QUICKBOOKS_ENVIRONMENT: "production", LINEAGE_PAYMENT_ACCESS: "approved" };
  // Deterministic evidence from a synthetic reconciliation adapter. Production
  // deliberately has no default implementation of this verifier.
  const verifyReversals = async context => {
    await reversalEffect?.();
    return { ...context, version: 1, outcome: "clear", evidenceHash: digest("fictional-reversal-evidence"),
      checkedAt: new Date(time).toISOString(), expiresAt: new Date(time + 60_000).toISOString(), ...options.reversalEvidence };
  };
  const dependencies = { read, write, now: () => time, env, transport, receiptDelivery: { deliver: async () => {} },
    ...(options.missingReversalVerifier ? {} : { verifyReversals }),
    pricingSettings: async () => ({ revision: 1, markupBasisPoints: 5000 }),
    quoteProvider: async () => ({ preparedId: plan.id, manifestHash: plan.manifestHash, filmId: plan.filmId, filmTitle: "Fictional film",
      currency: "USD", providerCostCents: 300, pricingBasis: "planning-rate", pricingRevision: 1, quoteReference: "paid-planning-price",
      environment: "production", expiresAt: new Date(NOW + 300_000).toISOString() }),
    productionQuote: input => film.quoteForProductionBudget(input),
  };
  const hosted = createHostedCheckoutService(dependencies);
  const q = await hosted.quote(actor, { project: {}, preparedId: plan.id, idempotencyKey: "fictional-hosted-quote" });
  const order = await hosted.checkout(actor, { quoteId: q.id, idempotencyKey: "fictional-hosted-checkout", consent: true });
  invoice.Balance = 0; invoice.LinkedTxn = [{ TxnId: "40", TxnType: "Payment" }];
  assert.equal((await hosted.check(actor, { orderId: order.id })).status, "captured");
  const orderPath = `payments/orders/${order.id}.json`, quotePath = `payments/hosted-quotes/${digest(email)}/${q.id}.json`;
  const initialOrder = structuredClone(records.get(orderPath).value);
  const request = { email, orderId: order.id, manifestHash: plan.manifestHash, preparedId: plan.id };
  const payments = createPaymentsService({ read, write, hostedCheckout: hosted,
    readiness: async () => assert.fail("Hosted spending must not use direct-card readiness"),
    provider: { binding: async () => assert.fail("Hosted spending must not use the card processor") } });
  requests.length = 0;
  return { hosted, payments, film, records, requests, quoteCalls, request, orderPath, quotePath, planPath, initialOrder, env,
    read, write, transport, adapter, actor, verifyReversals, now: () => time,
    authorize: () => payments.authorizeProduction(request), peer: () => createHostedCheckoutService(dependencies),
    mutateOrder: change => mutate(orderPath, change), mutateQuote: change => mutate(quotePath, change), mutatePlan: change => mutate(planPath, change),
    mutateActor: change => mutate(userPath(email), change), mutateSettings: change => mutate(HOSTED_CHECKOUT_SETTINGS_PATH, change),
    editInvoice: change => Object.assign(invoice, change), editPayment: change => Object.assign(payment, change),
    reconnect: change => { binding = { ...binding, grantId: "b".repeat(64), ...change }; }, advance: ms => { time += ms; },
    setProductionEffect: effect => { productionEffect = effect; }, setTransportEffect: effect => { transportEffect = effect; },
    setWriteEffect: effect => { writeEffect = effect; }, setBindingEffect: effect => { bindingEffect = effect; },
    setReversalEffect: effect => { reversalEffect = effect; },
    invoice: () => invoice, payment: () => payment,
  };
}

test("hosted paid planning orders dispatch through exact live allocation and a capped actual quote after retail expiry", async () => {
  const h = await fixture(); h.advance(3600_000);
  const grant = await h.authorize();
  assert.deepEqual(grant, { allowed: true, manifestHash: h.request.manifestHash, budgetCents: 280, quoteReference: "actual-film-1",
    expiresAt: new Date(NOW + 3660_000).toISOString(), environment: "production", fictionalOnly: false });
  const saved = h.records.get(h.orderPath).value;
  assert.deepEqual({ ...saved, fulfillmentQuote: undefined, changeId: undefined, updatedAt: undefined },
    { ...h.initialOrder, fulfillmentQuote: undefined, changeId: undefined, updatedAt: undefined });
  assert.equal(saved.fulfillmentQuote.providerCostCents, 260); assert.equal(saved.amountCents, 450);
  assert.deepEqual(h.requests.map(r => r.path), ["/invoice/30", "/payment/40", "/invoice/30", "/payment/40"]);
  assert.ok(h.requests.every(r => r.method === "GET")); assert.equal(h.quoteCalls.length, 1);
  h.advance(20_000); assert.equal((await h.authorize()).quoteReference, grant.quoteReference);
  assert.equal(h.quoteCalls.length, 1); assert.equal(h.requests.length, 6);
});

test("hosted production never treats a planning price or partner flag as an actual provider quote", async () => {
  for (const options of [{ missingAdapter: true }, { validation: { ready: false } }, { validation: { maximumCostCents: 301 } },
    { productionQuote: { providerCostCents: 301 } }, { productionQuote: { currency: "EUR" } }, { productionQuote: { manifestHash: "bad" } },
    { productionQuote: { expiresAt: new Date(NOW).toISOString() } }]) {
    const h = await fixture(options); h.env.MAGICLIGHT_PARTNER = "true";
    await denied(h.authorize()); assert.deepEqual(h.records.get(h.orderPath).value, h.initialOrder);
  }
});

test("account approval, active status and exact owner/order/plan identity are required before any provider read", async () => {
  for (const change of [user => { user.status = "suspended"; }, user => { user.status = "pending"; },
    user => { delete user.approvedAt; }, user => { user.mustChangePassword = true; }, user => { user.email = "other@example.invalid"; }]) {
    const h = await fixture(); h.mutateActor(change); await denied(h.authorize()); assert.equal(h.requests.length, 0); assert.equal(h.quoteCalls.length, 0);
  }
  for (const change of [{ email: "other@example.invalid" }, { manifestHash: "f".repeat(64) }, { preparedId: "00000000-0000-4000-8000-000000000002" }]) {
    const h = await fixture(); await denied(h.hosted.authorizeProduction({ ...h.request, ...change })); assert.equal(h.requests.length, 0);
  }
  for (const change of [job => { job.ownerHash = digest("other@example.invalid"); }, job => { job.manifest.shots[0].title = "Changed"; },
    job => { job.shots[0].id = "wrong"; }, job => { job.filmId = "wrong"; }, job => { job.status = "failed"; }]) {
    const h = await fixture(); h.mutatePlan(change); await denied(h.authorize()); assert.equal(h.requests.length, 0);
  }
});

test("persisted legacy owner and admin approval follows shared rules and fresh revocation still blocks", async () => {
  for (const actor of [{ email: OWNER_EMAIL, role: "owner" }, { email: EMAIL, role: "admin" }]) {
    const h = await fixture({ actor }); assert.equal((await h.authorize()).allowed, true);
    h.mutateActor(user => { user.status = "suspended"; }); await denied(h.authorize());
    const removed = await fixture({ actor }); removed.setProductionEffect(() => removed.mutateActor(user => { user.role = "customer"; }));
    await denied(removed.authorize()); assert.equal(removed.records.get(removed.orderPath).value.fulfillmentQuote, undefined);
    const password = await fixture({ actor }); password.mutateActor(user => { user.mustChangePassword = true; });
    await denied(password.authorize()); assert.equal(password.quoteCalls.length, 0);
  }
});

test("unconfirmed, refunded and altered saved budgets cannot authorize hosted production", async () => {
  for (const change of [order => { order.status = "uncertain"; }, order => { order.refundedCents = 1; },
    order => { order.refundOperation = { pending: true }; }, order => { order.refunds = [{ amountCents: 1 }]; },
    order => { order.capturedAt = new Date(NOW + 1).toISOString(); }, order => { order.lastCheckFailureReason = "PAYMENT_READ_FAILED"; },
    order => { order.checkOperation = "in-flight"; }, order => { order.confirmationSource = "browser"; },
    order => { order.accountingPayments[0].allocatedCents--; }, order => { order.providerCostCents = 400; order.markupCents = 50; },
    order => { order.amountCents = 600; order.markupCents = 300; }, order => { order.currency = "EUR"; },
    order => { order.id = "f".repeat(64); }]) {
    const h = await fixture(); h.mutateOrder(change); await denied(h.authorize()); assert.equal(h.requests.length, 0); assert.equal(h.quoteCalls.length, 0);
  }
  const h = await fixture(); h.mutateQuote(q => { q.providerCostCents = 400; }); await denied(h.authorize()); assert.equal(h.requests.length, 0);
});

test("fresh accounting reads reject zero-balance credit, void, partial, wrong customer and ambiguous allocation", async () => {
  for (const change of [{ Balance: 0, LinkedTxn: [] }, { Balance: 1 }, { Voided: true }, { TotalAmt: 5 },
    { CustomerRef: { value: "21" } }, { LinkedTxn: [{ TxnId: "40", TxnType: "CreditMemo" }] }]) {
    const h = await fixture(); h.editInvoice(change); await denied(h.authorize()); assert.equal(h.quoteCalls.length, 0);
    assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote, undefined);
  }
  for (const change of [{ Voided: true }, { CurrencyRef: { value: "EUR" } }, { CustomerRef: { value: "21" } }, { TotalAmt: 4 },
    { Line: [{ Amount: 4, LinkedTxn: [{ TxnId: "30", TxnType: "Invoice" }] }] },
    { Line: [{ Amount: 4.5, LinkedTxn: [{ TxnId: "30", TxnType: "Invoice" }, { TxnId: "31", TxnType: "Invoice" }] }] }]) {
    const h = await fixture(); h.editPayment(change); await denied(h.authorize()); assert.equal(h.quoteCalls.length, 0);
  }
});

test("same-company reconnect grants only after new live validation and retains the original invoice binding", async () => {
  const h = await fixture(); h.reconnect(); const grant = await h.authorize();
  assert.equal(grant.allowed, true); assert.deepEqual(h.records.get(h.orderPath).value.merchantBinding, BINDING);
  assert.equal(h.requests.filter(r => r.path === "/invoice/30").length, 2);
  for (const change of [{ realmId: "other" }, { realmId: "9999" }, { environment: "sandbox" }]) {
    const bad = await fixture(); bad.reconnect(change); await denied(bad.authorize()); assert.equal(bad.requests.length, 0);
  }
  const voided = await fixture(); voided.reconnect(); voided.editPayment({ Voided: true }); await denied(voided.authorize()); assert.equal(voided.quoteCalls.length, 0);
});

test("order, account, settings, quote, plan and merchant changes during production quote revoke authorization", async () => {
  for (const effect of [h => h.mutateOrder(o => { o.refundedCents = 1; }), h => h.mutateOrder(o => { o.reviewedAt = "changed"; }),
    h => h.mutateActor(u => { u.status = "suspended"; }), h => h.mutateSettings(s => { s.enabled = false; }),
    h => h.mutateQuote(q => { q.providerCostCents++; }), h => h.mutatePlan(p => { p.updatedAt = "changed"; }), h => h.reconnect()]) {
    const h = await fixture(); h.setProductionEffect(() => effect(h)); await denied(h.authorize());
    assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote, undefined);
  }
});

test("payment reversal during production quote is re-read before any fulfillment quote is locked", async () => {
  const h = await fixture(); h.setProductionEffect(() => h.editPayment({ Voided: true }));
  await denied(h.authorize()); assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote, undefined);
  assert.equal(h.requests.filter(r => r.path === "/payment/40").length, 2);
});

test("binding and account changes during live accounting reads cannot escape the final checks", async () => {
  for (const effect of [h => h.reconnect(), h => h.mutateActor(u => { u.status = "suspended"; }),
    h => h.mutateOrder(o => { o.refundOperation = { pending: true }; }), h => h.mutateSettings(s => { s.revision++; })]) {
    const h = await fixture(); h.setTransportEffect(operation => {
      if (operation.path === "/payment/40") { const reply = json({ Payment: h.payment() }); effect(h); return reply; }
    });
    await denied(h.authorize()); assert.equal(h.quoteCalls.length, 0);
  }
});

test("parallel hosted authorizations lock one whole-film quote and cannot overwrite the winner", async () => {
  const h = await fixture(); let arrivals = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.setProductionEffect(async () => { if (++arrivals === 2) release(); await gate; });
  const results = await Promise.allSettled([h.authorize(), h.peer().authorizeProduction(h.request)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const saved = h.records.get(h.orderPath).value.fulfillmentQuote;
  assert.equal((await h.authorize()).quoteReference, saved.quoteReference); assert.equal(h.quoteCalls.length, 2);
});

test("started films retain the original quote and budget, and expire closed without refreshing", async () => {
  const h = await fixture(), initial = await h.authorize();
  h.mutatePlan(job => { job.status = "processing"; job.shots[0].status = "completed"; job.authorization = { ...initial }; });
  assert.equal((await h.authorize()).quoteReference, initial.quoteReference); assert.equal(h.quoteCalls.length, 1);
  h.advance(300_000); await denied(h.authorize()); assert.equal(h.quoteCalls.length, 1);
  assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote.quoteReference, initial.quoteReference);
  const missing = await fixture(); missing.mutatePlan(job => { job.shots[0].status = "submitting"; });
  await denied(missing.authorize()); assert.equal(missing.quoteCalls.length, 0);
  const changed = await fixture(), grant = await changed.authorize();
  changed.mutatePlan(job => { job.status = "processing"; job.shots[0].status = "completed"; job.authorization = { ...grant, quoteReference: "other" }; });
  await denied(changed.authorize()); assert.equal(changed.quoteCalls.length, 1);
});

test("unstarted expired quotes can refresh only within the original paid budget", async () => {
  const h = await fixture(); const first = await h.authorize(); h.advance(300_000);
  const second = await h.authorize(); assert.notEqual(first.quoteReference, second.quoteReference);
  assert.equal(second.budgetCents, first.budgetCents); assert.equal(h.records.get(h.orderPath).value.amountCents, 450);
});

test("grants are bounded by actual quote expiry and a fresh live-payment read", async () => {
  const h = await fixture({ productionQuote: { expiresAt: new Date(NOW + 15_000).toISOString() } });
  assert.equal((await h.authorize()).expiresAt, new Date(NOW + 15_000).toISOString());
  const slow = await fixture(); slow.setTransportEffect(operation => { if (operation.path === "/payment/40") slow.advance(60_000); });
  await denied(slow.authorize()); assert.equal(slow.quoteCalls.length, 0);
});

test("concurrent local refund at the fulfillment CAS rejects the grant", async () => {
  const h = await fixture(); h.setWriteEffect((path, value) => {
    if (path === h.orderPath && value.fulfillmentQuote) h.mutateOrder(order => { order.refundedCents = 1; });
  });
  await denied(h.authorize()); assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote, undefined);
});

test("worker composes the hosted authorizer with its own adapter and a restarted worker polls without resubmitting", async () => {
  const h = await fixture(), ticketPath = productionQueuePath(h.request.email, h.request.preparedId);
  await h.write(ticketPath, { version: 1, email: h.request.email, id: h.request.preparedId, orderId: h.request.orderId,
    manifestHash: h.request.manifestHash, state: "pending", attempts: 0, nextAttemptAt: NOW, createdAt: new Date(NOW).toISOString() });
  const quotes = [], submitted = [], polls = [];
  const adapter = { ...h.adapter,
    quote: async request => {
      quotes.push(request);
      return { manifestHash: request.manifestHash, currency: "USD", providerCostCents: 260,
        quoteReference: "worker-actual-film", expiresAt: new Date(NOW + 300_000).toISOString() };
    },
    submitShot: async request => { submitted.push(request); return { status: "queued", providerJobId: "fictional-clip-1" }; },
    pollShot: async request => { polls.push(request); return { status: "queued", providerJobId: "fictional-clip-1" }; },
  };
  const options = { adapter, read: h.read, write: h.write, now: h.now, transport: h.transport, env: h.env, verifyReversals: h.verifyReversals,
    listBlobs: async () => ({ blobs: [{ pathname: ticketPath }], hasMore: false }) };
  const first = createProductionWorker(options);
  assert.equal((await first.runBatch()).pending, 1);
  assert.equal(quotes.length, 1); assert.equal(h.quoteCalls.length, 0); assert.equal(submitted.length, 1);
  assert.equal(submitted[0].quoteReference, "worker-actual-film"); assert.equal(submitted[0].budgetCents, 280);
  assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote.quoteReference, "worker-actual-film");
  h.advance(5000);
  const restarted = createProductionWorker(options);
  assert.equal((await restarted.runBatch()).pending, 1);
  assert.equal(polls.length, 1); assert.equal(submitted.length, 1); assert.equal(quotes.length, 1);
  assert.equal(polls[0].idempotencyKey, submitted[0].idempotencyKey);
  assert.equal(polls[0].quoteReference, "worker-actual-film");
  assert.ok(h.requests.every(request => request.method === "GET"));
});

test("hosted production defaults unavailable without supported reversal evidence even when invoice and allocation stay paid", async () => {
  const h = await fixture({ missingReversalVerifier: true });
  h.env.HOSTED_REVERSALS_CLEAR = "true";
  const before = structuredClone(h.invoice()), allocation = structuredClone(h.payment());
  await assert.rejects(h.authorize(), error => error.code === "HOSTED_REVERSALS_UNVERIFIED");
  assert.deepEqual(h.invoice(), before); assert.deepEqual(h.payment(), allocation); assert.equal(h.quoteCalls.length, 0);
  assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote, undefined);
});

test("separate refunded or ambiguous sale evidence blocks spending while the original paid invoice and Payment are unchanged", async () => {
  for (const outcome of ["refunded", "ambiguous"]) {
    const h = await fixture({ reversalEvidence: { outcome } });
    const invoice = structuredClone(h.invoice()), payment = structuredClone(h.payment());
    await assert.rejects(h.authorize(), error => error.code === "HOSTED_REVERSALS_UNVERIFIED");
    assert.deepEqual(h.invoice(), invoice); assert.deepEqual(h.payment(), payment);
    assert.equal(h.records.get(h.orderPath).value.refundedCents, 0); assert.equal(h.quoteCalls.length, 0);
  }
});

test("reversal evidence must be current and bound to this exact company, grant, customer, invoice, payment and amount", async () => {
  for (const reversalEvidence of [{ version: 2 }, { outcome: true }, { evidenceHash: "" }, { environment: "sandbox" },
    { realmId: "9999" }, { grantId: "f".repeat(64) }, { customerId: "21" }, { invoiceId: "31" },
    { paymentIds: ["41"] }, { orderId: "f".repeat(64) }, { currency: "EUR" }, { amountCents: 1 },
    { checkedAt: new Date(NOW - 1).toISOString() }, { checkedAt: new Date(NOW + 1).toISOString() },
    { expiresAt: new Date(NOW).toISOString() }, { expiresAt: new Date(NOW + 60_001).toISOString() }]) {
    const h = await fixture({ reversalEvidence });
    await assert.rejects(h.authorize(), error => error.code === "HOSTED_REVERSALS_UNVERIFIED");
    assert.equal(h.quoteCalls.length, 0);
  }
});

test("reversal after the provider quote or account changes during reconciliation revoke the grant", async () => {
  const options = {}, h = await fixture(options);
  h.setProductionEffect(() => { options.reversalEvidence = { outcome: "refunded" }; });
  await assert.rejects(h.authorize(), error => error.code === "HOSTED_REVERSALS_UNVERIFIED");
  assert.equal(h.records.get(h.orderPath).value.fulfillmentQuote, undefined);
  const revoked = await fixture(); revoked.setReversalEffect(() => revoked.mutateActor(user => { user.status = "suspended"; }));
  await denied(revoked.authorize()); assert.equal(revoked.quoteCalls.length, 0);
  const short = await fixture({ reversalEvidence: { expiresAt: new Date(NOW + 5000).toISOString() } });
  assert.equal((await short.authorize()).expiresAt, new Date(NOW + 5000).toISOString());
});
