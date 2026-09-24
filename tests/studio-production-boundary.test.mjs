import { captchaStub } from "./fixtures/captcha.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { connections, createStudioHandler } from "../api/studio.mjs";
import { createFilmProductionService, FilmProductionError } from "../api/_lib/film-production.mjs";
import { productionReadiness } from "../api/_lib/production.mjs";

const user = { email: "customer@example.invalid", role: "customer", status: "active" };
const fixtureAdapter = () => ({ id: "magiclight", environment: "production", available: true,
  evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true },
  ...Object.fromEntries(["quote", "submitShot", "reconcileShot", "pollShot", "validateManifest"].map(name => [name, async () => { throw new Error("Readiness must not make provider requests."); }])) });
async function request(handler, action, body) {
  let status, result;
  await handler({ method: body ? "POST" : "GET", url: `/api/studio?action=${action}&id=00000000-0000-4000-8000-000000000001`,
    headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com" }, ...(body ? { body: { ...body, action } } : {}) },
  { set statusCode(value) { status = value; }, setHeader() {}, end(value) { result = JSON.parse(value); } });
  return { status, result };
}

test("failed production lookups never assert an order was not charged", async () => {
  const unavailable = async () => { throw new FilmProductionError("This production does not belong to your account.", 404, "PRODUCTION_NOT_FOUND"); };
  const handler = createStudioHandler({ captcha: captchaStub, getSession: async () => ({ user }), filmProduction: { status: unavailable, manifest: unavailable } });
  for (const action of ["productionStatus", "manifest"]) {
    const response = await request(handler, action);
    assert.equal(response.status, 404);
    assert.equal(Object.hasOwn(response.result, "charged"), false);
  }
});

test("customer production capabilities follow the same configured film service", async () => {
  const service = createFilmProductionService({ adapter: fixtureAdapter() });
  const handler = createStudioHandler({ getSession: async () => ({ user }), filmProduction: service,
    connections: options => connections({ ...options, key: null }), readPricingSettings: async () => ({ markupBasisPoints: 0, revision: 0 }),
    hostedCheckout: { configuration: async () => ({ available: true }) } });
  const response = await request(handler, "capabilities");
  assert.equal(response.status, 200);
  assert.equal(response.result.production, true);
  assert.equal(response.result.quality.verified, true);
  assert.equal(response.result.billing, true);
  assert.doesNotMatch(JSON.stringify(response.result), /magiclight|quoteReference|apiVerified|commercialTermsVerified/i);
});

test("sandbox, incomplete and failed provider configuration never enables customer production", () => {
  const good = fixtureAdapter();
  for (const adapter of [{ ...good, environment: "sandbox" }, { ...good, available: false },
    { ...good, evidence: { ...good.evidence, reconciliationVerified: false } }, { ...good, submitShot: undefined }]) {
    const readiness = productionReadiness({ filmService: createFilmProductionService({ adapter }) });
    assert.equal(readiness.magiclight, false);
    assert.equal(readiness.quality.verified, false);
  }
  assert.equal(productionReadiness({ filmService: { readiness() { throw new Error("Unavailable"); } } }).magiclight, false);
});

test("throttled payment retries leave previous charge status unknown and never call the payment service", async () => {
  let calls = 0;
  const handler = createStudioHandler({ captcha: captchaStub, getSession: async () => ({ user }), limitAction: async () => false,
    payments: { quote: async () => { calls++; }, checkout: async () => { calls++; } } });
  for (const action of ["quote", "checkout"]) {
    const response = await request(handler, action, { idempotencyKey: "repeated-existing-order-request" });
    assert.equal(response.status, 429); assert.equal(response.result.charged, null);
    assert.match(response.result.message, /Check an existing order/);
  }
  assert.equal(calls, 0);
});
