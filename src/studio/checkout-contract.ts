export type CheckoutConfiguration = { available: false } | {
  available: true;
  method: "quickbooks-hosted-invoice";
  environment: "sandbox" | "production";
  deliveryTerms: string; refundTerms: string;
};
export type FilmQuote = {
  id: string; orderId: string; preparedId: string; filmId: string; filmTitle: string;
  manifestHash: string; currency: "USD"; amountCents: number; expiresAt: string; sandbox: boolean;
  method: "quickbooks-hosted-invoice"; deliveryTerms: string; refundTerms: string;
};
export type FilmOrder = {
  id: string; quoteId: string; preparedId: string; filmId: string; filmTitle: string;
  status: "submitting" | "awaiting-payment" | "captured" | "declined" | "uncertain" | "refund-pending" | "partially-refunded" | "refunded";
  currency: "USD"; amountCents: number; refundedCents: number; charged: boolean | null;
  requiresReview: boolean; receiptAvailable: boolean; createdAt: string; updatedAt: string; sandbox: boolean;
  checkoutMethod?: "quickbooks-hosted-invoice"; invoiceUrl?: string | null; invoiceNumber?: string | null;
  confirmationSource?: "quickbooks-accounting";
  retryAllowed?: boolean;
};
export type FilmReceipt = { receiptId: string; filmTitle: string; currency: "USD"; amountCents: number; refundedCents: number; capturedAt: string; status: FilmOrder["status"]; sandbox: boolean; transactionId: string | null; processorDisclosure: string; confirmationSource?: "quickbooks-accounting" };
const processorDisclosure = "Payment is processed by: Intuit Payments Inc., 2700 Coast Avenue, Mountain View, CA 94043, Phone number 1-888-536-4801, NMLS #1098819";
const accountingDisclosure = "Payment recorded by QuickBooks. This record reflects a payment applied to your invoice; it does not confirm payment processor capture, bank settlement, or any later refund.";
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const amount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100_000_000;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const terms = (value: unknown): value is string => text(value, 10_000) && Boolean(value.trim()) && !/[<>\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
const hostedMethod = "quickbooks-hosted-invoice";

// Only the provider's hosted invoice portal may receive payment navigation.
// No customer card or bank data is collected or submitted by this application.
export function normalizeHostedInvoiceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192 || !value.startsWith("https://connect.intuit.com/")
    || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const portal = url.pathname.startsWith("/portal/") && url.pathname.length > "/portal/".length;
    const shortLink = /^https:\/\/connect\.intuit\.com\/t\/scs-v1-[a-fA-F0-9]{96}(?:\?locale=[a-zA-Z]{2}_[a-zA-Z]{2})?$/.test(value);
    if (url.protocol !== "https:" || url.hostname !== "connect.intuit.com" || url.username || url.password || url.port || url.hash
      || (!portal && !shortLink) || url.href !== value) return null;
    return value;
  } catch { return null; }
}

export function normalizeCheckoutConfiguration(value: unknown): CheckoutConfiguration {
  if (!object(value) || value.available !== true || !["sandbox", "production"].includes(String(value.environment))
    || value.method !== hostedMethod || !terms(value.deliveryTerms) || !terms(value.refundTerms)) return { available: false };
  return { available: true, method: hostedMethod, environment: value.environment as "sandbox" | "production",
    deliveryTerms: value.deliveryTerms, refundTerms: value.refundTerms };
}

export function normalizeFilmQuote(value: unknown): FilmQuote | null {
  if (!object(value) || !digest(value.id) || !digest(value.orderId) || !uuid(value.preparedId) || !digest(value.manifestHash)
    || !text(value.filmId, 100) || !text(value.filmTitle, 300) || value.currency !== "USD" || !amount(value.amountCents)
    || !timestamp(value.expiresAt) || typeof value.sandbox !== "boolean" || value.method !== hostedMethod
    || !terms(value.deliveryTerms) || !terms(value.refundTerms)) return null;
  return { id: value.id, orderId: value.orderId, preparedId: value.preparedId, manifestHash: value.manifestHash,
    filmId: value.filmId, filmTitle: value.filmTitle, currency: "USD", amountCents: value.amountCents, expiresAt: value.expiresAt, sandbox: value.sandbox,
    method: hostedMethod, deliveryTerms: value.deliveryTerms, refundTerms: value.refundTerms };
}

export function normalizeFilmOrder(value: unknown): FilmOrder | null {
  if (!object(value) || !digest(value.id) || !digest(value.quoteId) || !uuid(value.preparedId)
    || !text(value.filmId, 100) || !text(value.filmTitle, 300) || value.currency !== "USD" || !amount(value.amountCents)
    || !Number.isSafeInteger(value.refundedCents) || Number(value.refundedCents) < 0 || Number(value.refundedCents) > value.amountCents
    || !["submitting", "awaiting-payment", "captured", "declined", "uncertain", "refund-pending", "partially-refunded", "refunded"].includes(String(value.status))
    || ![true, false, null].includes(value.charged as boolean | null) || typeof value.requiresReview !== "boolean"
    || typeof value.receiptAvailable !== "boolean" || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || typeof value.sandbox !== "boolean") return null;
  if ((["captured", "partially-refunded", "refunded"].includes(String(value.status)) && value.charged !== true)
    || (value.status === "declined" && value.charged !== false) || (value.receiptAvailable && value.charged !== true)) return null;
  const hosted = value.checkoutMethod === hostedMethod;
  if (value.checkoutMethod !== undefined && !hosted) return null;
  if (value.retryAllowed !== undefined && (typeof value.retryAllowed !== "boolean" || !hosted)) return null;
  if (value.retryAllowed === true && (value.status !== "uncertain" || value.charged !== null || !value.requiresReview || value.receiptAvailable || value.invoiceUrl != null)) return null;
  if (value.confirmationSource !== undefined && (value.confirmationSource !== "quickbooks-accounting" || !hosted)) return null;
  if (hosted && value.charged === true && value.confirmationSource !== "quickbooks-accounting") return null;
  if ((value.status === "awaiting-payment" && (!hosted || value.charged !== false || value.receiptAvailable || value.refundedCents !== 0))
    || (!hosted && (value.invoiceUrl !== undefined || value.invoiceNumber !== undefined))) return null;
  const invoiceUrl = value.invoiceUrl == null ? null : normalizeHostedInvoiceUrl(value.invoiceUrl);
  if (hosted && ((value.invoiceUrl != null && !invoiceUrl) || (value.invoiceNumber != null
    && (!text(value.invoiceNumber, 100) || !value.invoiceNumber.trim() || /[<>\u0000-\u001f\u007f]/.test(value.invoiceNumber))))) return null;
  return { id: value.id, quoteId: value.quoteId, preparedId: value.preparedId, filmId: value.filmId, filmTitle: value.filmTitle,
    status: value.status as FilmOrder["status"], currency: "USD", amountCents: value.amountCents, refundedCents: value.refundedCents as number,
    charged: value.charged as boolean | null, requiresReview: value.requiresReview, receiptAvailable: value.receiptAvailable,
    createdAt: value.createdAt, updatedAt: value.updatedAt, sandbox: value.sandbox,
    ...(hosted ? { checkoutMethod: hostedMethod, invoiceUrl, invoiceNumber: value.invoiceNumber as string | null | undefined ?? null, retryAllowed: value.retryAllowed === true,
      ...(value.confirmationSource === "quickbooks-accounting" ? { confirmationSource: "quickbooks-accounting" as const } : {}) } : {}) };
}

export function normalizeFilmReceipt(value: unknown): FilmReceipt | null {
  if (!object(value) || !digest(value.receiptId) || !text(value.filmTitle, 300) || value.currency !== "USD" || !amount(value.amountCents)
    || !Number.isSafeInteger(value.refundedCents) || Number(value.refundedCents) < 0 || Number(value.refundedCents) > value.amountCents
    || !timestamp(value.capturedAt) || !["captured", "uncertain", "refund-pending", "partially-refunded", "refunded"].includes(String(value.status))
    || typeof value.sandbox !== "boolean") return null;
  if (value.confirmationSource !== undefined && value.confirmationSource !== "quickbooks-accounting") return null;
  const accounting = value.confirmationSource === "quickbooks-accounting";
  if (value.checkoutMethod !== undefined && (value.checkoutMethod !== hostedMethod || !accounting)) return null;
  return { receiptId: value.receiptId, filmTitle: value.filmTitle, currency: "USD", amountCents: value.amountCents,
    refundedCents: value.refundedCents as number, capturedAt: value.capturedAt, status: value.status as FilmOrder["status"], sandbox: value.sandbox,
    transactionId: typeof value.transactionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.transactionId) ? value.transactionId : null,
    processorDisclosure: accounting ? accountingDisclosure : processorDisclosure,
    ...(accounting ? { confirmationSource: "quickbooks-accounting" as const } : {}) };
}

export function quoteMatchesConfiguration(quote: FilmQuote | null, configuration: CheckoutConfiguration | null): boolean {
  return Boolean(quote && configuration?.available && quote.method === configuration.method
    && quote.deliveryTerms === configuration.deliveryTerms && quote.refundTerms === configuration.refundTerms
    && quote.sandbox === (configuration.environment === "sandbox"));
}

export function paymentStatusMessage(order: FilmOrder): string {
  if (order.retryAllowed === true) return "Your payment page could not be prepared. No invoice was submitted for this order. You can retry preparing the saved payment page.";
  if (order.requiresReview) return "Your payment needs review. Do not submit another payment. Check this order's status or contact the administrator.";
  switch (order.status) {
    case "awaiting-payment": return order.invoiceUrl
      ? "Your payment is not yet confirmed. Complete payment on QuickBooks, then return here to check its status."
      : "Your invoice is saved and remains unpaid. The secure payment page is not available yet. Check payment status to try loading the page again, or contact the administrator. Your finished film stays locked until payment is confirmed.";
    case "captured": return order.confirmationSource === "quickbooks-accounting"
      ? order.sandbox ? "Test payment recorded by QuickBooks. No real money was charged." : "Payment recorded by QuickBooks."
      : order.sandbox ? "Your test payment is confirmed. No real money was charged." : "Your payment is confirmed.";
    case "declined": return "Your payment was declined. No charge was confirmed. Contact the administrator before trying another payment for this plan.";
    case "partially-refunded": return "Part of your payment has been refunded.";
    case "refunded": return "Your payment has been refunded.";
    default: return "Your payment is not yet confirmed. Check this order's status before doing anything further.";
  }
}
