import {digest} from "./auth.mjs";

// Recorded Accounting evidence only: this is not processor/bank settlement or
// proof that an out-of-system refund was recorded. Supported query/pagination:
// https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/docs/_sources/quickstart.rst.txt
// Payment linkage: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Payment
// Purchase.EntityRef: https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/00fa13c7-5af6-952f-853a-f3ae84f21ecf.htm
export const HOSTED_REVERSAL_SCOPE="quickbooks-accounting-recorded-reversals";
const ENTITIES=["RefundReceipt","CreditMemo","Purchase","JournalEntry","Deposit","Payment"];
const PAGE=100,MAX_RECORDS=1000,MAX_BYTES=8*1024*1024,MAX_TIME=45_000;
const id=value=>typeof value==="string"&&/^[0-9]{1,30}$/.test(value);
const hash=value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const plain=value=>Boolean(value&&typeof value==="object"&&!Array.isArray(value));
const cents=value=>typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1_000_000
  &&Math.abs(value*100-Math.round(value*100))<0.0000001?Math.round(value*100):null;
const instant=value=>typeof value==="string"&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const bindingEqual=(a,b)=>a&&b&&a.environment===b.environment&&a.grantId===b.grantId&&a.realmId===b.realmId;
// Fixed diagnostic reasons never contain transaction data or provider responses.
const REASONS=new Set([
  "RECORD_INVALID","REFERENCE_INVALID","LINKS_INVALID","LINK_INVALID","LINES_INVALID","REVERSAL_AMOUNT_INVALID",
  "PURCHASE_LINE_INVALID","PURCHASE_DETAIL_INVALID","JOURNAL_LINE_INVALID","JOURNAL_PARTY_INVALID",
  "DEPOSIT_LINE_INVALID","DEPOSIT_DETAIL_INVALID","DEPOSIT_AMOUNT_INVALID","PAYMENT_CONTEXT_MISMATCH",
  "PAYMENT_AMOUNT_INVALID","PAYMENT_LINE_INVALID","PAYMENT_LINK_UNSUPPORTED","PAYMENT_ALLOCATION_INVALID",
  "PAYMENT_LINK_MISMATCH","PAYMENT_ALLOCATION_MISMATCH","CONTEXT_INVALID","SCAN_TIME_LIMIT","BINDING_CHANGED",
  "QUERY_RESPONSE_UNAVAILABLE","QUERY_BODY_INVALID","SCAN_BYTE_LIMIT","QUERY_JSON_INVALID","QUERY_ENVELOPE_INVALID",
  "QUERY_PAGE_INVALID","QUERY_COUNT_INVALID","QUERY_DUPLICATE_RECORD","SCAN_RECORD_LIMIT",
  "REVERSAL_REQUIRES_REVIEW","SALE_ALLOCATION_MISMATCH","SCAN_CHANGED",
]);
export const hostedReversalReason=value=>REASONS.has(value)?value:null;
function unavailable(reason="RECORD_INVALID") {const error=new Error("Recorded payment reversals could not be verified.");error.code="HOSTED_REVERSALS_UNVERIFIED";error.status=503;error.reason=hostedReversalReason(reason)||"RECORD_INVALID";return error;}
function reference(value) {if(!plain(value)||!id(value.value))throw unavailable("REFERENCE_INVALID");return value.value;}
function linked(value,context) {
  if(value===undefined)return false;
  if(!Array.isArray(value)||value.length>1000)throw unavailable("LINKS_INVALID");
  return value.some(link=>{
    if(!plain(link)||!id(link.TxnId)||typeof link.TxnType!=="string"||!link.TxnType||link.TxnType.length>100)throw unavailable("LINK_INVALID");
    return link.TxnType==="Invoice"&&link.TxnId===context.invoiceId||link.TxnType==="Payment"&&context.paymentIds.includes(link.TxnId);
  });
}
function lines(value) {if(!Array.isArray(value)||value.length>1000)throw unavailable("LINES_INVALID");return value;}
function identity(entity,value,now) {
  const created=instant(value?.MetaData?.CreateTime),updated=instant(value?.MetaData?.LastUpdatedTime);
  if(!plain(value)||!id(value.Id)||!id(value.SyncToken)||value.sparse===true||!Number.isFinite(created)||!Number.isFinite(updated)
    ||created>updated||updated>now||!Array.isArray(value.Line))throw unavailable();
  return {entity,id:value.Id,updated,sha256:digest(JSON.stringify(value))};
}
function relevantReversal(entity,value,context,saleTime) {
  const rows=lines(value.Line),direct=linked(value.LinkedTxn,context)||rows.some(line=>linked(line?.LinkedTxn,context));
  let customer=null,payee=null,customerLine=false;
  if(entity==="RefundReceipt"||entity==="CreditMemo") {
    customer=reference(value.CustomerRef);if(cents(value.TotalAmt)===null)throw unavailable("REVERSAL_AMOUNT_INVALID");
  }
  if(entity==="Purchase") {
    payee=value.EntityRef===undefined?null:reference(value.EntityRef);
    for(const line of rows) {
      if(!plain(line)||!["AccountBasedExpenseLineDetail","ItemBasedExpenseLineDetail","DescriptionOnly"].includes(line.DetailType))throw unavailable("PURCHASE_LINE_INVALID");
      const detail=line[line.DetailType];
      if(line.DetailType!=="DescriptionOnly"&&!plain(detail))throw unavailable("PURCHASE_DETAIL_INVALID");
      if(detail?.CustomerRef!==undefined&&reference(detail.CustomerRef)===context.customerId)customerLine=true;
    }
  }
  if(entity==="JournalEntry")for(const line of rows) {
    if(!plain(line)||line.DetailType!=="JournalEntryLineDetail"||!plain(line.JournalEntryLineDetail))throw unavailable("JOURNAL_LINE_INVALID");
    const party=line.JournalEntryLineDetail.Entity;
    if(party!==undefined&&(!plain(party)||!["Customer","Vendor","Employee"].includes(party.Type)||!id(party.EntityRef?.value)))throw unavailable("JOURNAL_PARTY_INVALID");
  }
  if(entity==="Deposit")for(const line of rows) {
    if(!plain(line)||cents(line.Amount)===null)throw unavailable("DEPOSIT_LINE_INVALID");
    const detail=line.DepositLineDetail;
    // Linked payment deposits can carry optional detail metadata without DetailType.
    // https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/Line.html
    const linkedPayment=line.DetailType===undefined&&Array.isArray(line.LinkedTxn)&&line.LinkedTxn.length>0&&line.LinkedTxn.length<=1000
      &&line.LinkedTxn.every(link=>plain(link)&&id(link.TxnId)&&["Payment","SalesReceipt"].includes(link.TxnType));
    if(linkedPayment) {
      if(detail!==undefined&&!plain(detail))throw unavailable("DEPOSIT_DETAIL_INVALID");
      for(const key of ["PaymentMethodRef","AccountRef","ClassRef"])if(detail?.[key]!==undefined)reference(detail[key]);
    }else if(line.DetailType!=="DepositLineDetail"||!plain(detail))throw unavailable("DEPOSIT_DETAIL_INVALID");
    if(detail?.Entity!==undefined)reference(detail.Entity);
  }
  // Server-generated LastUpdatedTime predating order creation is reliable
  // chronology; a user-editable TxnDate or equal amount is not.
  if(instant(value.MetaData.LastUpdatedTime)<saleTime&&!direct)return false;
  if(entity==="RefundReceipt"||entity==="CreditMemo") {
    if(customer!==context.customerId&&!direct)return false;
    const amount=cents(value.TotalAmt);
    return amount!==0||direct;
  }
  if(entity==="Purchase") {
    // A payment with no identifiable payee cannot be excluded as unrelated.
    if(direct||payee===context.customerId||customerLine||payee===null)return true;
    return false;
  }
  if(entity==="JournalEntry") {
    for(const line of rows) {
      const party=line.JournalEntryLineDetail.Entity;
      if(party?.Type==="Customer"&&reference(party.EntityRef)===context.customerId)return true;
    }
    return direct;
  }
  if(entity==="Deposit") {
    for(const line of rows) {
      const amount=cents(line?.Amount);
      if(amount===null)throw unavailable("DEPOSIT_AMOUNT_INVALID");
      const detail=line.DepositLineDetail,party=detail?.Entity;
      if(party!==undefined)reference(party);
      if(amount<0&&(party?.value===context.customerId||party===undefined||direct||linked(line.LinkedTxn,context)))return true;
    }
    return false;
  }
  return false;
}
function paymentAllocation(value,context) {
  if(reference(value.CustomerRef)!==context.customerId||value.CurrencyRef?.value!==context.currency)throw unavailable("PAYMENT_CONTEXT_MISMATCH");
  const total=cents(value.TotalAmt);
  if(total===null||total<0)throw unavailable("PAYMENT_AMOUNT_INVALID");
  const rows=lines(value.Line);
  let allocated=0;
  for(const line of rows) {
    if(!plain(line)||!Array.isArray(line.LinkedTxn)||!line.LinkedTxn.length)throw unavailable("PAYMENT_LINE_INVALID");
    // Credits, refund expenses/checks, journals and credit-card credits can be
    // associated through a separate zero-total Payment, so inspect every
    // Payment for this customer, not just the invoice's original payment IDs.
    for(const link of line.LinkedTxn)if(!id(link?.TxnId)||link.TxnType!=="Invoice")throw unavailable("PAYMENT_LINK_UNSUPPORTED");
    const amount=cents(line.Amount);if(amount===null||amount<=0)throw unavailable("PAYMENT_ALLOCATION_INVALID");
    if(line.LinkedTxn.some(link=>link.TxnId===context.invoiceId)) {
      if(line.LinkedTxn.length!==1||!context.paymentIds.includes(value.Id))throw unavailable("PAYMENT_LINK_MISMATCH");
      allocated+=amount;
    }
  }
  if(allocated>total||context.paymentIds.includes(value.Id)&&allocated<=0)throw unavailable("PAYMENT_ALLOCATION_MISMATCH");
  return allocated;
}

export function createHostedReversalVerifier({transport,now=Date.now}={}) {
  return async function verifyReversals(context) {
    const start=now(),saleTime=instant(context?.saleCreatedAt);
    if(!plain(context)||!hash(context.orderId)||!["production","sandbox"].includes(context.environment)||!hash(context.grantId)
      ||![context.realmId,context.customerId,context.invoiceId].every(id)||context.currency!=="USD"
      ||!Number.isSafeInteger(context.amountCents)||context.amountCents<=0||context.amountCents>100_000_000
      ||!Array.isArray(context.paymentIds)||!context.paymentIds.length||context.paymentIds.length>100
      ||!context.paymentIds.every(id)||new Set(context.paymentIds).size!==context.paymentIds.length
      ||!Number.isFinite(saleTime)||saleTime>start||typeof transport?.request!=="function"||typeof transport?.binding!=="function")throw unavailable("CONTEXT_INVALID");
    const binding={environment:context.environment,grantId:context.grantId,realmId:context.realmId};
    let consumed=0;
    async function current() {
      if(now()-start>=MAX_TIME)throw unavailable("SCAN_TIME_LIMIT");
      if(!bindingEqual(binding,await transport.binding({allowRefresh:false})))throw unavailable("BINDING_CHANGED");
    }
    async function readBody(response) {
      if(response?.status!==200||typeof response.body?.getReader!=="function") {
        await response?.body?.cancel?.().catch(()=>{});throw unavailable("QUERY_RESPONSE_UNAVAILABLE");
      }
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try {
        for(;;) {
          const remaining=start+MAX_TIME-now();if(remaining<=0)throw unavailable("SCAN_TIME_LIMIT");
          let timer;
          const part=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(unavailable("SCAN_TIME_LIMIT")),remaining);})]).finally(()=>clearTimeout(timer));
          if(part.done)break;
          if(!(part.value instanceof Uint8Array))throw unavailable("QUERY_BODY_INVALID");
          bytes+=part.value.byteLength;consumed+=part.value.byteLength;
          if(bytes>1_048_576||consumed>MAX_BYTES)throw unavailable("SCAN_BYTE_LIMIT");
          if(now()-start>=MAX_TIME)throw unavailable("SCAN_TIME_LIMIT");
          chunks.push(part.value);
        }
        return Buffer.concat(chunks,bytes).toString("utf8");
      }finally {await reader.cancel().catch(()=>{});}
    }
    async function scan() {
      const evidence=[];let allocated=0;const foundPayments=new Set();
      for(const entity of ENTITIES) {
        const seen=new Set();let position=1,finished=false;
        while(!finished) {
          await current();
          const response=await transport.request(binding,{method:"GET",path:"/query",query:{entity,startPosition:position,maxResults:PAGE,
            ...(entity==="Payment"?{where:{field:"CustomerRef",value:context.customerId}}:{})}});
          const raw=await readBody(response);
          let data;try {data=JSON.parse(raw);}catch{throw unavailable("QUERY_JSON_INVALID");}
          const query=data?.QueryResponse;
          if(!plain(query)||data.Fault||Object.keys(query).some(key=>![entity,"startPosition","maxResults","totalCount"].includes(key)))throw unavailable("QUERY_ENVELOPE_INVALID");
          const records=Object.hasOwn(query,entity)?query[entity]:[];
          if(!Array.isArray(records)||records.length>PAGE||query.startPosition!==undefined&&query.startPosition!==position
            ||query.maxResults!==undefined&&query.maxResults!==records.length)throw unavailable("QUERY_PAGE_INVALID");
          // SELECT * reports the count returned in this page; an overall count
          // requires a separate SELECT COUNT(*). Completeness comes from paging
          // to exhaustion, not from treating this metadata as a global total.
          // https://intuit.github.io/QuickBooks-V3-PHP-SDK/quickstart.html#count
          if(query.totalCount!==undefined&&(!Number.isSafeInteger(query.totalCount)||query.totalCount!==records.length))throw unavailable("QUERY_COUNT_INVALID");
          for(const value of records) {
            const entry=identity(entity,value,now());
            if(seen.has(entry.id))throw unavailable("QUERY_DUPLICATE_RECORD");
            if(seen.size>=MAX_RECORDS)throw unavailable("SCAN_RECORD_LIMIT");
            seen.add(entry.id);evidence.push(entry);
            if(entity==="Payment") {
              if(instant(value.MetaData.LastUpdatedTime)<saleTime&&!context.paymentIds.includes(value.Id))continue;
              allocated+=paymentAllocation(value,context);
              if(context.paymentIds.includes(value.Id))foundPayments.add(value.Id);
            }else if(relevantReversal(entity,value,context,saleTime))throw unavailable("REVERSAL_REQUIRES_REVIEW");
          }
          position+=records.length;finished=records.length<PAGE;
        }
      }
      if(foundPayments.size!==context.paymentIds.length||allocated!==context.amountCents)throw unavailable("SALE_ALLOCATION_MISMATCH");
      await current();
      return evidence.sort((a,b)=>`${a.entity}:${a.id}`.localeCompare(`${b.entity}:${b.id}`));
    }
    await current();const first=await scan(),second=await scan();
    if(JSON.stringify(first)!==JSON.stringify(second))throw unavailable("SCAN_CHANGED");
    await current();
    return {...structuredClone(context),version:1,outcome:"clear",scope:HOSTED_REVERSAL_SCOPE,
      evidenceHash:digest(JSON.stringify({scope:HOSTED_REVERSAL_SCOPE,context,records:second})),checkedAt:new Date(now()).toISOString(),
      expiresAt:new Date(Math.min(start+60_000,now()+15_000)).toISOString()};
  };
}
