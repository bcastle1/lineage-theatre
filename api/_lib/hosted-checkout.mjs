import {randomUUID} from "node:crypto";
import {digest,readRecord,writeRecord,userPath} from "./auth.mjs";
import {accessStatusForUser,isOwner,hasAdminAccess} from "./access.mjs";
import {readPricingSettings} from "./admin.mjs";
import {createQuickBooksAccountingTransport} from "./quickbooks.mjs";
import {PaymentError} from "./payments.mjs";
import {productionJobPath} from "./film-production.mjs";
import {readProductionAllowance} from "./production-allowance.mjs";
import {createFalFunding,fundingCycleCanExpire} from "./fal-funding.mjs";
import {createHostedReversalVerifier,HOSTED_REVERSAL_SCOPE} from "./hosted-reversals.mjs";
import {markProductionAuthorizationFailure} from "./production-authorization-diagnostics.mjs";
import {normalizeHostedInvoiceUrl as safeLink} from "../../src/studio/hosted-invoice-url.mjs";

export class HostedCheckoutError extends PaymentError {}
export const HOSTED_CHECKOUT_SETTINGS_PATH="settings/quickbooks-hosted.json";
const METHOD="quickbooks-hosted-invoice",SOURCE="quickbooks-accounting";
const hex=/^[a-f0-9]{64}$/,numeric=/^[0-9]{1,30}$/,keys=/^[A-Za-z0-9_-]{16,100}$/;
const unavailable=()=>new HostedCheckoutError("Payment is not available yet. Your saved film and price are unchanged.",503,"HOSTED_CHECKOUT_UNAVAILABLE");
const productionUnavailable=reason=>markProductionAuthorizationFailure(new HostedCheckoutError("Film production is not available yet. Your payment and saved plan remain recorded.",503,"PRODUCTION_UNAVAILABLE"),"authorization",reason);
const reversalsUnavailable=reason=>markProductionAuthorizationFailure(new HostedCheckoutError("Film production is not available yet. Your payment and saved plan remain recorded.",503,"HOSTED_REVERSALS_UNVERIFIED"),"authorization",reason);
const conflict=()=>new HostedCheckoutError("This request changed or is already being processed. Check the saved order before continuing.",409,"PAYMENT_CONFLICT",null);
const expired=()=>new HostedCheckoutError("This price or its checkout terms changed. Prepare your price again.",409,"QUOTE_EXPIRED");
const checkoutProductionUnavailable=()=>new HostedCheckoutError("Production availability or cost could not be confirmed for this saved film. No invoice has been requested. Check your film price before paying.",503,"PRODUCTION_UNAVAILABLE");
const fundingUnavailable=()=>new HostedCheckoutError("Film production cannot be reserved right now. Your saved price remains available. No invoice has been requested. Please try again later.",503,"PRODUCTION_FUNDING_UNAVAILABLE");
const existingOrder=()=>new HostedCheckoutError("A payment page already exists for this saved film. Recover its saved payment or contact the administrator.",409,"ORDER_ALREADY_EXISTS");
const stamp=now=>new Date(now).toISOString();
const amountValid=n=>Number.isSafeInteger(n)&&n>0&&n<=100_000_000;
const money=n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1_000_000&&Math.abs(n*100-Math.round(n*100))<0.0000001?Math.round(n*100):null;
const bound=b=>Boolean(b&&["sandbox","production"].includes(b.environment)&&hex.test(b.grantId||"")&&numeric.test(b.realmId||""));
const sameBinding=(a,b)=>bound(a)&&bound(b)&&a.environment===b.environment&&a.grantId===b.grantId&&a.realmId===b.realmId;
const sandbox=v=>v.merchantBinding?.environment==="sandbox";
const orderPath=id=>`payments/orders/${id}.json`;
const quotePath=(email,id)=>`payments/hosted-quotes/${digest(email)}/${id}.json`;
const legacyId=q=>digest(`${q.customerEmail}:${q.manifestHash}`);
const orderId=q=>sandbox(q)?legacyId(q):digest(`${q.customerEmail}:production:${q.manifestHash}`);
const uuid=value=>{const h=digest(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const defaults=()=>({revision:0,enabled:false,serviceItemId:"",serviceItemName:"",taxCode:"",deliveryTerms:"",refundTerms:"",merchantConfirmed:false,pciAcknowledged:false,automaticInvoiceEmailDisabled:false,merchantBinding:null});
function exact(value,allowed) {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new HostedCheckoutError("This checkout request contains unsupported information.");}
function reference(value,pattern=hex) {if(typeof value!=="string"||!pattern.test(value))throw new HostedCheckoutError("This checkout reference is invalid.");return value;}
function emailFor(actor) {
  if(!actor||accessStatusForUser(actor)!=="approved"||actor.mustChangePassword||typeof actor.email!=="string"||actor.email.length>254
    ||actor.email!==actor.email.trim().toLowerCase()||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(actor.email))throw new HostedCheckoutError("Sign in to continue.",401);
  return actor.email;
}
function term(value) {if(typeof value!=="string"||value.length>10_000||/[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw new HostedCheckoutError("Enter valid plain-text checkout terms.");return value.replace(/\r\n?/g,"\n").trim();}
function complete(s) {return Boolean(s&&s.enabled===true&&Number.isSafeInteger(s.revision)&&s.revision>0&&numeric.test(s.serviceItemId||"")&&s.taxCode==="NON"
  &&typeof s.deliveryTerms==="string"&&s.deliveryTerms.trim().length>0&&typeof s.refundTerms==="string"&&s.refundTerms.trim().length>0
  &&s.merchantConfirmed===true&&s.pciAcknowledged===true&&s.automaticInvoiceEmailDisabled===true&&bound(s.merchantBinding));}
const checkStages=["binding","invoice-read","invoice-validation","payment-read","payment-validation","actor-recheck","binding-recheck","complete"];
const checkReasons=new Set(["CONNECTION_BINDING_FAILED","INVOICE_READ_FAILED","INVOICE_VALIDATION_FAILED","PAYMENT_READ_FAILED","PAYMENT_VALIDATION_FAILED","ACTOR_RECHECK_FAILED","BINDING_RECHECK_FAILED","CHECK_FAILED",
  "INVOICE_ID_INVALID","INVOICE_ID_MISMATCH","INVOICE_CUSTOMER_MISMATCH","INVOICE_CURRENCY_MISMATCH","INVOICE_EMAIL_MISMATCH","INVOICE_TOTAL_MISMATCH","INVOICE_BALANCE_INVALID",
  "INVOICE_LINES_INVALID","INVOICE_SALES_LINE_COUNT","INVOICE_LINE_TYPE_UNSUPPORTED","INVOICE_ITEM_MISMATCH","INVOICE_QUANTITY_MISMATCH","INVOICE_UNIT_PRICE_MISMATCH","INVOICE_LINE_AMOUNT_MISMATCH",
  "INVOICE_TAX_CODE_MISMATCH","INVOICE_TAX_AMOUNT_MISMATCH","INVOICE_CARD_DISABLED","INVOICE_ACH_DISABLED","INVOICE_EMAIL_STATUS_CHANGED","INVOICE_VOIDED",
  "INVOICE_LINKED_TRANSACTIONS_INVALID","INVOICE_LINKED_TRANSACTION_UNSUPPORTED","INVOICE_LINKED_TRANSACTION_LIMIT","INVOICE_LINKED_TRANSACTION_DUPLICATE","INVOICE_LINK_INVALID","PAYMENT_RECONCILIATION_INCOMPLETE"]);
function invoiceMismatch(reason) {const error=conflict();error.diagnosticReason=reason;return error;}
function checkReason(error,stage) {
  if(checkReasons.has(error?.diagnosticReason))return error.diagnosticReason;
  return {binding:"CONNECTION_BINDING_FAILED","invoice-read":"INVOICE_READ_FAILED","invoice-validation":"INVOICE_VALIDATION_FAILED","payment-read":"PAYMENT_READ_FAILED",
    "payment-validation":"PAYMENT_VALIDATION_FAILED","actor-recheck":"ACTOR_RECHECK_FAILED","binding-recheck":"BINDING_RECHECK_FAILED"}[stage]||"CHECK_FAILED";
}
function invoiceLinkDiagnostics(value) {
  const result={kind:typeof value==="string"?"string":Array.isArray(value)?"array":typeof value==="object"?"object":typeof value==="boolean"?"boolean":typeof value==="number"?"number":"other",
    length:typeof value==="string"?Math.min(value.length,4097):0,blank:typeof value==="string"&&value.trim()==="",whitespace:typeof value==="string"&&/[\s\\\x00-\x1f\x7f]/.test(value),parsed:false};
  if(typeof value!=="string"||value.length>4096)return result;
  try {
    const url=new URL(value),short=url.pathname.startsWith("/t/scs-v1-"),token=short?url.pathname.slice(10):"";
    const hostKind=["connect.intuit.com","payments.intuit.com","quickbooks.intuit.com","qbo.intuit.com"].includes(url.hostname)?url.hostname:url.hostname.endsWith(".intuit.com")?"other-intuit":"other";
    return {...result,parsed:true,https:url.protocol==="https:",expectedHost:url.hostname==="connect.intuit.com",hostKind,credentials:Boolean(url.username||url.password),
      port:Boolean(url.port)||/^https:\/\/connect\.intuit\.com:/.test(value),fragment:value.includes("#"),canonical:url.href===value,
      pathKind:short?"short":url.pathname.startsWith("/portal/")?"portal":"other",shortTokenLength:token.length,shortTokenHex:short&&/^[a-fA-F0-9]+$/.test(token),
      queryKind:url.search===""?"none":/^\?locale=[a-zA-Z]{2}_[a-zA-Z]{2}$/.test(url.search)?"locale":"other",queryCount:Math.min([...url.searchParams].length,100)};
  }catch{return result;}
}
function safeLinkDiagnostics(value) {
  if(!value||typeof value!=="object")return null;
  const result={};
  for(const key of ["parsed","blank","https","expectedHost","credentials","port","fragment","whitespace","canonical","shortTokenHex"])if(typeof value[key]==="boolean")result[key]=value[key];
  for(const key of ["length","shortTokenLength","queryCount"])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=4097)result[key]=value[key];
  for(const [key,allowed] of [["kind",["string","array","object","boolean","number","other"]],["pathKind",["short","portal","other"]],["queryKind",["none","locale","other"]],
    ["hostKind",["connect.intuit.com","payments.intuit.com","quickbooks.intuit.com","qbo.intuit.com","other-intuit","other"]]])if(allowed.includes(value[key]))result[key]=value[key];
  return result;
}
function publicQuote(q) {return {id:q.id,orderId:orderId(q),preparedId:q.preparedId,manifestHash:q.manifestHash,filmId:q.filmId,filmTitle:q.filmTitle,currency:q.currency,
  amountCents:q.amountCents,expiresAt:q.expiresAt,sandbox:sandbox(q),method:METHOD,deliveryTerms:q.checkoutSettings.deliveryTerms,refundTerms:q.checkoutSettings.refundTerms};}
function publicOrder(v,at) {
  const paid=v.status==="captured"&&Boolean(v.capturedAt),review=!paid&&v.status!=="awaiting-payment";
  return {id:v.id,quoteId:v.quoteId,preparedId:v.preparedId,filmId:v.filmId,filmTitle:v.filmTitle,status:v.status,currency:v.currency,amountCents:v.amountCents,
    refundedCents:0,charged:paid?true:review?null:false,requiresReview:review,receiptAvailable:paid,createdAt:v.createdAt,updatedAt:v.updatedAt,sandbox:sandbox(v),
    checkoutMethod:METHOD,invoiceUrl:review||paid?null:safeLink(v.invoiceUrl),invoiceNumber:v.invoiceNumber||null,
    retryAllowed:v.status==="uncertain"&&!v.invoiceAttemptedAt&&Date.parse(v.expiresAt)>at,...(paid?{confirmationSource:SOURCE}:{})};
}
function itemData(item) {return item&&numeric.test(item.Id||"")&&typeof item.Name==="string"&&item.Name.length<=500
  ?{id:item.Id,name:item.Name,active:item.Active===true,type:typeof item.Type==="string"?item.Type:"",taxable:item.Taxable===true}:null;}
function invoiceData(invoice,order) {
  const lines=invoice?.Line,sales=Array.isArray(lines)?lines.filter(l=>l?.DetailType==="SalesItemLineDetail"):[],line=sales[0],detail=line?.SalesItemLineDetail;
  const balance=money(invoice?.Balance),invoiceId=invoice?.Id;
  if(!numeric.test(invoiceId||""))throw invoiceMismatch("INVOICE_ID_INVALID");
  if(order.invoiceId&&invoiceId!==order.invoiceId)throw invoiceMismatch("INVOICE_ID_MISMATCH");
  if(invoice.CustomerRef?.value!==order.customerId)throw invoiceMismatch("INVOICE_CUSTOMER_MISMATCH");
  if(invoice.CurrencyRef?.value!=="USD")throw invoiceMismatch("INVOICE_CURRENCY_MISMATCH");
  if(typeof invoice.BillEmail?.Address!=="string"||invoice.BillEmail.Address.toLowerCase()!==order.customerEmail)throw invoiceMismatch("INVOICE_EMAIL_MISMATCH");
  if(money(invoice.TotalAmt)!==order.amountCents)throw invoiceMismatch("INVOICE_TOTAL_MISMATCH");
  if(balance===null||balance>order.amountCents)throw invoiceMismatch("INVOICE_BALANCE_INVALID");
  if(!Array.isArray(lines))throw invoiceMismatch("INVOICE_LINES_INVALID");
  if(sales.length!==1)throw invoiceMismatch("INVOICE_SALES_LINE_COUNT");
  if(lines.some(l=>!["SalesItemLineDetail","SubTotalLineDetail"].includes(l?.DetailType)))throw invoiceMismatch("INVOICE_LINE_TYPE_UNSUPPORTED");
  if(detail?.ItemRef?.value!==order.checkoutSettings.serviceItemId)throw invoiceMismatch("INVOICE_ITEM_MISMATCH");
  if(detail.Qty!==1)throw invoiceMismatch("INVOICE_QUANTITY_MISMATCH");
  if(money(detail.UnitPrice)!==order.amountCents)throw invoiceMismatch("INVOICE_UNIT_PRICE_MISMATCH");
  if(money(line.Amount)!==order.amountCents)throw invoiceMismatch("INVOICE_LINE_AMOUNT_MISMATCH");
  if(detail.TaxCodeRef?.value!=="NON")throw invoiceMismatch("INVOICE_TAX_CODE_MISMATCH");
  if(invoice.TxnTaxDetail?.TotalTax!==undefined&&money(invoice.TxnTaxDetail.TotalTax)!==0)throw invoiceMismatch("INVOICE_TAX_AMOUNT_MISMATCH");
  if(invoice.AllowOnlineCreditCardPayment!==true)throw invoiceMismatch("INVOICE_CARD_DISABLED");
  if(invoice.AllowOnlineACHPayment!==true)throw invoiceMismatch("INVOICE_ACH_DISABLED");
  if(invoice.EmailStatus!=="NotSet")throw invoiceMismatch("INVOICE_EMAIL_STATUS_CHANGED");
  if(invoice.TxnStatus==="Voided"||invoice.status==="Voided"||invoice.Voided===true)throw invoiceMismatch("INVOICE_VOIDED");
  const links=invoice.LinkedTxn??[];
  if(!Array.isArray(links))throw invoiceMismatch("INVOICE_LINKED_TRANSACTIONS_INVALID");
  if(links.some(l=>l?.TxnType!=="Payment"||!numeric.test(l.TxnId||"")))throw invoiceMismatch("INVOICE_LINKED_TRANSACTION_UNSUPPORTED");
  if(links.length>100)throw invoiceMismatch("INVOICE_LINKED_TRANSACTION_LIMIT");
  if(new Set(links.map(l=>l.TxnId)).size!==links.length)throw invoiceMismatch("INVOICE_LINKED_TRANSACTION_DUPLICATE");
  const invoiceUrl=safeLink(invoice.InvoiceLink);
  return {invoiceId,invoiceNumber:typeof invoice.DocNumber==="string"&&invoice.DocNumber.length<=100?invoice.DocNumber:null,
    invoiceUrl,invoiceLinkStatus:invoiceUrl?"ready":invoice.InvoiceLink==null?"pending":"invalid",balanceCents:balance,paymentIds:links.map(l=>l.TxnId)};
}
function paymentAllocation(payment,order,paymentId) {
  if(payment?.Id!==paymentId||payment.CustomerRef?.value!==order.customerId||payment.CurrencyRef?.value!=="USD"||payment.TxnStatus==="Voided"||payment.Voided===true
    ||money(payment.TotalAmt)===null||money(payment.TotalAmt)===0||!Array.isArray(payment.Line)||payment.Line.length>1000)throw conflict();
  let allocation=0;
  for(const line of payment.Line) {
    const links=line.LinkedTxn;
    if(!Array.isArray(links)||links.some(l=>l.TxnType!=="Invoice"||!numeric.test(l.TxnId||"")))throw conflict();
    if(links.some(l=>l.TxnId===order.invoiceId)) {
      // A line covering multiple invoices does not identify our exact allocation.
      if(links.length!==1||money(line.Amount)===null||money(line.Amount)===0)throw conflict();
      allocation+=money(line.Amount);
    }
  }
  if(!amountValid(allocation)||allocation>money(payment.TotalAmt))throw conflict();
  return {id:paymentId,allocatedCents:allocation,transactionDate:typeof payment.TxnDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(payment.TxnDate)?payment.TxnDate:null};
}

export function createHostedCheckoutService({read=readRecord,write=writeRecord,now=Date.now,env=process.env,transport=createQuickBooksAccountingTransport(),
  receiptDelivery={deliver:async order=>(await import("./receipt-delivery.mjs")).receiptDelivery.deliver(order)},
  productionAutomation={schedule:async input=>(await import("./automatic-production.mjs")).automaticProduction.schedule(input)},
  pricingSettings=readPricingSettings,quoteProvider=async(...args)=>(await import("./film-pricing.mjs")).filmPricing.quoteForPayment(...args),
  productionQuote=async input=>(await import("./film-production.mjs")).filmProduction.quoteForProductionBudget(input),
  verifyReversals=createHostedReversalVerifier({transport,now}),funding=createFalFunding({read,write,now,env}),reserveFunding=funding.reserve}={}) {
  async function save(path,previous,value) {
    const next={...value,changeId:randomUUID(),updatedAt:stamp(now())};
    try {const result=await write(path,next,previous?.etag);if(result?.etag)return {value:next,etag:result.etag};}catch{}
    const saved=await read(path);if(saved?.value.changeId!==next.changeId)throw conflict();return saved;
  }
  async function currentActor(actor,owner=false) {
    const email=emailFor(actor),current=(await read(userPath(email)))?.value;
    if(!current||emailFor(current)!==email)throw new HostedCheckoutError("Sign in to continue.",401);
    if(owner&&(!isOwner(actor)||!isOwner(current)))throw new HostedCheckoutError("Owner access is required.",403);
    return current;
  }
  async function access(actor) {
    const current=await currentActor(actor),environment=env.QUICKBOOKS_ENVIRONMENT;
    if(!["sandbox","production"].includes(environment)||(environment==="production"&&![undefined,"approved","owner"].includes(env.LINEAGE_PAYMENT_ACCESS)))throw unavailable();
    if((environment==="sandbox"||env.LINEAGE_PAYMENT_ACCESS==="owner")&&!isOwner(current))throw unavailable();
    return current;
  }
  async function response(binding,operation) {
    const reply=await transport.request(binding,operation);
    if(![200,201].includes(reply.status))throw unavailable();
    const raw=await reply.text();if(raw.length>262_144)throw unavailable();
    try {return JSON.parse(raw);}catch{throw unavailable();}
  }
  const readSettings=async()=>await read(HOSTED_CHECKOUT_SETTINGS_PATH);
  async function presentOrder(value) {
    const result=publicOrder(value,now());
    if(value.status==="uncertain"&&value.checkoutBlock==="production-funding"&&!value.invoiceAttemptedAt&&!value.invoiceId&&!value.invoiceNumber&&!value.invoiceUrl) {
      result.checkoutBlock="production-funding";
      result.checkoutRestartAllowed=await funding.wasReleased(value);
    }
    if(result.retryAllowed) {
      const settings=(await readSettings())?.value;
      result.retryAllowed=complete(settings)&&settings.revision===value.checkoutSettings?.revision&&sameBinding(settings.merchantBinding,value.merchantBinding);
    }
    return result;
  }
  async function enabled(actor,allowRefresh=false) {
    await access(actor);const record=await readSettings(),s=record?.value;if(!complete(s))throw unavailable();
    const binding=await transport.binding({allowRefresh});
    if(binding.environment!==env.QUICKBOOKS_ENVIRONMENT||!sameBinding(binding,s.merchantBinding))throw unavailable();
    return {record,settings:s,binding};
  }
  async function configurationStatus(actor,record) {
    const s=record?.value;
    if(!complete(s))return {available:false,configured:false,connectionStatus:"setup-required",
      reason:"Save the service item, business terms, and merchant confirmations for the current connection before enabling checkout."};
    try {
      await access(actor);
      const state=typeof transport.readiness==="function"?await transport.readiness():{binding:await transport.binding({allowRefresh:false}),status:"ready"};
      if(!["ready","renewal-due"].includes(state.status)||!bound(state.binding)||state.binding.environment!==env.QUICKBOOKS_ENVIRONMENT)throw unavailable();
      if(!sameBinding(s.merchantBinding,state.binding))return {available:false,configured:false,connectionStatus:"setup-required",
        reason:"The QuickBooks connection changed. Review and save the checkout settings for the current connection."};
      await access(actor);
      if((await readSettings())?.etag!==record.etag)throw unavailable();
      return {available:state.status==="ready",configured:true,connectionStatus:state.status,
        reason:state.status==="renewal-due"?"Checkout setup is complete. Authorization renewal is due; the next checkout action will attempt renewal automatically. No payment was made by viewing this status.":null};
    }catch{return {available:false,configured:false,connectionStatus:"needs-attention",
      reason:"Checkout settings remain saved, but the QuickBooks connection could not be verified. Review its authorization status before changing checkout settings."};}
  }
  async function adminConfiguration(actor) {
    if(!hasAdminAccess(await currentActor(actor)))throw new HostedCheckoutError("Administrator access is required.",403);
    return configurationStatus(actor,await readSettings());
  }
  async function settings(actor) {
    await currentActor(actor,true);const record=await readSettings(),s=record?.value||defaults(),status=await configurationStatus(actor,record);
    return {revision:s.revision,enabled:s.enabled,serviceItemId:s.serviceItemId,serviceItemName:s.serviceItemName,taxCode:s.taxCode,deliveryTerms:s.deliveryTerms,refundTerms:s.refundTerms,
      merchantConfirmed:s.merchantConfirmed,pciAcknowledged:s.pciAcknowledged,automaticInvoiceEmailDisabled:s.automaticInvoiceEmailDisabled,
      environment:s.merchantBinding?.environment||env.QUICKBOOKS_ENVIRONMENT||null,...status};
  }
  async function catalog(actor) {
    await currentActor(actor,true);const binding=await transport.binding({allowRefresh:true});if(!bound(binding)||binding.environment!==env.QUICKBOOKS_ENVIRONMENT)throw unavailable();
    const data=await response(binding,{method:"GET",path:"/query",query:{entity:"Item",where:{field:"Active",value:true},maxResults:1000}});
    const list=data.QueryResponse?.Item??[];if(!Array.isArray(list))throw unavailable();
    return {environment:binding.environment,items:list.map(itemData).filter(i=>i?.active&&i.type==="Service"),truncated:list.length>=1000};
  }
  async function saveSettings(actor,body) {
    await currentActor(actor,true);exact(body,["expectedRevision","enabled","serviceItemId","taxCode","deliveryTerms","refundTerms","merchantConfirmed","pciAcknowledged","automaticInvoiceEmailDisabled"]);
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!["enabled","merchantConfirmed","pciAcknowledged","automaticInvoiceEmailDisabled"].every(k=>typeof body[k]==="boolean"))throw new HostedCheckoutError("Choose explicit checkout settings and confirmations.");
    if(typeof body.serviceItemId!=="string"||(body.serviceItemId&&!numeric.test(body.serviceItemId))||!["","NON"].includes(body.taxCode))throw new HostedCheckoutError("Choose a service item and the explicit NON tax code.");
    const old=await readSettings();if((old?.value.revision??0)!==body.expectedRevision)throw conflict();
    const next={revision:body.expectedRevision+1,enabled:body.enabled,serviceItemId:body.serviceItemId,serviceItemName:"",taxCode:body.taxCode,deliveryTerms:term(body.deliveryTerms),refundTerms:term(body.refundTerms),
      merchantConfirmed:body.merchantConfirmed,pciAcknowledged:body.pciAcknowledged,automaticInvoiceEmailDisabled:body.automaticInvoiceEmailDisabled,merchantBinding:null,updatedBy:actor.email};
    if(next.serviceItemId) {
      const binding=await transport.binding({allowRefresh:true});if(!bound(binding)||binding.environment!==env.QUICKBOOKS_ENVIRONMENT)throw unavailable();
      const item=itemData((await response(binding,{method:"GET",path:`/item/${next.serviceItemId}`})).Item);
      if(!item||item.id!==next.serviceItemId||!item.active||item.type!=="Service")throw new HostedCheckoutError("Choose an active QuickBooks service item.");
      next.serviceItemName=item.name;next.merchantBinding=binding;
    }
    if(next.enabled&&!complete(next))throw new HostedCheckoutError("Complete the service item, NON tax choice, delivery and refund terms, and all merchant confirmations before enabling checkout.");
    await currentActor(actor,true);if(next.merchantBinding&&!sameBinding(next.merchantBinding,await transport.binding({allowRefresh:false})))throw conflict();
    await save(HOSTED_CHECKOUT_SETTINGS_PATH,old,next);return settings(actor);
  }
  async function configuration(actor,{allowRefresh=false}={}) {
    try {const {settings:s,binding}=await enabled(actor,allowRefresh);return {available:true,method:METHOD,environment:binding.environment,deliveryTerms:s.deliveryTerms,refundTerms:s.refundTerms};}catch{return {available:false};}
  }
  async function legacyGuard(q) {
    if(sandbox(q))return;const legacy=await read(orderPath(legacyId(q)));
    if(legacy&&(!sandbox(legacy.value)||legacy.value.customerEmail!==q.customerEmail||legacy.value.manifestHash!==q.manifestHash))throw conflict();
  }
  async function quote(actor,body) {
    exact(body,["project","preparedId","idempotencyKey"]);reference(body.idempotencyKey,keys);if(body.preparedId!==undefined)reference(body.preparedId,keys);
    const email=emailFor(actor),{binding,settings:s}=await enabled(actor,true);
    const supplied=await quoteProvider(body.project,actor,{preparedId:body.preparedId,idempotencyKey:body.idempotencyKey,environment:binding.environment}),until=Date.parse(supplied?.expiresAt);
    if(!supplied||(body.preparedId&&body.preparedId!==supplied.preparedId)||supplied.environment!==binding.environment||supplied.currency!=="USD"||!amountValid(supplied.providerCostCents)
      ||!hex.test(supplied.manifestHash||"")||!keys.test(supplied.preparedId||"")||typeof supplied.filmId!=="string"||supplied.filmId.length>100
      ||typeof supplied.filmTitle!=="string"||supplied.filmTitle.length>300||typeof supplied.quoteReference!=="string"||!supplied.quoteReference||supplied.quoteReference.length>200
      ||!Number.isFinite(until)||until<=now()||(supplied.pricingBasis!=="planning-rate"&&(supplied.apiVerified!==true||supplied.qualityVerified!==true||supplied.commercialTermsVerified!==true)))throw unavailable();
    const pricing=await pricingSettings();if(!Number.isSafeInteger(pricing.revision)||pricing.revision<0||!Number.isInteger(pricing.markupBasisPoints)||pricing.markupBasisPoints<0||pricing.markupBasisPoints>100_000)throw unavailable();
    if(supplied.pricingRevision!==undefined&&supplied.pricingRevision!==pricing.revision)throw expired();
    const markupCents=Number((BigInt(supplied.providerCostCents)*BigInt(pricing.markupBasisPoints)+5000n)/10000n),amountCents=supplied.providerCostCents+markupCents;if(!amountValid(amountCents))throw unavailable();
    const q={id:digest(`${email}:${body.idempotencyKey}`),customerEmail:email,preparedId:supplied.preparedId,manifestHash:supplied.manifestHash,filmId:supplied.filmId,filmTitle:supplied.filmTitle,currency:"USD",amountCents,
      providerCostCents:supplied.providerCostCents,markupCents,pricingRevision:pricing.revision,pricingBasis:supplied.pricingBasis,quoteReference:supplied.quoteReference,
      merchantBinding:binding,checkoutSettings:s,createdAt:stamp(now()),expiresAt:stamp(Math.min(until,now()+15*60_000))};
    await legacyGuard(q);let order=await read(orderPath(orderId(q)));
    if(order?.value.quoteRollover===true&&order.value.checkoutKeyHash===null) {
      if(fundingCycleCanExpire(order.value,now())) order=await funding.releaseExpiredOrder(order.value.id,order.value.quoteId);
      else {
        // A refresh response may be lost before the browser can save its new
        // payment reference. Reuse the one exact, still-unclaimed saved quote.
        const original=await read(quotePath(email,order.value.quoteId)),prior=original?.value;
        if(!prior||prior.id!==order.value.quoteId||prior.customerEmail!==email||prior.manifestHash!==q.manifestHash
          ||prior.preparedId!==q.preparedId||!sameBinding(prior.merchantBinding,binding))throw conflict();
        if(Date.parse(prior.expiresAt)<=now()||prior.checkoutSettings?.revision!==s.revision
          ||["currency","providerCostCents","markupCents","amountCents","pricingRevision","pricingBasis"].some(field=>prior[field]!==q[field]))throw expired();
        const current=await enabled(actor,false);
        if(current.settings.revision!==s.revision||!sameBinding(current.binding,binding)
          ||(await read(orderPath(orderId(q))))?.etag!==order.etag||(await read(quotePath(email,prior.id)))?.etag!==original.etag)throw conflict();
        return publicQuote(prior);
      }
    }
    let rollover=false;
    if(order) {
      if(order.value.checkoutMethod!==METHOD||order.value.customerEmail!==email||order.value.manifestHash!==q.manifestHash)throw conflict();
      rollover=order.value.quoteId!==q.id&&order.value.checkoutBlock==="production-funding"&&await funding.wasReleased(order.value);
      if(!rollover&&(order.value.quoteId!==q.id||order.value.preparedId!==q.preparedId))throw existingOrder();
    }
    const path=quotePath(email,q.id),existing=await read(path);
    const matches=v=>v.customerEmail===email&&v.manifestHash===q.manifestHash&&v.preparedId===q.preparedId&&sameBinding(v.merchantBinding,binding);
    const samePrice=v=>["currency","providerCostCents","markupCents","amountCents","pricingRevision","pricingBasis"].every(field=>v[field]===q[field]);
    async function finishQuote(value) {
      if(rollover) {
        // The immutable release proves this old cycle never attempted an
        // invoice. CAS gives exactly one fresh quote the shared film order.
        const next={...value,id:orderId(value),version:1,provider:"quickbooks",quoteId:value.id,checkoutMethod:METHOD,status:"uncertain",
          refundedCents:0,providerChargeId:null,capturedAt:null,invoiceId:null,invoiceUrl:null,invoiceNumber:null,
          invoiceRequestId:uuid(`invoice:${orderId(value)}:${value.id}`),checkoutKeyHash:null,quoteRollover:true,
          previousFundingQuoteId:order.value.quoteId,createdAt:stamp(now())};
        await save(orderPath(next.id),order,next);
      }
      return publicQuote(value);
    }
    if(existing) {if(!matches(existing.value))throw conflict();if(Date.parse(existing.value.expiresAt)<=now()||existing.value.checkoutSettings.revision!==s.revision||!samePrice(existing.value))throw expired();return finishQuote(existing.value);}
    const fresh=await enabled(actor,false);if(fresh.settings.revision!==s.revision||!sameBinding(binding,fresh.binding))throw expired();
    let created;
    try {created=(await save(path,null,q)).value;}
    catch(error){const winner=await read(path);if(winner&&matches(winner.value)&&winner.value.checkoutSettings.revision===s.revision){if(Date.parse(winner.value.expiresAt)<=now()||!samePrice(winner.value))throw expired();created=winner.value;}else throw error;}
    return finishQuote(created);
  }
  async function readOrder(actor,orderReference) {
    const current=await currentActor(actor),record=await read(orderPath(reference(orderReference)));
    if(!record||record.value.checkoutMethod!==METHOD||(record.value.customerEmail!==current.email&&!hasAdminAccess(current)))throw new HostedCheckoutError("This order was not found.",404);
    return record;
  }
  async function customer(actor,binding) {
    const email=emailFor(actor),identity=digest(`${binding.environment}:${binding.realmId}:${email}`),path=`payments/hosted-customers/${identity}.json`,displayName=`Lineage ${identity}`;
    const existing=await read(path);let record;
    const validCustomer=value=>value&&numeric.test(value.Id||"")&&value.DisplayName===displayName&&value.PrimaryEmailAddr?.Address?.toLowerCase()===email&&value.Active===true;
    if(existing) {
      if(existing.value.email!==email||existing.value.merchantBinding?.realmId!==binding.realmId||existing.value.merchantBinding?.environment!==binding.environment)throw conflict();
      if(existing.value.status==="ready") {
        const value=(await response(binding,{method:"GET",path:`/customer/${reference(existing.value.customerId,numeric)}`})).Customer;
        if(!validCustomer(value)||value.Id!==existing.value.customerId)throw conflict();
        if(!sameBinding(existing.value.merchantBinding,binding))await save(path,existing,{...existing.value,merchantBinding:binding});
        return value.Id;
      }
      if(existing.value.customerAttemptedAt) {
        // Unknown creation may be recovered by an exact read, never another POST.
        const found=(await response(binding,{method:"GET",path:"/query",query:{entity:"Customer",where:{field:"DisplayName",value:displayName},maxResults:2}})).QueryResponse?.Customer??[];
        if(!Array.isArray(found)||found.length!==1||!validCustomer(found[0]))throw conflict();
        await save(path,existing,{...existing.value,merchantBinding:binding,status:"ready",customerId:found[0].Id});return found[0].Id;
      }
      record=await save(path,existing,{...existing.value,merchantBinding:binding,status:"submitting"});
    }
    else record=await save(path,null,{email,merchantBinding:binding,status:"submitting",requestId:uuid(`customer:${identity}`),createdAt:stamp(now())});
    const found=(await response(binding,{method:"GET",path:"/query",query:{entity:"Customer",where:{field:"DisplayName",value:displayName},maxResults:2}})).QueryResponse?.Customer??[];
    if(!Array.isArray(found)||found.length>1)throw conflict();
    let value=found[0];
    if(!value) {
      await access(actor);const fresh=await enabled(actor,false);if(!sameBinding(binding,fresh.binding))throw conflict();
      record=await save(path,record,{...record.value,customerAttemptedAt:stamp(now())});
      value=(await response(binding,{method:"POST",path:"/customer",requestId:record.value.requestId,body:{DisplayName:displayName,PrimaryEmailAddr:{Address:email}}})).Customer;
    }
    if(!validCustomer(value))throw conflict();
    record=await save(path,record,{...record.value,status:"ready",customerId:value.Id});return record.value.customerId;
  }
  async function checkout(actor,body) {
    exact(body,["quoteId","idempotencyKey","consent","productionConsent"]);reference(body.quoteId);reference(body.idempotencyKey,keys);if(body.consent!==true)throw new HostedCheckoutError("Confirm the exact total and checkout terms before continuing.");
    if(body.productionConsent!==undefined&&typeof body.productionConsent!=="boolean")throw new HostedCheckoutError("Confirm whether this paid version should start automatically.");
    const email=emailFor(actor),{binding,settings:s}=await enabled(actor,true),savedQuote=await read(quotePath(email,body.quoteId)),q=savedQuote?.value;
    if(!q||q.customerEmail!==email||!sameBinding(q.merchantBinding,binding))throw conflict();
    await legacyGuard(q);const id=orderId(q),path=orderPath(id),existing=await read(path);
    if(existing) {
      if(existing.value.checkoutMethod!==METHOD||existing.value.customerEmail!==email||existing.value.manifestHash!==q.manifestHash||!sameBinding(existing.value.merchantBinding,binding))throw conflict();
      if(existing.value.quoteId!==q.id||existing.value.preparedId!==q.preparedId
        ||!(existing.value.quoteRollover===true&&existing.value.checkoutKeyHash===null)&&existing.value.checkoutKeyHash!==digest(body.idempotencyKey))throw existingOrder();
      if(existing.value.fundingRelease)throw expired();
      if(existing.value.status!=="uncertain"||existing.value.invoiceAttemptedAt)return presentOrder(existing.value);
    }
    if(binding.environment==="production"&&body.productionConsent!==true)throw new HostedCheckoutError("Confirm that this saved film should be produced automatically after payment before opening checkout.",400,"PRODUCTION_CONSENT_REQUIRED");
    if(Date.parse(q.expiresAt)<=now()||q.checkoutSettings.revision!==s.revision)throw expired();
    let productionUntil=Infinity,fundingReservation;
    if(binding.environment==="production") {
      // Recheck the exact saved plan immediately before opening a payable
      // invoice. A browser capability snapshot cannot authorize this step.
      let production;
      try {production=await productionQuote({email,preparedId:q.preparedId,manifestHash:q.manifestHash,environment:binding.environment,budgetCents:q.providerCostCents});}
      catch {throw checkoutProductionUnavailable();}
      productionUntil=typeof production?.expiresAt==="string"?Date.parse(production.expiresAt):NaN;
      if(!amountValid(q.providerCostCents)||!production||production.preparedId!==q.preparedId||production.manifestHash!==q.manifestHash
        ||production.environment!==binding.environment||production.currency!=="USD"||production.apiVerified!==true||production.qualityVerified!==true||production.commercialTermsVerified!==true
        ||!Number.isSafeInteger(production.providerCostCents)||production.providerCostCents<0||production.providerCostCents>q.providerCostCents
        ||!Number.isSafeInteger(production.maximumCostCents)||production.maximumCostCents<production.providerCostCents||production.maximumCostCents>q.providerCostCents
        ||typeof production.quoteReference!=="string"||!production.quoteReference.trim()||production.quoteReference.length>200||!Number.isFinite(productionUntil)||productionUntil<=now())throw checkoutProductionUnavailable();
      const fresh=await enabled(actor,false),currentQuote=await read(quotePath(email,body.quoteId));
      if(!savedQuote?.etag||currentQuote?.etag!==savedQuote.etag||Date.parse(q.expiresAt)<=now()||fresh.settings.revision!==s.revision||!sameBinding(binding,fresh.binding))throw expired();
      if(productionUntil<=now())throw checkoutProductionUnavailable();
    }
    const previousConsentAt=existing?.value.productionConsentAt;
    const productionConsent=body.productionConsent===true?{productionConsent:true,productionConsentAt:
      existing?.value.productionConsent===true&&typeof previousConsentAt==="string"&&Number.isFinite(Date.parse(previousConsentAt))&&Date.parse(previousConsentAt)<=now()?previousConsentAt:stamp(now())}:{};
    let record;
    try {record=existing?await save(path,existing,{...existing.value,status:"submitting",quoteRollover:false,checkoutKeyHash:digest(body.idempotencyKey),checkoutBlock:null,...(binding.environment==="production"?productionConsent:{})}):await save(path,null,{...q,id,version:1,provider:"quickbooks",quoteId:q.id,checkoutMethod:METHOD,status:"submitting",refundedCents:0,providerChargeId:null,capturedAt:null,
      invoiceId:null,invoiceUrl:null,invoiceNumber:null,invoiceRequestId:uuid(`invoice:${id}`),checkoutKeyHash:digest(body.idempotencyKey),consentAt:stamp(now()),createdAt:stamp(now()),
      ...productionConsent});}
    catch(error) {const winner=await read(path);if(winner?.value.checkoutMethod===METHOD&&winner.value.customerEmail===email&&winner.value.quoteId===q.id&&winner.value.preparedId===q.preparedId&&winner.value.checkoutKeyHash===digest(body.idempotencyKey)&&sameBinding(winner.value.merchantBinding,binding))return presentOrder(winner.value);throw error;}
    try {
      if(binding.environment==="production") {
        try {
          fundingReservation=await reserveFunding({orderId:id,customerEmail:email,preparedId:q.preparedId,
            manifestHash:q.manifestHash,quoteId:q.id,maximumCostCents:q.providerCostCents});
          if(typeof fundingReservation?.recheck!=="function")throw fundingUnavailable();
        }catch {throw fundingUnavailable();}
        if(productionUntil<=now()||Date.parse(q.expiresAt)<=now())throw checkoutProductionUnavailable();
        if((await read(path))?.etag!==record.etag)throw conflict();
      }
      const customerId=await customer(actor,binding);record=await save(path,record,{...record.value,customerId});
      const fresh=await enabled(actor,false);if(fresh.settings.revision!==s.revision||!sameBinding(binding,fresh.binding))throw conflict();
      const item=itemData((await response(binding,{method:"GET",path:`/item/${s.serviceItemId}`})).Item);if(!item||!item.active||item.type!=="Service"||item.id!==s.serviceItemId)throw conflict();
      if(binding.environment==="production") {
        try {if(await fundingReservation.recheck()!==true)throw fundingUnavailable();}catch {throw fundingUnavailable();}
      }
      if(binding.environment==="production"&&(productionUntil<=now()||Date.parse(q.expiresAt)<=now()))throw checkoutProductionUnavailable();
      // This claim is durable before the one allowed POST. A timeout never retries it.
      record=await save(path,record,{...record.value,invoiceAttemptedAt:stamp(now())});
      const final=await enabled(actor,false);if(final.settings.revision!==s.revision||!sameBinding(binding,final.binding))throw conflict();
      if(binding.environment==="production"&&(productionUntil<=now()||Date.parse(q.expiresAt)<=now()))throw checkoutProductionUnavailable();
      const amount=q.amountCents/100,body={CustomerRef:{value:customerId},BillEmail:{Address:email},CurrencyRef:{value:"USD"},AllowOnlineCreditCardPayment:true,AllowOnlineACHPayment:true,EmailStatus:"NotSet",PrivateNote:`Lineage order ${id}`,
        Line:[{Amount:amount,DetailType:"SalesItemLineDetail",Description:"Film production",SalesItemLineDetail:{ItemRef:{value:s.serviceItemId},Qty:1,UnitPrice:amount,TaxCodeRef:{value:"NON"}}}]};
      let invoice=(await response(binding,{method:"POST",path:"/invoice",requestId:record.value.invoiceRequestId,body})).Invoice;
      let data=invoiceData(invoice,record.value);record=await save(path,record,{...record.value,...data});
      if(data.invoiceLinkStatus==="pending") {invoice=(await response(binding,{method:"GET",path:`/invoice/${data.invoiceId}`})).Invoice;data=invoiceData(invoice,record.value);}
      // A missing payment link does not make a fully verified unpaid invoice ambiguous.
      // Keep its identity so a later status check can recover the link without another POST.
      const unpaid=data.balanceCents===q.amountCents&&data.paymentIds.length===0&&data.invoiceLinkStatus!=="invalid";
      record=await save(path,record,{...record.value,...data,status:unpaid?"awaiting-payment":"uncertain"});
    }catch(error) {
      record=await save(path,record,{...record.value,status:"uncertain",invoiceUrl:null,
        ...(error instanceof HostedCheckoutError&&error.code==="PRODUCTION_FUNDING_UNAVAILABLE"&&!record.value.invoiceAttemptedAt?{checkoutBlock:"production-funding"}:{})});
      if(error instanceof HostedCheckoutError&&error.code==="PRODUCTION_FUNDING_UNAVAILABLE"&&!record.value.invoiceAttemptedAt)throw error;
    }
    return presentOrder(record.value);
  }
  async function check(actor,{orderId:referenceId,expectedQuoteId}={}) {
    let record=await readOrder(actor,referenceId);const value=record.value;
    if(expectedQuoteId!==undefined&&(!hex.test(expectedQuoteId)||value.quoteId!==expectedQuoteId))throw conflict();
    // This explicit POST may fence an expired funding-blocked checkout. GET
    // order remains read-only. A receipt exists before any restart is offered.
    if(expectedQuoteId!==undefined&&value.checkoutBlock==="production-funding"&&fundingCycleCanExpire(value,now()))
      return presentOrder((await funding.releaseExpiredOrder(value.id,expectedQuoteId)).value);
    const attemptedAt=stamp(now());let binding;
    // Pausing new checkout must not prevent prior customers reading their invoice.
    // Reconnecting the same company does not change an existing invoice's identity.
    // This exception is for reads only; creation retains its original exact grant.
    try {
      binding=await transport.binding({allowRefresh:true});
      if(!bound(binding)||!bound(value.merchantBinding)||binding.environment!==value.merchantBinding.environment||binding.realmId!==value.merchantBinding.realmId)throw conflict();
      if(!numeric.test(value.invoiceId||""))throw invoiceMismatch("INVOICE_ID_INVALID");
    }catch(error) {
      await save(orderPath(value.id),record,{...value,lastCheckAttemptedAt:attemptedAt,lastCheckStage:"binding",lastCheckFailureReason:checkReason(error,"binding"),lastCheckUrlDiagnostics:null});
      throw error;
    }
    // Claim the read operation too: overlapping responses cannot regress a newer result.
    record=await save(orderPath(value.id),record,{...value,checkOperation:randomUUID(),lastCheckAttemptedAt:attemptedAt,lastCheckStage:"invoice-read",lastCheckFailureReason:null,lastCheckUrlDiagnostics:null});
    let update={status:"uncertain",invoiceUrl:null},stage="invoice-read",urlDiagnostics=null;
    try {
      const invoice=(await response(binding,{method:"GET",path:`/invoice/${value.invoiceId}`})).Invoice;
      stage="invoice-validation";
      if(invoice?.InvoiceLink!=null&&!safeLink(invoice.InvoiceLink))urlDiagnostics=invoiceLinkDiagnostics(invoice.InvoiceLink);
      const data=invoiceData(invoice,value),payments=[];
      for(const paymentId of data.paymentIds) {
        stage="payment-read";const payment=(await response(binding,{method:"GET",path:`/payment/${paymentId}`})).Payment;
        stage="payment-validation";payments.push(paymentAllocation(payment,value,paymentId));
      }
      const allocated=payments.reduce((sum,p)=>sum+p.allocatedCents,0),paid=data.balanceCents===0&&allocated===value.amountCents&&payments.length>0;
      const unpaid=data.balanceCents===value.amountCents&&allocated===0&&data.paymentIds.length===0&&data.invoiceLinkStatus!=="invalid";
      update={...data,status:paid?"captured":unpaid?"awaiting-payment":"uncertain",accountingPayments:payments,accountingCheckedAt:stamp(now()),lastCheckedBinding:binding,
        ...(paid?{capturedAt:value.capturedAt||stamp(now()),confirmationSource:SOURCE}:{}),settlementVerified:false,lastCheckStage:"complete",
        lastCheckFailureReason:paid||unpaid?null:data.invoiceLinkStatus==="invalid"?"INVOICE_LINK_INVALID":"PAYMENT_RECONCILIATION_INCOMPLETE",lastCheckUrlDiagnostics:urlDiagnostics};
      stage="actor-recheck";await currentActor(actor);
      stage="binding-recheck";if(!sameBinding(binding,await transport.binding({allowRefresh:false})))throw conflict();
    }catch(error) {update={status:"uncertain",invoiceUrl:null,lastCheckStage:stage,lastCheckFailureReason:checkReason(error,stage),lastCheckUrlDiagnostics:urlDiagnostics};}
    const current=await read(orderPath(value.id));if(current?.etag!==record.etag)throw conflict();
    const saved=(await save(orderPath(value.id),record,{...record.value,...update,checkOperation:null})).value;
    // Persist production intent independently of the browser and receipt mail.
    // A transient queue failure is retried by payment reconciliation; payment
    // confirmation remains the verified Accounting result.
    if(saved.status==="captured"&&saved.productionConsent===true)try {await productionAutomation.schedule({id:saved.id});}catch{}
    // Receipt delivery is recoverable independently; mail problems must never
    // turn a verified payment into an uncertain financial result.
    if(saved.status==="captured")try {await receiptDelivery.deliver(saved);}catch{}
    return presentOrder(saved);
  }
  async function adminDiagnostics(actor,orderReference) {
    const current=await currentActor(actor);
    if(!hasAdminAccess(actor)||!hasAdminAccess(current))throw new HostedCheckoutError("Administrator access is required.",403);
    const value=(await readOrder(current,orderReference)).value,attempted=Date.parse(value.lastCheckAttemptedAt);
    return {orderId:value.id,lastCheckAttemptedAt:Number.isFinite(attempted)?stamp(attempted):null,
      lastCheckStage:checkStages.includes(value.lastCheckStage)?value.lastCheckStage:null,
      lastCheckFailureReason:checkReasons.has(value.lastCheckFailureReason)?value.lastCheckFailureReason:null,
      invoiceLinkStatus:["ready","pending","invalid"].includes(value.invoiceLinkStatus)?value.invoiceLinkStatus:null,
      invoiceLinkDiagnostics:safeLinkDiagnostics(value.lastCheckUrlDiagnostics)};
  }
  async function receipt(actor,orderReference) {
    const v=(await readOrder(actor,orderReference)).value;if(v.status!=="captured"||!v.capturedAt||v.confirmationSource!==SOURCE)throw new HostedCheckoutError("A receipt is available after QuickBooks records payment.",409);
    return {receiptId:v.id,filmTitle:v.filmTitle,currency:v.currency,amountCents:v.amountCents,refundedCents:0,transactionId:v.accountingPayments?.[0]?.id||null,
      processorDisclosure:"Payment recorded by QuickBooks. Processor capture and bank settlement have not been verified.",capturedAt:v.capturedAt,description:"Lineage Theatre film production",status:v.status,sandbox:sandbox(v),checkoutMethod:METHOD,confirmationSource:SOURCE,
      notice:sandbox(v)?"Sandbox accounting receipt. No live payment is represented.":"Payment recorded by QuickBooks. Film delivery and any refund are tracked separately; processor capture and settlement are not verified."};
  }
  async function authorizeBoundSale({email,orderId:referenceId,manifestHash,preparedId}={}, {saleOnly=false}={}) {
    // A planning price and a cached paid badge never authorize provider expense.
    // Each short-lived grant requires the original paid price, its private plan,
    // a live exact invoice allocation and an actual capped full-film quote.
    let stage="request";
    try {
    if(typeof email!=="string"||email!==email.trim().toLowerCase()||!hex.test(manifestHash||"")||!hex.test(referenceId||""))throw productionUnavailable("REQUEST_INVALID");
    stage="actor-read";
    const actorRecord=await read(userPath(email)),actor=actorRecord?.value;
    if(typeof actorRecord?.etag!=="string"||actor?.email!==email)throw productionUnavailable("ACTOR_RECORD_INVALID");
    stage="actor-access";
    await access(actor);
    stage="order-read";
    const path=orderPath(referenceId),record=await read(path),value=record?.value;
    if(!hex.test(value?.quoteId||""))throw productionUnavailable("PAID_QUOTE_REFERENCE_INVALID");
    stage="paid-quote-read";
    const paidQuotePath=quotePath(email,value.quoteId),paidQuote=await read(paidQuotePath),q=paidQuote?.value;
    const validTime=value=>typeof value==="string"&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now();
    const sameCompany=(a,b)=>bound(a)&&bound(b)&&a.environment===b.environment&&a.realmId===b.realmId;
    const quoteFields=["customerEmail","preparedId","manifestHash","filmId","filmTitle","currency","amountCents","providerCostCents","markupCents","pricingRevision","pricingBasis","quoteReference","expiresAt"];
    const captured=order=>Boolean(order&&q&&order.id===referenceId&&orderId(order)===referenceId&&order.checkoutMethod===METHOD
      &&order.customerEmail===email&&order.preparedId===preparedId&&order.manifestHash===manifestHash&&order.status==="captured"
      &&validTime(order.capturedAt)&&order.confirmationSource===SOURCE&&order.currency==="USD"&&order.refundedCents===0
      &&!order.refundOperation&&(!order.refunds||Array.isArray(order.refunds)&&order.refunds.length===0)&&!order.checkOperation
      &&order.lastCheckStage==="complete"&&order.lastCheckFailureReason===null&&validTime(order.accountingCheckedAt)
      &&numeric.test(order.invoiceId||"")&&numeric.test(order.customerId||"")&&order.balanceCents===0
      &&amountValid(order.providerCostCents)&&amountValid(order.amountCents)&&Number.isSafeInteger(order.markupCents)&&order.markupCents>=0
      &&order.amountCents===order.providerCostCents+order.markupCents&&q.id===order.quoteId&&quoteFields.every(field=>order[field]===q[field])
      &&sameBinding(order.merchantBinding,q.merchantBinding)&&complete(order.checkoutSettings)
      &&JSON.stringify(order.checkoutSettings)===JSON.stringify(q.checkoutSettings)
      &&Array.isArray(order.accountingPayments)&&order.accountingPayments.length>0&&order.accountingPayments.length<=100
      &&order.accountingPayments.every(payment=>numeric.test(payment?.id||"")&&amountValid(payment.allocatedCents))
      &&new Set(order.accountingPayments.map(payment=>payment.id)).size===order.accountingPayments.length
      &&order.accountingPayments.reduce((sum,payment)=>sum+payment.allocatedCents,0)===order.amountCents
      &&Array.isArray(order.paymentIds)&&order.paymentIds.length===order.accountingPayments.length
      &&order.paymentIds.every((id,index)=>id===order.accountingPayments[index].id));
    stage="captured-order";
    if(typeof record?.etag!=="string"||typeof paidQuote?.etag!=="string"||!captured(value))throw productionUnavailable("CAPTURED_ORDER_INVALID");
    stage="allowance";
    const allowance=saleOnly?{recheck:async()=>{}}:await readProductionAllowance({order:value,read,now});
    stage="plan";
    let planPath;
    try {planPath=productionJobPath(email,preparedId);}catch{throw productionUnavailable("PLAN_REFERENCE_INVALID");}
    const plan=await read(planPath),job=plan?.value;
    // A paused assembly resumes the same completed clips. It still needs the
    // existing live payment and saved-budget checks; it never prepares new shots.
    if(typeof plan?.etag!=="string"||!job||job.id!==preparedId||job.ownerHash!==digest(email)||job.manifestHash!==manifestHash
      ||!job.manifest||digest(JSON.stringify(job.manifest))!==manifestHash||job.filmId!==value.filmId||job.manifest.filmId!==value.filmId
      ||!Array.isArray(job.manifest.shots)||!job.manifest.shots.length||!Array.isArray(job.shots)||job.shots.length!==job.manifest.shots.length
      ||job.shots.some((shot,index)=>shot.id!==job.manifest.shots[index].id)||!(saleOnly?["prepared","processing","uncertain","awaiting-assembly","completed","failed"]:["prepared","processing","uncertain","awaiting-assembly"]).includes(job.status)
      ||job.status==="awaiting-assembly"&&job.shots.some(shot=>shot.status!=="completed"))throw productionUnavailable("PLAN_INVALID");
    stage="settings";
    const settingsRecord=await readSettings(),s=settingsRecord?.value;
    stage="binding";
    const binding=await transport.binding({allowRefresh:true});
    if(typeof settingsRecord?.etag!=="string"||!complete(s)||binding.environment!==env.QUICKBOOKS_ENVIRONMENT
      ||!sameCompany(binding,value.merchantBinding)||!sameCompany(binding,s.merchantBinding))throw productionUnavailable("MERCHANT_BINDING_INVALID");
    let authorizedRecord=record;
    async function recheck() {
      stage="allowance-recheck";
      await allowance.recheck();
      stage="binding-recheck";
      if(!sameBinding(binding,await transport.binding({allowRefresh:false})))throw productionUnavailable("BINDING_CHANGED");
      stage="records-recheck";
      const order=await read(path),quote=await read(paidQuotePath),prepared=await read(planPath),settings=await readSettings();
      if(order?.etag!==authorizedRecord.etag||!captured(order?.value)||quote?.etag!==paidQuote.etag
        ||prepared?.etag!==plan.etag||settings?.etag!==settingsRecord.etag)throw productionUnavailable("RECORDS_CHANGED");
      stage="actor-recheck";
      await access(actor);const account=await read(userPath(email));
      if(account?.etag!==actorRecord.etag)throw productionUnavailable("ACTOR_CHANGED");
    }
    async function verifyPaidInvoice() {
      await recheck();
      stage="invoice-read";
      const checkedAt=now(),invoice=(await response(binding,{method:"GET",path:`/invoice/${value.invoiceId}`})).Invoice;
      stage="invoice-validation";
      const data=invoiceData(invoice,value),payments=[];
      for(const paymentId of data.paymentIds) {
        stage="payment-read";
        const payment=(await response(binding,{method:"GET",path:`/payment/${paymentId}`})).Payment;
        stage="payment-validation";
        payments.push(paymentAllocation(payment,value,paymentId));
      }
      if(data.balanceCents!==0||!payments.length||payments.reduce((sum,payment)=>sum+payment.allocatedCents,0)!==value.amountCents)throw productionUnavailable("INVOICE_ALLOCATION_INVALID");
      // A separate RefundReceipt or CreditMemo/Expense can leave this invoice
      // and its Payment allocation unchanged. Require a fresh completed scan
      // for recorded Accounting reversals. This does not prove bank settlement
      // or absence of unrecorded refunds outside QuickBooks.
      // https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Payment
      stage="reversals";
      if(typeof verifyReversals!=="function")throw reversalsUnavailable("REVERSAL_VERIFIER_UNAVAILABLE");
      const context={orderId:referenceId,environment:binding.environment,grantId:binding.grantId,realmId:binding.realmId,
        customerId:value.customerId,invoiceId:value.invoiceId,currency:value.currency,amountCents:value.amountCents,paymentIds:data.paymentIds,saleCreatedAt:value.createdAt};
      const proof=await verifyReversals(structuredClone(context)),observed=Date.parse(proof?.checkedAt),expires=Date.parse(proof?.expiresAt);
      stage="reversal-proof";
      if(!proof||proof.version!==1||proof.outcome!=="clear"||proof.scope!==HOSTED_REVERSAL_SCOPE||!hex.test(proof.evidenceHash||"")
        ||Object.keys(context).some(field=>field==="paymentIds"?!Array.isArray(proof.paymentIds)||JSON.stringify(proof.paymentIds)!==JSON.stringify(context.paymentIds):proof[field]!==context[field])
        ||typeof proof.checkedAt!=="string"||typeof proof.expiresAt!=="string"||!Number.isFinite(observed)||!Number.isFinite(expires)
        ||observed<checkedAt||observed>now()||expires<=now()||expires>observed+60_000)throw reversalsUnavailable("REVERSAL_PROOF_INVALID");
      // Reconciliation can span several paginated queries. Re-read this sale
      // after the scan so an unapplied/voided invoice or Payment cannot reuse
      // the paid snapshot taken before it.
      stage="final-invoice-read";
      const finalInvoiceResponse=(await response(binding,{method:"GET",path:`/invoice/${value.invoiceId}`})).Invoice;
      stage="final-invoice-validation";
      const finalInvoice=invoiceData(finalInvoiceResponse,value);
      if(finalInvoice.balanceCents!==0||JSON.stringify(finalInvoice.paymentIds)!==JSON.stringify(data.paymentIds))throw productionUnavailable("FINAL_INVOICE_CHANGED");
      let finalAllocation=0;
      for(const paymentId of finalInvoice.paymentIds) {
        stage="final-payment-read";
        const payment=(await response(binding,{method:"GET",path:`/payment/${paymentId}`})).Payment;
        stage="final-payment-validation";
        finalAllocation+=paymentAllocation(payment,value,paymentId).allocatedCents;
      }
      if(finalAllocation!==value.amountCents)throw productionUnavailable("FINAL_ALLOCATION_INVALID");
      await recheck();
      stage="payment-freshness";
      if(checkedAt+60_000<=now()||expires<=now())throw productionUnavailable("PAYMENT_PROOF_EXPIRED");
      return {checkedAt,expiresAt:expires};
    }
    let verifiedAt=await verifyPaidInvoice(),fresh=value.fulfillmentQuote;
    // A merchant correction reuses only the verified original sale. Its target
    // plan and budget live in a separate immutable authorization; this branch
    // never refreshes or writes the original order's fulfillment quote.
    if(saleOnly)return {order:structuredClone(value),expiresAt:stamp(Math.min(verifiedAt.checkedAt+60_000,verifiedAt.expiresAt)),recheck};
    stage="quote-validation";
    const quoteValid=quote=>quote&&quote.preparedId===preparedId&&quote.manifestHash===manifestHash&&quote.environment===binding.environment&&quote.currency==="USD"
      &&quote.apiVerified===true&&quote.qualityVerified===true&&quote.commercialTermsVerified===true
      &&Number.isSafeInteger(quote.providerCostCents)&&quote.providerCostCents>=0&&quote.providerCostCents<=allowance.budgetCents
      &&Number.isSafeInteger(quote.maximumCostCents)&&quote.maximumCostCents>=quote.providerCostCents&&quote.maximumCostCents<=allowance.budgetCents
      &&(!allowance.quoteReference||quote.quoteReference===allowance.quoteReference)
      &&typeof quote.quoteReference==="string"&&quote.quoteReference.trim()&&quote.quoteReference.length<=200
      &&typeof quote.expiresAt==="string"&&Number.isFinite(Date.parse(quote.expiresAt));
    if(fresh&&!quoteValid(fresh))throw productionUnavailable("SAVED_QUOTE_INVALID");
    stage="started-authorization";
    const started=job.status!=="prepared"||job.shots.some(shot=>shot.status!=="prepared");
    if(started&&(!fresh||job.authorization?.manifestHash!==manifestHash||job.authorization.environment!==binding.environment
      ||job.authorization.quoteReference!==fresh.quoteReference||job.authorization.budgetCents!==fresh.maximumCostCents))throw productionUnavailable("STARTED_AUTHORIZATION_MISMATCH");
    if(!fresh||Date.parse(fresh.expiresAt)<=now()) {
      // An expired full-film quote cannot be replaced after even one submission.
      if(started)throw productionUnavailable("STARTED_QUOTE_EXPIRED");
      stage="quote-request";
      fresh=await productionQuote({email,preparedId,manifestHash,environment:binding.environment,budgetCents:allowance.budgetCents});
      stage="quote-refresh-validation";
      if(!quoteValid(fresh)||Date.parse(fresh.expiresAt)<=now())throw productionUnavailable("FRESH_QUOTE_INVALID");
      // Payment may have been voided/refunded while the provider quote was read.
      verifiedAt=await verifyPaidInvoice();
      stage="quote-refresh-validation";
      if(Date.parse(fresh.expiresAt)<=now())throw productionUnavailable("FRESH_QUOTE_EXPIRED");
      const fulfillmentQuote=Object.fromEntries(["preparedId","manifestHash","environment","currency","providerCostCents","maximumCostCents",
        "quoteReference","expiresAt","apiVerified","qualityVerified","commercialTermsVerified"].map(field=>[field,fresh[field]]));
      stage="quote-save";
      authorizedRecord=await save(path,record,{...value,fulfillmentQuote});
    }
    await recheck();
    stage="grant-freshness";
    const until=Math.min(Date.parse(fresh.expiresAt),verifiedAt.checkedAt+60_000,verifiedAt.expiresAt,now()+60_000);
    if(until<=now())throw productionUnavailable("GRANT_EXPIRED");
    return {allowed:true,manifestHash,budgetCents:fresh.maximumCostCents,quoteReference:fresh.quoteReference,expiresAt:stamp(until),
      environment:binding.environment,fictionalOnly:binding.environment==="sandbox"};
    }catch(error){throw markProductionAuthorizationFailure(error,stage);}
  }
  return {settings,catalog,saveSettings,configuration,adminConfiguration,quote,checkout,check,receipt,adminDiagnostics,order:async(actor,id)=>presentOrder((await readOrder(actor,id)).value),
    ownsOrder:async id=>hex.test(id||"")&&(await read(orderPath(id)))?.value.checkoutMethod===METHOD,
    authorizeProduction:input=>authorizeBoundSale(input),
    verifyPaidSale:input=>authorizeBoundSale(input,{saleOnly:true})};
}
export const hostedCheckout=createHostedCheckoutService();
