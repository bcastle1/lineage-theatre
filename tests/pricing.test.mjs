import test from "node:test";
import assert from "node:assert/strict";
import { costFromProviderCredits, customerQuoteFromCredits, pricingPolicy, pricingReadiness } from "../api/_lib/pricing.mjs";
import { productionReadiness } from "../api/_lib/production.mjs";

test("public Pro API pack produces the published unit cost with no markup", () => {
  const policy = pricingPolicy({});
  assert.equal(policy.packPriceCents, 8_800);
  assert.equal(policy.packCredits, 80_000);
  assert.equal(policy.markupBasisPoints, 0);
  assert.equal(costFromProviderCredits(1_000, policy), 110);
  assert.equal(costFromProviderCredits(80_000, policy), 8_800);
  assert.equal(costFromProviderCredits(123_456, policy), 13_580);
  assert.equal(pricingReadiness({}).referenceRate.amountCents, 110);
});

test("customer quote separates provider cost and percentage markup with integer rounding",()=>{
  const policy=pricingPolicy({});
  const quote=customerQuoteFromCredits(1000,policy,{markupBasisPoints:2500,revision:3});
  assert.deepEqual(quote,{currency:"USD",providerCredits:1000,providerCostCents:110,markupBasisPoints:2500,markupCents:28,amountCents:138,pricingRevision:3});
  assert.equal(customerQuoteFromCredits(1000,policy).amountCents,110);
  assert.equal(Object.isFrozen(quote),true);
  for(const markupBasisPoints of [-1,100001,1.5,"2500",NaN]) assert.throws(()=>customerQuoteFromCredits(1000,policy,{markupBasisPoints,revision:1}));
  const updated=pricingReadiness({},{markupBasisPoints:5000,revision:4});
  assert.equal(updated.markupBasisPoints,5000);assert.equal(updated.pricingRevision,4);
  assert.equal(updated.policy,"provider-cost-plus-markup");assert.equal(updated.estimate.amountCents,null);assert.equal(updated.chargeReady,false);
  assert.equal(quote.amountCents,138);
  assert.throws(()=>customerQuoteFromCredits(Number.MAX_SAFE_INTEGER,{currency:"USD",markupBasisPoints:0,packPriceCents:1,packCredits:1},{markupBasisPoints:10000,revision:1}),/exceeds/);
});

test("currency uses exact integer half-up rounding rather than floating-point rounding", () => {
  assert.equal(costFromProviderCredits(2_250, pricingPolicy({})), 248);
  const policy = { currency: "USD", markupBasisPoints: 0, packPriceCents: 1, packCredits: 8 };
  assert.equal(costFromProviderCredits(11, policy), 1);
  assert.equal(costFromProviderCredits(12, policy), 2);
  assert.equal(costFromProviderCredits(13, policy), 2);
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.equal(costFromProviderCredits(maximum, { ...policy, packPriceCents: maximum, packCredits: maximum }), maximum);
});

test("missing, client-shaped, noninteger, or unsafe credit amounts cannot create a film price", () => {
  const policy = pricingPolicy({});
  for (const quote of [undefined, null, 0, -1, 1.5, "1000", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    { providerCredits: 1_000, amountCents: 1, verified: true }]) {
    assert.throws(() => costFromProviderCredits(quote, policy), /valid MagicLight credit quote/);
  }
  assert.throws(() => costFromProviderCredits(1, policy), /billable currency amount/);
  assert.throws(() => costFromProviderCredits(Number.MAX_SAFE_INTEGER, {
    ...policy, packPriceCents: 2, packCredits: 1,
  }), /billable currency amount/);
});

test("invalid policy or attempted markup is rejected instead of silently substituted", () => {
  const policy = pricingPolicy({});
  for (const invalid of [undefined, {}, { ...policy, markupBasisPoints: 100 }, { ...policy, currency: "EUR" },
    { ...policy, packCredits: 0 }, { ...policy, packPriceCents: 0 }, { ...policy, packPriceCents: 8_800.5 }]) {
    assert.throws(() => costFromProviderCredits(1_000, invalid), /valid server pricing policy with no markup/);
  }
});

test("a complete valid server pack configuration replaces the reference rate", () => {
  const env = { MAGICLIGHT_API_PACK_PRICE_CENTS: "20000", MAGICLIGHT_API_PACK_CREDITS: "100000" };
  const policy = pricingPolicy(env);
  assert.equal(policy.source, "server-configuration");
  assert.equal(policy.sourceUrl, null);
  assert.equal(costFromProviderCredits(1_000, policy), 200);
  const pricing = pricingReadiness(env);
  assert.equal(pricing.referenceRate.amountCents, 200);
  assert.equal(pricing.estimate.amountCents, null);
  assert.equal(pricing.chargeReady, false);
});

test("partial or invalid supplied rate configuration fails closed", () => {
  const valid = { MAGICLIGHT_API_PACK_PRICE_CENTS: "8800", MAGICLIGHT_API_PACK_CREDITS: "80000" };
  const invalid = [
    { MAGICLIGHT_API_PACK_PRICE_CENTS: "8800" },
    { MAGICLIGHT_API_PACK_CREDITS: "80000" },
    ...["", "0", "-1", "1.5", "1e3", "Infinity", "9007199254740992", null].map(value => ({ ...valid, MAGICLIGHT_API_PACK_PRICE_CENTS: value })),
    ...["", "0", "-1", "1.5", "9007199254740992"].map(value => ({ ...valid, MAGICLIGHT_API_PACK_CREDITS: value })),
  ];
  for (const env of invalid) {
    assert.throws(() => pricingPolicy(env), /configuration is incomplete or invalid/);
    const pricing = pricingReadiness(env);
    assert.equal(pricing.referenceStatus, "configuration-pending");
    assert.equal(pricing.referenceRate, null);
    assert.equal(pricing.estimate.amountCents, null);
    assert.equal(pricing.chargeReady, false);
  }
});

test("a reference rate never becomes a complete-film quote or a charge", () => {
  const pricing = pricingReadiness({});
  assert.equal(pricing.policy, "provider-cost-no-markup");
  assert.equal(pricing.markupBasisPoints, 0);
  assert.equal(pricing.estimate.status, "awaiting-provider-quote");
  assert.equal(pricing.estimate.amountCents, null);
  assert.equal(pricing.estimate.providerCredits, null);
  assert.match(pricing.estimate.reason, /Highest-quality animation and final-film settings have not been quoted/);
  assert.equal(pricing.chargeReady, false);
});

test("rate configuration and connection flags cannot activate MagicLight or QuickBooks payment", () => {
  const readiness = productionReadiness({ env: {
    MAGICLIGHT_API_KEY: "synthetic-test-value",
    MAGICLIGHT_API_PACK_PRICE_CENTS: "8800",
    MAGICLIGHT_API_PACK_CREDITS: "80000",
    QUICKBOOKS_CONNECTED: "true",
    QUICKBOOKS_PAYMENTS_ENABLED: "true",
    MAGICLIGHT_QUOTED_CREDITS: "1000",
    CUSTOMER_AMOUNT_CENTS: "1",
  } });
  assert.equal(readiness.magiclight, false);
  assert.equal(readiness.billing, false);
  assert.equal(readiness.payment.provider, "quickbooks");
  assert.equal(readiness.payment.status, "connection-pending");
  assert.equal(readiness.payment.available, false);
  assert.equal(readiness.connections.billing.available, false);
  assert.equal(readiness.pricing.estimate.amountCents, null);
  assert.equal(readiness.pricing.chargeReady, false);
  assert.equal(readiness.quality.verified, false);
  assert.match(readiness.connections.billing.reason, /planning estimate plus the saved administrator markup/);
  assert.equal(JSON.stringify(readiness).includes("synthetic-test-value"), false);
});
