import test from "node:test";
import assert from "node:assert/strict";
import { createStudioHandler } from "../api/studio.mjs";
import { FilmProductionError } from "../api/_lib/film-production.mjs";

const user = { email: "customer@example.invalid", role: "customer", status: "active" };
async function request(handler, action, body) {
  let status, result;
  await handler({ method: body ? "POST" : "GET", url: `/api/studio?action=${action}&id=00000000-0000-4000-8000-000000000001`,
    headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com" }, ...(body ? { body: { ...body, action } } : {}) },
  { set statusCode(value) { status = value; }, setHeader() {}, end(value) { result = JSON.parse(value); } });
  return { status, result };
}

test("failed production lookups never assert an order was not charged", async () => {
  const unavailable = async () => { throw new FilmProductionError("This production does not belong to your account.", 404, "PRODUCTION_NOT_FOUND"); };
  const handler = createStudioHandler({ getSession: async () => ({ user }), filmProduction: { status: unavailable, manifest: unavailable } });
  for (const action of ["productionStatus", "manifest"]) {
    const response = await request(handler, action);
    assert.equal(response.status, 404);
    assert.equal(Object.hasOwn(response.result, "charged"), false);
  }
});

test("throttled payment retries leave previous charge status unknown and never call the payment service", async () => {
  let calls = 0;
  const handler = createStudioHandler({ getSession: async () => ({ user }), limitAction: async () => false,
    payments: { quote: async () => { calls++; }, checkout: async () => { calls++; } } });
  for (const action of ["quote", "checkout"]) {
    const response = await request(handler, action, { idempotencyKey: "repeated-existing-order-request" });
    assert.equal(response.status, 429); assert.equal(response.result.charged, null);
    assert.match(response.result.message, /Check an existing order/);
  }
  assert.equal(calls, 0);
});
