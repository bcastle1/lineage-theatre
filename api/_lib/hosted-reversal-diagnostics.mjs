import {readRecord} from "./auth.mjs";
import {createQuickBooksAccountingTransport,createQuickBooksService} from "./quickbooks.mjs";
import {createHostedReversalVerifier,HOSTED_REVERSAL_SCOPE} from "./hosted-reversals.mjs";

const HEX=/^[a-f0-9]{64}$/,ID=/^[0-9]{1,30}$/;
const ENTITIES=new Set(["RefundReceipt","CreditMemo","Purchase","JournalEntry","Deposit","Payment"]);
const CODES=new Set(["ORDER_INVALID","ORDER_CHANGED","ACCOUNTING_COMPANY_MISMATCH","ACCOUNTING_BINDING_CHANGED",
  "ACCOUNTING_CONNECTION_UNAVAILABLE","ACCOUNTING_REQUEST_UNCERTAIN","QUICKBOOKS_SETUP_REQUIRED","QUICKBOOKS_BUSY",
  "QUICKBOOKS_REFRESH_BLOCKED","QUICKBOOKS_REFRESH_EXPIRED","QUICKBOOKS_REFRESH_FAILED","QUICKBOOKS_REFRESH_UNCERTAIN",
  "QUICKBOOKS_CONFIGURATION_CHANGED","HOSTED_REVERSALS_UNVERIFIED","CHECK_TIMED_OUT"]);
const fail=code=>{const error=new Error("Recorded reversal acceptance could not be completed.");error.code=code;throw error;};
const amount=value=>Number.isSafeInteger(value)&&value>0&&value<=100_000_000;
const id=value=>typeof value==="string"&&ID.test(value);
const validBinding=value=>value&&["production","sandbox"].includes(value.environment)&&typeof value.grantId==="string"&&HEX.test(value.grantId)&&id(value.realmId);
const sameBinding=(a,b)=>validBinding(a)&&validBinding(b)&&a.environment===b.environment&&a.realmId===b.realmId&&a.grantId===b.grantId;

function paidOrder(record,orderId,now) {
  const value=record?.value,time=value=>typeof value==="string"&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now;
  if(typeof record?.etag!=="string"||!record.etag||value?.version!==1||value.id!==orderId||value.provider!=="quickbooks"
    ||value.checkoutMethod!=="quickbooks-hosted-invoice"||value.confirmationSource!=="quickbooks-accounting"||value.status!=="captured"
    ||!time(value.createdAt)||!time(value.capturedAt)||Date.parse(value.capturedAt)<Date.parse(value.createdAt)
    ||!time(value.accountingCheckedAt)||!validBinding(value.merchantBinding)||value.currency!=="USD"||!amount(value.amountCents)
    ||!id(value.customerId)||!id(value.invoiceId)||value.balanceCents!==0||value.refundedCents!==0
    ||value.refundOperation||value.checkOperation||value.refunds&&(!Array.isArray(value.refunds)||value.refunds.length)
    ||value.lastCheckStage!=="complete"||value.lastCheckFailureReason!==null
    ||!Array.isArray(value.paymentIds)||!value.paymentIds.length||value.paymentIds.length>100||!value.paymentIds.every(id)
    ||new Set(value.paymentIds).size!==value.paymentIds.length||!Array.isArray(value.accountingPayments)
    ||value.accountingPayments.length!==value.paymentIds.length
    ||!value.accountingPayments.every((payment,index)=>payment?.id===value.paymentIds[index]&&amount(payment.allocatedCents))
    ||value.accountingPayments.reduce((total,payment)=>total+payment.allocatedCents,0)!==value.amountCents)fail("ORDER_INVALID");
  return value;
}

// Server/operator diagnostic only. The caller must authorize an administrator;
// this never grants production, changes an order, or proves bank settlement.
// The sole permitted write side effect is the existing serialized OAuth refresh
// and its audit records. Accounting requests are restricted to verifier queries.
export async function checkHostedReversals({orderId,read=readRecord,transport,now=Date.now,env=process.env}={}) {
  const totals={accountingReads:0,paymentCount:0,amountCents:0};
  const result=(verified,code)=>({recordedReversalsVerified:verified,productionReady:false,scope:HOSTED_REVERSAL_SCOPE,code,totals:{...totals}});
  const end=now()+50_000,controller=new AbortController();
  let expired=false;
  const remaining=()=>{const value=end-now();if(expired||value<=0)fail("CHECK_TIMED_OUT");return value;};
  async function bounded(operation) {
    const limit=remaining();let timer;
    try {
      const value=await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
        timer=setTimeout(()=>{expired=true;controller.abort();const error=new Error("Diagnostic deadline reached.");error.code="CHECK_TIMED_OUT";reject(error);},limit);
      })]);
      remaining();return value;
    }finally {clearTimeout(timer);}
  }
  const boundedRead=path=>bounded(()=>read(path));
  try {
    if(typeof orderId!=="string"||!HEX.test(orderId))fail("ORDER_INVALID");
    const path=`payments/orders/${orderId}.json`,record=await boundedRead(path),order=paidOrder(record,orderId,now());
    totals.paymentCount=order.paymentIds.length;totals.amountCents=order.amountCents;
    if(!transport) {
      const fetchImpl=(url,options={})=>fetch(url,{...options,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(remaining()),...(options.signal?[options.signal]:[])])});
      const connection=createQuickBooksService({read:boundedRead,fetchImpl,env,now});
      transport=createQuickBooksAccountingTransport({read:boundedRead,fetchImpl,env,now,connection});
    }
    // A normal refresh preserves the existing grant. Reconnection is never an
    // automatic diagnostic action, and another company cannot be queried.
    const binding=await bounded(()=>transport.binding({allowRefresh:true}));
    if(!validBinding(binding)||binding.environment!==order.merchantBinding.environment||binding.realmId!==order.merchantBinding.realmId)
      fail("ACCOUNTING_COMPANY_MISMATCH");
    const guarded={binding:()=>bounded(()=>transport.binding({allowRefresh:false})),request:(expected,operation)=>bounded(()=>{
      if(!sameBinding(expected,binding)||operation?.method!=="GET"||operation.path!=="/query"||!ENTITIES.has(operation.query?.entity)
        ||operation.body!==undefined||operation.requestId!==undefined)fail("HOSTED_REVERSALS_UNVERIFIED");
      totals.accountingReads++;return transport.request(expected,operation);
    })};
    const context={orderId,environment:binding.environment,grantId:binding.grantId,realmId:binding.realmId,
      customerId:order.customerId,invoiceId:order.invoiceId,currency:order.currency,amountCents:order.amountCents,
      paymentIds:[...order.paymentIds],saleCreatedAt:order.createdAt};
    const proof=await bounded(()=>createHostedReversalVerifier({transport:guarded,now})(context));
    if(!sameBinding(binding,await guarded.binding()))fail("ACCOUNTING_BINDING_CHANGED");
    // A refund/check edit can land while the connection recheck awaits storage.
    // Read the order after that final await before reporting acceptance.
    const current=await boundedRead(path);
    if(current?.etag!==record.etag)fail("ORDER_CHANGED");
    paidOrder(current,orderId,now());
    if(proof.outcome!=="clear"||proof.scope!==HOSTED_REVERSAL_SCOPE||Date.parse(proof.expiresAt)<=now())fail("HOSTED_REVERSALS_UNVERIFIED");
    return result(true,"RECORDED_REVERSALS_VERIFIED");
  }catch(error) {
    return result(false,expired||now()>=end?"CHECK_TIMED_OUT":CODES.has(error?.code)?error.code:"RECORDED_REVERSAL_CHECK_FAILED");
  }finally {controller.abort();}
}
