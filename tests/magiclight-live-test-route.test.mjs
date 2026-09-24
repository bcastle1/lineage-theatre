import test from "node:test";
import assert from "node:assert/strict";
import { createAdminHandler } from "../api/admin.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const owner = { email: OWNER_EMAIL, role: "owner", status: "active" };
function fixture(actor = owner, limit = true) {
  const calls = [], events = [];
  const result = { productionReady: false, customerFulfillment: false, test: { status: "submitted", submissionCount: 1 } };
  const handler = createAdminHandler({ getSession: async () => actor ? { user: actor } : null,
    limitAction: async () => limit, audit: async (...event) => events.push(event),
    magiclightLiveTest: Object.fromEntries(["status", "submit", "check"].map(method => [method, async (...args) => { calls.push({ method, args }); return result; }])) });
  return { calls, events, async run({ action = "submitMagicLightLiveTest", method = "POST", fields = { consent: true }, origin = "https://lineagetheater.com" } = {}) {
    let status, body; const headers = {};
    await handler({ method, url: `/api/admin?action=${action}`, headers: { host: "lineagetheater.com", origin },
      ...(method === "POST" ? { body: { action, ...fields } } : {}) }, {
      set statusCode(value) { status = value; }, setHeader(name, value) { headers[name] = value; }, end(value) { body = JSON.parse(value); },
    });
    return { status, body, headers };
  } };
}

test("live generation is owner-only with same-origin explicit consent and no caller-selected provider input", async () => {
  for (const actor of [null, { email: "customer@example.invalid", role: "customer", status: "active" },
    { email: "admin@example.invalid", role: "admin", status: "active" }, { ...owner, status: "suspended" }, { ...owner, mustChangePassword: true }]) {
    const h = fixture(actor);
    assert.ok([401, 403].includes((await h.run()).status));
    assert.ok([401, 403].includes((await h.run({ method: "GET", action: "magicLightLiveTest" })).status));
    assert.equal(h.calls.length, 0);
  }
  const h = fixture();
  assert.equal((await h.run({ origin: "https://another.invalid" })).status, 403);
  for (const fields of [{}, { consent: false }, { consent: true, text: "another film" }, { consent: true, imageUrl: "https://other.invalid" },
    { consent: true, apiKey: "private" }, { consent: true, taskId: "other" }, { consent: true, idempotencyKey: "another" }]) {
    assert.equal((await h.run({ fields })).status, 400);
  }
  assert.equal(h.calls.length, 0);
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls, [{ method: "submit", args: [owner, { consent: true }] }]);
  assert.equal(response.body.productionReady, false);
  assert.equal(response.body.customerFulfillment, false);
  assert.match(response.headers["Cache-Control"], /no-store/);
});

test("saved live-test reads and checks cannot submit another task", async () => {
  const h = fixture();
  assert.equal((await h.run({ method: "GET", action: "magicLightLiveTest" })).status, 200);
  assert.equal((await h.run({ action: "checkMagicLightLiveTest", fields: {} })).status, 200);
  assert.deepEqual(h.calls.map(call => call.method), ["status", "check"]);
  assert.equal((await h.run({ method: "GET", action: "submitMagicLightLiveTest" })).status, 400);
  assert.equal((await h.run({ action: "checkMagicLightLiveTest", fields: { taskId: "another" } })).status, 400);
  assert.equal(h.calls.length, 2);
  const limited = fixture(owner, false);
  assert.equal((await limited.run()).status, 429);
  assert.equal(limited.calls.length, 0);
});
