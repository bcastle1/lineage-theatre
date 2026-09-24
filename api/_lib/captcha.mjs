import { randomBytes } from "node:crypto";
import { digest, readRecord, writeRecord } from "./auth.mjs";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const CHECKOUT_PROOF_TTL_MS = 120_000;
const ACTIONS = new Set(["login", "register", "mfa", "checkout"]);
const PROVIDER_ERRORS = new Set(["missing-input-secret", "invalid-input-secret", "missing-input-response", "invalid-input-response", "bad-request", "timeout-or-duplicate"]);
const expiredMessage = "The security check expired. Please try again to run a fresh check.";
const unavailableMessage = "The security check is temporarily unavailable. Please try again later or contact the administrator.";
export class CaptchaError extends Error {
  constructor(message = "The security check did not pass. Please try again or contact the administrator.", status = 403) {
    super(message); this.status = status; this.code = "CAPTCHA_REQUIRED";
  }
}

// There is no browser flag, account exemption, or production bypass. Tests inject
// their verifier explicitly; missing configuration always prevents protected work.
export function createCaptchaService({ env = process.env, fetchImpl = fetch, now = Date.now,
  read = readRecord, write = writeRecord,
  report = event => console.warn("[security:captcha]", JSON.stringify(event)) } = {}) {
  // Only fixed reason codes and bounded numeric metadata may reach diagnostics.
  // Never include tokens, secrets, account/quote IDs, or raw provider responses.
  function reject(stage, reason, action, details = {}, message, status = 403) {
    try { report({ stage, reason, action: ACTIONS.has(action) ? action : "unknown", ...details }); } catch {}
    throw new CaptchaError(message, status);
  }
  const setting = () => {
    const siteKey = env.RECAPTCHA_SITE_KEY?.trim() || "";
    const secret = env.RECAPTCHA_SECRET_KEY?.trim() || "";
    const hosts = (env.RECAPTCHA_ALLOWED_HOSTNAMES || "lineagetheater.com,www.lineagetheater.com")
      .split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    const score = Number(env.RECAPTCHA_MIN_SCORE ?? "0.5");
    const available = /^[A-Za-z0-9_-]{20,200}$/.test(siteKey) && secret.length >= 20
      && Number.isFinite(score) && score >= 0.5 && score <= 1 && hosts.length > 0
      && hosts.every(host => /^[a-z0-9.-]+$/.test(host) && !host.includes("*"));
    return { siteKey, secret, hosts, score, available };
  };
  function configuration() {
    const { available, siteKey } = setting();
    return { required: true, available, ...(available ? { provider: "recaptcha-v3", siteKey } : {}) };
  }
  async function verify(token, action) {
    const config = setting();
    if (!config.available) reject("configuration", "unavailable", action, {}, unavailableMessage, 503);
    if (!ACTIONS.has(action) || typeof token !== "string" || token.length < 20 || token.length > 8192 || /\s/.test(token)) reject("input", "invalid_token_or_action", action);
    let result;
    try {
      const response = await fetchImpl(VERIFY_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: config.secret, response: token }),
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (!response.ok) throw new Error();
      const raw = await response.text();
      if (raw.length > 16_384) throw new Error();
      result = JSON.parse(raw);
    } catch { reject("provider", "unavailable", action, {}, "The security check could not be reached. Please try again.", 503); }
    const providerErrors = Array.isArray(result?.["error-codes"])
      ? [...new Set(result["error-codes"].map(code => PROVIDER_ERRORS.has(code) ? code : "unknown"))] : [];
    if (providerErrors.includes("missing-input-secret") || providerErrors.includes("invalid-input-secret")) {
      reject("verification", "provider_rejected", action, { providerErrors }, unavailableMessage, 503);
    }
    if (providerErrors.includes("timeout-or-duplicate")) {
      reject("verification", "expired_token", action, { providerErrors }, expiredMessage);
    }
    if (result?.success !== true) reject("verification", "provider_rejected", action, { providerErrors });
    if (providerErrors.length) reject("verification", "provider_errors", action, { providerErrors });
    if (result.action !== action) reject("verification", "action_mismatch", action);
    if (!config.hosts.includes(result.hostname)) reject("verification", "hostname_mismatch", action);
    if (typeof result.score !== "number" || !Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
      reject("verification", "invalid_score", action);
    }
    if (result.score < config.score) reject("verification", "low_score", action,
      { score: result.score, minimumScore: config.score }, "The security check could not verify this attempt. Please try again. If this continues, contact the administrator.");
    // challenge_ts is the challenge load time, not token issuance. Google
    // enforces token expiry and single use via siteverify/timeout-or-duplicate.
    // https://developers.google.com/recaptcha/docs/verify
    const age = now() - Date.parse(result?.challenge_ts);
    if (!Number.isFinite(age)) reject("verification", "invalid_timestamp", action);
    if (age < -10_000) reject("verification", "future_timestamp", action);
    // Google consumes each token once. Never retry verification after an ambiguous response.
  }
  async function prepareCheckout(email, quoteId, token) {
    if (!/^[a-f0-9]{64}$/.test(quoteId || "")) reject("input", "invalid_quote", "checkout", {}, "Request a current film price before payment.");
    await verify(token, "checkout");
    const proof = randomBytes(32).toString("hex");
    await write(`security/checkout-checks/${digest(proof)}.json`, {
      email, quoteId, expiresAt: now() + CHECKOUT_PROOF_TTL_MS, used: false,
    });
    return { checkoutProof: proof };
  }
  async function consumeCheckout(email, quoteId, proof) {
    if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) reject("checkout-proof", "invalid_proof", "checkout");
    const path = `security/checkout-checks/${digest(proof)}.json`;
    const record = await read(path);
    if (!record || record.value.email !== email || record.value.quoteId !== quoteId
      || record.value.used !== false || !Number.isFinite(record.value.expiresAt) || record.value.expiresAt <= now()) reject("checkout-proof", "unavailable_or_mismatched", "checkout");
    try { await write(path, { ...record.value, used: true }, record.etag); }
    catch { reject("checkout-proof", "consume_failed", "checkout", {}, "The payment security check could not be confirmed. Check your order status before trying again."); }
  }
  return { configuration, verify, prepareCheckout, consumeCheckout };
}
export const captcha = createCaptchaService();
