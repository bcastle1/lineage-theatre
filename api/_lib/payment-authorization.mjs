// Official Payments SDK production/sandbox hosts; never accept a request URL.
// https://github.com/intuit/PHP-Payments-SDK/blob/master/src/PaymentClient.php
export const INTUIT_PAYMENT_ORIGINS = Object.freeze({
  sandbox: "https://sandbox.api.intuit.com",
  production: "https://api.intuit.com",
});

// This is a contract for a trusted server evidence verifier, not a verifier of
// merchant approval itself. No browser route, setting or environment flag mints
// this authorization. payment-readiness verifies signed human review records;
// that provenance is not automated proof of the underlying provider decisions.
export function paymentAuthorizationMatches(authorization, binding, operation, now = Date.now()) {
  const checked = Date.parse(authorization?.validatedAt), expires = Date.parse(authorization?.expiresAt);
  return Boolean(binding && Object.hasOwn(INTUIT_PAYMENT_ORIGINS, binding.environment)
    && authorization?.environment === binding.environment && authorization.grantId === binding.grantId
    && /^[a-f0-9]{64}$/.test(authorization.evidenceHash || "")
    && Number.isFinite(checked) && checked <= now && Number.isFinite(expires) && expires > now
    && expires > checked && expires - checked <= 24 * 3600_000
    && Array.isArray(authorization.operations) && authorization.operations.includes(operation)
    && authorization.operations.every(value => ["quote", "charge", "refund", "read", "render", "card-entry", "refresh"].includes(value)));
}
