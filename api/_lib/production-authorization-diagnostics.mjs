import { hostedReversalReason } from './hosted-reversals.mjs';

const stages = new Set(['authorization', 'request', 'actor-read', 'actor-access', 'order-read', 'paid-quote-read',
  'captured-order', 'allowance', 'plan', 'settings', 'binding', 'allowance-recheck', 'binding-recheck',
  'records-recheck', 'actor-recheck', 'invoice-read', 'invoice-validation', 'payment-read', 'payment-validation',
  'reversals', 'reversal-proof', 'final-invoice-read', 'final-invoice-validation', 'final-payment-read',
  'final-payment-validation', 'payment-freshness', 'quote-validation', 'started-authorization', 'quote-request',
  'quote-refresh-validation', 'quote-save', 'grant-freshness']);
const reasons = new Set(['REQUEST_INVALID', 'ACTOR_RECORD_INVALID', 'PAID_QUOTE_REFERENCE_INVALID',
  'CAPTURED_ORDER_INVALID', 'PLAN_REFERENCE_INVALID', 'PLAN_INVALID', 'MERCHANT_BINDING_INVALID',
  'BINDING_CHANGED', 'RECORDS_CHANGED', 'ACTOR_CHANGED', 'INVOICE_ALLOCATION_INVALID',
  'FINAL_INVOICE_CHANGED', 'FINAL_ALLOCATION_INVALID', 'PAYMENT_PROOF_EXPIRED', 'SAVED_QUOTE_INVALID',
  'STARTED_AUTHORIZATION_MISMATCH', 'STARTED_QUOTE_EXPIRED', 'FRESH_QUOTE_INVALID', 'FRESH_QUOTE_EXPIRED',
  'GRANT_EXPIRED', 'REVERSAL_VERIFIER_UNAVAILABLE', 'REVERSAL_PROOF_INVALID']);
const codes = new Set(['PRODUCTION_UNAVAILABLE', 'PRODUCTION_ALLOWANCE_INVALID', 'HOSTED_CHECKOUT_UNAVAILABLE',
  'HOSTED_REVERSALS_UNVERIFIED', 'PAYMENT_CONFLICT', 'PRODUCTION_NOT_FOUND', 'PRODUCTION_PLAN_CHANGED',
  'PRODUCTION_ALREADY_STARTED', 'PRODUCTION_REVIEW_REQUIRED', 'INVALID_PRODUCTION_REQUEST',
  'PRODUCTION_AUTHORIZATION_REQUIRED']);
const diagnostics = new WeakMap();
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');

// Diagnostic tags do not modify the thrown error or expose its message/data.
export function markProductionAuthorizationFailure(error, stage, reason) {
  if (object(error)) {
    const previous = diagnostics.get(error);
    diagnostics.set(error, { stage: stages.has(stage) ? stage : 'authorization',
      reason: reasons.has(reason) ? reason : previous?.reason });
  }
  return error;
}

export function productionAuthorizationDiagnostic(error) {
  const tagged = object(error) ? diagnostics.get(error) : undefined;
  const code = codes.has(error?.code) ? error.code : 'UNEXPECTED_FAILURE';
  return { stage: stages.has(tagged?.stage) ? tagged.stage : 'authorization',
    reason: reasons.has(tagged?.reason) ? tagged.reason
      : code === 'HOSTED_REVERSALS_UNVERIFIED' ? hostedReversalReason(error?.reason) || code : code };
}
