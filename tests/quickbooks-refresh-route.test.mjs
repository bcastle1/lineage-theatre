import test from "node:test";
import assert from "node:assert/strict";
import { createQuickBooksHandler } from "../api/quickbooks.mjs";
import { QuickBooksError } from "../api/_lib/quickbooks.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const OWNER = { email: OWNER_EMAIL, role: "owner", status: "active" };
function harness({ actor = OWNER, allowed = true, failure } = {}) {
  const calls = [];
  const handler = createQuickBooksHandler({
    sessionFor: async () => actor ? { user: actor } : null,
    limiter: async () => allowed,
    service: { refresh: async (...args) => {
      calls.push(args);
      if (failure) throw failure;
      return { connected: true, refreshed: true, revision: 7, paymentReady: false, refundReady: false };
    } },
  });
  return { calls, async run({ method = "POST", body = { action: "refresh", expectedRevision: 5 }, headers = {} } = {}) {
    let status, result;
    const responseHeaders = {};
    await handler({ method, url: "/api/quickbooks?action=refresh", body: body === null ? "null" : body,
      headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com", ...headers } }, {
      set statusCode(value) { status = value; },
      setHeader(key, value) { responseHeaders[key] = value; },
      end(value) { result = JSON.parse(value); },
    });
    return { status, body: result, headers: responseHeaders };
  } };
}

test("owner may renew the saved authorization once with only its expected revision", async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.status, 200);
  assert.deepEqual(h.calls, [[OWNER, { expectedRevision: 5 }]]);
  assert.equal(result.body.refreshed, true);
  assert.equal(result.body.paymentReady, false);
  assert.match(result.headers["Cache-Control"], /no-store/);
});

test("refresh enforces owner session, canonical origin, and POST before touching the grant", async () => {
  for (const [actor, expected] of [[null, 401], [{ email: "admin@example.invalid", role: "admin", status: "active" }, 403],
    [{ email: "customer@example.invalid", role: "customer", status: "active" }, 403]]) {
    const h = harness({ actor }); assert.equal((await h.run()).status, expected); assert.equal(h.calls.length, 0);
  }
  for (const headers of [{ origin: "https://other.invalid" }, { origin: "https://www.lineagetheater.com" },
    { host: "other.invalid" }, { origin: undefined }]) {
    const h = harness(); assert.equal((await h.run({ headers })).status, 403); assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal((await h.run({ method: "GET" })).status, 405); assert.equal(h.calls.length, 0);
});

test("refresh cannot accept injected credentials, endpoints, grant identity, or invalid revisions", async () => {
  for (const body of [null, [], { action: "refresh" }, ...[-1, 1.5, "5", Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => ({ action: "refresh", expectedRevision })),
    ...["token", "realmId", "environment", "url", "accessToken", "refreshToken"].map(key => ({ action: "refresh", expectedRevision: 5, [key]: "synthetic" }))]) {
    const h = harness(); assert.equal((await h.run({ body })).status, 400); assert.equal(h.calls.length, 0);
  }
});

test("refresh respects throttling and never retries uncertain provider outcomes", async () => {
  const limited = harness({ allowed: false });
  assert.equal((await limited.run()).status, 429); assert.equal(limited.calls.length, 0);
  for (const [failure, expected] of [[new QuickBooksError("Review the saved authorization.", 409, "QUICKBOOKS_REFRESH_BLOCKED"), 409],
    [new Error("synthetic-secret-must-not-be-returned"), 503]]) {
    const h = harness({ failure }), result = await h.run();
    assert.equal(result.status, expected); assert.equal(h.calls.length, 1);
    assert.equal(JSON.stringify(result.body).includes("synthetic-secret"), false);
    assert.equal(result.body.paymentReady, false);
  }
});
