export type CheckoutConfiguration = { available: false } | {
  available: true;
  environment: "sandbox" | "production";
  tokenization: { method: "intuit-browser-direct"; url: string };
};
export type FilmQuote = {
  id: string; orderId: string; preparedId: string; filmId: string; filmTitle: string;
  manifestHash: string; currency: "USD"; amountCents: number; expiresAt: string; sandbox: boolean;
};
export type FilmOrder = {
  id: string; quoteId: string; preparedId: string; filmId: string; filmTitle: string;
  status: "submitting" | "captured" | "declined" | "uncertain" | "refund-pending" | "partially-refunded" | "refunded";
  currency: "USD"; amountCents: number; refundedCents: number; charged: boolean | null;
  requiresReview: boolean; receiptAvailable: boolean; createdAt: string; updatedAt: string; sandbox: boolean;
};
export type FilmReceipt = { receiptId: string; filmTitle: string; currency: "USD"; amountCents: number; refundedCents: number; capturedAt: string; status: FilmOrder["status"]; sandbox: boolean };
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const amount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100_000_000;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

// Intuit's official browser sample posts card data directly to these token URLs.
// A server-supplied arbitrary URL must never become a card-data destination.
export function normalizeCheckoutConfiguration(value: unknown): CheckoutConfiguration {
  if (!object(value) || value.available !== true || !["sandbox", "production"].includes(String(value.environment)) || !object(value.tokenization)) return { available: false };
  const url = value.environment === "sandbox"
    ? "https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens"
    : "https://api.intuit.com/quickbooks/v4/payments/tokens";
  if (value.tokenization.method !== "intuit-browser-direct" || value.tokenization.url !== url) return { available: false };
  return { available: true, environment: value.environment as "sandbox" | "production", tokenization: { method: "intuit-browser-direct", url } };
}

export function normalizeFilmQuote(value: unknown): FilmQuote | null {
  if (!object(value) || !digest(value.id) || !digest(value.orderId) || !uuid(value.preparedId) || !digest(value.manifestHash)
    || !text(value.filmId, 100) || !text(value.filmTitle, 300) || value.currency !== "USD" || !amount(value.amountCents)
    || !timestamp(value.expiresAt) || typeof value.sandbox !== "boolean") return null;
  return { id: value.id, orderId: value.orderId, preparedId: value.preparedId, manifestHash: value.manifestHash,
    filmId: value.filmId, filmTitle: value.filmTitle, currency: "USD", amountCents: value.amountCents, expiresAt: value.expiresAt, sandbox: value.sandbox };
}

export function normalizeFilmOrder(value: unknown): FilmOrder | null {
  if (!object(value) || !digest(value.id) || !digest(value.quoteId) || !uuid(value.preparedId)
    || !text(value.filmId, 100) || !text(value.filmTitle, 300) || value.currency !== "USD" || !amount(value.amountCents)
    || !Number.isSafeInteger(value.refundedCents) || Number(value.refundedCents) < 0 || Number(value.refundedCents) > value.amountCents
    || !["submitting", "captured", "declined", "uncertain", "refund-pending", "partially-refunded", "refunded"].includes(String(value.status))
    || ![true, false, null].includes(value.charged as boolean | null) || typeof value.requiresReview !== "boolean"
    || typeof value.receiptAvailable !== "boolean" || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || typeof value.sandbox !== "boolean") return null;
  if ((["captured", "partially-refunded", "refunded"].includes(String(value.status)) && value.charged !== true)
    || (value.status === "declined" && value.charged !== false)) return null;
  return { id: value.id, quoteId: value.quoteId, preparedId: value.preparedId, filmId: value.filmId, filmTitle: value.filmTitle,
    status: value.status as FilmOrder["status"], currency: "USD", amountCents: value.amountCents, refundedCents: value.refundedCents as number,
    charged: value.charged as boolean | null, requiresReview: value.requiresReview, receiptAvailable: value.receiptAvailable,
    createdAt: value.createdAt, updatedAt: value.updatedAt, sandbox: value.sandbox };
}

export function normalizeFilmReceipt(value: unknown): FilmReceipt | null {
  if (!object(value) || !digest(value.receiptId) || !text(value.filmTitle, 300) || value.currency !== "USD" || !amount(value.amountCents)
    || !Number.isSafeInteger(value.refundedCents) || Number(value.refundedCents) < 0 || Number(value.refundedCents) > value.amountCents
    || !timestamp(value.capturedAt) || !["captured", "uncertain", "refund-pending", "partially-refunded", "refunded"].includes(String(value.status))
    || typeof value.sandbox !== "boolean") return null;
  return { receiptId: value.receiptId, filmTitle: value.filmTitle, currency: "USD", amountCents: value.amountCents,
    refundedCents: value.refundedCents as number, capturedAt: value.capturedAt, status: value.status as FilmOrder["status"], sandbox: value.sandbox };
}

export function quoteMatchesConfiguration(quote: FilmQuote | null, configuration: CheckoutConfiguration | null): boolean {
  return Boolean(quote && configuration?.available && quote.sandbox === (configuration.environment === "sandbox"));
}

export function paymentStatusMessage(order: FilmOrder): string {
  if (order.requiresReview) return "Your payment needs review. Do not submit another payment. Check this order's status or contact the administrator.";
  switch (order.status) {
    case "captured": return order.sandbox ? "Your test payment is confirmed. No real money was charged." : "Your payment is confirmed.";
    case "declined": return "Your payment was declined. No charge was confirmed. Contact the administrator before trying another payment for this plan.";
    case "partially-refunded": return "Part of your payment has been refunded.";
    case "refunded": return "Your payment has been refunded.";
    default: return "Your payment is not yet confirmed. Check this order's status before doing anything further.";
  }
}
