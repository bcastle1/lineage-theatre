import test from "node:test";
import assert from "node:assert/strict";
import { createFilmPricingService } from "../api/_lib/film-pricing.mjs";
import { createFilmProductionService, fictionalOperatorProject, FilmProductionError } from "../api/_lib/film-production.mjs";
import { readPricingSettings, PRICING_PATH } from "../api/_lib/admin.mjs";
import { createStudioHandler } from "../api/studio.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const actor = { email: "customer@example.invalid", role: "customer", status: "active",
  approvedAt: "2026-09-01T00:00:00.000Z", approvedBy: "erik@brocotech.ai" };
const project = fictionalOperatorProject();
const preparedId = "fictional-prepared-film-001";
const input = () => ({ project: structuredClone(project), preparedId, idempotencyKey: "fictional-price-request-001" });
const supplied = () => ({ preparedId, manifestHash: "a".repeat(64), filmId: project.id, filmTitle: project.title,
  quoteReference: "fictional-cost-quote-001", currency: "USD", providerCostCents: 1000,
  environment: "production", expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
  apiVerified: true, qualityVerified: true, commercialTermsVerified: true });
const unavailableMessage = "Your production plan is saved. A film price cannot be calculated until production costs are available.";
const planningSettings = { markupBasisPoints: 5000, revision: 2, planningCreditsPerClip: 286, planningSecondsPerClip: 6, planningRendersPerClip: 1 };
const fixedPriceNote = "This is the fixed price for this saved film. It will not change if production costs change.";
const unavailableError = error => error instanceof FilmProductionError && error.status === 503 && error.code === "PRICE_UNAVAILABLE" && error.message === unavailableMessage;
function fixture({ quote = supplied(), settings = planningSettings, ...overrides } = {}) {
  const calls = [];
  const service = createFilmPricingService({ now: () => NOW, env: {},
    filmProduction: { quoteForPayment: async (...args) => { calls.push(args); return quote; } },
    pricingSettings: () => readPricingSettings(async path => {
      assert.equal(path, PRICING_PATH);
      return { value: settings };
    }), ...overrides });
  return { service, calls };
}
function store() {
  const records = new Map();
  return { records, readRecordImpl: async path => records.has(path) ? structuredClone(records.get(path)) : null,
    writeRecordImpl: async (path, value) => { records.set(path, { value: structuredClone(value), etag: "fixture-etag" }); } };
}

test("film prices use the trusted cost plus saved markup without billing, card entry or payment records", async () => {
  const h = fixture(), body = input();
  body.project.amountCents = 1; body.project.providerCostCents = 1; body.project.markupBasisPoints = 0;
  const result = await h.service.price(actor, body);
  assert.deepEqual(result, { preparedId, manifestHash: "a".repeat(64), filmId: project.id, filmTitle: project.title,
    currency: "USD", amountCents: 1500, expiresAt: new Date(NOW + 15 * 60_000).toISOString(), sandbox: false, kind: "confirmed", pricingBasis: "provider-quote", note: fixedPriceNote });
  assert.deepEqual(h.calls, [[body.project, actor, { preparedId, idempotencyKey: body.idempotencyKey }]]);
  assert.doesNotMatch(JSON.stringify(result), /providerCost|markup|quoteReference|qualityVerified|apiVerified|commercialTerms|orderId|quoteId|merchant|billing/i);
});

test("prices preserve shorter provider expiry and use integer rounding with the checkout amount cap", async () => {
  const quote = { ...supplied(), providerCostCents: 1, environment: "sandbox", expiresAt: new Date(NOW + 60_000).toISOString() };
  const result = await fixture({ quote }).service.price(actor, input());
  assert.equal(result.amountCents, 2); assert.equal(result.sandbox, true); assert.equal(result.expiresAt, quote.expiresAt);
  assert.equal((await fixture({ quote: { ...supplied(), providerCostCents: 100_000_000 }, settings: { markupBasisPoints: 0, revision: 1 } }).service.price(actor, input())).amountCents, 100_000_000);
  await assert.rejects(fixture({ quote: { ...supplied(), providerCostCents: 100_000_000 } }).service.price(actor, input()), unavailableError);
  let time = NOW;
  await assert.rejects(fixture({ quote, now: () => time, pricingSettings: async () => {
    time += 60_000; return { markupBasisPoints: 5000, revision: 2 };
  } }).service.price(actor, input()), unavailableError);
});

test("invalid actors and unsupported client fields fail before any production quote", async () => {
  const h = fixture();
  for (const user of [null, { ...actor, status: "pending" }, { ...actor, status: "suspended" },
    { ...actor, approvedAt: undefined }, { ...actor, mustChangePassword: true },
    { ...actor, email: "Customer@example.invalid" }, { ...actor, email: "invalid" },
    { ...actor, status: undefined }, { email: OWNER_EMAIL }, { email: OWNER_EMAIL, status: "active" },
    { email: actor.email, role: "owner", status: "active" },
    { email: OWNER_EMAIL, role: "owner", status: "suspended" },
    { email: OWNER_EMAIL, role: "owner", mustChangePassword: true }])
    await assert.rejects(h.service.price(user, input()), error => error instanceof FilmProductionError && error.status === 401);
  for (const body of [null, [], {}, { ...input(), preparedId: undefined }, { ...input(), preparedId: "short" },
    { ...input(), idempotencyKey: 123 }, { ...input(), project: [] }, { ...input(), project: null },
    ...["amountCents", "providerCostCents", "currency", "markupBasisPoints", "paymentToken", "card", "environment", "checkoutProof"].map(field => ({ ...input(), [field]: 1 }))])
    await assert.rejects(h.service.price(actor, body), error => error instanceof FilmProductionError && error.status === 400);
  assert.equal(h.calls.length, 0);
});

test("legacy approved owner and administrator roles can price their saved plan without account changes", async () => {
  for (const legacy of [{ email: OWNER_EMAIL, role: "owner" }, { email: "admin@example.invalid", role: "admin" }]) {
    const data = store(), production = createFilmProductionService({ ...data, now: () => NOW });
    const plan = await production.prepare({ email: legacy.email, project, preparationConsent: true, idempotencyKey: "fictional-legacy-prepare-001" });
    const before = structuredClone([...data.records]);
    const h = fixture({ filmProduction: production });
    const result = await h.service.price(legacy, { ...input(), preparedId: plan.id });
    assert.equal(result.amountCents, 141);
    assert.equal(result.pricingBasis, "planning-rate");
    assert.equal(result.preparedId, plan.id);
    assert.deepEqual([...data.records], before);
    assert.equal(Object.hasOwn(legacy, "status"), false);
  }
});

test("every trusted provider field must be valid before returning a numeric price", async () => {
  for (const patch of [
    { preparedId: "different-prepared-film-001" }, { environment: undefined }, { environment: "test" }, { currency: "EUR" },
    ...[0, -1, 1.5, "1000", NaN, Number.MAX_SAFE_INTEGER, 100_000_001].map(providerCostCents => ({ providerCostCents })),
    { manifestHash: "bad" }, { manifestHash: ["a".repeat(64)] }, { filmId: "other-film" }, { filmId: "" },
    { filmId: "a".repeat(101) }, { filmTitle: null }, { filmTitle: " " }, { filmTitle: "a".repeat(301) },
    { quoteReference: " " }, { quoteReference: "a".repeat(201) },
    { qualityVerified: false }, { apiVerified: "true" }, { commercialTermsVerified: false },
    { expiresAt: "bad" }, { expiresAt: NOW + 60_000 }, { expiresAt: new Date(NOW).toISOString() },
  ]) await assert.rejects(fixture({ quote: { ...supplied(), ...patch } }).service.price(actor, input()), unavailableError);
  await assert.rejects(fixture({ quote: null }).service.price(actor, input()), unavailableError);
  for (const settings of [null, { markupBasisPoints: -1, revision: 1 }, { markupBasisPoints: 100_001, revision: 1 },
    { markupBasisPoints: 0.5, revision: 1 }, { markupBasisPoints: "5000", revision: 1 },
    { markupBasisPoints: 5000, revision: -1 }, { markupBasisPoints: 5000, revision: Number.MAX_SAFE_INTEGER + 1 }])
    await assert.rejects(fixture({ pricingSettings: async () => settings }).service.price(actor, input()), unavailableError);
});

test("the unavailable production adapter returns a fixed planning-rate price without creating a payment quote or order", async () => {
  const data = store(), production = createFilmProductionService({ ...data, now: () => NOW });
  const plan = await production.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: "fictional-prepare-request-001" });
  const before = structuredClone([...data.records]);
  const service = fixture({ filmProduction: production }).service;
  const result = await service.price(actor, { ...input(), preparedId: plan.id });
  assert.deepEqual(result, { preparedId: plan.id, manifestHash: plan.manifestHash, filmId: project.id, filmTitle: project.title,
    currency: "USD", amountCents: 141, expiresAt: new Date(NOW + 15 * 60_000).toISOString(), sandbox: false, kind: "confirmed", pricingBasis: "planning-rate", note: fixedPriceNote });
  assert.doesNotMatch(JSON.stringify(result), /magiclight|hailuo|provider|credits|markup|renders|quickbooks|orderId|quoteReference|qualityVerified/i);
  assert.deepEqual([...data.records], before);
  assert.equal(data.records.size, 1);
  assert.ok([...data.records.keys()].every(path => path.startsWith("production/jobs/")));
});

test("photo-only and older edited films receive fixed prices without screenplay review metadata", async () => {
  for (const kind of ["photo", "older-two-scenes", "manual-one-scene"]) {
    const saved = structuredClone(project), data = store();
    if (kind === "photo") {
      saved.sources[0] = { id: saved.sources[0].id, name: "fictional-photo.png", type: "image/png", text: "", note: "" };
    } else {
      saved.scenes = saved.scenes.slice(0, kind === "manual-one-scene" ? 1 : 2).map(({ title, narration, visual }) => ({ title, narration, visual }));
      delete saved.characters; delete saved.assumptions; delete saved.selectedThemes; delete saved.logline;
    }
    const unchanged = structuredClone(saved);
    const production = createFilmProductionService({ ...data, now: () => NOW });
    const plan = await production.prepare({ email: actor.email, project: saved, preparationConsent: true, idempotencyKey: `fictional-${kind}-request` });
    const beforePrice = structuredClone([...data.records]);
    const price = await fixture({ filmProduction: production }).service.price(actor, {
      project: saved, preparedId: plan.id, idempotencyKey: `fictional-${kind}-price`,
    });
    assert.equal(price.amountCents, kind === "older-two-scenes" ? 189 : 141);
    assert.equal(price.manifestHash, plan.manifestHash);
    assert.equal(price.kind, "confirmed");
    assert.deepEqual(saved, unchanged);
    assert.deepEqual([...data.records], beforePrice);
    assert.equal(data.records.size, 1, "pricing creates no payment or generation records");
  }
});

test("planning-rate prices use saved per-scene timing, server rate and editable clip assumptions", async () => {
  const data = store(), production = createFilmProductionService({ ...data, now: () => NOW });
  const plan = await production.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: "fictional-prepare-request-001" });
  const body = { ...input(), preparedId: plan.id };
  // Each of the three scenes needs two three-second clips. Two renders per
  // clip at 100 credits use 1,200 credits, costing $2.40 at this server rate.
  const result = await fixture({ filmProduction: production,
    env: { MAGICLIGHT_API_PACK_PRICE_CENTS: "200", MAGICLIGHT_API_PACK_CREDITS: "1000" },
    settings: { ...planningSettings, planningCreditsPerClip: 100, planningSecondsPerClip: 3, planningRendersPerClip: 2 },
  }).service.price(actor, body);
  assert.equal(result.amountCents, 360); assert.equal(result.kind, "confirmed"); assert.equal(result.pricingBasis, "planning-rate");
  const record = [...data.records.values()][0];
  record.value.expiresAt = new Date(NOW + 30_000).toISOString();
  const shortened = await fixture({ filmProduction: production }).service.price(actor, body);
  assert.equal(shortened.expiresAt, record.value.expiresAt);
});

test("an unset pricing record uses the saved-settings service defaults for a fixed price", async () => {
  const data = store(), production = createFilmProductionService({ ...data, now: () => NOW });
  const plan = await production.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: "fictional-prepare-request-001" });
  const service = fixture({ filmProduction: production, pricingSettings: () => readPricingSettings(async () => null) }).service;
  const result = await service.price(actor, { ...input(), preparedId: plan.id });
  assert.equal(result.amountCents, 141); assert.equal(result.kind, "confirmed"); assert.equal(result.pricingBasis, "planning-rate");
});

test("planning-rate prices reject unowned, changed, started, corrupt or expired saved plans", async () => {
  const data = store(), production = createFilmProductionService({ ...data, now: () => NOW });
  const plan = await production.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: "fictional-prepare-request-001" });
  const service = fixture({ filmProduction: production }).service, body = { ...input(), preparedId: plan.id };
  await assert.rejects(service.price({ ...actor, email: "other@example.invalid" }, body), error => error.code === "PRODUCTION_NOT_FOUND");
  await assert.rejects(service.price(actor, { ...body, project: { ...project, title: "Changed film" } }), error => error.code === "PRODUCTION_PLAN_CHANGED");
  const record = [...data.records.values()][0], original = structuredClone(record.value);
  for (const mutate of [job => { job.status = "processing"; }, job => { job.shots[0].status = "queued"; }, job => { job.shots.pop(); }]) {
    mutate(record.value);
    await assert.rejects(service.price(actor, body), error => error.code === "PRODUCTION_ALREADY_STARTED");
    record.value = structuredClone(original);
  }
  record.value.manifest.shots[0].targetDurationMs++;
  await assert.rejects(service.price(actor, body), error => error.code === "PRODUCTION_PLAN_CHANGED");
  record.value = structuredClone(original);
  for (const expiresAt of [new Date(NOW).toISOString(), "invalid", NOW + 60_000]) {
    record.value.expiresAt = expiresAt;
    await assert.rejects(service.price(actor, body), error => error.code === "PRODUCTION_PLAN_EXPIRED");
  }
});

test("invalid planning settings and rates cannot create a price or bypass the amount cap", async () => {
  const data = store(), production = createFilmProductionService({ ...data, now: () => NOW });
  const plan = await production.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: "fictional-prepare-request-001" });
  const body = { ...input(), preparedId: plan.id };
  for (const patch of [{ planningCreditsPerClip: 0 }, { planningCreditsPerClip: 1_000_001 }, { planningSecondsPerClip: 0 },
    { planningSecondsPerClip: 61 }, { planningSecondsPerClip: 1.5 }, { planningRendersPerClip: "2" }, { planningRendersPerClip: 21 },
    { markupBasisPoints: -1 }, { revision: -1 }])
    await assert.rejects(fixture({ filmProduction: production, pricingSettings: async () => ({ ...planningSettings, ...patch }) }).service.price(actor, body), unavailableError);
  for (const env of [{ MAGICLIGHT_API_PACK_PRICE_CENTS: "200" },
    { MAGICLIGHT_API_PACK_PRICE_CENTS: "100000000", MAGICLIGHT_API_PACK_CREDITS: "1" },
    { MAGICLIGHT_API_PACK_PRICE_CENTS: "1", MAGICLIGHT_API_PACK_CREDITS: "9007199254740991" }])
    await assert.rejects(fixture({ filmProduction: production, env }).service.price(actor, body), unavailableError);
  let time = NOW;
  [...data.records.values()][0].value.expiresAt = new Date(NOW + 60_000).toISOString();
  await assert.rejects(fixture({ filmProduction: production, now: () => time,
    pricingSettings: async () => { time += 60_000; return planningSettings; },
  }).service.price(actor, body), error => error.code === "PRODUCTION_PLAN_EXPIRED");
});

test("a malformed live quote never silently becomes a planning-rate price", async () => {
  for (const available of [true, undefined]) {
    const production = { readiness: () => ({ available }), getPrepared: async () => assert.fail("Must not estimate a live quote failure"),
      quoteForPayment: async () => { throw new FilmProductionError("Unverified live quote", 503, "PRODUCTION_UNAVAILABLE"); } };
    await assert.rejects(fixture({ filmProduction: production }).service.price(actor, input()), unavailableError);
  }
  const production = { readiness: () => ({ available: false }), getPrepared: async () => assert.fail("Must not estimate malformed provider output"),
    quoteForPayment: async () => ({ ...supplied(), providerCostCents: -1 }) };
  await assert.rejects(fixture({ filmProduction: production }).service.price(actor, input()), unavailableError);
});

test("trusted payment quotes retain planning cost snapshots without claiming provider readiness", async () => {
  const data = store(), production = createFilmProductionService({ ...data, now: () => NOW });
  const plan = await production.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: "fictional-prepare-request-001" });
  const service = fixture({ filmProduction: production }).service;
  const options = { preparedId: plan.id, idempotencyKey: input().idempotencyKey, environment: "sandbox" };
  const before = structuredClone([...data.records]);
  const quote = await service.quoteForPayment(project, actor, options);
  assert.deepEqual(quote, { preparedId: plan.id, manifestHash: plan.manifestHash, filmId: project.id, filmTitle: project.title,
    currency: "USD", providerCostCents: 94, expiresAt: new Date(NOW + 15 * 60_000).toISOString(), quoteReference: quote.quoteReference,
    environment: "sandbox", pricingBasis: "planning-rate", apiVerified: false, qualityVerified: false, commercialTermsVerified: false, pricingRevision: 2 });
  assert.match(quote.quoteReference, /^[a-f0-9]{64}$/);
  assert.deepEqual(await service.quoteForPayment(project, actor, options), quote);
  assert.equal((await service.quoteForPayment(project, actor, { ...options, environment: "production" })).environment, "production");
  assert.deepEqual([...data.records], before);
  for (const environment of [undefined, "unavailable", "Production"])
    await assert.rejects(service.quoteForPayment(project, actor, { ...options, environment }), unavailableError);
  const changed = await fixture({ filmProduction: production, settings: { ...planningSettings, planningCreditsPerClip: 300, revision: 3 } })
    .service.quoteForPayment(project, actor, options);
  assert.notEqual(changed.quoteReference, quote.quoteReference); assert.equal(changed.providerCostCents, 99);
});

test("trusted provider payment quotes preserve real verification flags and require a matching merchant environment", async () => {
  const h = fixture(), options = { preparedId, idempotencyKey: input().idempotencyKey, environment: "production" };
  const quote = await h.service.quoteForPayment(project, actor, options);
  assert.equal(quote.providerCostCents, 1000); assert.equal(quote.pricingBasis, "provider-quote");
  assert.equal(quote.apiVerified, true); assert.equal(quote.qualityVerified, true); assert.equal(quote.commercialTermsVerified, true);
  assert.equal(quote.quoteReference, supplied().quoteReference); assert.equal(quote.pricingSettings, undefined);
  await assert.rejects(h.service.quoteForPayment(project, actor, { ...options, environment: "sandbox" }), unavailableError);
});

test("owned immutable prepared plans can be priced by the real service with a verified test adapter and no writes", async () => {
  const data = store();
  // Fabricated in-process adapter evidence exercises the production branch; it
  // does not authorize any live provider or customer payment.
  const adapter = { id: "magiclight", environment: "production", available: true,
    evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true },
    outputHosts: ["media.example.invalid"], validateManifest: async () => ({ ready: true }),
    quote: async ({ manifestHash }) => ({ ...supplied(), manifestHash }),
    submitShot: async () => assert.fail("Pricing must not render"), reconcileShot: async () => {}, pollShot: async () => {} };
  const production = createFilmProductionService({ ...data, adapter, now: () => NOW });
  const plan = await production.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: "fictional-prepare-request-001" });
  const before = structuredClone([...data.records]);
  const service = fixture({ filmProduction: production }).service;
  const result = await service.price(actor, { ...input(), preparedId: plan.id });
  assert.equal(result.amountCents, 1500); assert.equal(result.preparedId, plan.id); assert.equal(result.manifestHash, plan.manifestHash);
  assert.deepEqual([...data.records], before);
  await assert.rejects(service.price({ ...actor, email: "other@example.invalid" }, { ...input(), preparedId: plan.id }), error => error.code === "PRODUCTION_NOT_FOUND" && error.status === 404);
  await assert.rejects(service.price(actor, { ...input(), project: { ...project, title: "A changed film" }, preparedId: plan.id }), error => error.code === "PRODUCTION_PLAN_CHANGED" && error.status === 409);
});

test("only the known unavailable adapter error is translated; all other errors are preserved", async () => {
  for (const error of [new FilmProductionError("Not yours", 404, "PRODUCTION_NOT_FOUND"),
    new FilmProductionError("Review your plan", 409, "PRODUCTION_REVIEW_REQUIRED"), new Error("storage unavailable"),
    new FilmProductionError("Different status", 409, "PRODUCTION_UNAVAILABLE")]) {
    const service = fixture({ filmProduction: { quoteForPayment: async () => { throw error; } } }).service;
    await assert.rejects(service.price(actor, input()), thrown => thrown === error);
  }
});

function routeHarness(overrides = {}) {
  const calls = { quotes: 0, limits: [], pricing: 0 };
  const never = async () => assert.fail("A film price must not access payments, billing, CAPTCHA or persisted payment records");
  const handler = createStudioHandler({ getSession: async () => ({ user: actor }),
    filmProduction: { quoteForPayment: async () => { calls.quotes++; return { ...supplied(), expiresAt: "2099-01-01T00:00:00.000Z" }; } },
    readPricingSettings: async () => { calls.pricing++; return { markupBasisPoints: 5000, revision: 2 }; },
    payments: { quote: never, checkout: never, checkoutConfiguration: never },
    connections: never, readRecord: never, writeRecord: never, captcha: { prepareCheckout: never, consumeCheckout: never },
    limitAction: async (...args) => { calls.limits.push(args); return true; }, ...overrides });
  async function run({ method = "POST", headers = {}, body = { action: "price", ...input() } } = {}) {
    let status, output;
    await handler({ method, url: "/api/studio?action=price", headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com", ...headers }, body },
      { set statusCode(value) { status = value; }, setHeader() {}, end(value) { output = JSON.parse(value); } });
    return { status, body: output };
  }
  return { calls, run };
}

test("studio price POST is independently limited and returns a numeric price with billing absent", async () => {
  const h = routeHarness(), result = await h.run();
  assert.equal(result.status, 200); assert.equal(result.body.amountCents, 1500);
  assert.equal(h.calls.quotes, 1); assert.equal(h.calls.pricing, 1);
  assert.deepEqual(h.calls.limits, [[`price:${actor.email}`, 20, 3_600_000]]);
  const bad = await h.run({ body: { action: "price", ...input(), amountCents: 1 } });
  assert.equal(bad.status, 400); assert.equal(h.calls.quotes, 1);
});

test("studio price uses the same approved legacy owner role as the studio session", async () => {
  const legacy = { email: OWNER_EMAIL, role: "owner" };
  const h = routeHarness({ getSession: async () => ({ user: legacy }) });
  const result = await h.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.amountCents, 1500);
  assert.equal(h.calls.quotes, 1);
  assert.deepEqual(h.calls.limits, [[`price:${legacy.email}`, 20, 3_600_000]]);
});

test("studio price enforces POST, same origin, session approval and rate limit before provider access", async () => {
  for (const [overrides, request, expectedStatus] of [
    [{}, { method: "GET" }, 400], [{}, { headers: { origin: "https://other.example.invalid" } }, 403],
    [{ getSession: async () => null }, {}, 401],
    [{ getSession: async () => ({ user: { ...actor, approvedAt: undefined } }) }, {}, 401],
    [{ limitAction: async () => false }, {}, 429],
  ]) {
    const h = routeHarness(overrides), result = await h.run(request);
    assert.equal(result.status, expectedStatus); assert.equal(h.calls.quotes, 0); assert.equal(h.calls.pricing, 0);
  }
  const unavailable = { quoteForPayment: async () => { throw new FilmProductionError("Unavailable", 503, "PRODUCTION_UNAVAILABLE"); } };
  const result = await routeHarness({ filmProduction: unavailable }).run();
  assert.deepEqual(result, { status: 503, body: { code: "PRICE_UNAVAILABLE", message: unavailableMessage } });
});
