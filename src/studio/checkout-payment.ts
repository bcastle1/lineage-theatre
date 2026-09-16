import { normalizeFilmOrder, type FilmOrder, type FilmQuote } from "./checkout-contract";
import type { FilmPaymentReference } from "./model";

type Request = (path: string, body?: unknown) => Promise<unknown>;
const unconfirmed = () => new Error("Your payment result is not confirmed. Do not submit another payment. Check this order's status or contact the administrator.");

export function orderForReference(value: unknown, reference: FilmPaymentReference): FilmOrder {
  const result = normalizeFilmOrder(value);
  if (!result || result.id !== reference.orderId || result.quoteId !== reference.quoteId || result.preparedId !== reference.preparedId || result.sandbox !== reference.sandbox) throw unconfirmed();
  return result;
}

export async function recoverFilmPayment(request: Request, reference: FilmPaymentReference): Promise<FilmOrder> {
  return orderForReference(await request(`/api/studio?action=order&id=${encodeURIComponent(reference.orderId)}`), reference);
}

// The caller creates one attempt, saves this safe reference, and then makes one
// checkout POST. Every uncertain outcome uses reads, including after a reload.
export async function commitFilmPayment({ request, quote, reference, paymentToken, checkoutProof, persist, now = Date.now }: {
  request: Request; quote: FilmQuote; reference: FilmPaymentReference; paymentToken: string; checkoutProof: string;
  persist: (reference: FilmPaymentReference) => void; now?: () => number;
}): Promise<FilmOrder> {
  if (quote.orderId !== reference.orderId || quote.id !== reference.quoteId || quote.preparedId !== reference.preparedId
    || quote.manifestHash !== reference.manifestHash || quote.sandbox !== reference.sandbox || Date.parse(quote.expiresAt) <= now()) {
    throw new Error("Your film price expired or changed before payment. Request a new price.");
  }
  persist(reference);
  const verifyAmount = (order: FilmOrder) => {
    if (order.amountCents !== quote.amountCents || order.sandbox !== quote.sandbox || order.filmId !== quote.filmId) throw unconfirmed();
    return order;
  };
  try {
    const result = await request("/api/studio", { action: "checkout", quoteId: quote.id, idempotencyKey: reference.checkoutKey, paymentToken, checkoutProof, consent: true });
    return verifyAmount(orderForReference(result, reference));
  } catch {
    try { return verifyAmount(await recoverFilmPayment(request, reference)); }
    catch { throw unconfirmed(); }
  }
}
