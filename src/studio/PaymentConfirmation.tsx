import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { api } from "./model";
import { paymentStatusMessage, type FilmOrder } from "./checkout-contract";
import { libraryCanWatch, libraryFilmLink, type LibraryEntry } from "./film-library";
import { confirmedFilmPayment, paymentProductionSummary, readPaymentFilm, watchPaymentConfirmation } from "./payment-confirmation";
import { completePaymentWindow, rememberPaymentWindow, reservePaymentWindow } from "./payment-window";
import FilmProductionProgress from "./FilmProductionProgress";
import "./payment-confirmation.css";

export default function PaymentConfirmation({ orderId, visible, productionAvailable, onPaid }: {
  orderId: string | null; visible: boolean; productionAvailable?: boolean; onPaid: (id: string) => void;
}) {
  const [order, setOrder] = useState<FilmOrder | null>(null), [film, setFilm] = useState<LibraryEntry | null>(null);
  const [error, setError] = useState(""), [checking, setChecking] = useState(true), [reload, setReload] = useState(0);
  const [opening, setOpening] = useState(false);
  const latest = useRef({ visible, onPaid }); latest.current = { visible, onPaid };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setOrder(null); setFilm(null); }, [orderId]);
  useEffect(() => { if (visible) { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: "start" }); } }, [visible, orderId]);
  useEffect(() => {
    setError(""); setChecking(true);
    if (!orderId) { setChecking(false); return; }
    let active = true;
    const watcher = watchPaymentConfirmation({ id: orderId, request: api,
      isVisible: () => latest.current.visible && document.visibilityState === "visible",
      onPaid: saved => { latest.current.onPaid(saved.id); completePaymentWindow(saved.id); },
      onOrder: async saved => {
        if (!active) return;
        setOrder(saved); setError(""); setChecking(false);
        if (confirmedFilmPayment(saved)) {
          try { const entry = await readPaymentFilm(api, saved); if (active) setFilm(entry); }
          catch { if (active) { setFilm(null); setError("Payment received. Film status is temporarily unavailable. Check again or open your film library; do not pay again."); } }
        } else setFilm(null);
      },
      onError: message => { if (active) { setChecking(false); setError(message); } },
    });
    const refresh = () => { if (document.visibilityState === "visible") void watcher.refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { active = false; watcher.stop(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [orderId, reload]);
  const paid = confirmedFilmPayment(order), ready = Boolean(paid && film && libraryCanWatch(film));
  function openPayment() {
    if (!order?.invoiceUrl || order.status !== "awaiting-payment" || order.requiresReview || opening) return;
    setOpening(true);
    const handle = reservePaymentWindow();
    if (handle.open(order.invoiceUrl)) { rememberPaymentWindow(order.id, handle); setError(""); }
    else setError("Your browser did not open the payment tab. Allow pop-ups for Lineage Theatre, then select Open secure payment page. Your saved invoice will be reused.");
    handle.close(); setOpening(false);
  }
  return <section hidden={!visible} className="payment-confirmation" aria-labelledby="paid-film-heading">
    <p className="eyebrow">LINEAGE THEATRE · PAYMENT & PRODUCTION</p>
    <h1 id="paid-film-heading" tabIndex={-1} ref={heading}>Your paid film</h1>
    {!orderId ? <p role="alert">This payment link is incomplete. Open your film library to find your saved order.</p> : <>
      <div className="payment-confirmation-status" role="status">
        {paid ? <CheckCircle2 size={26} aria-hidden="true" /> : checking ? <Loader2 size={26} className="spin" aria-hidden="true" /> : <RefreshCw size={26} aria-hidden="true" />}
        <div><h2>{paid ? order?.sandbox ? "Test payment confirmed" : "Payment received" : checking ? "Checking your payment" : order?.status === "awaiting-payment" ? "Waiting for payment confirmation" : "Payment needs review"}</h2>
          {order && <p>{order.filmTitle} · {(order.amountCents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })}{paid ? order.sandbox ? " test payment" : " paid to BROCOTech" : " invoice total"}</p>}
        </div>
      </div>
      {paid ? <p className="payment-confirmation-summary">{paymentProductionSummary(order, film, productionAvailable)}</p>
        : order?.status === "awaiting-payment" ? <p>Complete your secure payment in the QuickBooks tab. Keep this Lineage Theatre tab open. We check in the background and return the payment tab here after confirmation, where your film status appears. If your browser prevents the automatic return, come back to this tab.</p>
          : order ? <p>{paymentStatusMessage(order)}</p> : <p>We verify your saved order before confirming a purchase. Opening this page does not charge you.</p>}
      {paid && film && <FilmProductionProgress paid ready={ready} available={productionAvailable} status={film.production.status}
        completedShots={film.production.completedShots} shotCount={film.production.shotCount} progress={film.production.progress} needsAttention={film.production.needsAttention} />}
      {order?.invoiceNumber && <p className="field-note">Invoice {order.invoiceNumber} · Confirmation is checked with QuickBooks.</p>}
      {error && <p className="feedback error" role="alert">{error}</p>}
      <div className="action-group">
        {order?.status === "awaiting-payment" && order.invoiceUrl && !order.requiresReview && <button className="button primary" disabled={opening} onClick={openPayment}><ExternalLink size={16} />Open secure payment page</button>}
        <button className="button secondary" disabled={checking} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} />Check payment status</button>
        {order && <a className={`button ${ready ? "primary" : "secondary"}`} href={libraryFilmLink(order.preparedId)}>{ready ? "Watch your film" : "View saved film"}</a>}
        <a className="text-button" href={`mailto:admin@brocotech.ai?subject=${encodeURIComponent(`Lineage Theatre payment ${orderId}`)}`}>Get help</a>
      </div>
      {ready && film?.mediaUrl && <video controls preload="metadata" src={film.mediaUrl} aria-label="Your finished paid film" />}
      {paid && <p className="field-note">Your payment and saved film stay in your account. Watch and download become available here and in your film library when the finished video is verified.</p>}
    </>}
    {!orderId && <a className="button secondary" href="#library">Open film library</a>}
  </section>;
}
