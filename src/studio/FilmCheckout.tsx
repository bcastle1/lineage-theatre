import { useEffect, useMemo, useRef, useState } from "react";
import { CreditCard, Download, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { api, ApiError, normalizePaymentReference, productionInputHash, productionPreparationInput, type Film, type FilmPaymentReference, type PreparedProduction } from "./model";
import {prepareFilmPrice,type FilmPrice} from "./film-pricing";
import { normalizeCheckoutConfiguration, normalizeFilmOrder, normalizeFilmQuote, normalizeFilmReceipt, paymentStatusMessage, quoteMatchesConfiguration, type CheckoutConfiguration, type FilmOrder, type FilmQuote } from "./checkout-contract";
import { commitFilmPayment, recoverFilmPayment } from "./checkout-payment";
import { captchaToken } from "../lib/captcha";
import CaptchaNotice from "../CaptchaNotice";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const problem = (error: unknown) => error instanceof Error ? error.message : "This request could not be completed. Please try again.";

function PaymentCardForm({ configuration, quote, consent, disabled, onToken, onBusyChange }: {
  configuration: Extract<CheckoutConfiguration, { available: true }>;
  quote: FilmQuote; consent: boolean; disabled: boolean; onToken: (token: string, checkoutProof: string) => Promise<void>;
  onBusyChange: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function tokenize(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || disabled || !consent || Date.parse(quote.expiresAt) <= Date.now()) return;
    lock.current = true; setBusy(true); setError(""); onBusyChange("Completing the payment security check…");
    const form = event.currentTarget;
    let securityCheckPending = false;
    try {
      // Uncontrolled fields stay out of application state, logs, and storage.
      // Only a token from Intuit is passed to the Lineage Theatre payment route.
      const fields = new FormData(form);
      const field = (name: string) => String(fields.get(name) || "").trim();
      const card = { name: field("cardName"), number: field("cardNumber").replace(/\s/g, ""), expMonth: field("expMonth"), expYear: field("expYear"), cvc: field("cvc"),
        address: { streetAddress: field("streetAddress"), city: field("city"), region: field("region"), postalCode: field("postalCode"), country: "US" } };
      if (!/^\d{12,19}$/.test(card.number) || !/^\d{3,4}$/.test(card.cvc) || !/^(?:0?[1-9]|1[0-2])$/.test(card.expMonth)
        || !/^20\d{2}$/.test(card.expYear) || !card.name || !card.address.streetAddress || !card.address.city || !card.address.region || !card.address.postalCode) {
        throw new Error("Check your card and billing details. No payment request has been sent.");
      }
      const body = JSON.stringify({ card });
      form.reset();
      // Check for automated abuse before sending even a test card to Intuit.
      securityCheckPending = true;
      const proof = await api<{checkoutProof: string}>("/api/studio", {
        action: "checkoutCheck", quoteId: quote.id, captchaToken: await captchaToken("checkout"),
      });
      if (!/^[a-f0-9]{64}$/.test(proof.checkoutProof || "")) throw new Error("The security check could not be confirmed.");
      securityCheckPending = false;
      onBusyChange("Checking your card…");
      const response = await fetch(configuration.tokenization.url, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", body, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error("The secure card check did not complete. No payment request was sent to Lineage Theatre. Check your details and try again.");
      const raw = await response.text();
      if (raw.length > 16_384) throw new Error("The secure card response could not be verified. No payment request was sent to Lineage Theatre.");
      const result: unknown = JSON.parse(raw);
      const token = result && typeof result === "object" && "value" in result ? result.value : null;
      if (typeof token !== "string" || token.length < 8 || token.length > 2048 || !/^[A-Za-z0-9_.=-]+$/.test(token) || !/[A-Za-z]/.test(token)) {
        throw new Error("The secure card response could not be verified. No payment request was sent to Lineage Theatre.");
      }
      await onToken(token, proof.checkoutProof);
    } catch (cause) {
      setError(securityCheckPending ? `${problem(cause)} Your card has not been submitted. Re-enter your card details to retry.`
        : cause instanceof Error && cause.message.startsWith("Check your card") ? cause.message
        : "The secure card step did not complete. No new payment request was sent. Check the order status before trying again.");
    } finally { form.reset(); lock.current = false; setBusy(false); onBusyChange(""); }
  }
  return <form className="film-card-form" onSubmit={event => void tokenize(event)} autoComplete="off">
    <fieldset disabled={busy || disabled}>
      <legend>Card and billing details</legend>
      {configuration.environment === "sandbox" && <p className="feedback">Test payment only. Use a test card; do not enter a real card.</p>}
      <p className="field-note">Payment processing provided by Intuit Payments Inc. Lineage Theatre does not store your card details.</p>
      <CaptchaNotice />
      <label>Name on card<input name="cardName" autoComplete="cc-name" required maxLength={100} /></label>
      <label>Card number<input name="cardNumber" autoComplete="cc-number" inputMode="numeric" pattern="[0-9 ]{12,23}" maxLength={23} required /></label>
      <div className="film-card-row">
        <label>Expiry month<input name="expMonth" autoComplete="cc-exp-month" inputMode="numeric" pattern="0?[1-9]|1[0-2]" placeholder="MM" maxLength={2} required /></label>
        <label>Expiry year<input name="expYear" autoComplete="cc-exp-year" inputMode="numeric" pattern="20[0-9]{2}" placeholder="YYYY" maxLength={4} required /></label>
        <label>Security code<input name="cvc" autoComplete="cc-csc" inputMode="numeric" pattern="[0-9]{3,4}" maxLength={4} required type="password" /></label>
      </div>
      <label>Billing street address<input name="streetAddress" autoComplete="billing street-address" maxLength={200} required /></label>
      <div className="film-card-row">
        <label>City<input name="city" autoComplete="billing address-level2" maxLength={100} required /></label>
        <label>State<input name="region" autoComplete="billing address-level1" maxLength={50} required /></label>
        <label>ZIP code<input name="postalCode" autoComplete="billing postal-code" inputMode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" maxLength={10} required /></label>
      </div>
      <p className="field-note">United States billing address.</p>
      {error && <p className="feedback error" role="alert">{error}</p>}
      <button className="button primary" disabled={!consent || busy || disabled}>
        {busy ? <Loader2 className="spin" size={16} /> : <CreditCard size={16} />}
        {busy ? "Checking your card…" : quote.sandbox ? `Confirm ${money(quote.amountCents)} test payment` : `Pay ${money(quote.amountCents)}`}
      </button>
    </fieldset>
  </form>;
}

type ProductionStatus = { id: string; manifestHash: string; status: string; completedShots: number; shotCount: number; preparationOnly: boolean; mediaReady?: boolean; needsAttention?: boolean };

export default function FilmCheckout({ film, productionAvailable, persistPaymentReference, onPrepared, onBusyChange }: {
  film: Film; productionAvailable: boolean;
  persistPaymentReference: (reference: FilmPaymentReference) => void;
  onPrepared: (prepared: PreparedProduction) => void;
  onBusyChange: (message: string) => void;
}) {
  const prepared = film.productionPreparation;
  const payment = normalizePaymentReference(film.paymentReference);
  const [configuration, setConfiguration] = useState<CheckoutConfiguration | null>(null);
  const [quote, setQuote] = useState<FilmQuote | null>(null);
  const [price, setPrice] = useState<FilmPrice | null>(null);
  const [preparationConsent, setPreparationConsent] = useState(false);
  const [order, setOrder] = useState<FilmOrder | null>(null);
  const [production, setProduction] = useState<ProductionStatus | null>(null);
  const [inputHash, setInputHash] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const lock = useRef(false);
  const quoteRequest = useRef<{ hash: string; key: string } | null>(null);
  const preparationRequest = useRef<{input:string;key:string;priceKey:string}|null>(null);
  const checkoutKey = useRef(crypto.randomUUID());
  const attemptedPayment = useRef<FilmPaymentReference | null>(null);
  const input = useMemo(() => JSON.stringify(productionPreparationInput(film)), [film]);
  const currentPlan = Boolean(prepared && inputHash && prepared.inputHash === inputHash);
  const priceCurrent = Boolean(price && prepared && currentPlan && price.preparedId===prepared.id && price.manifestHash===prepared.manifestHash && Date.parse(price.expiresAt)>now);
  const quoteCurrent = Boolean(quote && prepared && quote.preparedId === prepared.id && quote.manifestHash === prepared.manifestHash && currentPlan && quoteMatchesConfiguration(quote, configuration) && Date.parse(quote.expiresAt) > now);
  const paymentReference = payment || attemptedPayment.current;
  const paidPlanCurrent = Boolean(paymentReference && prepared && currentPlan && paymentReference.preparedId === prepared.id && paymentReference.manifestHash === prepared.manifestHash);

  useEffect(() => {
    let active = true; setInputHash(""); setConsent(false);
    void productionInputHash(input).then(value => { if (active) setInputHash(value); }).catch(() => { if (active) setError("Your saved plan could not be verified. Reload before requesting a price."); });
    return () => { active = false; };
  }, [input]);
  useEffect(() => {
    let active = true;
    void api("/api/studio?action=checkoutConfiguration")
      .then(value => { if (active) setConfiguration(normalizeCheckoutConfiguration(value)); })
      .catch(() => { if (active) setConfiguration({ available: false }); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!quote && !price) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote, price]);
  useEffect(() => {
    if (!payment?.orderId) return;
    // The active checkout owns its result. A parallel mount read could run
    // before its order record exists and falsely report a missing payment.
    if (lock.current && attemptedPayment.current?.orderId === payment.orderId) return;
    setOrder(null);
    let active = true;
    void api(`/api/studio?action=order&id=${encodeURIComponent(payment.orderId)}`).then(value => {
      const saved = normalizeFilmOrder(value);
      if (!saved || saved.id !== payment.orderId || saved.quoteId !== payment.quoteId || saved.preparedId !== payment.preparedId || saved.sandbox !== payment.sandbox) throw new Error();
      if (active) setOrder(saved);
    }).catch(() => { if (active) setError("A payment request is saved, but its result could not be confirmed. Do not pay again. Check this order's status or contact the administrator."); });
    return () => { active = false; };
  }, [payment?.orderId, payment?.quoteId, payment?.preparedId, payment?.sandbox]);
  useEffect(() => {
    if (!paymentReference || !order?.receiptAvailable) return;
    const reference = paymentReference;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const value = await api<ProductionStatus>(`/api/studio?action=productionStatus&id=${encodeURIComponent(reference.preparedId)}`);
        if (!active) return;
        if (value.id !== reference.preparedId || value.manifestHash !== reference.manifestHash
          || !["prepared", "queued", "submitting", "processing", "uncertain", "failed", "completed"].includes(value.status)) return;
        setProduction(value);
        if (!["prepared", "failed", "completed"].includes(value.status) && !value.needsAttention) timer = setTimeout(() => void refresh(), 10_000);
      } catch { /* Manual status recovery remains available after a temporary outage. */ }
    }
    void refresh();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [paymentReference?.preparedId, paymentReference?.manifestHash, order?.receiptAvailable, production?.status === "queued"]);

  async function work(label: string, operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(label); onBusyChange(label); setError(""); setMessage("");
    try { await operation(); } catch (cause) { setError(problem(cause)); }
    finally { lock.current = false; setBusy(""); onBusyChange(""); }
  }
  async function requestQuote() {
    if (!prepared || !currentPlan || paymentReference) return;
    await work("Checking your film price…", async () => {
      setQuote(null); setConsent(false);
      const latestConfiguration = normalizeCheckoutConfiguration(await api("/api/studio", { action: "prepareCheckout" }));
      setConfiguration(latestConfiguration);
      if (!latestConfiguration.available) {
        setQuote(null);
        throw new Error("Payment and film production are not available yet. Your plan remains saved. You can check availability again later.");
      }
      if (quote && Date.parse(quote.expiresAt) <= Date.now()) quoteRequest.current = null;
      if (quoteRequest.current?.hash !== prepared.manifestHash) quoteRequest.current = { hash: prepared.manifestHash, key: crypto.randomUUID() };
      let value: unknown;
      try {
        value = await api("/api/studio", { action: "quote", project: JSON.parse(input), preparedId: prepared.id, idempotencyKey: quoteRequest.current.key });
      } catch (cause) {
        // A lost quote response can be retried with its original key, but a
        // definitively expired quote needs a new price-request identity.
        if (cause instanceof ApiError && cause.code === "QUOTE_EXPIRED") quoteRequest.current = null;
        throw cause;
      }
      const result = normalizeFilmQuote(value);
      if (!result || result.preparedId !== prepared.id || result.manifestHash !== prepared.manifestHash || result.filmId !== film.id
        || result.sandbox !== (latestConfiguration.environment === "sandbox") || Date.parse(result.expiresAt) <= Date.now()) {
        throw new Error("Your film price could not be verified against the saved plan. No payment has been requested.");
      }
      setQuote(result); setConsent(false); setNow(Date.now()); checkoutKey.current = crypto.randomUUID();
      if(price&&result.amountCents!==price.amountCents)setMessage("The pricing settings changed. Review the updated total below before approving payment.");
    });
  }
  async function requestPrice() {
    if(paymentReference||(!currentPlan&&!preparationConsent))return;
    await work("Preparing your pricing…",async()=>{
      setQuote(null);setPrice(null);setConsent(false);
      if(preparationRequest.current?.input!==input)preparationRequest.current={input,
        key:currentPlan&&prepared?prepared.requestId:crypto.randomUUID(),priceKey:crypto.randomUUID()};
      if(price&&Date.parse(price.expiresAt)<=Date.now())preparationRequest.current.priceKey=crypto.randomUUID();
      const result=await prepareFilmPrice({request:api,input,filmId:film.id,existing:prepared,
        preparationKey:preparationRequest.current.key,priceKey:preparationRequest.current.priceKey,
        preparationConsent,persist:onPrepared});
      setPrice(result.price);setNow(Date.now());
      setMessage("Your production plan is saved and your film price is ready.");
    });
  }
  async function downloadPlan() {
    if(!prepared)return;
    await work("Opening your production plan…",async()=>{
      const value=await api(`/api/studio?action=manifest&id=${encodeURIComponent(prepared.id)}`);
      const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));
      const link=document.createElement("a");link.href=url;link.download="film-production-plan.json";document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30_000);
    });
  }
  async function readOrder(reference: FilmPaymentReference) {
    const result = await recoverFilmPayment(api, reference);
    setOrder(result);
    return result;
  }
  async function submitPayment(paymentToken: string, checkoutProof: string) {
    if (!quote || !quoteCurrent || !consent || paymentReference || !configuration?.available) return;
    await work("Confirming your payment…", async () => {
      if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error("Your price expired before payment. Request a new price.");
      const reference = { preparedId: quote.preparedId, manifestHash: quote.manifestHash, quoteId: quote.id, orderId: quote.orderId, checkoutKey: checkoutKey.current, submittedAt: new Date().toISOString(), sandbox: quote.sandbox };
      // Verify durable local recovery before the single charge request. Never
      // persist the card, its token, or a browser-supplied amount.
      const result = await commitFilmPayment({ request: api, quote, reference, paymentToken, checkoutProof, persist: saved => {
        persistPaymentReference(saved);
        attemptedPayment.current = saved;
      } });
      setOrder(result);
    });
  }
  async function downloadReceipt() {
    if (!paymentReference || !order?.receiptAvailable) return;
    await work("Opening your receipt…", async () => {
      const value = normalizeFilmReceipt(await api(`/api/studio?action=receipt&id=${encodeURIComponent(paymentReference.orderId)}`));
      if (!value || value.receiptId !== order.id || value.amountCents !== order.amountCents || value.sandbox !== paymentReference.sandbox) throw new Error("The receipt could not be verified. Check the order status and try again.");
      const receipt = { receiptId: value.receiptId, transactionId: value.transactionId, filmTitle: value.filmTitle, currency: value.currency,
        paymentAmount: money(value.amountCents), totalAmount: money(value.amountCents), refunded: money(value.refundedCents), status: value.status,
        type: value.sandbox ? "Sandbox test receipt — no real money" : "Payment receipt", paidAt: value.capturedAt,
        processorDisclosure: `${value.sandbox ? "Sandbox test only. " : ""}${value.processorDisclosure}`,
        notice: "A payment receipt does not confirm bank settlement or completion of your film." };
      const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `Lineage-Theatre-receipt-${order.id.slice(0, 12)}.json`; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage("Your receipt download has started.");
    });
  }
  async function productionRequest(start: boolean) {
    if (!paymentReference || (start && (!paidPlanCurrent || order?.status !== "captured" || !productionAvailable))) return;
    await work(start ? "Starting your film…" : "Checking film production…", async () => {
      const result = await api<ProductionStatus>(start ? "/api/studio" : `/api/studio?action=productionStatus&id=${encodeURIComponent(paymentReference.preparedId)}`,
        start ? { action: "startProduction", preparedId: paymentReference.preparedId, orderId: paymentReference.orderId, productionConsent: true } : undefined);
      if (result.id !== paymentReference.preparedId || result.manifestHash !== paymentReference.manifestHash
        || !["prepared", "queued", "submitting", "processing", "uncertain", "failed", "completed"].includes(result.status)) {
        throw new Error("Film production status could not be verified. Check status before starting another request.");
      }
      setProduction(result);
    });
  }

  return <section className="readiness-panel film-checkout" aria-label="Film payment and production">
    <h3>Your film price and payment</h3>
    {!paymentReference && <>
      <p>Save your production plan and calculate your film price in one step. This does not take a payment or start rendering.</p>
      {!currentPlan&&<label className="check-label"><input type="checkbox" checked={preparationConsent} disabled={Boolean(busy)} onChange={event=>setPreparationConsent(event.target.checked)}/><span>Save this screenplay, cast, and production plan privately in Lineage Theatre with administrator access.</span></label>}
      <button className="button primary small" disabled={Boolean(busy) || !film.scenes.length || (!currentPlan&&!preparationConsent)} onClick={() => void requestPrice()}>{busy?<Loader2 className="spin" size={15}/>:<RefreshCw size={15} />}{busy|| (price ? "Refresh my pricing" : "Prepare my pricing")}</button>
    </>}
    {prepared&&<p className="field-note">{currentPlan?`Plan saved: ${prepared.sceneCount} scenes, ${prepared.durationSeconds} seconds target.`:"Your film has changed since this plan was saved. The download contains the saved version."} <button className="text-button" disabled={Boolean(busy)} onClick={()=>void downloadPlan()}><Download size={15}/>Download prepared plan</button></p>}
    {price&&!paymentReference&&!quote&&<div className="film-price-review" role="status">
      <p className="eyebrow">Your film price</p>
      <p className="film-price-total">{money(price.amountCents)} <span>USD total</span></p>
      <p>{price.filmTitle} · {prepared?.durationSeconds} seconds target</p>
      <p className="field-note">{price.note}</p>
      {!priceCurrent&&<p className="feedback">Refresh your pricing to include the latest plan and rates.</p>}
      {price.kind==="confirmed"&&priceCurrent&&<button className="button secondary" disabled={Boolean(busy)} onClick={()=>void requestQuote()}>Continue to payment</button>}
    </div>}
    {quote && !paymentReference && <div className="film-price-review">
      <p className="film-price-total">{money(quote.amountCents)} <span>USD total</span></p>
      <p>{quote.filmTitle} · {prepared?.durationSeconds} seconds target</p>
      <p>{quote.sandbox ? "Test payment — no real money will be charged." : "This is a real payment to BROCO Technologies LLC."}</p>
      <p className="field-note">Price valid until {new Date(quote.expiresAt).toLocaleString()}. The confirmed payment amount stays fixed for this saved film.</p>
      {!productionAvailable&&<p className="field-note">Rendering is not available yet. A payment does not start production.</p>}
      {!quoteCurrent && <p className="feedback">This price has expired or the plan has changed. Request a new price before paying.</p>}
      <label className="check-label"><input type="checkbox" checked={consent} disabled={Boolean(busy) || !quoteCurrent} onChange={event => setConsent(event.target.checked)} />
        <span>{quote.sandbox ? `I confirm a ${money(quote.amountCents)} test payment for this saved film plan. No real money will move.` : `I authorize BROCO Technologies LLC to charge exactly ${money(quote.amountCents)} for this saved film plan.`}</span>
      </label>
      {configuration?.available && quoteCurrent && <PaymentCardForm configuration={configuration} quote={quote} consent={consent} disabled={Boolean(busy)} onToken={submitPayment} onBusyChange={label => { setBusy(label); onBusyChange(label); }} />}
    </div>}
    {paymentReference && <div className="film-order-status" role="status">
      <h4>{order?.sandbox ? "Test payment status" : "Payment status"}</h4>
      <p>{order ? paymentStatusMessage(order) : "A payment request has been recorded. Check its result before taking any further action."}</p>
      {order && <p>{money(order.amountCents)} total{order.refundedCents > 0 ? ` · ${money(order.refundedCents)} refunded` : ""}</p>}
      <p className="field-note">Order reference: <span className="film-order-reference">{paymentReference.orderId}</span></p>
      {!paidPlanCurrent && <p className="feedback">This payment belongs to an earlier saved plan. Review its status before paying for a different version.</p>}
      <div className="action-group">
        <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void work("Checking payment status…", async () => { await readOrder(paymentReference); })}><RefreshCw size={15} />Check payment status</button>
        {order?.receiptAvailable && <button className="text-button" disabled={Boolean(busy)} onClick={() => void downloadReceipt()}><Download size={15} />Download receipt</button>}
        <a className="text-button" href={`mailto:admin@brocotech.ai?subject=${encodeURIComponent(`Lineage Theatre payment ${paymentReference.orderId}`)}`}>Contact the administrator</a>
      </div>
      {order?.status === "captured" && <div className="film-paid-production">
        <h4>Film production</h4>
        <p>{production ? production.preparationOnly ? "Your production plan is saved. Rendering has not started." : `Production status: ${production.status}. ${production.completedShots} of ${production.shotCount} shots complete.`
          : "Your payment is confirmed. Starting production uses the saved plan associated with this order."}</p>
        {production?.needsAttention && <p className="feedback">Production needs administrator attention. Your order and saved plan remain recorded.</p>}
        {!productionAvailable && !production?.mediaReady && <p>Film production is currently unavailable. Your order remains recorded; contact the administrator for help or a refund.</p>}
        <div className="action-group">
          {(!production || production.preparationOnly || (production.needsAttention && production.status !== "failed")) && <button className="button primary small" disabled={Boolean(busy) || !productionAvailable || !paidPlanCurrent} onClick={() => void productionRequest(true)}><ShieldCheck size={15} />{production?.needsAttention ? "Resume production" : "Start my film"}</button>}
          <button className="text-button" disabled={Boolean(busy)} onClick={() => void productionRequest(false)}><RefreshCw size={15} />Check production status</button>
        </div>
        {production?.status === "completed" && production.mediaReady && <div className="finished-production">
          <video controls preload="metadata" aria-label="Your finished film" src={`/api/studio?action=productionMedia&id=${encodeURIComponent(production.id)}`} />
          <a className="button secondary small" href={`/api/studio?action=productionMedia&id=${encodeURIComponent(production.id)}&download=1`} download><Download size={15} />Download finished film</a>
        </div>}
      </div>}
    </div>}
    {busy && <p role="status"><Loader2 className="spin" size={15} /> {busy}</p>}
    {error && <p className="feedback error" role="alert">{error}</p>}
    {message && <p className="feedback success" role="status">{message}</p>}
  </section>;
}
