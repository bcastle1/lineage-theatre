import { digest } from '../../api/_lib/auth.mjs';

// Historical checkout tests begin with an explicitly saved, unattempted order.
// New production orders must use render-first; this fixture is never runtime code.
export function legacyHostedOrder(quote, idempotencyKey, at) {
  const id = quote.merchantBinding.environment === 'sandbox' ? digest(`${quote.customerEmail}:${quote.manifestHash}`)
    : digest(`${quote.customerEmail}:production:${quote.manifestHash}`);
  const h = digest(`invoice:${id}`), invoiceRequestId = `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
  return { ...quote, id, version: 1, provider: 'quickbooks', quoteId: quote.id, checkoutMethod: 'quickbooks-hosted-invoice',
    status: 'uncertain', refundedCents: 0, providerChargeId: null, capturedAt: null, invoiceId: null, invoiceUrl: null, invoiceNumber: null,
    invoiceRequestId, checkoutKeyHash: digest(idempotencyKey), consentAt: new Date(at).toISOString(), createdAt: new Date(at).toISOString() };
}
