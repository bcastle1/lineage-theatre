import test from "node:test";
import assert from "node:assert/strict";
import { checkMagicLightConnection } from "../api/_lib/magiclight-diagnostics.mjs";
import { MagicLightClientError } from "../api/_lib/magiclight-client.mjs";
import { createAdminHandler } from "../api/admin.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const secret = "fixture-private-key-never-return";
test("saved-key check reads only a fresh task reference at the fixed production origin", async () => {
  const tasks = [];
  const options = { apiKey: secret, clientFactory: configuration => {
    assert.deepEqual(configuration, { apiKey: secret, environment: "production", enableSubmission: false, requestTimeoutMs: 15_000 });
    return { async checkTask({ taskId }) { tasks.push(taskId); return { providerCode: 10000, taskStatus: 0, videoUrl: "private-fixture-output" }; },
      submitTask() { assert.fail("No generation may be submitted"); } };
  } };
  for (let i = 0; i < 2; i++) {
    const result = await checkMagicLightConnection(options);
    assert.equal(result.authentication, "unconfirmed"); assert.equal(result.code, "MAGICLIGHT_STATUS_RECEIVED");
    assert.equal(result.productionReady, false); assert.equal(result.generationSubmitted, false);
    assert.equal(result.origin, "https://open.magiclight.ai");
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-output|fixture-private-key-never-return|lineage_probe_/);
  }
  assert.match(tasks[0], /^lineage_probe_[a-f0-9-]{36}$/); assert.notEqual(tasks[0], tasks[1]);
});

test("unknown business codes do not prove authentication or disclose provider messages", async () => {
  const result = await checkMagicLightConnection({ apiKey: secret, clientFactory: () => ({ checkTask: async () => ({ providerCode: 12345, message: secret }) }) });
  assert.equal(result.authentication, "unconfirmed"); assert.equal(result.providerCode, 12345);
  assert.equal(result.code, "MAGICLIGHT_STATUS_UNCONFIRMED"); assert.equal(JSON.stringify(result).includes(secret), false);
});

test("missing configuration never sends a request and transport failures are redacted", async () => {
  let calls = 0;
  const absent = await checkMagicLightConnection({ apiKey: "", clientFactory() { calls++; } });
  assert.equal(absent.configured, false); assert.equal(calls, 0);
  for (const error of [new Error(secret), new MagicLightClientError(secret),
    new MagicLightClientError("MAGICLIGHT_HTTP_REJECTED", { httpStatus: 401, message: secret }),
    new MagicLightClientError("MAGICLIGHT_HTTP_REJECTED", { httpStatus: 403, message: secret }),
    new MagicLightClientError("MAGICLIGHT_TIMEOUT", { message: secret })]) {
    const result = await checkMagicLightConnection({ apiKey: secret, clientFactory: () => ({ checkTask: async () => { throw error; } }) });
    assert.equal(result.authentication, error.httpStatus === 401 ? "rejected" : "unconfirmed");
    assert.equal(result.productionReady, false); assert.equal(result.generationSubmitted, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

const owner = { email: OWNER_EMAIL, role: "owner", status: "active" };
function harness(actor = owner, overrides = {}) {
  let calls = 0;
  const events = [], limits = [];
  const handler = createAdminHandler({ getSession: async () => actor ? { user: actor } : null,
    limitAction: async (...args) => { limits.push(args); return true; }, audit: async (...args) => events.push(args),
    checkMagicLightConnection: async () => { calls++; return { code: "MAGICLIGHT_STATUS_UNCONFIRMED", authentication: "unconfirmed", productionReady: false, generationSubmitted: false }; }, ...overrides });
  return { get calls() { return calls; }, events, limits, async run({ method = "POST", fields = {}, origin = "https://lineagetheater.com" } = {}) {
    let status, body; const headers = {};
    await handler({ method, url: "/api/admin?action=checkMagicLightConnection", headers: { host: "lineagetheater.com", origin },
      ...(method === "POST" ? { body: { action: "checkMagicLightConnection", ...fields } } : {}) },
    { set statusCode(value) { status = value; }, setHeader(name, value) { headers[name] = value; }, end(value) { body = JSON.parse(value); } });
    return { status, body, headers };
  } };
}
test("only an active owner may explicitly check the saved key, with no caller-selected input", async () => {
  for (const actor of [null, { email: "user@example.invalid", role: "customer", status: "active" },
    { email: "admin@example.invalid", role: "admin", status: "active" }, { ...owner, status: "suspended" }, { ...owner, mustChangePassword: true }]) {
    const h = harness(actor); assert.ok([401, 403].includes((await h.run()).status)); assert.equal(h.calls, 0);
  }
  const h = harness();
  assert.equal((await h.run({ origin: "https://other.invalid" })).status, 403);
  assert.equal((await h.run({ method: "GET" })).status, 400);
  for (const fields of [{ apiKey: secret }, { taskId: "existing-customer-task" }, { origin: "https://other.invalid" }, { text: "generate something" }])
    assert.equal((await h.run({ fields })).status, 400);
  assert.equal(h.calls, 0);
  const result = await h.run(); assert.equal(result.status, 200); assert.equal(h.calls, 1);
  assert.match(result.headers["Cache-Control"], /no-store/);
  assert.deepEqual(h.events, [[OWNER_EMAIL, "production.connection.checked", "magiclight", { code: "MAGICLIGHT_STATUS_UNCONFIRMED", authentication: "unconfirmed" }]]);
  assert.ok(h.limits.some(([key, max, window]) => key.startsWith("magiclight-check:") && max === 3 && window === 60_000));
});
test("throttled owner checks never call the provider", async () => {
  const h = harness(owner, { limitAction: async key => !key.startsWith("magiclight-check:") });
  assert.equal((await h.run()).status, 429); assert.equal(h.calls, 0);
});
