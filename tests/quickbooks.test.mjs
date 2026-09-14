import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createQuickBooksHandler } from "../api/quickbooks.mjs";
import { userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { createQuickBooksService, quickbooksConfig, encryptQuickBooksTokens, decryptQuickBooksTokens,
  QUICKBOOKS_CONNECTION_PATH, QUICKBOOKS_SCOPES, QUICKBOOKS_CALLBACK, QUICKBOOKS_STATE_COOKIE,
  INTUIT_AUTHORIZE, INTUIT_TOKEN, INTUIT_REVOKE, quickbooksStatePath, readQuickBooksStateCookie,
  callbackLocation } from "../api/_lib/quickbooks.mjs";

const OWNER = { email: OWNER_EMAIL, name: "Test owner", passwordHash: "synthetic-password-hash", role: "owner", status: "active" };
const ADMIN = { email: "admin@example.invalid", role: "admin", status: "active" };
const CUSTOMER = { email: "customer@example.invalid", role: "customer", status: "active" };
const ACCESS = "synthetic-access-token-only";
const REFRESH = "synthetic-refresh-token-only";
const REALM = "123456789012345";
function testEnv() { return { QUICKBOOKS_ENVIRONMENT: "sandbox", QUICKBOOKS_CLIENT_ID: "synthetic-client-id",
  QUICKBOOKS_CLIENT_SECRET: "synthetic-client-secret", QUICKBOOKS_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") }; }
function tokenResponse(extra = {}) { return new Response(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, token_type: "bearer", expires_in: 3600, x_refresh_token_expires_in: 8_726_400, ...extra }), { status: 200 }); }
function harness(options = {}) {
  let tick = Date.parse("2026-09-14T00:00:00Z"), nextEtag = 0, actor = options.actor === undefined ? OWNER : options.actor;
  const records = new Map(), calls = [], events = [], env = options.env || testEnv();
  const putRecord = (path, value) => { const record = { value: structuredClone(value), etag: `etag-${++nextEtag}` }; records.set(path, record); return structuredClone(record); };
  putRecord(userPath(OWNER.email), OWNER);
  const read = async path => { await options.beforeRead?.(path); return records.has(path) ? structuredClone(records.get(path)) : null; };
  const write = async (path, value, etag) => {
    if ((records.has(path) && records.get(path).etag !== etag) || (!records.has(path) && etag)) throw new Error("Precondition failed");
    const result = putRecord(path, value);
    await options.afterWrite?.(path, value);
    return result;
  };
  let fetcher = async () => tokenResponse();
  const serviceOptions = { env, read, write, now: () => tick,
    fetchImpl: async (...args) => { calls.push(args); return fetcher(...args); }, auditImpl: async (...args) => { events.push(args); await options.afterAudit?.(...args); } };
  const service = createQuickBooksService(serviceOptions);
  const handler = createQuickBooksHandler({ service, sessionFor: async () => actor ? { user: structuredClone(actor) } : null,
    limiter: async () => options.allowed !== false });
  async function run(method = "GET", query = "action=status", body, headers = {}) {
    let status, text;
    const responseHeaders = {};
    await handler({ method, url: `/api/quickbooks?${query}`, headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com", ...headers }, ...(body ? { body } : {}) },
      { set statusCode(v) { status = v; }, setHeader(k, v) { responseHeaders[k.toLowerCase()] = v; }, end(v) { text = v; } });
    return { status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
  }
  async function start(extra = {}) {
    const revision = records.get(QUICKBOOKS_CONNECTION_PATH)?.value.revision || 0;
    const result = await service.start(OWNER, { expectedRevision: revision, ...extra });
    const state = new URL(result.authorizationUrl).searchParams.get("state");
    const cookie = result.stateCookie.split(";")[0].split("=")[1];
    const query = new URLSearchParams({ action: "callback", state, code: "synthetic-code", realmId: REALM });
    return { ...result, state, cookie, query };
  }
  async function authorize(extra = {}) { const attempt = await start(extra); await service.callback(attempt.query, attempt.cookie); return attempt; }
  return { env, records, calls, events, service, run, start, authorize, putRecord,
    peer: () => createQuickBooksService(serviceOptions),
    setActor: value => { actor = value; }, setFetch: value => { fetcher = value; }, advance: ms => { tick += ms; } };
}

test("OAuth diagnostics capture bounded support correlation metadata without credential payloads", async () => {
  const h = harness(), tid = "12345678-abcd-4321-baad-123456789abc";
  h.setFetch(async () => {
    const response = tokenResponse(); response.headers.set("intuit_tid", tid); return response;
  });
  await h.authorize();
  const providerEvents = h.events.filter(event => event[1] === "quickbooks.provider.request");
  assert.equal(providerEvents.length, 1);
  assert.deepEqual(providerEvents[0][3], { operation: "token-exchange", at: "2026-09-14T00:00:00.000Z", httpStatus: 200,
    intuitTid: tid, code: "HTTP_RESPONSE", outcome: "response-received" });
  for (const secret of [ACCESS, REFRESH, REALM, "synthetic-code", h.env.QUICKBOOKS_CLIENT_SECRET])
    assert.equal(JSON.stringify(providerEvents).includes(secret), false);
  assert.equal(JSON.stringify(await h.service.status(OWNER)).includes(tid), false);
});

test("a correlation audit failure cannot turn a successful OAuth exchange into a duplicate or revoked grant", async () => {
  const h = harness({ afterAudit: async (...event) => {
    if (event[1] === "quickbooks.provider.request") throw new Error("synthetic audit unavailable");
  } });
  await h.authorize();
  assert.equal(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.status, "authorized");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], INTUIT_TOKEN);
});

test("QuickBooks config requires explicit allowlisted environment, app credentials, and a dedicated canonical encryption key", () => {
  const env = testEnv();
  assert.equal(quickbooksConfig(env).environment, "sandbox");
  assert.equal(quickbooksConfig({ ...env, QUICKBOOKS_ENVIRONMENT: "production" }).environment, "production");
  for (const key of Object.keys(env)) assert.throws(() => quickbooksConfig({ ...env, [key]: "" }), /setup is incomplete/);
  for (const value of ["staging", "production/evil", "https://evil.invalid", undefined])
    assert.throws(() => quickbooksConfig({ ...env, QUICKBOOKS_ENVIRONMENT: value }), /setup is incomplete/);
  assert.throws(() => quickbooksConfig({ ...env, QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "x".repeat(32) }), /setup is incomplete/);
  assert.throws(() => quickbooksConfig({ ...env, QUICKBOOKS_CLIENT_ID: "bad\nvalue" }), /setup is incomplete/);
});

test("AES-GCM ciphertext hides tokens and rejects tampering, key changes, app/environment changes, and envelope swaps", () => {
  const env = testEnv(), config = quickbooksConfig(env), payload = { accessToken: ACCESS, refreshToken: REFRESH, realmId: REALM };
  const encrypted = encryptQuickBooksTokens(payload, config), second = encryptQuickBooksTokens(payload, config);
  assert.deepEqual(decryptQuickBooksTokens(encrypted, config), payload);
  assert.notEqual(encrypted.iv, second.iv);
  for (const text of [ACCESS, REFRESH, REALM]) assert.equal(JSON.stringify(encrypted).includes(text), false);
  for (const field of ["tag", "iv", "ciphertext"]) {
    const bytes = Buffer.from(encrypted[field], "base64"); bytes[0] ^= 1;
    assert.throws(() => decryptQuickBooksTokens({ ...encrypted, [field]: bytes.toString("base64") }, config), /cannot be read/);
  }
  assert.throws(() => decryptQuickBooksTokens({ ...encrypted, secretId: second.secretId }, config), /cannot be read/);
  assert.throws(() => decryptQuickBooksTokens(encrypted, quickbooksConfig(testEnv())), /cannot be read/);
  assert.throws(() => decryptQuickBooksTokens(encrypted, quickbooksConfig({ ...env, QUICKBOOKS_ENVIRONMENT: "production" })), /cannot be read/);
  assert.throws(() => decryptQuickBooksTokens(encrypted, quickbooksConfig({ ...env, QUICKBOOKS_CLIENT_ID: "other-app" })), /cannot be read/);
});

test("only administrators read status and only the owner starts or disconnects", async () => {
  for (const actor of [null, CUSTOMER]) {
    const h = harness({ actor });
    assert.equal((await h.run()).status, actor ? 403 : 401);
    for (const action of ["start", "disconnect"]) assert.equal((await h.run("POST", "", { action, expectedRevision: 0 })).status, actor ? 403 : 401);
    assert.equal(h.calls.length, 0); assert.equal(h.records.size, 1);
  }
  const admin = harness({ actor: ADMIN });
  assert.equal((await admin.run()).status, 200);
  for (const action of ["start", "disconnect"]) assert.equal((await admin.run("POST", "", { action, expectedRevision: 0 })).status, 403);
  const ownerAddressOnly = harness({ actor: { ...OWNER, role: "customer" } });
  assert.equal((await ownerAddressOnly.run("POST", "", { action: "start", expectedRevision: 0 })).status, 403);
});

test("connection writes require canonical same-origin POST and obey request limits", async () => {
  const h = harness();
  for (const headers of [{ origin: "https://evil.invalid" }, { origin: "http://lineagetheater.com" }, { host: "www.lineagetheater.com", origin: "https://www.lineagetheater.com" }, { origin: "" }])
    assert.equal((await h.run("POST", "", { action: "start", expectedRevision: 0 }, headers)).status, 403);
  assert.equal((await h.run("GET", "action=start")).status, 405);
  assert.equal((await h.run("GET", "action=disconnect")).status, 405);
  assert.equal((await h.run("POST", "action=callback", {})).status, 405);
  assert.equal(h.records.size, 1);
  assert.equal((await harness({ allowed: false }).run("POST", "", { action: "start", expectedRevision: 0 })).status, 429);
});

test("unconfigured status fails closed without exposing values; no provider calls occur", async () => {
  const h = harness({ env: {} }), result = await h.run();
  assert.equal(result.body.configured, false); assert.equal(result.body.connected, false);
  assert.equal(result.body.authorizationStatus, "not-configured");
  assert.equal(result.body.paymentReady, false); assert.equal(result.body.refundReady, false);
  assert.equal((await h.run("POST", "", { action: "start", expectedRevision: 0 })).status, 503);
  assert.equal(h.records.size, 1); assert.equal(h.calls.length, 0);
});

test("start binds a hashed state and separate secure Lax cookie to owner version; redirect/scopes are fixed", async () => {
  const h = harness(), result = await h.run("POST", "", { action: "start", expectedRevision: 0, redirectUri: "https://evil.invalid", scope: "openid" });
  assert.equal(result.status, 200);
  const url = new URL(result.body.authorizationUrl), state = url.searchParams.get("state");
  assert.equal(`${url.origin}${url.pathname}`, INTUIT_AUTHORIZE);
  assert.equal(url.searchParams.get("redirect_uri"), QUICKBOOKS_CALLBACK);
  assert.equal(url.searchParams.get("scope"), QUICKBOOKS_SCOPES.join(" "));
  const cookieHeader = result.headers["set-cookie"], cookie = readQuickBooksStateCookie({ headers: { cookie: cookieHeader.split(";")[0] } });
  assert.match(cookieHeader, /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600/);
  assert.match(state, /^[a-f0-9]{64}$/); assert.match(cookie, /^[a-f0-9]{64}$/); assert.notEqual(state, cookie);
  const stored = h.records.get(quickbooksStatePath(state)).value;
  assert.equal(stored.ownerEmail, OWNER.email); assert.equal(stored.connectionRevision, 1);
  const persisted = JSON.stringify([...h.records.values()]);
  assert.equal(persisted.includes(state), false); assert.equal(persisted.includes(cookie), false);
  assert.equal(JSON.stringify(h.events).includes(state), false);
  assert.equal(result.body.stateCookie, undefined); assert.equal(h.calls.length, 0);
});

test("callback does not need the Strict session cookie; it saves only ciphertext and redirects without query secrets", async () => {
  const h = harness(); h.setFetch(async () => tokenResponse({ scope: QUICKBOOKS_SCOPES.join(" "), realmId: REALM }));
  const attempt = await h.start(); h.setActor(null);
  const result = await h.run("GET", attempt.query.toString(), undefined, { cookie: `${QUICKBOOKS_STATE_COOKIE}=${attempt.cookie}`, origin: undefined });
  assert.equal(result.status, 302); assert.equal(result.headers.location, callbackLocation("connected"));
  assert.equal(result.headers["cache-control"], "no-cache, no-store"); assert.equal(result.headers["pragma"], "no-cache"); assert.equal(result.headers["referrer-policy"], "no-referrer");
  assert.equal(result.headers["set-cookie"], undefined, "late callback responses must not erase a newer nonce cookie");
  const [url, request] = h.calls[0];
  assert.equal(url, INTUIT_TOKEN); assert.equal(request.method, "POST"); assert.equal(request.redirect, "error");
  assert.equal(request.headers["Content-Type"], "application/x-www-form-urlencoded"); assert.ok(request.signal);
  const form = new URLSearchParams(request.body);
  assert.equal(form.get("grant_type"), "authorization_code"); assert.equal(form.get("redirect_uri"), QUICKBOOKS_CALLBACK);
  const persisted = JSON.stringify([...h.records.values()]);
  for (const secret of [ACCESS, REFRESH, "synthetic-code", h.env.QUICKBOOKS_CLIENT_SECRET]) assert.equal(persisted.includes(secret), false);
  h.setActor(OWNER);
  const status = (await h.run()).body;
  assert.equal(status.connected, true); assert.equal(status.realmId, REALM);
  assert.equal(status.scopeVerification, "token-response"); assert.equal(status.realmVerification, "token-response-matched");
  assert.equal(status.paymentReady, false); assert.equal(status.refundReady, false);
  for (const secret of [ACCESS, REFRESH, h.env.QUICKBOOKS_CLIENT_SECRET]) assert.equal(JSON.stringify(status).includes(secret), false);
});

test("callback keeps missing scope/realm attestation uncertain; token expiry is not connected", async () => {
  const h = harness(); await h.authorize();
  let status = await h.service.status();
  assert.equal(status.scopeVerification, "not-returned"); assert.equal(status.grantedScopes, null);
  assert.equal(status.realmVerification, "callback-only");
  h.advance(3_600_001); status = await h.service.status();
  assert.equal(status.connected, false); assert.equal(status.authorizationStatus, "expired");
  assert.equal(h.calls.length, 1, "status must not automatically refresh or retry");
});

test("CSRF, duplicate callback parameters, expired state, and changed owner credentials fail before token exchange", async () => {
  for (const variant of ["cookie", "duplicate-cookie", "duplicate-state", "expired", "password", "password-setup", "suspended", "role", "config"]) {
    const h = harness(), attempt = await h.start(); let cookie = attempt.cookie;
    if (variant === "cookie") cookie = randomBytes(32).toString("hex");
    if (variant === "duplicate-state") attempt.query.append("state", attempt.state);
    if (variant === "expired") h.advance(600_001);
    if (variant === "password") h.putRecord(userPath(OWNER.email), { ...OWNER, passwordHash: "changed" });
    if (variant === "password-setup") h.putRecord(userPath(OWNER.email), { ...OWNER, mustChangePassword: true });
    if (variant === "suspended") h.putRecord(userPath(OWNER.email), { ...OWNER, status: "suspended" });
    if (variant === "role") h.putRecord(userPath(OWNER.email), { ...OWNER, role: "customer" });
    if (variant === "config") h.env.QUICKBOOKS_CLIENT_ID = "different-app";
    if (variant === "duplicate-cookie") cookie = readQuickBooksStateCookie({ headers: { cookie: `${QUICKBOOKS_STATE_COOKIE}=${cookie}; ${QUICKBOOKS_STATE_COOKIE}=${cookie}` } });
    await assert.rejects(() => h.service.callback(attempt.query, cookie), /expired or no longer current/);
    assert.equal(h.calls.length, 0, variant);
  }
});

test("single-use CAS permits only one of racing callback exchanges and refuses replay", async () => {
  const h = harness(), attempt = await h.start();
  const results = await Promise.allSettled([h.service.callback(attempt.query, attempt.cookie), h.service.callback(attempt.query, attempt.cookie)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.calls.length, 1);
  await assert.rejects(() => h.service.callback(attempt.query, attempt.cookie), /expired or no longer current/);
  assert.equal(h.calls.length, 1);
});

test("concurrent starts select one durable attempt and pending states never report connected", async () => {
  const h = harness();
  const results = await Promise.allSettled([h.service.start(OWNER, { expectedRevision: 0 }), h.service.start(OWNER, { expectedRevision: 0 })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const status = await h.service.status();
  assert.equal(status.pending, true); assert.equal(status.connected, false); assert.equal(status.hasSavedAuthorization, false);
  assert.equal(h.calls.length, 0);
});

test("disconnect cancels an unexchanged attempt without contacting Intuit and permits a fresh attempt", async () => {
  const h = harness(), attempt = await h.start();
  const status = await h.service.disconnect(OWNER, { expectedRevision: attempt.revision });
  assert.equal(status.pending, false); assert.equal(status.hasSavedAuthorization, false);
  await assert.rejects(() => h.service.callback(attempt.query, attempt.cookie));
  assert.equal(h.calls.length, 0);
  assert.ok((await h.start()).authorizationUrl);
});

test("a superseded callback or stale disconnect cannot clear the newer attempt's browser cookie", async () => {
  const h = harness(), old = await h.start(), current = await h.start();
  const stale = await h.run("GET", old.query.toString(), undefined, { cookie: `${QUICKBOOKS_STATE_COOKIE}=${current.cookie}` });
  assert.equal(stale.status, 302); assert.equal(stale.headers.location, callbackLocation("error"));
  assert.equal(stale.headers["set-cookie"], undefined);
  const disconnect = await h.run("POST", "", { action: "disconnect", expectedRevision: old.revision });
  assert.equal(disconnect.status, 409); assert.equal(disconnect.headers["set-cookie"], undefined);
  const success = await h.run("GET", current.query.toString(), undefined, { cookie: `${QUICKBOOKS_STATE_COOKIE}=${current.cookie}` });
  assert.equal(success.headers.location, callbackLocation("connected")); assert.equal(success.headers["set-cookie"], undefined);
  assert.equal(h.calls.length, 1);
});

test("successful denial and disconnect responses never overwrite a later tab's nonce cookie", async () => {
  const h = harness(), attempt = await h.start(); attempt.query.set("error", "access_denied");
  const denied = await h.run("GET", attempt.query.toString(), undefined, { cookie: `${QUICKBOOKS_STATE_COOKIE}=${attempt.cookie}` });
  assert.equal(denied.headers.location, callbackLocation("denied")); assert.equal(denied.headers["set-cookie"], undefined);
  const fresh = await h.start();
  const disconnected = await h.run("POST", "", { action: "disconnect", expectedRevision: fresh.revision });
  assert.equal(disconnected.status, 200); assert.equal(disconnected.headers["set-cookie"], undefined);
  await assert.rejects(() => h.service.callback(fresh.query, fresh.cookie));
  assert.equal(h.calls.length, 0);
});

test("denial consumes state with no token request and rejects missing or invalid realm", async () => {
  const h = harness(), attempt = await h.start(); attempt.query.delete("code"); attempt.query.set("error", "access_denied");
  assert.deepEqual(await h.service.callback(attempt.query, attempt.cookie), { result: "denied" });
  assert.equal((await h.service.status()).pending, false); assert.equal(h.calls.length, 0);
  await assert.rejects(() => h.service.callback(attempt.query, attempt.cookie));
  for (const realm of ["", "../other", "https://evil.invalid"]) {
    const other = harness(), current = await other.start(); current.query.set("realmId", realm);
    await assert.rejects(() => other.service.callback(current.query, current.cookie)); assert.equal(other.calls.length, 0);
  }
});

test("invalid token response, excess/missing granted scopes, and company mismatch never save an authorization", async () => {
  for (const extra of [{ token_type: "other" }, { access_token: "" }, { refresh_token: "" }, { expires_in: 0 },
    { scope: QUICKBOOKS_SCOPES[0] }, { scope: `${QUICKBOOKS_SCOPES.join(" ")} openid` }, { realmId: "98765" }]) {
    const h = harness(), attempt = await h.start(); h.setFetch(async () => tokenResponse(extra));
    await assert.rejects(() => h.service.callback(attempt.query, attempt.cookie));
    assert.equal((await h.service.status()).connected, false); assert.equal(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens, undefined);
    assert.equal(h.calls.length, 2, "an issued token must be revoked even when the response fails validation");
    assert.equal(h.calls[1][0], INTUIT_REVOKE);
  }
});

test("provider errors/timeouts are secret-safe and never retry an uncertain exchange", async () => {
  for (const fail of [async () => { throw new Error(`network contained ${ACCESS}`); }, async () => new Response(`secret ${REFRESH}`, { status: 500 })]) {
    const h = harness(), attempt = await h.start(); h.setFetch(fail);
    const result = await h.run("GET", attempt.query.toString(), undefined, { cookie: `${QUICKBOOKS_STATE_COOKIE}=${attempt.cookie}` });
    assert.equal(result.status, 302); assert.equal(result.headers.location, callbackLocation("error"));
    assert.equal(JSON.stringify(result).includes(ACCESS), false); assert.equal(JSON.stringify(result).includes(REFRESH), false);
    await assert.rejects(() => h.service.callback(attempt.query, attempt.cookie)); assert.equal(h.calls.length, 1);
    assert.equal((await h.service.status()).remoteReviewRequired, true);
    await assert.rejects(() => h.start(), /Review the previous grant/);
  }
});

test("start uses the current revision; superseded attempts cannot exchange and saved grants must be disconnected", async () => {
  const h = harness(), old = await h.start();
  await assert.rejects(() => h.service.start(OWNER, { expectedRevision: 0 }), /connection changed/);
  const current = await h.start();
  await assert.rejects(() => h.service.callback(old.query, old.cookie)); assert.equal(h.calls.length, 0);
  await h.service.callback(current.query, current.cookie);
  const revision = (await h.service.status()).revision;
  await assert.rejects(() => h.service.start(OWNER, { expectedRevision: revision }), /Disconnect the saved/);
  await assert.rejects(() => h.start({ replaceExisting: true }), /Disconnect the saved/);
  await h.service.disconnect(OWNER, { expectedRevision: revision });
  assert.ok((await h.start()).authorizationUrl);
});

test("disconnect racing the token exchange prevents callback resurrection; changed password also rejects final save", async () => {
  for (const variant of ["disconnect", "password", "password-setup"]) {
    const h = harness(), attempt = await h.start();
    h.setFetch(async (url) => {
      if (url === INTUIT_REVOKE) {
        await assert.rejects(() => h.start(), /still being verified/);
        return new Response(null, { status: 200 });
      }
      if (variant === "disconnect") {
        await h.service.disconnect(OWNER, { expectedRevision: (await h.service.status()).revision });
        assert.equal((await h.service.status()).pending, true);
      } else if (variant === "password-setup") h.putRecord(userPath(OWNER.email), { ...OWNER, mustChangePassword: true });
      else h.putRecord(userPath(OWNER.email), { ...OWNER, passwordHash: "changed-during-exchange" });
      return tokenResponse();
    });
    await assert.rejects(() => h.service.callback(attempt.query, attempt.cookie));
    const status = await h.service.status(); assert.equal(status.connected, false); assert.equal(status.pending, false);
    assert.equal(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens, undefined);
    assert.equal(status.remoteReviewRequired, false); assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1][0], INTUIT_REVOKE);
    assert.equal(JSON.parse(h.calls[1][1].body).token, REFRESH);
  }
});

test("an uncertain orphan-grant revocation leaves a durable review gate with no stored tokens or retries", async () => {
  const h = harness(), attempt = await h.start();
  h.setFetch(async url => {
    if (url === INTUIT_TOKEN) {
      await h.service.disconnect(OWNER, { expectedRevision: (await h.service.status()).revision });
      return tokenResponse();
    }
    throw new Error(`uncertain provider response ${REFRESH}`);
  });
  await assert.rejects(() => h.service.callback(attempt.query, attempt.cookie));
  const status = await h.service.status();
  assert.equal(status.connected, false); assert.equal(status.pending, false); assert.equal(status.hasSavedAuthorization, false);
  assert.equal(status.remoteReviewRequired, true); assert.equal(status.authorizationStatus, "needs-attention");
  assert.equal(h.calls.length, 2);
  await assert.rejects(() => h.start(), /Review the previous grant/);
  for (const secret of [ACCESS, REFRESH, h.env.QUICKBOOKS_CLIENT_SECRET]) {
    assert.equal(JSON.stringify([...h.records.values()]).includes(secret), false);
    assert.equal(JSON.stringify(h.events).includes(secret), false);
    assert.equal(JSON.stringify(status).includes(secret), false);
  }
  assert.equal(h.events.some(event => event[1] === "quickbooks.authorization.cleanup" && event[3].revocationStatus === "unconfirmed"), true);
});

test("an abandoned exchange cannot be overwritten after state expiry or hidden by missing configuration", async () => {
  const h = harness(), attempt = await h.start();
  const previous = h.records.get(QUICKBOOKS_CONNECTION_PATH).value;
  h.putRecord(QUICKBOOKS_CONNECTION_PATH, { ...previous, pending: { ...previous.pending, stage: "exchanging" } });
  h.advance(600_001);
  assert.equal((await h.service.status()).pending, true);
  await assert.rejects(() => h.start(), /still being verified/);
  delete h.env.QUICKBOOKS_CLIENT_SECRET;
  const status = await h.service.disconnect(OWNER, { expectedRevision: attempt.revision });
  assert.equal(status.configured, false); assert.equal(status.pending, true); assert.equal(status.connected, false);
  assert.equal(h.calls.length, 0);
});

test("disconnect deletes local tokens first and distinguishes confirmed from uncertain revocation without retry", async () => {
  for (const confirmed of [true, false]) {
    const h = harness(); await h.authorize();
    const before = await h.service.status();
    h.setFetch(async (url, request) => {
      assert.equal(url, INTUIT_REVOKE); assert.equal(request.method, "POST"); assert.equal(request.redirect, "error");
      assert.equal(request.headers["Content-Type"], "application/json"); assert.equal(JSON.parse(request.body).token, REFRESH);
      assert.equal(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens, undefined);
      await assert.rejects(() => h.start(), /still being verified/);
      if (!confirmed) throw new Error("uncertain revoke");
      return new Response(null, { status: 200 });
    });
    await assert.rejects(() => h.service.disconnect(OWNER, { expectedRevision: before.revision - 1 }), /connection changed/);
    assert.equal(h.calls.length, 1);
    const status = await h.service.disconnect(OWNER, { expectedRevision: before.revision });
    assert.equal(status.connected, false); assert.equal(status.revocationStatus, confirmed ? "confirmed" : "unconfirmed");
    assert.equal(h.calls.length, 2); assert.equal(status.paymentReady, false);
    assert.equal(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens, undefined);
    assert.equal(status.remoteReviewRequired, !confirmed); assert.equal(status.hasSavedAuthorization, false);
    if (!confirmed) await assert.rejects(() => h.start(), /Review the previous grant/);
  }
});

test("corrupt or mismatched encrypted authorization can still be disabled locally without credential disclosure", async () => {
  for (const variant of ["corrupt", "different-app", "missing-config"]) {
    const h = harness(); await h.authorize();
    if (variant === "corrupt") h.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    if (variant === "different-app") h.env.QUICKBOOKS_CLIENT_ID = "different-app";
    if (variant === "missing-config") delete h.env.QUICKBOOKS_CLIENT_SECRET;
    const status = await h.service.status(); assert.equal(status.connected, false); assert.equal(status.hasSavedAuthorization, true);
    const disconnected = await h.service.disconnect(OWNER, { expectedRevision: status.revision });
    assert.equal(disconnected.revocationStatus, "unconfirmed"); assert.equal(h.calls.length, 1);
    assert.equal(disconnected.realmId, null); assert.equal(disconnected.hasSavedAuthorization, false);
    assert.equal(disconnected.remoteReviewRequired, true);
    assert.equal(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens, undefined);
  }
});

test("callback redirects are fixed and never echo untrusted query or provider error descriptions", async () => {
  assert.equal(callbackLocation("https://evil.invalid"), "https://lineagetheater.com/#admin/payments?quickbooks=error");
  const h = harness();
  const result = await h.run("GET", "action=callback&state=bad&error_description=private-value&redirect=https://evil.invalid");
  assert.equal(result.headers.location, callbackLocation("error")); assert.equal(JSON.stringify(result).includes("private-value"), false);
  assert.equal(h.calls.length, 0);
});

async function refreshCurrent(h, service = h.service) { return service.refresh(OWNER, { expectedRevision: (await h.service.status()).revision }); }
const rotatedResponse = (extra = {}) => tokenResponse({ access_token: "synthetic-rotated-access", refresh_token: "synthetic-rotated-refresh", ...extra });
const savedToken = h => decryptQuickBooksTokens(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens, quickbooksConfig(h.env));

test("refresh stays server-only and owner-only; valid access skips refresh and no tokens enter results or audits", async () => {
  const h = harness(); await h.authorize();
  for (const actor of [ADMIN, CUSTOMER, { ...OWNER, mustChangePassword: true }])
    await assert.rejects(() => h.service.refresh(actor, { expectedRevision: 3 }), /Only the owner/);
  assert.equal((await h.run("POST", "", { action: "refresh", expectedRevision: 3 })).status, 400);
  const result = await refreshCurrent(h);
  assert.equal(result.refreshed, false); assert.equal(h.calls.length, 1);
  assert.equal(result.paymentReady, false); assert.equal(result.refundReady, false);
  for (const secret of [ACCESS, REFRESH, h.env.QUICKBOOKS_CLIENT_SECRET]) assert.equal(JSON.stringify([result, h.events]).includes(secret), false);
});

test("refresh atomically rotates both tokens and the next refresh uses the newest stored refresh token", async () => {
  const h = harness(); await h.authorize(); h.advance(3_600_001);
  const originalCiphertext = h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens.ciphertext;
  h.setFetch(async (url, request) => {
    assert.equal(url, INTUIT_TOKEN); assert.equal(request.method, "POST"); assert.equal(request.redirect, "error");
    assert.ok(request.signal); assert.equal(request.headers["x-include-refresh-token-hard-expires-in"], "true");
    const form = new URLSearchParams(request.body);
    assert.equal(form.get("grant_type"), "refresh_token"); assert.equal(form.has("code"), false);
    assert.equal(form.get("refresh_token"), h.calls.length === 2 ? REFRESH : "synthetic-rotated-refresh");
    return rotatedResponse();
  });
  const result = await refreshCurrent(h);
  assert.equal(result.refreshed, true); assert.equal(result.refreshStatus, "refreshed"); assert.equal(result.connected, true);
  assert.notEqual(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens.ciphertext, originalCiphertext);
  assert.equal(savedToken(h).refreshToken, "synthetic-rotated-refresh"); assert.equal(savedToken(h).accessToken, "synthetic-rotated-access");
  h.advance(3_600_001); await refreshCurrent(h); assert.equal(h.calls.length, 3);
  for (const secret of [ACCESS, REFRESH, "synthetic-rotated-access", "synthetic-rotated-refresh"])
    assert.equal(JSON.stringify([result, [...h.records.values()], h.events]).includes(secret), false);
});

test("independent service instances serialize refreshes and do not take over abandoned locks", async () => {
  const h = harness(); await h.authorize(); h.advance(3_600_001);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  h.setFetch(async () => { entered(); return new Promise(resolve => { release = () => resolve(rotatedResponse()); }); });
  const revision = (await h.service.status()).revision;
  const first = h.service.refresh(OWNER, { expectedRevision: revision }); await ready;
  await assert.rejects(() => h.peer().refresh(OWNER, { expectedRevision: revision }), /connection changed/);
  await assert.rejects(() => refreshCurrent(h, h.peer()), /still being verified/);
  h.advance(20 * 60_000);
  await assert.rejects(() => refreshCurrent(h, h.peer()), /still being verified/);
  assert.equal((await h.service.status()).connected, false); assert.equal((await h.service.status()).pending, true);
  assert.equal(h.calls.length, 2); release(); await first;
  assert.equal((await h.service.status()).pending, false);
});

test("refresh preserves omitted scope/realm provenance and known rolling/hard expiry instead of inventing attestation", async () => {
  for (const attested of [true, false]) {
    const h = harness(); h.setFetch(async () => tokenResponse({ ...(attested ? { scope: QUICKBOOKS_SCOPES.join(" "), realmId: REALM } : {}), x_refresh_token_hard_expires_in: 100_000 }));
    await h.authorize(); const before = savedToken(h); h.advance(3_600_001);
    h.setFetch(async () => rotatedResponse({ x_refresh_token_expires_in: undefined, x_refresh_token_hard_expires_in: undefined }));
    await refreshCurrent(h); const after = savedToken(h);
    for (const field of ["grantedScopes", "scopeVerification", "realmVerification", "refreshTokenExpiresAt", "refreshTokenHardExpiresAt"])
      assert.deepEqual(after[field], before[field], field);
  }
});

test("known refresh expiry, unknown lifetime and hard expiry block without provider calls; a hard deadline never extends", async () => {
  for (const extra of [{ x_refresh_token_expires_in: 1 }, { x_refresh_token_expires_in: undefined }, { x_refresh_token_hard_expires_in: 1 }]) {
    const h = harness(); h.setFetch(async () => tokenResponse(extra)); await h.authorize(); h.advance(3_600_001);
    await assert.rejects(() => refreshCurrent(h), /expiry cannot be validated or has passed/);
    assert.equal(h.calls.length, 1); assert.equal((await h.service.status()).connected, false);
    assert.equal((await h.service.status()).refreshStatus, "reconnect-required");
  }
  const h = harness(); h.setFetch(async () => tokenResponse({ x_refresh_token_hard_expires_in: 50_000 }));
  await h.authorize(); const hard = savedToken(h).refreshTokenHardExpiresAt; h.advance(3_600_001);
  h.setFetch(async () => rotatedResponse({ x_refresh_token_hard_expires_in: 100_000 }));
  await refreshCurrent(h); assert.equal(savedToken(h).refreshTokenHardExpiresAt, hard);
});

test("malformed rotation, expiry, scope or realm responses revoke returned tokens and never save an unusable pair", async () => {
  for (const extra of [{ x_refresh_token_expires_in: 0 }, { x_refresh_token_expires_in: "100" }, { x_refresh_token_hard_expires_in: -1 },
    { scope: "openid" }, { realmId: "99999" }, { refresh_token: "" }]) {
    const h = harness(); await h.authorize(); h.advance(3_600_001);
    h.setFetch(async (url, request) => {
      if (url === INTUIT_TOKEN) return rotatedResponse(extra);
      assert.equal(url, INTUIT_REVOKE);
      assert.equal(JSON.parse(request.body).token, extra.refresh_token === "" ? "synthetic-rotated-access" : "synthetic-rotated-refresh");
      return new Response(null, { status: 200 });
    });
    await assert.rejects(() => refreshCurrent(h));
    const status = await h.service.status(); assert.equal(status.connected, false); assert.equal(status.hasSavedAuthorization, false);
    assert.equal(h.calls.length, 3); assert.equal(status.remoteReviewRequired, false);
  }
});

test("invalid_grant and rejected credentials disable old access; ambiguous responses block reuse without retries or secret leaks", async () => {
  for (const variant of ["invalid_grant", "invalid_client", "network", "server", "bad-json"]) {
    const h = harness(); await h.authorize(); h.advance(3_550_000); // Access is still valid but inside the refresh margin.
    h.setFetch(async () => {
      if (variant === "network") throw new Error(`network ${REFRESH}`);
      if (variant === "bad-json") return new Response(`bad ${REFRESH}`, { status: 200 });
      return new Response(JSON.stringify({ error: variant, error_description: REFRESH }), { status: variant === "server" ? 500 : 400 });
    });
    await assert.rejects(() => refreshCurrent(h), error => !error.message.includes(REFRESH));
    const status = await h.service.status();
    assert.equal(status.connected, false); assert.equal(status.hasSavedAuthorization, true); assert.equal(status.pending, false);
    assert.equal(status.remoteReviewRequired, !["invalid_grant", "invalid_client"].includes(variant));
    await assert.rejects(() => refreshCurrent(h), /cannot be refreshed/); assert.equal(h.calls.length, 2);
    assert.equal(JSON.stringify([status, h.events]).includes(REFRESH), false);
  }
});

test("disconnect during refresh removes local access immediately and only the returned rotated token is revoked", async () => {
  for (const revokeConfirmed of [true, false]) {
    const h = harness(); await h.authorize(); h.advance(3_600_001);
    h.setFetch(async (url, request) => {
      if (url === INTUIT_TOKEN) {
        const status = await h.service.disconnect(OWNER, { expectedRevision: (await h.service.status()).revision });
        assert.equal(status.hasSavedAuthorization, false); assert.equal(status.pending, true);
        assert.equal(h.calls.length, 2, "disconnect defers old-token revocation");
        return rotatedResponse();
      }
      assert.equal(JSON.parse(request.body).token, "synthetic-rotated-refresh");
      await assert.rejects(() => h.start(), /still being verified/);
      if (!revokeConfirmed) throw new Error("revocation timeout");
      return new Response(null, { status: 200 });
    });
    await assert.rejects(() => refreshCurrent(h));
    const status = await h.service.status(); assert.equal(status.hasSavedAuthorization, false); assert.equal(status.connected, false);
    assert.equal(status.pending, false); assert.equal(status.remoteReviewRequired, !revokeConfirmed); assert.equal(h.calls.length, 3);
  }
});

test("disconnect during a failed refresh revokes old tokens once but preserves unknown rotation uncertainty", async () => {
  for (const outcome of ["invalid_grant", "network"]) {
    const h = harness(); await h.authorize(); h.advance(3_600_001);
    h.setFetch(async (url, request) => {
      if (url === INTUIT_TOKEN) {
        await h.service.disconnect(OWNER, { expectedRevision: (await h.service.status()).revision });
        if (outcome === "network") throw new Error("unknown outcome");
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      assert.equal(JSON.parse(request.body).token, REFRESH); return new Response(null, { status: 200 });
    });
    await assert.rejects(() => refreshCurrent(h));
    const status = await h.service.status(); assert.equal(status.hasSavedAuthorization, false); assert.equal(status.pending, false);
    assert.equal(status.remoteReviewRequired, outcome === "network"); assert.equal(h.calls.length, 3);
  }
});

test("changed credentials fail before refresh; changes to owner or configuration during refresh revoke the returned pair", async () => {
  for (const key of ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_TOKEN_ENCRYPTION_KEY"]) {
    const h = harness(); await h.authorize(); h.advance(3_600_001);
    h.env[key] = key.includes("KEY") ? randomBytes(32).toString("base64") : "changed-value";
    await assert.rejects(() => refreshCurrent(h), /credentials changed/); assert.equal(h.calls.length, 1);
  }
  for (const variant of ["password", "suspended", "role", "setup", "client", "key"]) {
    const h = harness(); await h.authorize(); h.advance(3_600_001);
    h.setFetch(async (url, request) => {
      if (url === INTUIT_REVOKE) { assert.equal(JSON.parse(request.body).token, "synthetic-rotated-refresh"); return new Response(null, { status: 200 }); }
      if (variant === "client") h.env.QUICKBOOKS_CLIENT_SECRET = "changed-value";
      else if (variant === "key") h.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      else h.putRecord(userPath(OWNER.email), { ...OWNER, ...(variant === "password" ? { passwordHash: "changed" } : variant === "suspended" ? { status: "suspended" } : variant === "role" ? { role: "customer" } : { mustChangePassword: true }) });
      return rotatedResponse();
    });
    await assert.rejects(() => refreshCurrent(h));
    assert.equal((await h.service.status()).hasSavedAuthorization, false); assert.equal(h.calls.length, 3);
  }
});

test("a rotated-pair write that commits but loses its response is identified and revoked without presenting connected", async () => {
  let failed = false;
  const h = harness({ afterWrite: async (path, value) => {
    if (path === QUICKBOOKS_CONNECTION_PATH && value.status === "authorized" && value.lastRefreshAttemptId && !failed) { failed = true; throw new Error("lost write response"); }
  } });
  await h.authorize(); h.advance(3_600_001);
  h.setFetch(async url => url === INTUIT_TOKEN ? rotatedResponse() : new Response(null, { status: 200 }));
  await assert.rejects(() => refreshCurrent(h));
  const status = await h.service.status(); assert.equal(status.connected, false); assert.equal(status.hasSavedAuthorization, false);
  assert.equal(status.pending, false); assert.equal(h.calls.length, 3);
});

test("cleanup for a lost save cannot revoke or overwrite a newer refresh that already owns the same grant", async () => {
  let failed = false, h;
  h = harness({ afterWrite: async (path, value) => {
    if (path === QUICKBOOKS_CONNECTION_PATH && value.status === "authorized" && value.lastRefreshAttemptId && !failed) {
      failed = true;
      h.putRecord(path, { ...value, revision: value.revision + 1, status: "refreshing",
        refreshOperation: { attemptId: "newer-worker-attempt", stage: "exchanging" } });
      throw new Error("lost write response after a new worker claimed the grant");
    }
  } });
  await h.authorize(); h.advance(3_600_001); h.setFetch(async () => rotatedResponse());
  await assert.rejects(() => refreshCurrent(h));
  const current = h.records.get(QUICKBOOKS_CONNECTION_PATH).value;
  assert.equal(current.refreshOperation.attemptId, "newer-worker-attempt"); assert.ok(current.encryptedTokens);
  assert.equal(h.calls.length, 2, "stale cleanup must not revoke a grant now owned by a newer operation");
});

test("an audit failure after a confirmed rotated-pair save does not revoke the saved authorization", async () => {
  const h = harness({ afterAudit: async (_, action) => { if (action === "quickbooks.refresh.saved") throw new Error("audit unavailable"); } });
  await h.authorize(); h.advance(3_600_001); h.setFetch(async () => rotatedResponse());
  await assert.rejects(() => refreshCurrent(h));
  assert.equal((await h.service.status()).connected, true); assert.equal(savedToken(h).refreshToken, "synthetic-rotated-refresh");
  assert.equal(h.calls.length, 2);
});

test("precondition storage errors in server-only refresh are sanitized without a provider request", async () => {
  let failRead = false;
  const h = harness({ beforeRead: async () => { if (failRead) throw new Error(`storage error ${REFRESH}`); } });
  await h.authorize(); failRead = true;
  await assert.rejects(() => h.service.refresh(OWNER, { expectedRevision: 3 }), error =>
    error.code === "QUICKBOOKS_REFRESH_UNCERTAIN" && !error.message.includes(REFRESH));
  assert.equal(h.calls.length, 1);
});

test("a callback whose final save loses its response cannot revoke a refresh that now owns or has rotated the grant", async () => {
  for (const completed of [false, true]) {
    let failed = false, h, peerRefresh, release, entered;
    const refreshStarted = new Promise(resolve => { entered = resolve; });
    h = harness({ afterWrite: async (path, value) => {
      if (path === QUICKBOOKS_CONNECTION_PATH && value.status === "authorized" && !value.lastRefreshAttemptId && !failed) {
        failed = true;
        peerRefresh = h.peer().refresh(OWNER, { expectedRevision: value.revision });
        await refreshStarted;
        if (completed) { release(); await peerRefresh; }
        throw new Error("callback write response lost after another worker claimed the grant");
      }
    } });
    h.setFetch(async (url, request) => {
      assert.equal(url, INTUIT_TOKEN, "stale callback cleanup must not revoke this grant");
      if (new URLSearchParams(request.body).get("grant_type") === "authorization_code") return tokenResponse({ expires_in: 1 });
      entered(); return new Promise(resolve => { release = () => resolve(rotatedResponse()); });
    });
    await assert.rejects(() => h.authorize());
    assert.equal(h.calls.length, 2);
    if (!completed) { assert.equal((await h.service.status()).pending, true); release(); await peerRefresh; }
    assert.equal((await h.service.status()).connected, true);
    assert.equal(savedToken(h).refreshToken, "synthetic-rotated-refresh");
  }
});

test("callback cleanup claims its committed generation before revocation and removes locally saved tokens", async () => {
  let failed = false;
  const h = harness({ afterWrite: async (path, value) => {
    if (path === QUICKBOOKS_CONNECTION_PATH && value.status === "authorized" && !failed) { failed = true; throw new Error("callback write response lost"); }
  } });
  h.setFetch(async url => {
    if (url === INTUIT_TOKEN) return tokenResponse();
    const status = await h.service.status(); assert.equal(status.hasSavedAuthorization, false); assert.equal(status.pending, true);
    await assert.rejects(() => refreshCurrent(h), /still being verified/);
    return new Response(null, { status: 200 });
  });
  await assert.rejects(() => h.authorize());
  assert.equal((await h.service.status()).hasSavedAuthorization, false); assert.equal((await h.service.status()).pending, false);
  assert.equal(h.calls.length, 2);
});

function companyResponse(extra = {}, root = {}) {
  return new Response(JSON.stringify({ CompanyInfo: { Id: "1", domain: "QBO", CompanyName: "Sandbox Company", LegalName: "Sandbox Legal Name", Country: "US", ...extra }, ...root }),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
async function verifyCurrent(h, service = h.service) { return service.verifyCompany(OWNER, { expectedRevision: (await h.service.status()).revision }); }
function replaceStoredToken(h, extra) {
  const value = h.records.get(QUICKBOOKS_CONNECTION_PATH).value;
  h.putRecord(QUICKBOOKS_CONNECTION_PATH, { ...value, encryptedTokens: encryptQuickBooksTokens({ ...savedToken(h), ...extra }, quickbooksConfig(h.env)) });
}

test("company checks require owner same-origin POST and cannot accept client-supplied realm, token, or destination", async () => {
  const h = harness(); await h.authorize(); h.setFetch(async (url, request) => {
    assert.equal(url, `https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/companyinfo/${REALM}`);
    assert.equal(request.method, "GET"); assert.equal(request.body, undefined); assert.equal(request.redirect, "error");
    assert.ok(request.signal); assert.equal(request.headers.Authorization, `Bearer ${ACCESS}`); assert.equal(request.headers.Accept, "application/json");
    return companyResponse();
  });
  const revision = (await h.service.status()).revision;
  for (const actor of [null, CUSTOMER, ADMIN, { ...OWNER, role: "customer" }]) {
    h.setActor(actor);
    assert.equal((await h.run("POST", "", { action: "verifyCompany", expectedRevision: revision })).status, actor ? 403 : 401);
  }
  h.setActor(OWNER);
  assert.equal((await h.run("GET", "action=verifyCompany")).status, 405);
  for (const headers of [{ origin: "https://evil.invalid" }, { origin: "" }, { host: "www.lineagetheater.com", origin: "https://www.lineagetheater.com" }])
    assert.equal((await h.run("POST", "", { action: "verifyCompany", expectedRevision: revision }, headers)).status, 403);
  const result = await h.run("POST", "", { action: "verifyCompany", expectedRevision: revision, realmId: "999999", token: "client-token", url: "https://evil.invalid" });
  assert.equal(result.status, 200); assert.equal(h.calls.length, 2);
  assert.equal(result.body.companyVerification.companyName, "Sandbox Company");
});

test("company evidence contains only minimal fields, proves Accounting access alone, and permits entity Id 1", async () => {
  const h = harness(); await h.authorize(); h.setFetch(async () => companyResponse({
    CompanyAddr: { Line1: "private address" }, Email: { Address: "private@example.invalid" }, secret: REFRESH,
  }, { access_token: ACCESS, refresh_token: REFRESH }));
  const result = await verifyCurrent(h);
  assert.deepEqual(Object.keys(result.companyVerification).sort(), ["accountingAccessVerified", "companyName", "country", "legalName", "verifiedAt"]);
  assert.equal(result.companyVerification.accountingAccessVerified, true);
  assert.equal(result.scopeVerification, "not-returned"); assert.equal(result.realmVerification, "callback-only");
  assert.equal(result.paymentReady, false); assert.equal(result.refundReady, false);
  for (const secret of [ACCESS, REFRESH, "private address", "private@example.invalid", h.env.QUICKBOOKS_CLIENT_SECRET])
    assert.equal(JSON.stringify([result, [...h.records.values()], h.events]).includes(secret), false);
  h.setActor(ADMIN); assert.deepEqual((await h.run()).body.companyVerification, result.companyVerification);
});

test("company check uses the fixed production Accounting origin only for a saved production authorization", async () => {
  const h = harness({ env: { ...testEnv(), QUICKBOOKS_ENVIRONMENT: "production" } }); await h.authorize();
  h.setFetch(async url => { assert.equal(url, `https://quickbooks.api.intuit.com/v3/company/${REALM}/companyinfo/${REALM}`); return companyResponse(); });
  assert.equal((await verifyCurrent(h)).companyVerification.accountingAccessVerified, true);
});

test("company scope, saved realm, owner, config, expiry and pending gates fail without reading or altering provider authorization", async () => {
  for (const variant of ["scope", "malformed-scope", "realm", "token", "expired", "invalid-expiry", "password", "owner-setup", "suspended", "config", "refreshing", "review", "disconnected"]) {
    const h = harness(); await h.authorize();
    if (variant === "scope") replaceStoredToken(h, { grantedScopes: [QUICKBOOKS_SCOPES[0]] });
    if (variant === "malformed-scope") replaceStoredToken(h, { grantedScopes: "com.intuit.quickbooks.accounting" });
    if (variant === "realm") replaceStoredToken(h, { realmId: "../../other?token=bad" });
    if (variant === "token") replaceStoredToken(h, { accessToken: "bad\nheader" });
    if (variant === "expired") h.advance(3_600_001);
    if (variant === "invalid-expiry") replaceStoredToken(h, { accessTokenExpiresAt: "invalid-date" });
    if (variant === "password") h.putRecord(userPath(OWNER.email), { ...OWNER, passwordHash: "new-value" });
    if (variant === "owner-setup") h.putRecord(userPath(OWNER.email), { ...OWNER, mustChangePassword: true });
    if (variant === "suspended") h.putRecord(userPath(OWNER.email), { ...OWNER, status: "suspended" });
    if (variant === "config") h.env.QUICKBOOKS_CLIENT_SECRET = "changed-secret";
    if (["refreshing", "review", "disconnected"].includes(variant)) {
      const value = h.records.get(QUICKBOOKS_CONNECTION_PATH).value;
      h.putRecord(QUICKBOOKS_CONNECTION_PATH, { ...value, ...(variant === "refreshing" ? { refreshOperation: { attemptId: "other" } } : variant === "review" ? { remoteReviewRequired: true } : { status: "disconnected" }) });
    }
    const before = structuredClone([...h.records.values()]);
    await assert.rejects(() => verifyCurrent(h));
    assert.equal(h.calls.length, 1, variant); assert.deepEqual([...h.records.values()], before, variant);
  }
});

test("company JSON/field faults, oversized bodies and echoed secrets never persist evidence or revoke tokens", async () => {
  for (const response of [() => companyResponse({ CompanyName: "" }), () => companyResponse({ CompanyName: ["bad"] }),
    () => companyResponse({ Country: { value: "US" } }), () => companyResponse({ LegalName: "bad\nname" }),
    () => companyResponse({ domain: "other" }), () => companyResponse({}, { CompanyInfo: [] }),
    () => companyResponse({}, { Fault: { Error: [{ Message: REFRESH }] } }), () => companyResponse({ CompanyName: ACCESS }),
    () => companyResponse({ CompanyName: "x".repeat(1025) }), () => companyResponse({}, { oversized: "x".repeat(70_000) }),
    () => new Response("bad-json", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => new Response("<html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } })]) {
    const h = harness(); await h.authorize(); const before = structuredClone([...h.records.values()]);
    h.setFetch(async () => response());
    await assert.rejects(() => verifyCurrent(h), error => !error.message.includes(ACCESS) && !error.message.includes(REFRESH));
    assert.deepEqual([...h.records.values()], before); assert.equal(h.calls.length, 2);
    assert.equal((await h.service.status()).companyVerification, null);
  }
  const optional = harness(); await optional.authorize(); optional.setFetch(async () => companyResponse({ LegalName: undefined, Country: undefined }));
  const result = await verifyCurrent(optional); assert.equal(result.companyVerification.legalName, null); assert.equal(result.companyVerification.country, null);
});

test("failed company reads preserve prior timestamped evidence and never set monetary uncertainty or retry", async () => {
  for (const code of [401, 403, 404, 429, 500, "network"]) {
    const h = harness(); await h.authorize(); h.setFetch(async () => companyResponse());
    const verified = await verifyCurrent(h), before = structuredClone([...h.records.values()]);
    h.setFetch(async () => { if (code === "network") throw new Error(`network ${REFRESH}`); return new Response(REFRESH, { status: code }); });
    await assert.rejects(() => verifyCurrent(h), error => !error.message.includes(REFRESH));
    assert.deepEqual([...h.records.values()], before); assert.equal(h.calls.length, 3);
    const status = await h.service.status(); assert.deepEqual(status.companyVerification, verified.companyVerification);
    assert.equal(status.remoteReviewRequired, false); assert.equal(status.paymentReady, false); assert.equal(status.refundReady, false);
  }
});

test("company checks discard evidence if disconnect, token rotation, expiry, owner, or config changes while GET is running", async () => {
  for (const variant of ["disconnect", "rotation", "expired", "password", "role", "config"]) {
    const h = harness(); await h.authorize();
    h.setFetch(async url => {
      if (url === INTUIT_REVOKE) return new Response(null, { status: 200 });
      if (variant === "disconnect") await h.service.disconnect(OWNER, { expectedRevision: (await h.service.status()).revision });
      if (variant === "rotation") replaceStoredToken(h, { accessToken: "newly-rotated-access" });
      if (variant === "expired") h.advance(3_600_001);
      if (variant === "password") h.putRecord(userPath(OWNER.email), { ...OWNER, passwordHash: "new-value" });
      if (variant === "role") h.putRecord(userPath(OWNER.email), { ...OWNER, role: "admin" });
      if (variant === "config") h.env.QUICKBOOKS_CLIENT_ID = "new-app";
      return companyResponse();
    });
    await assert.rejects(() => verifyCurrent(h));
    assert.equal(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.companyVerification, undefined);
    assert.equal(Boolean(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.remoteReviewRequired), false);
    assert.equal(h.calls.length, variant === "disconnect" ? 3 : 2);
  }
});

test("concurrent company checks use the original ETag and save only one response", async () => {
  const h = harness(); await h.authorize(); h.setFetch(async () => companyResponse());
  const revision = (await h.service.status()).revision;
  const results = await Promise.allSettled([h.service.verifyCompany(OWNER, { expectedRevision: revision }), h.peer().verifyCompany(OWNER, { expectedRevision: revision })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal((await h.service.status()).revision, revision + 1); assert.equal(h.calls.length, 3);
});

test("company evidence is hidden after token/config changes, expiry, pending work or disconnect", async () => {
  for (const variant of ["rotation", "config", "expired", "pending", "disconnect"]) {
    const h = harness(); await h.authorize(); h.setFetch(async () => companyResponse()); await verifyCurrent(h);
    if (variant === "rotation") replaceStoredToken(h, { accessToken: "newly-rotated-access" });
    if (variant === "config") h.env.QUICKBOOKS_CLIENT_SECRET = "new-secret";
    if (variant === "expired") h.advance(3_600_001);
    if (variant === "pending") { const value = h.records.get(QUICKBOOKS_CONNECTION_PATH).value; h.putRecord(QUICKBOOKS_CONNECTION_PATH, { ...value, refreshOperation: { attemptId: "other" } }); }
    if (variant === "disconnect") { h.setFetch(async () => new Response(null, { status: 200 })); await h.service.disconnect(OWNER, { expectedRevision: (await h.service.status()).revision }); }
    assert.equal((await h.service.status()).companyVerification, null, variant);
  }
});
