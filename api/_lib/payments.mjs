import {randomUUID} from "node:crypto";
import {digest,readRecord,writeRecord} from "./auth.mjs";
import {hasAdminAccess,accessStatusForUser} from "./access.mjs";
import {readPricingSettings} from "./admin.mjs";
import {createQuickBooksPaymentsTransport,intuitDiagnostic} from "./quickbooks.mjs";
import {INTUIT_PAYMENT_ORIGINS,paymentAuthorizationMatches} from "./payment-authorization.mjs";
import {paymentReadiness} from "./payment-readiness.mjs";

// Contracts checked against Intuit's own SDK, not inferred endpoints:
// https://github.com/intuit/PHP-Payments-SDK/blob/master/src/Operations/ChargeOperations.php
// https://github.com/intuit/PHP-Payments-SDK/blob/master/tests/ChargeTest.php
// https://github.com/IntuitDeveloper/SampleApp-Dotnet_Payments/blob/master/OAuth2-Dotnet_Payments/OAuth2-Dotnet_Payments/Default.aspx.cs
// A captured payment is not evidence of bank settlement or a rendered film.
export class PaymentError extends Error {
  constructor(message,status=400,code="PAYMENT_REQUEST_INVALID",charged=false) {
    super(message);this.status=status;this.code=code;this.charged=charged;
  }
}
const blocked=()=>new PaymentError("Film production and payment are not available yet. Your screenplay remains saved.",503,"PRODUCTION_UNAVAILABLE");
const conflict=()=>new PaymentError("This payment request changed or is already being processed. Check its status before continuing.",409,"PAYMENT_CONFLICT",null);
const uncertain=()=>new PaymentError("The payment result needs review. Do not submit another payment; check this order's status.",409,"PAYMENT_REVIEW_REQUIRED",null);
const idPattern=/^[a-f0-9]{64}$/;
const providerIdPattern=/^[A-Za-z0-9_-]{1,128}$/;
const keyPattern=/^[A-Za-z0-9_-]{16,100}$/;
const stamp=now=>new Date(now).toISOString();
const amountValid=value=>Number.isSafeInteger(value)&&value>0&&value<=100_000_000;
const centsText=cents=>`${Math.floor(cents/100)}.${String(cents%100).padStart(2,"0")}`;
function cents(value) {
  if(typeof value!=="string"||!/^\d{1,7}(?:\.\d{1,2})?$/.test(value))return null;
  const [whole,fraction=""]=value.split(".");const result=Number(whole)*100+Number(fraction.padEnd(2,"0"));
  return amountValid(result)?result:null;
}
function token(value) {
  if(typeof value!=="string"||value.length<8||value.length>2048||!/[A-Za-z]/.test(value)||!/^[A-Za-z0-9_.=-]+$/.test(value))
    throw new PaymentError("A payment token is required. Enter card information only in the secure payment form.");
  return value;
}
function exactFields(value,keys) {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))
    throw new PaymentError("This payment request contains unsupported information.");
}
function actorEmail(actor) {
  // Use the same approval check as the studio, including persisted legacy
  // administrator roles. It still rejects suspended and unapproved accounts.
  if(!actor||accessStatusForUser(actor)!=="approved"||actor.mustChangePassword||typeof actor.email!=="string"
    ||actor.email!==actor.email.trim().toLowerCase()||!/^\S+@\S+\.\S+$/.test(actor.email))throw new PaymentError("Sign in to continue.",401);
  return actor.email;
}
function requireAdmin(actor) {actorEmail(actor);if(!hasAdminAccess(actor))throw new PaymentError("Administrator access is required.",403);}
function id(value) {if(typeof value!=="string"||!idPattern.test(value))throw new PaymentError("This payment reference is invalid.");return value;}
function key(value) {if(typeof value!=="string"||!keyPattern.test(value))throw new PaymentError("A unique payment request reference is required.");return value;}
const quotePath=(email,quoteId)=>`payments/quotes/${digest(email)}/${quoteId}.json`;
const orderPath=orderId=>`payments/orders/${orderId}.json`;
function bindingValid(binding) {return Boolean(binding&&Object.hasOwn(INTUIT_PAYMENT_ORIGINS,binding.environment)&&typeof binding.grantId==="string"&&idPattern.test(binding.grantId));}
const sameBinding=(a,b)=>bindingValid(a)&&bindingValid(b)&&a.environment===b.environment&&a.grantId===b.grantId;
const isSandbox=value=>value.merchantBinding?.environment==="sandbox";
const legacyOrderId=value=>digest(`${value.customerEmail}:${value.manifestHash}`);
// Keep issued sandbox references stable. Production identities are separate and
// deliberately omit grantId: reconnecting OAuth must never permit another charge.
const paymentOrderId=value=>isSandbox(value)?legacyOrderId(value):digest(`${value.customerEmail}:production:${value.manifestHash}`);
function publicQuote(value) {
  return {id:value.id,orderId:paymentOrderId(value),preparedId:value.preparedId,filmId:value.filmId,filmTitle:value.filmTitle,manifestHash:value.manifestHash,
    currency:value.currency,amountCents:value.amountCents,expiresAt:value.expiresAt,sandbox:isSandbox(value)};
}
function publicOrder(value) {
  return {id:value.id,quoteId:value.quoteId,preparedId:value.preparedId,filmId:value.filmId,filmTitle:value.filmTitle,status:value.status,
    currency:value.currency,amountCents:value.amountCents,refundedCents:value.refundedCents,
    charged:value.capturedAt?true:value.status==="declined"?false:null,
    requiresReview:["submitting","uncertain","refund-pending"].includes(value.status),
    receiptAvailable:Boolean(value.capturedAt),createdAt:value.createdAt,updatedAt:value.updatedAt,sandbox:isSandbox(value)};
}

export function createIntuitPaymentsAdapter({transport=createQuickBooksPaymentsTransport(),now=Date.now}={}) {
  async function send(binding,operation,expectedAmount,refund=false) {
    if(!bindingValid(binding))throw blocked();
    const operationName=`${refund?"refund":"charge"}-${operation.method==="GET"?"read":"create"}`;
    const failure=(response,code)=>{const error=uncertain();error.diagnostic=intuitDiagnostic(operationName,response,code,now());return error;};
    let response;
    try {response=await transport.request(binding,operation);}catch {throw failure(null,"NETWORK_OR_CONNECTION_ERROR");}
    // Never store/return raw processor errors, card details, authorization codes, or tokens.
    if(![200,201].includes(response.status))throw failure(response,"HTTP_ERROR");
    let data;
    try {const raw=await response.text();if(raw.length>65_536)throw new Error();data=JSON.parse(raw);}catch {throw failure(response,"INVALID_RESPONSE");}
    const knownId=typeof data?.id==="string"&&providerIdPattern.test(data.id)?data.id:null;
    const amountCents=cents(data?.amount);
    const currency=refund&&data?.currency===undefined?"USD":data?.currency;
    const status=["CAPTURED","AUTHORIZED","DECLINED","CANCELLED","ISSUED"].includes(data?.status)?data.status:"UNKNOWN";
    return {id:knownId,status,amountCents,currency:currency==="USD"?"USD":null,diagnostic:intuitDiagnostic(operationName,response,"HTTP_RESPONSE",now()),
      verified:Boolean(knownId&&amountCents===expectedAmount&&currency==="USD")};
  }
  return {
    binding:(options={})=>transport.binding({allowRefresh:true,...options}),
    charge(binding,{amountCents,paymentToken,requestId}) {
      if(!amountValid(amountCents))throw new PaymentError("The payment amount is invalid.");
      return send(binding,{method:"POST",path:"/charges",requestId,body:{amount:centsText(amountCents),currency:"USD",token:token(paymentToken),capture:true,context:{mobile:false,isEcommerce:true}}},amountCents);
    },
    readCharge(binding,{chargeId,amountCents}) {
      if(!providerIdPattern.test(chargeId||""))throw new PaymentError("The payment reference is invalid.");
      return send(binding,{method:"GET",path:`/charges/${chargeId}`,requestId:randomUUID()},amountCents);
    },
    refund(binding,{chargeId,amountCents,requestId}) {
      if(!providerIdPattern.test(chargeId||"")||!amountValid(amountCents))throw new PaymentError("The refund request is invalid.");
      return send(binding,{method:"POST",path:`/charges/${chargeId}/refunds`,requestId,body:{amount:centsText(amountCents),description:"Lineage Theatre customer refund"}},amountCents,true);
    },
    readRefund(binding,{chargeId,refundId,amountCents}) {
      if(![chargeId,refundId].every(value=>typeof value==="string"&&providerIdPattern.test(value)))throw new PaymentError("The refund reference is invalid.");
      return send(binding,{method:"GET",path:`/charges/${chargeId}/refunds/${refundId}`,requestId:randomUUID()},amountCents,true);
    },
  };
}

export function createPaymentsService(overrides={}) {
  const {read=readRecord,write=writeRecord,now=Date.now,provider=createIntuitPaymentsAdapter(),
    pricingSettings=readPricingSettings,
    quoteProvider=async(...args)=>(await import("./film-pricing.mjs")).filmPricing.quoteForPayment(...args),
    readiness=paymentReadiness.readiness}=overrides;
  async function enabled(operation="quote",{allowRefresh=true,actor,subjectEmail}={}) {
    const ready=await readiness({actor,subjectEmail,operation});
    // Legacy sandbox test injection cannot enable production. Production needs
    // a fresh current-grant authorization from a trusted server evidence verifier.
    if(!(ready?.sandboxEnabled===true&&ready?.merchantVerified===true)&&!ready?.authorization)throw blocked();
    // Card entry must be authorized before an explicit preparation may renew OAuth.
    if(operation==="card-entry"&&(!bindingValid(ready?.authorization)
      ||!paymentAuthorizationMatches(ready.authorization,ready.authorization,"card-entry",now())))throw blocked();
    const binding=await provider.binding({allowRefresh});
    if(!bindingValid(binding))throw blocked();
    if(binding.environment==="production"&&!paymentAuthorizationMatches(ready?.authorization,binding,operation,now()))throw blocked();
    if(binding.environment==="sandbox"&&!(ready?.sandboxEnabled===true&&ready?.merchantVerified===true)
      &&!paymentAuthorizationMatches(ready?.authorization,binding,operation,now()))throw blocked();
    return binding;
  }
  async function cardEntryConfiguration(actor,allowRefresh) {
    actorEmail(actor);
    try {
      const binding=await enabled("card-entry",{allowRefresh,actor}),ready=await readiness({actor,operation:"card-entry"});
      // Browser-direct entry makes the merchant page part of card-data handling.
      // Require a separately reviewed entry authorization even for sandbox UI.
      if(!paymentAuthorizationMatches(ready?.authorization,binding,"card-entry",now()))return {available:false};
      return {available:true,environment:binding.environment,
        tokenization:{method:"intuit-browser-direct",url:`${INTUIT_PAYMENT_ORIGINS[binding.environment]}/quickbooks/v4/payments/tokens`}};
    }catch {return {available:false};}
  }
  // Status reads never renew authorization. Renewal requires the same-origin POST.
  const checkoutConfiguration=actor=>cardEntryConfiguration(actor,false);
  const prepareCheckout=actor=>cardEntryConfiguration(actor,true);
  async function save(path,previous,value) {
    const next={...value,changeId:randomUUID(),updatedAt:stamp(now())};
    try {
      const result=await write(path,next,previous?.etag);
      if(result?.etag)return {value:next,etag:result.etag};
    }catch {/* Confirm only this exact attempted write; never repeat a provider operation. */}
    const saved=await read(path);
    if(saved?.value.changeId!==next.changeId)throw conflict();
    return saved;
  }
  async function readOrder(actor,orderId) {
    const email=actorEmail(actor),record=await read(orderPath(id(orderId)));
    if(!record||(record.value.customerEmail!==email&&!hasAdminAccess(actor)))throw new PaymentError("This order was not found.",404);
    return record;
  }
  async function guardLegacyProductionOrder(value) {
    if(isSandbox(value))return;
    const legacy=await read(orderPath(legacyOrderId(value)));
    // Older records remain readable by their original ID. Only a positively
    // identified sandbox order is safe to leave behind when moving to live.
    if(legacy&&(!isSandbox(legacy.value)||legacy.value.customerEmail!==value.customerEmail
      ||legacy.value.manifestHash!==value.manifestHash))throw conflict();
  }
  async function quote(actor,body) {
    const email=actorEmail(actor);exactFields(body,["project","preparedId","idempotencyKey"]);key(body.idempotencyKey);
    if(body.preparedId!==undefined)key(body.preparedId);
    const binding=await enabled("quote",{actor});
    const supplied=await quoteProvider(body.project,actor,{idempotencyKey:body.idempotencyKey,environment:binding.environment,...(body.preparedId?{preparedId:body.preparedId}:{})});
    // The owner may sell a film at an app-calculated fixed price before its
    // eventual provider expense is exact. This trusted server quote does not
    // assert API readiness, quality verification, or production authorization.
    const planningPrice=supplied?.pricingBasis==="planning-rate";
    const until=Date.parse(supplied?.expiresAt);
    if(!supplied||(body.preparedId&&supplied.preparedId!==body.preparedId)||supplied.environment!==binding.environment||supplied.currency!=="USD"||!amountValid(supplied.providerCostCents)||!idPattern.test(supplied.manifestHash||"")
      ||typeof supplied.preparedId!=="string"||!keyPattern.test(supplied.preparedId)
      ||typeof supplied.filmId!=="string"||supplied.filmId.length>100
      ||typeof supplied.filmTitle!=="string"||supplied.filmTitle.length>300
      ||typeof supplied.quoteReference!=="string"||!supplied.quoteReference||supplied.quoteReference.length>200
      ||(!planningPrice&&(supplied.qualityVerified!==true||supplied.apiVerified!==true||supplied.commercialTermsVerified!==true))
      ||!Number.isFinite(until)||until<=now())throw blocked();
    const quoteId=digest(`${email}:${body.idempotencyKey}`),path=quotePath(email,quoteId),existing=await read(path);
    await guardLegacyProductionOrder({customerEmail:email,manifestHash:supplied.manifestHash,merchantBinding:binding});
    if(existing) {
      if(existing.value.manifestHash!==supplied.manifestHash||existing.value.preparedId!==supplied.preparedId||!sameBinding(existing.value.merchantBinding,binding))throw conflict();
      if(Date.parse(existing.value.expiresAt)<=now())throw new PaymentError("This quote expired. Request a new price.",409,"QUOTE_EXPIRED");
      return publicQuote(existing.value);
    }
    const settings=await pricingSettings();
    if(supplied.pricingRevision!==undefined&&supplied.pricingRevision!==settings.revision)
      throw new PaymentError("Pricing settings changed while this price was being prepared. Request your price again.",409,"PRICE_CHANGED");
    if(!Number.isInteger(settings.markupBasisPoints)||settings.markupBasisPoints<0||settings.markupBasisPoints>100_000
      ||!Number.isSafeInteger(settings.revision)||settings.revision<0)throw blocked();
    const markupCents=Number((BigInt(supplied.providerCostCents)*BigInt(settings.markupBasisPoints)+5_000n)/10_000n);
    const amountCents=supplied.providerCostCents+markupCents;
    if(!amountValid(amountCents))throw blocked();
    const value={version:1,id:quoteId,customerEmail:email,preparedId:supplied.preparedId,filmId:supplied.filmId,filmTitle:supplied.filmTitle,
      manifestHash:supplied.manifestHash,quoteReference:supplied.quoteReference,currency:"USD",providerCostCents:supplied.providerCostCents,
      pricingBasis:planningPrice?"planning-rate":"provider-quote",
      markupBasisPoints:settings.markupBasisPoints,markupCents,pricingRevision:settings.revision,amountCents,
      merchantBinding:binding,createdAt:stamp(now()),expiresAt:stamp(Math.min(until,now()+15*60_000))};
    try {return publicQuote((await save(path,null,value)).value);}catch(error) {
      const winner=await read(path);
      if(winner?.value.manifestHash===value.manifestHash&&winner.value.preparedId===value.preparedId&&sameBinding(winner.value.merchantBinding,binding))return publicQuote(winner.value);
      throw error;
    }
  }
  async function storeCharge(record,result) {
    const value=record.value;
    const matched=result?.verified===true&&typeof result.id==="string"&&providerIdPattern.test(result.id)&&result.amountCents===value.amountCents&&result.currency===value.currency
      &&(!value.providerChargeId||value.providerChargeId===result.id);
    const captured=matched&&result.status==="CAPTURED",declined=matched&&result.status==="DECLINED";
    return save(orderPath(value.id),record,{...value,status:captured?"captured":declined?"declined":"uncertain",
      providerChargeId:value.providerChargeId||(result?.id&&providerIdPattern.test(result.id)?result.id:null),
      capturedAt:captured?value.capturedAt||stamp(now()):value.capturedAt||null,diagnostics:[...(value.diagnostics||[]),...(result?.diagnostic?[result.diagnostic]:[])].slice(-100),
      accounting:captured?{status:"unmapped",events:[{id:value.chargeRequestId,type:"customer-payment-captured",amountCents:value.amountCents,at:stamp(now())}],settlementVerified:false,feesCents:null,providerExpenseCents:null}:value.accounting});
  }
  async function checkout(actor,body) {
    const email=actorEmail(actor);exactFields(body,["quoteId","idempotencyKey","paymentToken","consent"]);
    id(body.quoteId);key(body.idempotencyKey);if(body.consent!==true)throw new PaymentError("Confirm the total price before paying.");token(body.paymentToken);
    const binding=await enabled("charge",{actor}),quoteRecord=await read(quotePath(email,body.quoteId)),q=quoteRecord?.value;
    if(!q||q.customerEmail!==email)throw new PaymentError("This quote was not found.",404);
    if(!sameBinding(q.merchantBinding,binding))throw conflict();
    await guardLegacyProductionOrder(q);
    const orderId=paymentOrderId(q),path=orderPath(orderId),existing=await read(path);
    if(existing) {
      if(existing.value.customerEmail!==email||existing.value.checkoutKeyHash!==digest(body.idempotencyKey)||existing.value.quoteId!==q.id)throw conflict();
      return publicOrder(existing.value);
    }
    if(Date.parse(q.expiresAt)<=now())throw new PaymentError("This quote expired. Request a new price.",409,"QUOTE_EXPIRED");
    let record=await save(path,null,{version:1,id:orderId,customerEmail:email,quoteId:q.id,preparedId:q.preparedId,
      filmId:q.filmId,filmTitle:q.filmTitle,manifestHash:q.manifestHash,quoteReference:q.quoteReference,quoteExpiresAt:q.expiresAt,currency:q.currency,amountCents:q.amountCents,
      provider:"quickbooks",merchantBinding:q.merchantBinding,providerCostEstimateCents:q.providerCostCents,pricingRevision:q.pricingRevision,
      pricingBasis:q.pricingBasis||"provider-quote",
      checkoutKeyHash:digest(body.idempotencyKey),chargeRequestId:randomUUID(),providerChargeId:null,status:"submitting",refundedCents:0,
      refunds:[],refundOperation:null,accounting:{status:"unmapped",events:[],settlementVerified:false,feesCents:null,providerExpenseCents:null},createdAt:stamp(now())});
    let result=null;
    try {result=await provider.charge(binding,{amountCents:q.amountCents,paymentToken:body.paymentToken,requestId:record.value.chargeRequestId});}
    catch(error) {if(error instanceof PaymentError&&error.diagnostic)result={diagnostic:error.diagnostic};}
    record=await storeCharge(record,result);
    return publicOrder(record.value);
  }
  async function order(actor,orderId) {return publicOrder((await readOrder(actor,orderId)).value);}
  async function reconcile(actor,{orderId}) {
    requireAdmin(actor);let record=await readOrder(actor,orderId),value=record.value;
    const binding=await enabled("read",{actor});if(!sameBinding(value.merchantBinding,binding))throw conflict();
    if(value.refundOperation) {
      const operation=value.refundOperation;
      if(!operation.providerRefundId)throw uncertain();
      let result;
      try{result=await provider.readRefund(binding,{chargeId:value.providerChargeId,refundId:operation.providerRefundId,amountCents:operation.amountCents});}
      catch(error){if(!(error instanceof PaymentError)||!error.diagnostic)throw error;result={diagnostic:error.diagnostic};}
      return publicOrder((await storeRefund(record,result)).value);
    }
    if(!["submitting","uncertain"].includes(value.status))return publicOrder(value);
    // No documented read-by-request-id contract has been established. Missing IDs
    // require provider/operator evidence; never guess an ID or replay the POST.
    if(!value.providerChargeId)throw uncertain();
    let result;
    try{result=await provider.readCharge(binding,{chargeId:value.providerChargeId,amountCents:value.amountCents});}
    catch(error){if(!(error instanceof PaymentError)||!error.diagnostic)throw error;result={diagnostic:error.diagnostic};}
    record=await storeCharge(record,result);return publicOrder(record.value);
  }
  async function storeRefund(record,result) {
    const value=record.value,operation=value.refundOperation;
    const issued=result?.verified===true&&typeof result.id==="string"&&providerIdPattern.test(result.id)&&result.status==="ISSUED"&&result.amountCents===operation.amountCents
      &&result.currency==="USD"&&(!operation.providerRefundId||operation.providerRefundId===result.id);
    const diagnostics=[...(value.diagnostics||[]),...(result?.diagnostic?[result.diagnostic]:[])].slice(-100);
    if(!issued)return save(orderPath(value.id),record,{...value,status:"refund-pending",diagnostics,refundOperation:{...operation,
      providerRefundId:operation.providerRefundId||(result?.id&&providerIdPattern.test(result.id)?result.id:null)}});
    const refundedCents=value.refundedCents+operation.amountCents;
    return save(orderPath(value.id),record,{...value,status:refundedCents===value.amountCents?"refunded":"partially-refunded",refundedCents,diagnostics,
      refunds:[...value.refunds,{...operation,providerRefundId:result.id,status:"issued",issuedAt:stamp(now())}],refundOperation:null,
      accounting:{...value.accounting,events:[...value.accounting.events,{id:operation.requestId,type:"customer-refund-issued",amountCents:operation.amountCents,at:stamp(now())}]}});
  }
  async function refund(actor,body) {
    requireAdmin(actor);exactFields(body,["orderId","amountCents","reason","idempotencyKey"]);key(body.idempotencyKey);
    if(!amountValid(body.amountCents)||typeof body.reason!=="string"||!body.reason.trim()||body.reason.length>500)throw new PaymentError("Enter a valid refund amount and reason.");
    let record=await readOrder(actor,body.orderId),value=record.value;
    const prior=value.refunds.find(item=>item.keyHash===digest(body.idempotencyKey));
    if(prior) {if(prior.amountCents!==body.amountCents||prior.reason!==body.reason.trim())throw conflict();return publicOrder(value);}
    if(value.refundOperation) {
      if(value.refundOperation.keyHash===digest(body.idempotencyKey)&&value.refundOperation.amountCents===body.amountCents&&value.refundOperation.reason===body.reason.trim())return publicOrder(value);
      throw uncertain();
    }
    if(!["captured","partially-refunded"].includes(value.status)||!value.providerChargeId||body.amountCents>value.amountCents-value.refundedCents||value.refunds.length>=50)
      throw new PaymentError("The refund must not exceed the confirmed unrefunded payment.");
    const binding=await enabled("refund",{actor});if(!sameBinding(value.merchantBinding,binding))throw conflict();
    record=await save(orderPath(value.id),record,{...value,status:"refund-pending",refundOperation:{keyHash:digest(body.idempotencyKey),requestId:randomUUID(),amountCents:body.amountCents,
      reason:body.reason.trim(),requestedBy:actor.email,requestedAt:stamp(now()),providerRefundId:null}});
    let result=null;
    try {result=await provider.refund(binding,{chargeId:value.providerChargeId,amountCents:body.amountCents,requestId:record.value.refundOperation.requestId});}
    catch(error) {if(error instanceof PaymentError&&error.diagnostic)result={diagnostic:error.diagnostic};}
    return publicOrder((await storeRefund(record,result)).value);
  }
  async function receipt(actor,orderId) {
    const value=(await readOrder(actor,orderId)).value;
    if(!value.capturedAt)throw new PaymentError("A receipt is available after the payment is confirmed.",409);
    return {receiptId:value.id,filmTitle:value.filmTitle,currency:value.currency,amountCents:value.amountCents,refundedCents:value.refundedCents,
      transactionId:typeof value.providerChargeId==="string"&&providerIdPattern.test(value.providerChargeId)?value.providerChargeId:null,
      processorDisclosure:"Payment is processed by: Intuit Payments Inc., 2700 Coast Avenue, Mountain View, CA 94043, Phone number 1-888-536-4801, NMLS #1098819",
      capturedAt:value.capturedAt,description:"Lineage Theatre film production",status:value.status,sandbox:isSandbox(value),
      notice:isSandbox(value)?"Sandbox test receipt. No live payment or bank settlement is represented.":"Payment captured. Film delivery is tracked separately."};
  }
  async function accountingExport(actor,orderId) {
    requireAdmin(actor);const value=(await readOrder(actor,orderId)).value;
    return {orderId:value.id,currency:value.currency,events:value.accounting.events,postingReady:false,mappingStatus:"unmapped",
      settlementVerified:false,feesCents:null,providerExpenseCents:null,providerCostEstimateCents:value.providerCostEstimateCents,sandbox:isSandbox(value)};
  }
  async function adminDiagnostics(actor,orderId) {
    requireAdmin(actor);const value=(await readOrder(actor,orderId)).value;
    return {orderId:value.id,diagnostics:value.diagnostics||[],chargeRequestId:value.chargeRequestId,
      refundRequestId:value.refundOperation?.requestId||null,requiresReview:publicOrder(value).requiresReview};
  }
  async function authorizeProduction({email,orderId,manifestHash,preparedId}) {
    const record=await read(orderPath(id(orderId))),value=record?.value;
    const captured=order=>order&&order.customerEmail===email&&order.manifestHash===manifestHash&&order.preparedId===preparedId&&order.status==="captured"
      &&order.capturedAt&&order.refundedCents===0&&!order.refundOperation&&bindingValid(order.merchantBinding);
    if(!captured(value))throw blocked();
    if(value.pricingBasis==="planning-rate") {
      if(typeof record.etag!=="string"||!amountValid(value.providerCostEstimateCents)
        ||!Number.isFinite(Date.parse(value.capturedAt))||Date.parse(value.capturedAt)>now())throw blocked();
      const binding=await enabled("render",{subjectEmail:email});if(!sameBinding(value.merchantBinding,binding))throw blocked();
      const quoteValid=fresh=>fresh&&fresh.preparedId===preparedId&&fresh.manifestHash===manifestHash&&fresh.environment===binding.environment&&fresh.currency==="USD"
        &&fresh.apiVerified===true&&fresh.qualityVerified===true&&fresh.commercialTermsVerified===true
        &&Number.isSafeInteger(fresh.providerCostCents)&&fresh.providerCostCents>=0&&fresh.providerCostCents<=value.providerCostEstimateCents
        &&Number.isSafeInteger(fresh.maximumCostCents)&&fresh.maximumCostCents>=fresh.providerCostCents&&fresh.maximumCostCents<=value.providerCostEstimateCents
        &&typeof fresh.quoteReference==="string"&&fresh.quoteReference.trim()&&fresh.quoteReference.length<=200
        &&typeof fresh.expiresAt==="string"&&Number.isFinite(Date.parse(fresh.expiresAt));
      let fresh=value.fulfillmentQuote,authorizedRecord=record;
      if(fresh&&!quoteValid(fresh))throw blocked();
      if(!fresh||Date.parse(fresh.expiresAt)<=now()) {
        const productionQuote=overrides.productionQuote||((input)=>import("./film-production.mjs").then(module=>module.filmProduction.quoteForProductionBudget(input)));
        fresh=await productionQuote({email,preparedId,manifestHash,environment:binding.environment,budgetCents:value.providerCostEstimateCents});
        if(!quoteValid(fresh)||Date.parse(fresh.expiresAt)<=now())throw blocked();
        const checkedBinding=await enabled("render",{subjectEmail:email});
        const checked=await read(orderPath(orderId));
        if(!sameBinding(binding,checkedBinding)||checked?.etag!==record.etag||!captured(checked?.value)
          ||!sameBinding(checked.value.merchantBinding,checkedBinding)||Date.parse(fresh.expiresAt)<=now())throw blocked();
        // All later shots must use this same actual full-film quote. The film
        // helper refuses fresh whole-film quotes after any shot has started.
        const fulfillmentQuote=Object.fromEntries(["preparedId","manifestHash","environment","currency","providerCostCents","maximumCostCents",
          "quoteReference","expiresAt","apiVerified","qualityVerified","commercialTermsVerified"].map(field=>[field,fresh[field]]));
        authorizedRecord=await save(orderPath(orderId),record,{...value,fulfillmentQuote});
      }
      const until=Date.parse(fresh.expiresAt);
      // Recheck the current grant and captured order after the provider await:
      // a refund or merchant reconnect must revoke this fresh spending grant.
      const currentBinding=await enabled("render",{subjectEmail:email});
      const current=await read(orderPath(orderId));
      if(!sameBinding(binding,currentBinding)||current?.etag!==authorizedRecord.etag||!captured(current?.value)
        ||!sameBinding(current.value.merchantBinding,currentBinding)||until<=now())throw blocked();
      return {allowed:true,manifestHash,budgetCents:fresh.maximumCostCents,quoteReference:fresh.quoteReference,
        expiresAt:stamp(Math.min(until,now()+60_000)),environment:binding.environment,fictionalOnly:binding.environment==="sandbox"};
    }
    if(!Number.isFinite(Date.parse(value.quoteExpiresAt))||Date.parse(value.quoteExpiresAt)<=now())throw blocked();
    const binding=await enabled("render",{subjectEmail:email});if(!sameBinding(value.merchantBinding,binding))throw blocked();
    return {allowed:true,manifestHash,budgetCents:value.providerCostEstimateCents,quoteReference:value.quoteReference,
      expiresAt:stamp(Math.min(Date.parse(value.quoteExpiresAt),now()+60_000)),environment:binding.environment,fictionalOnly:binding.environment==="sandbox"};
  }
  return {checkoutConfiguration,prepareCheckout,quote,checkout,order,reconcile,refund,receipt,accountingExport,adminDiagnostics,authorizeProduction};
}
export const payments=createPaymentsService();
