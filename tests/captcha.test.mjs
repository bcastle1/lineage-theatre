import test from "node:test";
import assert from "node:assert/strict";
import { createCaptchaService, CaptchaError } from "../api/_lib/captcha.mjs";
import { createAuthHandler } from "../api/auth.mjs";
import { createStudioHandler } from "../api/studio.mjs";

const time = Date.parse("2026-09-16T23:00:00.000Z");
const env = { RECAPTCHA_SITE_KEY: "synthetic-site-key-for-tests", RECAPTCHA_SECRET_KEY: "synthetic-secret-never-deployed" };
const good = () => ({ success: true, action: "checkout", hostname: "lineagetheater.com", score: 0.9, challenge_ts: new Date(time).toISOString() });
const token = "synthetic-recaptcha-response";
const quote = "a".repeat(64);
const email = "fictional@example.invalid";
function harness(options = {}) {
  const records = new Map(), calls = [];
  let clock = time, revision = 0;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    const current = records.get(path);
    if (current ? etag !== current.etag : Boolean(etag)) throw new Error("Conflict");
    const result = { value: structuredClone(value), etag: `etag-${++revision}` };
    records.set(path, result); return result;
  };
  const service = createCaptchaService({ env, now: () => clock, read, write,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(good())); }, ...options });
  return { service, calls, records, read, write, advance: ms => { clock += ms; } };
}
const request = (body, method = "POST", url = "/api/studio") => ({ method, url, body,
  headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com" } });
async function run(handler, req) {
  const result = { status: 0, body: null };
  await handler(req, { set statusCode(value) { result.status = value; }, setHeader() {}, end(body) { result.body = JSON.parse(body); } });
  return result;
}

test("public config exposes only site key; incomplete or unsafe configuration blocks verification", async () => {
  const h = harness();
  assert.deepEqual(h.service.configuration(), { required: true, available: true, provider: "recaptcha-v3", siteKey: env.RECAPTCHA_SITE_KEY });
  for (const config of [{}, { RECAPTCHA_SITE_KEY: env.RECAPTCHA_SITE_KEY }, { ...env, RECAPTCHA_MIN_SCORE: "0" }, { ...env, RECAPTCHA_ALLOWED_HOSTNAMES: "*.com" }]) {
    const service = harness({ env: config, fetchImpl: () => assert.fail("No provider request permitted") }).service;
    assert.deepEqual(service.configuration(), { required: true, available: false });
    await assert.rejects(service.verify(token, "checkout"), error => error instanceof CaptchaError && error.status === 503);
  }
});
test("verification sends only token and secret to the fixed Google endpoint", async () => {
  const h = harness(); await h.service.verify(token, "checkout");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://www.google.com/recaptcha/api/siteverify");
  assert.deepEqual([...h.calls[0].init.body], [["secret", env.RECAPTCHA_SECRET_KEY], ["response", token]]);
  assert.equal(h.calls[0].init.redirect, "error");
});
test("wrong action, domain, score, expired token, replay and malformed responses fail closed", async () => {
  for (const patch of [{ success: false }, { action: "login" }, { hostname: "evil.invalid" }, { hostname: "lineagetheater.com.evil.invalid" },
    { score: 0.49 }, { score: "0.9" }, { score: 1.1 }, { challenge_ts: new Date(time - 120_001).toISOString() },
    { challenge_ts: new Date(time + 10_001).toISOString() }, { challenge_ts: "invalid" }, { "error-codes": ["timeout-or-duplicate"] }]) {
    const h = harness({ fetchImpl: async () => new Response(JSON.stringify({ ...good(), ...patch })) });
    await assert.rejects(h.service.verify(token, "checkout"), CaptchaError);
    assert.equal(h.records.size, 0);
  }
  for (const value of [undefined, "", 7, "a".repeat(8193), "invalid response with spaces"]) await assert.rejects(harness().service.verify(value, "checkout"), CaptchaError);
  let attempts = 0;
  await assert.rejects(harness({ fetchImpl: async () => { attempts++; throw new Error("network"); } }).service.verify(token, "checkout"), CaptchaError);
  assert.equal(attempts, 1);
  await assert.rejects(harness({ fetchImpl: async () => new Response("not JSON") }).service.verify(token, "checkout"), CaptchaError);
});
test("checkout proof is short lived, account/quote bound, and consumed by only one concurrent request", async () => {
  const h = harness();
  const { checkoutProof } = await h.service.prepareCheckout(email, quote, token);
  assert.doesNotMatch(JSON.stringify([...h.records]), new RegExp(token));
  assert.doesNotMatch(JSON.stringify([...h.records]), new RegExp(checkoutProof));
  await assert.rejects(h.service.consumeCheckout("other@example.invalid", quote, checkoutProof), CaptchaError);
  await assert.rejects(h.service.consumeCheckout(email, "b".repeat(64), checkoutProof), CaptchaError);
  const results = await Promise.allSettled([h.service.consumeCheckout(email, quote, checkoutProof), h.service.consumeCheckout(email, quote, checkoutProof)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  await assert.rejects(h.service.consumeCheckout(email, quote, checkoutProof), CaptchaError);
  const second = await h.service.prepareCheckout(email, quote, token);
  h.advance(120_000);
  await assert.rejects(h.service.consumeCheckout(email, quote, second.checkoutProof), CaptchaError);
});
test("sign-in, registration and MFA reject failed CAPTCHA before password or account side effects", async () => {
  const actions = [];
  const handler = createAuthHandler({ limitAction: async () => true,
    captcha: { verify: async (_, action) => { actions.push(action); throw new CaptchaError(); } },
    verifyPassword: () => assert.fail("Must not check a password"),
    readRecord: () => assert.fail("Must not access account records"), writeRecord: () => assert.fail("Must not create an account") });
  for (const action of ["login", "register", "mfaChallenge"]) {
    const result = await run(handler, request({ action }, "POST", "/api/auth"));
    assert.equal(result.status, 403); assert.equal(result.body.code, "CAPTCHA_REQUIRED");
  }
  assert.deepEqual(actions, ["login", "register", "mfa"]);
});
test("CAPTCHA configuration is public without a session or secret disclosure", async () => {
  const handler = createAuthHandler({ captcha: harness().service, getSession: () => assert.fail("No account lookup needed") });
  const result = await run(handler, request(null, "GET", "/api/auth?action=captcha"));
  assert.equal(result.status, 200); assert.equal(result.body.siteKey, env.RECAPTCHA_SITE_KEY);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});
test("payment route demands a real one-use proof before processor invocation; GET recovery stays available", async () => {
  const h = harness(), processed = [];
  const handler = createStudioHandler({ captcha: h.service, getSession: async () => ({ user: { email } }), limitAction: async () => true,
    payments: { checkoutConfiguration: async () => ({ available: true }), checkout: async (_, body) => { processed.push(body); return { status: "synthetic-captured" }; }, order: async () => ({ status: "synthetic-order" }) } });
  const body = { action: "checkout", quoteId: quote, paymentToken: "synthetic-payment-token", consent: true };
  assert.equal((await run(handler, request(body))).status, 403); assert.equal(processed.length, 0);
  const preflight = await run(handler, request({ action: "checkoutCheck", quoteId: quote, captchaToken: token }));
  assert.equal(preflight.status, 200); assert.equal(processed.length, 0);
  const withProof = { ...body, checkoutProof: preflight.body.checkoutProof };
  assert.equal((await run(handler, request(withProof))).status, 200);
  const replay = await run(handler, request(withProof));
  assert.equal(replay.status, 403);
  assert.equal(replay.body.charged, null, "A rejected replay cannot deny an earlier successful charge");
  assert.equal(processed.length, 1); assert.equal(processed[0].checkoutProof, undefined);
  assert.equal((await run(handler, request(null, "GET", "/api/studio?action=order&id=saved"))).status, 200);
});
test("disabled checkout cannot issue a proof or contact reCAPTCHA", async () => {
  const handler = createStudioHandler({ getSession: async () => ({ user: { email } }), limitAction: async () => true,
    captcha: { prepareCheckout: () => assert.fail("Checkout is disabled") }, payments: { checkoutConfiguration: async () => ({ available: false }) } });
  const result = await run(handler, request({ action: "checkoutCheck", quoteId: quote, captchaToken: token }));
  assert.equal(result.status, 503); assert.equal(result.body.charged, false);
});
