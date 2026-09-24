import { useEffect, useMemo, useRef, useState } from "react";
import { CreditCard, Download, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { api, ApiError, normalizePaymentReference, productionInputHash, productionPreparationInput, type Film, type FilmPaymentReference, type PreparedProduction } from "./model";
import {prepareFilmPrice,type FilmPrice} from "./film-pricing";
import { normalizeCheckoutConfiguration, normalizeFilmOrder, normalizeFilmQuote, normalizeFilmReceipt, paymentStatusMessage, quoteMatchesConfiguration, type CheckoutConfiguration, type FilmOrder, type FilmQuote } from "./checkout-contract";
import { checkFilmPayment, commitFilmPayment, retryFilmPayment } from "./checkout-payment";
import { createFilmReceiptData, createFilmReceiptHtml } from "./payment-receipt";
import { captchaToken } from "../lib/captcha";
import { reservePaymentWindow } from "./payment-window";
import CaptchaNotice from "../CaptchaNotice";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const problem = (error: unknown) => error instanceof Error ? error.message : "This request could not be completed. Please try again.";

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
  const hostedOrder = order?.checkoutMethod === "quickbooks-hosted-invoice";
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
        throw new Error("Payment is not available yet. Your plan and price remain saved. You can check availability again later.");
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
        || !quoteMatchesConfiguration(result, latestConfiguration) || Date.parse(result.expiresAt) <= Date.now()) {
        quoteRequest.current = null;
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
      quoteRequest.current = null;
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
    const result = await checkFilmPayment(api, reference, order || undefined);
    setOrder(result);
    return result;
  }
  function presentPaymentPage(result: FilmOrder, paymentWindow: ReturnType<typeof reservePaymentWindow>) {
    setOrder(result);
    if (result.status === "awaiting-payment" && result.invoiceUrl && !result.requiresReview) {
      setMessage(paymentWindow.open(result.invoiceUrl)
        ? "Your secure payment page opened in another tab. Complete payment there, then return here to check its status."
        : "Your secure payment page is ready. Select Open secure payment page below to enter your payment details.");
    } else setMessage(paymentStatusMessage(result));
  }
  async function submitPayment() {
    if (!quote || !quoteCurrent || !consent || paymentReference || !configuration?.available) return;
    await work("Preparing your secure payment page…", async () => {
      // Reserve the tab during the click so browser popup protection does not
      // block navigation after the asynchronous security and invoice requests.
      const paymentWindow = reservePaymentWindow();
      try {
      if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error("Your price expired before payment. Request a new price.");
      const proof = await api<{ checkoutProof: string }>("/api/studio", {
        action: "checkoutCheck", quoteId: quote.id, captchaToken: await captchaToken("checkout"),
      });
      if (!/^[a-f0-9]{64}$/.test(proof.checkoutProof || "")) throw new Error("The security check could not be confirmed. No invoice has been requested.");
      const reference = { preparedId: quote.preparedId, manifestHash: quote.manifestHash, quoteId: quote.id, orderId: quote.orderId, checkoutKey: checkoutKey.current, submittedAt: new Date().toISOString(), sandbox: quote.sandbox };
      // Save recovery before requesting one invoice. An uncertain response
      // can only recover this order, never create a replacement invoice.
      const result = await commitFilmPayment({ request: api, quote, reference, checkoutProof: proof.checkoutProof, persist: saved => {
        persistPaymentReference(saved);
        attemptedPayment.current = saved;
      } });
      presentPaymentPage(result, paymentWindow);
      } finally { paymentWindow.close(); }
    });
  }
  async function downloadReceipt(format: "html" | "json" = "html") {
    if (!paymentReference || !order?.receiptAvailable) return;
    await work("Opening your receipt…", async () => {
      const value = normalizeFilmReceipt(await api(`/api/studio?action=receipt&id=${encodeURIComponent(paymentReference.orderId)}`));
      if (!value || value.receiptId !== order.id || value.amountCents !== order.amountCents || value.sandbox !== paymentReference.sandbox
        || value.confirmationSource !== order.confirmationSource) throw new Error("The receipt could not be verified. Check the order status and try again.");
      const receipt = createFilmReceiptData(value);
      const blob = new Blob([format === "html" ? createFilmReceiptHtml(value) : JSON.stringify(receipt, null, 2)],
        { type: format === "html" ? "text/html;charset=utf-8" : "application/json" });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `Lineage-Theatre-receipt-${order.id.slice(0, 12)}.${format}`; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage(format === "html" ? "Your receipt download has started. Open it in your browser to print or save as PDF." : "Your receipt data download has started.");
    });
  }
  async function retryPaymentPage() {
    if (!paymentReference || !order || order.retryAllowed !== true) return;
    const savedReference = paymentReference, savedOrder = order;
    await work("Retrying your saved payment page…", async () => {
      const paymentWindow = reservePaymentWindow();
      try {
      const proof = await api<{ checkoutProof: string }>("/api/studio", {
        action: "checkoutCheck", quoteId: savedReference.quoteId, captchaToken: await captchaToken("checkout"),
      });
      if (!/^[a-f0-9]{64}$/.test(proof.checkoutProof || "")) throw new Error("The security check could not be confirmed. No invoice retry was requested.");
      // Hide the retry immediately. Only the next verified server record may
      // authorize another attempt if this response is lost or unreadable.
      setOrder({ ...savedOrder, retryAllowed: false });
      presentPaymentPage(await retryFilmPayment({ request: api, order: savedOrder, reference: savedReference, checkoutProof: proof.checkoutProof }), paymentWindow);
      } finally { paymentWindow.close(); }
    });
  }
  async function productionRequest(start: boolean) {
    if (!paymentReference || (start && (!paidPlanCurrent || hostedOrder || order?.status !== "captured" || !productionAvailable))) return;
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
      <p className="field-note">A payment does not start film production. Your administrator will confirm production availability.</p>
      <h4>Delivery</h4><p style={{ whiteSpace: "pre-wrap" }}>{quote.deliveryTerms}</p>
      <h4>Refund policy</h4><p style={{ whiteSpace: "pre-wrap" }}>{quote.refundTerms}</p>
      {!quoteCurrent && <p className="feedback">This price has expired or the plan has changed. Request a new price before paying.</p>}
      <label className="check-label"><input type="checkbox" checked={consent} disabled={Boolean(busy) || !quoteCurrent} onChange={event => setConsent(event.target.checked)} />
        <span>{quote.sandbox ? `I accept the delivery and refund terms and want to create a ${money(quote.amountCents)} test invoice for this saved film. No real money will move.` : `I accept the delivery and refund terms and want to create a ${money(quote.amountCents)} invoice for this saved film. I will complete payment on QuickBooks.`}</span>
      </label>
      {configuration?.available && quoteCurrent && <>
        <p className="field-note">Your secure payment page opens in another tab. Enter your payment details there, then return here to check payment status. Your finished film unlocks only after payment is confirmed.</p>
        <CaptchaNotice />
        <button className="button primary" disabled={Boolean(busy) || !consent} onClick={() => void submitPayment()}>
          <CreditCard size={16} />{quote.sandbox ? "Prepare test payment page" : "Prepare secure payment page"}
        </button>
      </>}
    </div>}
    {paymentReference && <div className="film-order-status" role="status">
      <h4>{order?.sandbox ? "Test payment status" : "Payment status"}</h4>
      <p>{order ? paymentStatusMessage(order) : "A payment request has been recorded. Check its result before taking any further action."}</p>
      {order && <p>{money(order.amountCents)} total{order.refundedCents > 0 ? ` · ${money(order.refundedCents)} refunded` : ""}</p>}
      {hostedOrder && order?.invoiceNumber && <p className="field-note">Invoice {order.invoiceNumber}</p>}
      {hostedOrder && order?.status === "captured" && <p className="field-note">This confirms a payment applied to the invoice in QuickBooks. It does not verify bank settlement or later refunds.</p>}
      {order?.retryAllowed === true && <><p className="field-note">Retrying uses this saved price and the terms you accepted. It prepares the payment page; you complete payment separately on QuickBooks.</p><CaptchaNotice /></>}
      <p className="field-note">Order reference: <span className="film-order-reference">{paymentReference.orderId}</span></p>
      {!paidPlanCurrent && <p className="feedback">This payment belongs to an earlier saved plan. Review its status before paying for a different version.</p>}
      <div className="action-group">
        {order?.retryAllowed === true && <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void retryPaymentPage()}><RefreshCw size={15} />Retry preparing this payment page</button>}
        {order?.status === "awaiting-payment" && order.invoiceUrl && !order.requiresReview && <a className="button primary small" href={order.invoiceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Open secure payment page</a>}
        <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void work("Checking payment status…", async () => { const latest = await readOrder(paymentReference); setMessage(`Status checked. ${paymentStatusMessage(latest)}`); })}><RefreshCw size={15} />Check payment status</button>
        {order?.receiptAvailable && <button className="text-button" disabled={Boolean(busy)} onClick={() => void downloadReceipt()}><Download size={15} />Download receipt</button>}
        {order?.receiptAvailable && <button className="text-button" disabled={Boolean(busy)} onClick={() => void downloadReceipt("json")}>Receipt data (JSON)</button>}
        <a className="text-button" href={`mailto:admin@brocotech.ai?subject=${encodeURIComponent(`Lineage Theatre payment ${paymentReference.orderId}`)}`}>Contact the administrator</a>
      </div>
      {order?.status === "captured" && <div className="film-paid-production">
        <h4>Film production</h4>
        <p>{production ? production.preparationOnly ? "Your production plan is saved. Rendering has not started." : `Production status: ${production.status}. ${production.completedShots} of ${production.shotCount} shots complete.`
          : hostedOrder ? "Payment is recorded. Your administrator must confirm production availability." : "Your payment is confirmed. Starting production uses the saved plan associated with this order."}</p>
        {production?.needsAttention && <p className="feedback">Production needs administrator attention. Your order and saved plan remain recorded.</p>}
        {(!productionAvailable || hostedOrder) && !production?.mediaReady && <p>Film production is currently unavailable. Your order remains recorded; contact the administrator for help or a refund.</p>}
        <div className="action-group">
          {!hostedOrder && (!production || production.preparationOnly || (production.needsAttention && production.status !== "failed")) && <button className="button primary small" disabled={Boolean(busy) || !productionAvailable || !paidPlanCurrent} onClick={() => void productionRequest(true)}><ShieldCheck size={15} />{production?.needsAttention ? "Resume production" : "Start my film"}</button>}
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
