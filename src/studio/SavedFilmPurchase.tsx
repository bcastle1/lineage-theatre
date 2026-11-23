import { useEffect, useRef, useState } from 'react';
import { api, normalizePaymentReference, type FilmPaymentReference } from './model';
import type { FilmQuote } from './checkout-contract';
import { commitFilmPayment } from './checkout-payment';
import { paymentReturnLink, rememberPaymentWindow, reservePaymentWindow } from './payment-window';
import { captchaToken } from '../lib/captcha';
import CaptchaNotice from '../CaptchaNotice';
import type { LibraryEntry } from './film-library';
import { prepareSavedFilmCheckout } from './saved-film-purchase';
import { normalizePreRenderStatus, preRenderCanResume, preRenderRequest } from './film-prerender';

const money = (cents: number) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
export default function SavedFilmPurchase({ entry, disabled = false, onRefresh }: { entry: LibraryEntry; disabled?: boolean; onRefresh?: () => Promise<void> }) {
  const [quote, setQuote] = useState<FilmQuote | null>(null), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const [recovery, setRecovery] = useState<FilmPaymentReference | null>(null);
  const quoteKey = useRef(crypto.randomUUID()), checkoutKey = useRef(crypto.randomUUID()), lock = useRef(false);
  const storageKey = `lineage-film-purchase:${entry.id}`;
  useEffect(() => {
    try {
      const saved = normalizePaymentReference(JSON.parse(localStorage.getItem(storageKey) || 'null'));
      if (saved && saved.preparedId === entry.id && saved.manifestHash === entry.manifestHash) setRecovery(saved);
    } catch { /* No order is created until recovery can be saved successfully. */ }
    setLoaded(true);
  }, [storageKey, entry.id, entry.manifestHash]);
  const savedStatus = entry.kind === 'plan' && entry.manifestHash ? normalizePreRenderStatus({ ...entry.production, id: entry.id, manifestHash: entry.manifestHash }, { id: entry.id, manifestHash: entry.manifestHash }) : null;
  const canResume = Boolean(!recovery && !entry.payments.length && entry.manifestHash && preRenderCanResume(savedStatus, { id: entry.id, manifestHash: entry.manifestHash }));
  if (!entry.production.price || !canResume && (!entry.production.artifactReady || !entry.production.purchaseReady || !entry.production.paymentLocked)) return null;
  if (entry.payments.length > 1) return <p role="alert">This film has multiple payment records. Contact the administrator before paying.</p>;
  const existingId = entry.payments[0]?.id || recovery?.orderId;
  async function work(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment could not be prepared. Check this saved film before retrying.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function reviewPrice() {
    await work(async () => {
      setConsent(false); setQuote(null);
      const next = await prepareSavedFilmCheckout({ entry, quoteKey: quoteKey.current, request: api });
      setQuote(next);
    });
  }
  async function resumeProduction() {
    if (!canResume || !consent || !loaded || !savedStatus) return;
    await work(async () => {
      const value = await api('/api/studio', preRenderRequest(entry.id, savedStatus.price.amountCents, consent));
      if (!normalizePreRenderStatus(value, { id: entry.id, manifestHash: savedStatus.manifestHash })) throw new Error('Check this saved film’s status before retrying.');
      setConsent(false); await onRefresh?.();
    });
  }
  async function pay() {
    if (!quote || !consent || existingId || lock.current) return;
    const handle = reservePaymentWindow();
    await work(async () => {
      try {
        const proof = await api<{checkoutProof:string}>('/api/studio', { action: 'checkoutCheck', quoteId: quote.id, captchaToken: await captchaToken('checkout') });
        const reference: FilmPaymentReference = { preparedId: quote.preparedId, manifestHash: quote.manifestHash,
          quoteId: quote.id, orderId: quote.orderId, checkoutKey: checkoutKey.current, submittedAt: new Date().toISOString(), sandbox: false };
        const order = await commitFilmPayment({ request: api, quote, reference, checkoutProof: proof.checkoutProof, productionConsent: true,
          persist: saved => { localStorage.setItem(storageKey, JSON.stringify(saved)); setRecovery(saved); } });
        if (order.status === 'awaiting-payment' && order.invoiceUrl && !order.requiresReview && handle.open(order.invoiceUrl)) rememberPaymentWindow(order.id, handle);
        window.location.hash = paymentReturnLink(order.id);
      } finally { handle.close(); }
    });
  }
  if (canResume) return <section className="film-price-review" aria-label="Resume this saved film">
    <h3>Retry creating this saved film</h3><p>Production has not entered the queue. The studio covers rendering; your purchase price stays {money(entry.production.price.amountCents)}. No payment is requested.</p>
    <label className="check-label"><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={event=>setConsent(event.target.checked)}/><span>Retry creating this exact saved film before payment.</span></label>
    <button className="button primary" disabled={busy || disabled || !loaded || !consent} onClick={()=>void resumeProduction()}>Retry this saved film</button>
    {busy&&<p role="status">Checking this saved film’s production request…</p>}{error&&<p role="alert">{error}</p>}
  </section>;
  return <section className="film-price-review" aria-label="Unlock this finished film">
    <h3>Unlock your finished film</h3><p>{money(entry.production.price.amountCents)} total. Your video has passed its delivery checks. Payment unlocks this exact saved film.</p>
    {existingId ? <a className="button primary" href={paymentReturnLink(existingId)}>Open saved payment and film</a> : <>
      {!quote && <button className="button primary" disabled={disabled || busy || !loaded} onClick={() => void reviewPrice()}>Review price and payment terms</button>}
      {quote && <><p>{money(quote.amountCents)} USD · Price valid until {new Date(quote.expiresAt).toLocaleString()}</p>
        <button className="text-button" disabled={busy || disabled} onClick={() => { quoteKey.current = crypto.randomUUID(); void reviewPrice(); }}>Refresh checkout terms</button>
        <h4>Delivery</h4><p style={{whiteSpace:'pre-wrap'}}>{quote.deliveryTerms}</p><h4>Refund policy</h4><p style={{whiteSpace:'pre-wrap'}}>{quote.refundTerms}</p>
        <label className="check-label"><input type="checkbox" checked={consent} disabled={busy || disabled} onChange={event => setConsent(event.target.checked)}/><span>I accept these terms and want to pay {money(quote.amountCents)} on QuickBooks to unlock this finished film.</span></label>
        <p>QuickBooks opens in another tab. Once payment is confirmed, return to this film to watch and download it. Confirmation may take a moment.</p><CaptchaNotice/>
        <button className="button primary" disabled={busy || disabled || !consent} onClick={() => void pay()}>Open secure payment page</button></>}
    </>}{busy && <p role="status">Checking your saved film and payment…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
