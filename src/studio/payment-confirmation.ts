import { normalizeFilmOrder, type FilmOrder } from "./checkout-contract";
import { normalizeLibraryEntry, libraryCanWatch, type LibraryEntry } from "./film-library";

type Request = (path: string, body?: unknown) => Promise<unknown>;
export function confirmedFilmPayment(order: FilmOrder | null) {
  return Boolean(order?.status === "captured" && order.charged === true && order.receiptAvailable
    && !order.requiresReview && order.refundedCents === 0);
}
export function verifyPaymentReturnOrder(value: unknown, id: string, previous?: FilmOrder | null): FilmOrder {
  const order = normalizeFilmOrder(value);
  if (!order || order.id !== id || previous && (["quoteId", "preparedId", "filmId", "amountCents", "currency", "sandbox", "checkoutMethod"] as const)
    .some(key => order[key] !== previous[key])) throw new Error("Your payment could not be verified. Do not pay again. Please check its status.");
  return order;
}
export async function readPaymentConfirmation(request: Request, id: string, previous?: FilmOrder | null) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Choose a saved payment from your film library.");
  let order = verifyPaymentReturnOrder(await request(`/api/studio?action=order&id=${id}`), id, previous);
  if (order.status === "awaiting-payment") order = verifyPaymentReturnOrder(await request("/api/studio", { action: "checkPayment", orderId: id }), id, order);
  return order;
}
export async function readPaymentFilm(request: Request, order: FilmOrder): Promise<LibraryEntry> {
  const value = await request(`/api/library?action=detail&kind=plan&id=${order.preparedId}`) as { entry?: unknown };
  const entry = normalizeLibraryEntry(value?.entry);
  if (entry.kind !== "plan" || entry.id !== order.preparedId || entry.filmId !== order.filmId
    || !entry.payments.some(payment => payment.id === order.id && payment.amountCents === order.amountCents && payment.sandbox === order.sandbox))
    throw new Error("The film for this payment could not be verified. Your payment remains saved.");
  return entry;
}

// This watcher stays mounted in the signed-in workspace, including while the
// payment tab is foreground or the customer visits another studio section.
// It only reconciles an existing order; it never creates an invoice or charge.
export function watchPaymentConfirmation({ id, request, onOrder, onPaid, onError, isVisible = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }: {
  id: string; request: Request; onOrder: (order: FilmOrder) => void | Promise<void>;
  onPaid: (order: FilmOrder) => void; onError: (message: string) => void; isVisible?: () => boolean;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; now?: () => number;
}) {
  let stopped = false, inFlight = false, notified = false, checks = 0, previous: FilmOrder | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, lastCheck = -Infinity;
  const deadline = now() + 24 * 60_000;
  const clear = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const schedule = () => { clear(); if (!stopped) timer = setTimer(() => void refresh(), 30_000); };
  async function refresh() {
    if (stopped || inFlight) return;
    if (now() - lastCheck < 30_000) return;
    if (previous && previous.status !== "awaiting-payment" && !isVisible()) { schedule(); return; }
    if ((!previous || previous.status === "awaiting-payment") && (checks >= 48 || now() >= deadline)) {
      clear(); onError("Automatic payment checks have paused. Select Check payment status to continue; do not pay again."); return;
    }
    clear(); inFlight = true; lastCheck = now(); checks++;
    try {
      const order = await readPaymentConfirmation(request, id, previous);
      if (stopped) return;
      previous = order;
      if (confirmedFilmPayment(order) && !notified) { notified = true; onPaid(order); }
      await onOrder(order);
    } catch (cause) {
      if (!stopped) {
        const status = (cause as { status?: number })?.status;
        if (status === 401 || status === 403 || status === 404) {
          stopped = true;
          onError("This saved payment is unavailable to this session. Sign in to the account used for the purchase, or contact the studio. Do not pay again.");
        } else onError("We could not refresh your payment or film status. Your last confirmed result is shown. Do not pay again.");
      }
    }
    finally { inFlight = false; if (!stopped) schedule(); }
  }
  void refresh();
  return { refresh, stop: () => { stopped = true; clear(); } };
}
export function paymentProductionSummary(order: FilmOrder | null, film: LibraryEntry | null, available?: boolean) {
  if (!confirmedFilmPayment(order)) return "We are waiting for confirmed payment before showing production progress.";
  if (!film) return "Payment received. We are checking your saved film's production status.";
  if (libraryCanWatch(film)) return "Your finished film is ready to watch and download.";
  if (film.production.needsAttention || ["failed", "uncertain"].includes(film.production.status)) return "Your payment is confirmed. The studio needs to resolve a production issue before your film can continue. You do not need to pay again.";
  if (film.production.status === "queued") return "Your payment is confirmed and your film is queued for production.";
  if (["processing", "submitting", "verifying", "completed"].includes(film.production.status)) return "Your payment is confirmed and your film is in production. Follow its progress below.";
  return available === false ? "Your payment is confirmed, but film production is currently unavailable and your film has not started. The studio must resolve this before a delivery time can be estimated. You do not need to pay again."
    : "Your payment is confirmed. Your saved film is waiting for production to start; its delivery estimate will appear when production timing is available.";
}
