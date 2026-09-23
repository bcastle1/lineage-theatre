import { createPublicKey, verify } from "node:crypto";
import { digest, readRecord, userPath } from "./auth.mjs";
import { accessStatusForUser, isOwner, OWNER_EMAIL } from "./access.mjs";
import { paymentAuthorizationMatches } from "./payment-authorization.mjs";

// These records are supplied by an authorized reviewer through the private
// server vault, never by an app route. The signing private key stays outside
// this deployment. A signature authenticates a human review; it does not
// independently prove Intuit approval, merchant capability or PCI compliance.
export const PAYMENT_REVIEW_AUDIENCE = "https://lineagetheater.com";
export const paymentReviewPath = (environment, kind) => {
  if (!["sandbox", "production"].includes(environment) || !["operations", "card-entry"].includes(kind)) throw new Error("Invalid payment review scope");
  return `integrations/payments/reviews/${environment}/${kind}.json`;
};
const HASH = /^[a-f0-9]{64}$/;
const hash = value => typeof value === "string" && HASH.test(value);
const OPERATIONS = ["quote", "charge", "refund", "read", "render", "refresh"];
const stamp = value => new Date(value).toISOString();
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max = 500) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && stamp(Date.parse(value)) === value;
function decode(value, max) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > max) throw new Error("Invalid review encoding");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("Noncanonical review encoding");
  return bytes;
}
function trustedKey(env, keyId, environment) {
  if (!text(keyId, 80) || typeof env.PAYMENT_REVIEW_TRUSTED_KEYS !== "string" || env.PAYMENT_REVIEW_TRUSTED_KEYS.length > 32_768) return null;
  const keys = JSON.parse(env.PAYMENT_REVIEW_TRUSTED_KEYS);
  if (!plain(keys) || Object.keys(keys).length > 10 || !Object.hasOwn(keys, keyId)) return null;
  const key = keys[keyId];
  if (!exact(key, ["publicKey", "reviewer", "environments"]) || !text(key.reviewer, 200)
      || !Array.isArray(key.environments) || !key.environments.includes(environment)
      || key.environments.some(value => !["sandbox", "production"].includes(value))
      || typeof key.publicKey !== "string" || key.publicKey.length > 2048) return null;
  const publicKey = createPublicKey(key.publicKey);
  if (publicKey.asymmetricKeyType !== "ed25519") return null;
  return { publicKey, reviewer: key.reviewer };
}
function requiredEvidence(environment, kind) {
  if (kind === "card-entry") return environment === "production"
    ? ["card-entry-review", "pci-responsibilities"] : ["card-entry-review", "fictional-card-only"];
  return environment === "production"
    ? ["intuit-production-approval", "merchant-activation", "payments-scope", "sandbox-lifecycle", "commercial-terms"]
    : ["sandbox-company", "payments-scope", "owner-test-authorization"];
}
function reviewValid(value, kind, environment, reviewer, revision, now) {
  if (!exact(value, ["version", "audience", "kind", "environment", "grantId", "applicationRevision", "reviewer", "reviewedAt", "expiresAt", "operations", "subjectEmail", "fictionalOnly", "evidence"])
      || value.version !== 1 || value.audience !== PAYMENT_REVIEW_AUDIENCE || value.kind !== kind || value.environment !== environment
      || !hash(value.grantId) || value.reviewer !== reviewer
      || !/^[a-f0-9]{40}$/.test(revision || "") || value.applicationRevision !== revision
      || !instant(value.reviewedAt) || !instant(value.expiresAt)) return false;
  const checked = Date.parse(value.reviewedAt), expires = Date.parse(value.expiresAt);
  if (checked > now || expires <= now || expires <= checked) return false;
  if (environment === "sandbox" ? value.subjectEmail !== OWNER_EMAIL || value.fictionalOnly !== true
    : value.subjectEmail !== null || value.fictionalOnly !== false) return false;
  const allowed = kind === "card-entry" ? ["card-entry"] : OPERATIONS;
  if (!Array.isArray(value.operations) || !value.operations.length || new Set(value.operations).size !== value.operations.length
      || value.operations.some(operation => !allowed.includes(operation))) return false;
  const required = requiredEvidence(environment, kind);
  if (!Array.isArray(value.evidence) || value.evidence.length !== required.length) return false;
  return required.every(type => {
    const evidence = value.evidence.filter(item => item?.type === type);
    if (evidence.length !== 1) return false;
    const item = evidence[0];
    return exact(item, ["type", "reference", "sha256", "observedAt"])
      && text(item.reference, 1000) && hash(item.sha256) && instant(item.observedAt)
      && Date.parse(item.observedAt) <= checked;
  });
}

export function createPaymentReadiness({ read = readRecord, env = process.env, now = Date.now } = {}) {
  async function reviewed(kind, environment) {
    try {
      // A key alone never enables payments; both a valid signed review and a
      // currently usable OAuth binding are needed by the consuming services.
      if (!env.PAYMENT_REVIEW_TRUSTED_KEYS) return null;
      const record = await read(paymentReviewPath(environment, kind)), envelope = record?.value;
      if (!exact(envelope, ["keyId", "payload", "signature"])) return null;
      const key = trustedKey(env, envelope.keyId, environment);
      if (!key) return null;
      const payload = decode(envelope.payload, 32_768), signature = decode(envelope.signature, 100);
      if (signature.length !== 64 || !verify(null, payload, key.publicKey, signature)) return null;
      const value = JSON.parse(payload.toString("utf8"));
      if (!reviewValid(value, kind, environment, key.reviewer, env.VERCEL_GIT_COMMIT_SHA, now())) return null;
      return { value, evidenceHash: digest(payload) };
    } catch { return null; }
  }
  async function authorization(environment, operation) {
    if (!["sandbox", "production"].includes(environment) || ![...OPERATIONS, "card-entry"].includes(operation)) return null;
    const operations = await reviewed("operations", environment);
    if (!operations || (operation !== "card-entry" && !operations.value.operations.includes(operation))) return null;
    const entry = operation === "card-entry" ? await reviewed("card-entry", environment) : null;
    if (operation === "card-entry" && (!entry || entry.value.grantId !== operations.value.grantId
        || !entry.value.operations.includes("card-entry") || !operations.value.operations.includes("charge"))) return null;
    const reviews = entry ? [operations, entry] : [operations];
    // The reviewer's evidence validity is independent of the short-lived
    // operational authorization. Re-read and revalidate the signed records on
    // every operation; never extend the human-selected review expiration.
    const validated = now(), expires = Math.min(validated + 5 * 60_000,
      ...reviews.map(review => Date.parse(review.value.expiresAt)));
    if (expires <= validated) return null;
    return {
      environment, grantId: operations.value.grantId,
      evidenceHash: digest(reviews.map(review => review.evidenceHash).join(":")),
      validatedAt: stamp(validated),
      expiresAt: stamp(expires),
      operations: [operation],
    };
  }
  async function readiness({ actor, subjectEmail, operation = "quote" } = {}) {
    try {
      const environment = env.QUICKBOOKS_ENVIRONMENT;
      const authorized = await authorization(environment, operation);
      if (!authorized) return {};
      const email = actor?.email || subjectEmail;
      if (!text(email, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return {};
      // The worker's internal subject comes from a saved captured order. Browser
      // requests use the session account. Neither supplied roles nor an email
      // string can grant access without the current private account record.
      const account = (await read(userPath(email)))?.value;
      if (account?.email !== email || account.mustChangePassword
          || accessStatusForUser(account) !== "approved") return {};
      if (environment === "sandbox" && (!isOwner(account) || account.email !== OWNER_EMAIL)) return {};
      return { authorization: authorized };
    } catch { return {}; }
  }
  async function authorizeTransport({ binding, operation } = {}) {
    const authorized = await authorization(binding?.environment, operation);
    return paymentAuthorizationMatches(authorized, binding, operation, now()) ? authorized : null;
  }
  return { readiness, authorizeTransport };
}

export const paymentReadiness = createPaymentReadiness();
