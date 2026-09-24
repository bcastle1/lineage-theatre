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
  const records = new Map(), calls = [], reports = [];
  let clock = time, revision = 0;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    const current = records.get(path);
    if (current ? etag !== current.etag : Boolean(etag)) throw new Error("Conflict");
    const result = { value: structuredClone(value), etag: `etag-${++revision}` };
    records.set(path, result); return result;
  };
  const service = createCaptchaService({ env, now: () => clock, read, write, report: event => reports.push(event),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(good())); }, ...options });
  return { service, calls, records, reports, read, write, advance: ms => { clock += ms; } };
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
test("a fresh Google-approved token from a long-open page gets a new short-lived checkout proof", async () => {
  for (const challengeAge of [120_001, 3_600_000]) {
    const h = harness();
    h.advance(challengeAge);
    const { checkoutProof } = await h.service.prepareCheckout(email, quote, token);
    assert.equal(h.calls.length, 1, "Google still verifies the token before a proof is issued");
    assert.deepEqual(h.reports, []);
    const record = [...h.records.values()][0].value;
    assert.equal(record.expiresAt, time + challengeAge + 120_000, "Proof expiry starts at verification, not challenge load");
    h.advance(119_999);
    await h.service.consumeCheckout(email, quote, checkoutProof);
    await assert.rejects(h.service.consumeCheckout(email, quote, checkoutProof), CaptchaError);
  }
});
test("wrong action, domain, score, expired token, replay and malformed responses fail closed", async () => {
  for (const patch of [{ success: false }, { action: "login" }, { hostname: "evil.invalid" }, { hostname: "lineagetheater.com.evil.invalid" },
    { score: 0.49 }, { score: "0.9" }, { score: 1.1 },
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
test("verification rejection diagnostics identify the cause without relaxing any gate", async () => {
  const failures = [
    [{ success: false }, "provider_rejected"],
    [{ "error-codes": ["invalid-input-response"] }, "provider_errors"],
    [{ action: "login" }, "action_mismatch"],
    [{ hostname: "evil.invalid" }, "hostname_mismatch"],
    [{ score: "0.9" }, "invalid_score"],
    [{ score: 1.1 }, "invalid_score"],
    [{ score: 0.49 }, "low_score"],
    [{ challenge_ts: "invalid" }, "invalid_timestamp"],
    [{ challenge_ts: new Date(time + 10_001).toISOString() }, "future_timestamp"],
    [{ success: false, "error-codes": ["timeout-or-duplicate"] }, "expired_token"],
  ];
  for (const [patch, reason] of failures) {
    const h = harness({ fetchImpl: async () => new Response(JSON.stringify({ ...good(), ...patch })) });
    await assert.rejects(h.service.prepareCheckout(email, quote, token), error =>
      error instanceof CaptchaError && error.status === 403 && error.code === "CAPTCHA_REQUIRED");
    assert.equal(h.records.size, 0, `${reason} cannot issue a checkout proof`);
    assert.equal(h.reports.length, 1, reason);
    assert.equal(h.reports[0].stage, "verification", reason);
    assert.equal(h.reports[0].reason, reason);
    assert.equal(h.reports[0].action, "checkout");
  }
  const accepted = harness();
  await accepted.service.verify(token, "checkout");
  assert.deepEqual(accepted.reports, [], "Accepted checks do not produce failure diagnostics");
});
test("expired checks are recoverable while invalid provider secrets are temporarily unavailable", async () => {
  for (const challengeAge of [0, 120_001, 3_600_000]) {
    let attempts = 0;
    const h = harness({ fetchImpl: async () => {
      attempts++;
      return new Response(JSON.stringify({ ...good(), success: false, "error-codes": ["timeout-or-duplicate"],
        challenge_ts: new Date(time - challengeAge).toISOString() }));
    } });
    await assert.rejects(h.service.prepareCheckout(email, quote, token), error =>
      error instanceof CaptchaError && error.status === 403 && error.code === "CAPTCHA_REQUIRED" && /expired/i.test(error.message));
    assert.equal(attempts, 1, "Expired or replayed tokens are never automatically retried");
    assert.equal(h.records.size, 0, "Google-rejected tokens cannot issue a checkout proof at any challenge age");
    assert.deepEqual(h.reports, [{ stage: "verification", reason: "expired_token", action: "checkout", providerErrors: ["timeout-or-duplicate"] }]);
  }
  for (const providerError of ["missing-input-secret", "invalid-input-secret"]) {
    const h = harness({ fetchImpl: async () => new Response(JSON.stringify({ success: false, "error-codes": [providerError] })) });
    await assert.rejects(h.service.verify(token, "checkout"), error =>
      error instanceof CaptchaError && error.status === 503 && error.code === "CAPTCHA_REQUIRED" && /temporarily unavailable/i.test(error.message));
    assert.deepEqual(h.reports[0].providerErrors, [providerError]);
    assert.equal(h.records.size, 0);
  }
});
test("security diagnostics never include raw provider or request values", async () => {
  const raw = `private-provider-value:${email}:${token}:${env.RECAPTCHA_SECRET_KEY}`;
  const cases = [
    { ...good(), success: false, action: raw, hostname: raw, challenge_ts: raw, score: raw, "error-codes": ["invalid-input-response", raw, { raw }] },
    { ...good(), action: raw },
    { ...good(), hostname: raw },
    { ...good(), challenge_ts: raw },
    { ...good(), score: raw },
  ];
  const allowedKeys = new Set(["stage", "reason", "action", "score", "minimumScore", "providerErrors"]);
  const allowedProviderErrors = new Set(["missing-input-secret", "invalid-input-secret", "missing-input-response", "invalid-input-response", "bad-request", "timeout-or-duplicate", "unknown"]);
  for (const value of cases) {
    const h = harness({ fetchImpl: async () => new Response(JSON.stringify(value)) });
    await assert.rejects(h.service.prepareCheckout(email, quote, token), CaptchaError);
    assert.equal(h.reports.length, 1);
    const report = h.reports[0];
    assert.ok(Object.keys(report).every(key => allowedKeys.has(key)));
    assert.equal(report.action, "checkout");
    for (const field of ["score", "minimumScore"]) {
      if (field in report) assert.ok(typeof report[field] === "number" && Number.isFinite(report[field]));
    }
    if (report.providerErrors) assert.ok(report.providerErrors.every(value => allowedProviderErrors.has(value)));
    const output = JSON.stringify(report);
    for (const privateValue of [raw, email, token, quote, env.RECAPTCHA_SITE_KEY, env.RECAPTCHA_SECRET_KEY]) {
      assert.equal(output.includes(privateValue), false, "Diagnostics contain only fixed labels and safe numbers");
    }
  }
  const h = harness({ fetchImpl: () => assert.fail("Invalid action must not contact Google") });
  await assert.rejects(h.service.verify(token, raw), CaptchaError);
  assert.equal(h.reports[0].action, "unknown");
  assert.equal(JSON.stringify(h.reports).includes(raw), false);
});
test("a failing diagnostic reporter cannot replace the security rejection", async () => {
  const h = harness({ report: () => { throw new Error("Synthetic logging failure"); },
    fetchImpl: async () => new Response(JSON.stringify({ ...good(), score: 0.1 })) });
  await assert.rejects(h.service.prepareCheckout(email, quote, token), error =>
    error instanceof CaptchaError && error.status === 403 && error.code === "CAPTCHA_REQUIRED");
  assert.equal(h.records.size, 0);
});
test("configuration, transport and proof failures keep sensitive details out of diagnostics", async () => {
  const disabled = harness({ env: { ...env, RECAPTCHA_MIN_SCORE: "0" } });
  await assert.rejects(disabled.service.verify(token, "checkout"), CaptchaError);
  assert.deepEqual(disabled.reports, [{ stage: "configuration", reason: "unavailable", action: "checkout" }]);
  const network = harness({ fetchImpl: async () => { throw new Error(`${token}:${env.RECAPTCHA_SECRET_KEY}`); } });
  await assert.rejects(network.service.verify(token, "checkout"), CaptchaError);
  assert.deepEqual(network.reports, [{ stage: "provider", reason: "unavailable", action: "checkout" }]);
  const h = harness();
  const { checkoutProof } = await h.service.prepareCheckout(email, quote, token);
  await assert.rejects(h.service.consumeCheckout("other@example.invalid", quote, checkoutProof), CaptchaError);
  assert.deepEqual(h.reports, [{ stage: "checkout-proof", reason: "unavailable_or_mismatched", action: "checkout" }]);
  assert.equal(h.reports.some(event => JSON.stringify(event).includes(checkoutProof)), false);
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
    payments: { prepareCheckout: async () => ({ available: true }), checkout: async (_, body) => { processed.push(body); return { status: "synthetic-captured" }; }, order: async () => ({ status: "synthetic-order" }) } });
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
    captcha: { prepareCheckout: () => assert.fail("Checkout is disabled") }, payments: { prepareCheckout: async () => ({ available: false }) } });
  const result = await run(handler, request({ action: "checkoutCheck", quoteId: quote, captchaToken: token }));
  assert.equal(result.status, 503); assert.equal(result.body.charged, false);
});
test("hosted checkout security rejection cannot create an invoice or proof and permits a fresh check", async () => {
  let providerAttempts = 0, invoiceAttempts = 0;
  const h = harness({ fetchImpl: async () => {
    providerAttempts++;
    return new Response(JSON.stringify({ ...good(), score: providerAttempts === 1 ? 0.1 : 0.9 }));
  } });
  const handler = createStudioHandler({ captcha: h.service, getSession: async () => ({ user: { email } }), limitAction: async () => true,
    hostedCheckout: { configuration: async () => ({ available: true }), checkout: async () => { invoiceAttempts++; throw new Error("No invoice authorized by this test"); } } });
  const failed = await run(handler, request({ action: "checkoutCheck", quoteId: quote, captchaToken: token }));
  assert.equal(failed.status, 403);
  assert.equal(failed.body.code, "CAPTCHA_REQUIRED");
  assert.equal(failed.body.charged, null);
  assert.equal(failed.body.checkoutProof, undefined);
  assert.equal(h.records.size, 0);
  assert.equal(invoiceAttempts, 0);
  assert.equal(providerAttempts, 1, "The failed provider check is not automatically retried");
  assert.equal(JSON.stringify(failed.body).includes("low_score"), false, "Internal diagnostic labels stay off customer responses");
  const retried = await run(handler, request({ action: "checkoutCheck", quoteId: quote, captchaToken: "fresh-synthetic-recaptcha-response" }));
  assert.equal(retried.status, 200);
  assert.match(retried.body.checkoutProof, /^[a-f0-9]{64}$/);
  assert.equal(providerAttempts, 2);
  assert.equal(h.records.size, 1);
  assert.equal(invoiceAttempts, 0, "Successful security verification still cannot issue an invoice");
});
