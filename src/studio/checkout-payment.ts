import { normalizeFilmOrder, normalizeFilmQuote, type FilmOrder, type FilmQuote } from "./checkout-contract";
import type { FilmPaymentReference } from "./model";

type Request = (path: string, body?: unknown) => Promise<unknown>;
type ExpectedOrder = Pick<FilmOrder, "amountCents" | "filmId" | "checkoutMethod">;
const unconfirmed = () => new Error("Your payment result is not confirmed. Do not submit another payment. Check this order's status or contact the administrator.");

export function orderForReference(value: unknown, reference: FilmPaymentReference, expected?: ExpectedOrder): FilmOrder {
  const result = normalizeFilmOrder(value);
  if (!result || result.id !== reference.orderId || result.quoteId !== reference.quoteId || result.preparedId !== reference.preparedId || result.sandbox !== reference.sandbox
    || (expected && (result.amountCents !== expected.amountCents || result.filmId !== expected.filmId || result.checkoutMethod !== expected.checkoutMethod))) throw unconfirmed();
  return result;
}

// An explicit status check asks the server to verify the existing invoice and
// linked payment. It cannot create another invoice or infer payment from a URL.
export async function checkFilmPayment(request: Request, reference: FilmPaymentReference, expected?: ExpectedOrder): Promise<FilmOrder> {
  return orderForReference(await request("/api/studio", { action: "checkPayment", orderId: reference.orderId }), reference, expected);
}

export async function recoverFilmPayment(request: Request, reference: FilmPaymentReference): Promise<FilmOrder> {
  return orderForReference(await request(`/api/studio?action=order&id=${encodeURIComponent(reference.orderId)}`), reference);
}

// Only a fresh server record explicitly proving that no invoice POST was
// attempted can authorize this retry. It keeps every saved request identity.
export async function retryFilmPayment({ request, order, reference, checkoutProof }: {
  request: Request; order: FilmOrder; reference: FilmPaymentReference; checkoutProof: string;
}): Promise<FilmOrder> {
  const current = orderForReference(order, reference);
  if (current.retryAllowed !== true || current.status !== "uncertain" || current.checkoutMethod !== "quickbooks-hosted-invoice") {
    throw new Error("This order cannot be retried. Check payment status or contact the administrator.");
  }
  if (!/^[a-f0-9]{64}$/.test(checkoutProof)) throw new Error("Complete the payment security check before continuing.");
  try {
    return orderForReference(await request("/api/studio", { action: "checkout", quoteId: reference.quoteId,
      idempotencyKey: reference.checkoutKey, checkoutProof, consent: true }), reference, current);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "QUOTE_EXPIRED") {
      throw new Error("The saved price or checkout terms changed. Contact the administrator before continuing with this order.");
    }
    try { return orderForReference(await recoverFilmPayment(request, reference), reference, current); }
    catch { throw unconfirmed(); }
  }
}

// The caller creates one attempt, saves this safe reference, and then makes one
// checkout POST. Every uncertain outcome uses reads, including after a reload.
export async function commitFilmPayment({ request, quote, reference, checkoutProof, persist, now = Date.now }: {
  request: Request; quote: FilmQuote; reference: FilmPaymentReference; checkoutProof: string;
  persist: (reference: FilmPaymentReference) => void; now?: () => number;
}): Promise<FilmOrder> {
  if (!normalizeFilmQuote(quote) || quote.orderId !== reference.orderId || quote.id !== reference.quoteId || quote.preparedId !== reference.preparedId
    || quote.manifestHash !== reference.manifestHash || quote.sandbox !== reference.sandbox || Date.parse(quote.expiresAt) <= now()) {
    throw new Error("Your film price expired or changed before payment. Request a new price.");
  }
  if (!/^[a-f0-9]{64}$/.test(checkoutProof)) throw new Error("Complete the payment security check before continuing.");
  persist(reference);
  const verifyAmount = (order: FilmOrder) => {
    if (order.amountCents !== quote.amountCents || order.sandbox !== quote.sandbox || order.filmId !== quote.filmId
      || order.checkoutMethod !== quote.method) throw unconfirmed();
    return order;
  };
  try {
    const result = await request("/api/studio", { action: "checkout", quoteId: quote.id, idempotencyKey: reference.checkoutKey, checkoutProof, consent: true });
    return verifyAmount(orderForReference(result, reference));
  } catch {
    try { return verifyAmount(await recoverFilmPayment(request, reference)); }
    catch { throw unconfirmed(); }
  }
}
