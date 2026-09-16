import { randomBytes } from "node:crypto";
import { digest, readRecord, writeRecord } from "./auth.mjs";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const MAX_AGE_MS = 120_000;
const ACTIONS = new Set(["login", "register", "mfa", "checkout"]);
export class CaptchaError extends Error {
  constructor(message = "The security check did not pass. Please try again or contact the administrator.", status = 403) {
    super(message); this.status = status; this.code = "CAPTCHA_REQUIRED";
  }
}

// There is no browser flag, account exemption, or production bypass. Tests inject
// their verifier explicitly; missing configuration always prevents protected work.
export function createCaptchaService({ env = process.env, fetchImpl = fetch, now = Date.now,
  read = readRecord, write = writeRecord } = {}) {
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
    if (!config.available) throw new CaptchaError("The security check is temporarily unavailable. Please try again later.", 503);
    if (!ACTIONS.has(action) || typeof token !== "string" || token.length < 20 || token.length > 8192 || /\s/.test(token)) throw new CaptchaError();
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
    } catch { throw new CaptchaError("The security check could not be reached. Please try again.", 503); }
    const age = now() - Date.parse(result?.challenge_ts);
    if (result?.success !== true || result.action !== action
      || !config.hosts.includes(result.hostname) || typeof result.score !== "number"
      || !Number.isFinite(result.score) || result.score < config.score || result.score > 1
      || !Number.isFinite(age) || age < -10_000 || age > MAX_AGE_MS
      || (Array.isArray(result["error-codes"]) && result["error-codes"].length)) throw new CaptchaError();
    // Google consumes each token once. Never retry verification after an ambiguous response.
  }
  async function prepareCheckout(email, quoteId, token) {
    if (!/^[a-f0-9]{64}$/.test(quoteId || "")) throw new CaptchaError("Request a current film price before payment.");
    await verify(token, "checkout");
    const proof = randomBytes(32).toString("hex");
    await write(`security/checkout-checks/${digest(proof)}.json`, {
      email, quoteId, expiresAt: now() + MAX_AGE_MS, used: false,
    });
    return { checkoutProof: proof };
  }
  async function consumeCheckout(email, quoteId, proof) {
    if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) throw new CaptchaError();
    const path = `security/checkout-checks/${digest(proof)}.json`;
    const record = await read(path);
    if (!record || record.value.email !== email || record.value.quoteId !== quoteId
      || record.value.used !== false || !Number.isFinite(record.value.expiresAt) || record.value.expiresAt <= now()) throw new CaptchaError();
    try { await write(path, { ...record.value, used: true }, record.etag); }
    catch { throw new CaptchaError("The payment security check could not be confirmed. Check your order status before trying again."); }
  }
  return { configuration, verify, prepareCheckout, consumeCheckout };
}
export const captcha = createCaptchaService();
