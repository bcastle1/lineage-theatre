import test from "node:test";
import assert from "node:assert/strict";
import { createFilmProductionService, fictionalOperatorProject, productionJobPath } from "../api/_lib/film-production.mjs";
import { createPaymentsService } from "../api/_lib/payments.mjs";
import { digest } from "../api/_lib/auth.mjs";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const EMAIL = "customer@example.invalid";
const ORDER_ID = digest("fictional captured planning order");
const ORDER_PATH = `payments/orders/${ORDER_ID}.json`;
const blocked = error => error.code === "PRODUCTION_UNAVAILABLE";

async function fixture(options = {}) {
  let time = NOW, revision = 0, binding = { environment: "production", grantId: "a".repeat(64) }, revoked = false;
  let quoteEffect = options.quoteEffect, quoteCount = 0, readinessCount = 0;
  const records = new Map(), writes = [], quoteCalls = [], validationCalls = [];
  const read = async path => records.has(path) ? structuredClone(records.get(path)) : null;
  const write = async (path, value, etag) => {
    if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw new Error("precondition failed");
    const record = { value: structuredClone(value), etag: `fixture-${++revision}` };
    records.set(path, record); writes.push(path); return structuredClone(record);
  };
  const mutate = (path, change) => { const record = records.get(path); change(record.value); record.etag = `fixture-${++revision}`; };
  const adapter = { id: "magiclight", environment: "production", available: true,
    evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true },
    outputHosts: ["media.example.invalid"],
    validateManifest: async manifest => { validationCalls.push(manifest); return { ready: true, maximumCostCents: 280, ...options.validation }; },
    quote: async request => {
      quoteCalls.push(request); const number = ++quoteCount;
      await quoteEffect?.();
      return { manifestHash: request.manifestHash, currency: "USD", providerCostCents: 260,
        quoteReference: `actual-full-film-${number}`, expiresAt: new Date(NOW + 5 * 60_000).toISOString(), ...options.quote };
    },
    submitShot: async () => assert.fail("Budget verification must not submit a shot"),
    pollShot: async () => ({ status: "queued", providerJobId: "existing-clip-1" }),
    reconcileShot: async () => ({ status: "uncertain" }), ...options.adapter,
  };
  const film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now: () => time,
    ...(options.missingAdapter ? {} : { adapter }) });
  const plan = await film.prepare({ email: EMAIL, project: fictionalOperatorProject(), preparationConsent: true, idempotencyKey: "fictional-preparation-001" });
  const planPath = productionJobPath(EMAIL, plan.id);
  const initialOrder = { id: ORDER_ID, customerEmail: EMAIL, preparedId: plan.id, manifestHash: plan.manifestHash,
    pricingBasis: "planning-rate", status: "captured", capturedAt: new Date(NOW - 3600_000).toISOString(),
    quoteExpiresAt: new Date(NOW - 1800_000).toISOString(), refundedCents: 0, refundOperation: null,
    merchantBinding: structuredClone(binding), amountCents: 450, currency: "USD", providerCostEstimateCents: 300,
    pricingRevision: 2, quoteReference: "old-planning-price", ...options.order };
  await write(ORDER_PATH, initialOrder);
  const payments = createPaymentsService({ read, write, now: () => time,
    provider: { binding: async () => structuredClone(binding), charge: async () => assert.fail("No payment operation is allowed") },
    readiness: async () => {
      readinessCount++; options.readinessEffect?.(readinessCount, { advance: ms => { time += ms; } });
      return revoked ? {} : { authorization: { ...binding, evidenceHash: "b".repeat(64), operations: ["render"],
        validatedAt: new Date(time).toISOString(), expiresAt: new Date(time + 60_000).toISOString() } };
    },
    productionQuote: options.productionQuote || (request => film.quoteForProductionBudget(request)),
  });
  const request = { email: EMAIL, orderId: ORDER_ID, preparedId: plan.id, manifestHash: plan.manifestHash };
  return { film, payments, request, records, writes, quoteCalls, validationCalls, planPath, initialOrder,
    authorize: () => payments.authorizeProduction(request),
    quoteBudget: extra => film.quoteForProductionBudget({ email: EMAIL, preparedId: plan.id, manifestHash: plan.manifestHash, environment: "production", budgetCents: 300, ...extra }),
    mutateOrder: change => mutate(ORDER_PATH, change), mutatePlan: change => mutate(planPath, change),
    advance: ms => { time += ms; }, changeBinding: () => { binding = { ...binding, grantId: "c".repeat(64) }; },
    revoke: () => { revoked = true; }, setQuoteEffect: effect => { quoteEffect = effect; },
    setQuote: quote => { options.quote = quote; },
  };
}

test("paid planning orders outlive retail quote expiry and lock a fresh actual quote within the original budget", async () => {
  const h = await fixture(), grant = await h.authorize();
  assert.deepEqual(grant, { allowed: true, manifestHash: h.request.manifestHash, budgetCents: 280,
    quoteReference: "actual-full-film-1", expiresAt: new Date(NOW + 60_000).toISOString(), environment: "production", fictionalOnly: false });
  const saved = h.records.get(ORDER_PATH).value;
  assert.deepEqual({ ...saved, fulfillmentQuote: undefined, changeId: undefined, updatedAt: undefined },
    { ...h.initialOrder, fulfillmentQuote: undefined, changeId: undefined, updatedAt: undefined });
  assert.equal(saved.fulfillmentQuote.providerCostCents, 260); assert.equal(saved.fulfillmentQuote.maximumCostCents, 280);
  assert.equal(saved.fulfillmentQuote.apiVerified, true); assert.equal(h.quoteCalls.length, 1);
  h.advance(20_000);
  assert.equal((await h.authorize()).quoteReference, grant.quoteReference);
  assert.equal(h.quoteCalls.length, 1); assert.equal(h.records.get(ORDER_PATH).value.amountCents, 450);
});

test("a production grant never outlives the actual quote", async () => {
  const h = await fixture({ quote: { expiresAt: new Date(NOW + 15_000).toISOString() } });
  assert.equal((await h.authorize()).expiresAt, new Date(NOW + 15_000).toISOString());
});

test("missing provider readiness and over-budget actual quotes do not change the captured payment", async () => {
  for (const options of [{ missingAdapter: true }, { adapter: { evidence: { apiVerified: false } } },
    { validation: { maximumCostCents: 301 } }, { quote: { providerCostCents: 301 } },
    { validation: { maximumCostCents: 250 } }, { validation: { ready: false } }]) {
    const h = await fixture(options);
    await assert.rejects(h.authorize(), blocked);
    assert.deepEqual(h.records.get(ORDER_PATH).value, h.initialOrder);
  }
});

test("provider identity, cost and expiry are verified before any fulfillment authorization is saved", async () => {
  for (const quote of [{ manifestHash: "wrong" }, { currency: "EUR" }, { quoteReference: " " },
    { providerCostCents: -1 }, { providerCostCents: 1.5 }, { expiresAt: "bad" }, { expiresAt: NOW + 60_000 },
    { expiresAt: new Date(NOW).toISOString() }]) {
    const h = await fixture({ quote }); await assert.rejects(h.authorize(), blocked);
    assert.equal(h.records.get(ORDER_PATH).value.fulfillmentQuote, undefined);
  }
  const h = await fixture();
  for (const input of [{ environment: "sandbox" }, { manifestHash: "a".repeat(64) }, { budgetCents: 0 }, { budgetCents: NaN }])
    await assert.rejects(h.quoteBudget(input), blocked);
  await assert.rejects(h.quoteBudget({ email: "other@example.invalid" }), error => error.code === "PRODUCTION_NOT_FOUND");
  h.mutatePlan(job => { job.manifest.shots[0].targetDurationMs++; });
  await assert.rejects(h.authorize(), blocked);
});

test("refunds and any order revision while the provider quote is in flight revoke the new authorization", async () => {
  for (const change of [order => { order.refundedCents = 1; }, order => { order.refundOperation = { id: "pending" }; },
    order => { order.status = "refunded"; }, order => { order.reviewedAt = "changed"; }]) {
    const h = await fixture(); h.setQuoteEffect(() => h.mutateOrder(change));
    await assert.rejects(h.authorize(), blocked);
    assert.equal(h.records.get(ORDER_PATH).value.fulfillmentQuote, undefined);
    assert.equal(h.records.get(ORDER_PATH).value.amountCents, 450);
  }
});

test("merchant reconnect, grant revocation and expiry during awaits block production", async () => {
  for (const effect of [h => h.changeBinding(), h => h.revoke(), h => h.advance(5 * 60_000),
    h => h.mutatePlan(job => { job.updatedAt = "changed"; })]) {
    const h = await fixture(); h.setQuoteEffect(() => effect(h));
    await assert.rejects(h.authorize(), blocked);
    assert.equal(h.records.get(ORDER_PATH).value.fulfillmentQuote, undefined);
  }
  const h = await fixture({ quote: { expiresAt: new Date(NOW + 1000).toISOString() },
    readinessEffect: (count, clock) => { if (count === 2) clock.advance(1000); } });
  await assert.rejects(h.authorize(), blocked);
  assert.equal(h.records.get(ORDER_PATH).value.fulfillmentQuote, undefined);
});

test("parallel authorizations lock one actual quote reference and never mix whole-film quotes", async () => {
  const h = await fixture(); let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.setQuoteEffect(async () => { if (++calls === 2) release(); await gate; });
  const results = await Promise.allSettled([h.authorize(), h.authorize()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const locked = h.records.get(ORDER_PATH).value.fulfillmentQuote;
  assert.equal((await h.authorize()).quoteReference, locked.quoteReference);
  assert.equal(h.quoteCalls.length, 2);
  assert.equal(h.records.get(ORDER_PATH).value.amountCents, 450);
});

test("partially produced films reuse the locked quote and block new spending when it expires", async () => {
  const h = await fixture(), initial = await h.authorize();
  h.mutatePlan(job => { job.status = "processing"; job.shots[0].status = "completed"; });
  assert.equal((await h.authorize()).quoteReference, initial.quoteReference);
  assert.equal(h.quoteCalls.length, 1);
  h.advance(5 * 60_000);
  await assert.rejects(h.authorize(), blocked);
  assert.equal(h.quoteCalls.length, 1); assert.equal(h.records.get(ORDER_PATH).value.amountCents, 450);
  const partial = await fixture();
  partial.mutatePlan(job => { job.status = "uncertain"; job.shots[0].status = "submitting"; });
  await assert.rejects(partial.authorize(), blocked);
  assert.equal(partial.quoteCalls.length, 0);
});

test("expired fulfillment quotes may refresh only before production starts", async () => {
  const h = await fixture(); await h.authorize(); h.advance(5 * 60_000);
  await assert.rejects(h.authorize(), blocked);
  assert.equal(h.quoteCalls.length, 2);
  assert.equal(h.records.get(ORDER_PATH).value.fulfillmentQuote.quoteReference, "actual-full-film-1");
  h.setQuote({ expiresAt: new Date(NOW + 10 * 60_000).toISOString() });
  const renewed = await h.authorize();
  assert.equal(renewed.quoteReference, "actual-full-film-3");
  assert.equal(h.records.get(ORDER_PATH).value.fulfillmentQuote.quoteReference, renewed.quoteReference);
  assert.equal(h.records.get(ORDER_PATH).value.amountCents, 450);
});

test("verified provider-quote orders retain their existing retail quote expiry behavior", async () => {
  const expired = await fixture({ order: { pricingBasis: "provider-quote" } });
  await assert.rejects(expired.authorize(), blocked); assert.equal(expired.quoteCalls.length, 0);
  const current = await fixture({ order: { pricingBasis: "provider-quote", quoteExpiresAt: new Date(NOW + 30_000).toISOString() } });
  const grant = await current.authorize();
  assert.equal(grant.quoteReference, "old-planning-price"); assert.equal(grant.budgetCents, 300);
  assert.equal(grant.expiresAt, new Date(NOW + 30_000).toISOString()); assert.equal(current.quoteCalls.length, 0);
});
