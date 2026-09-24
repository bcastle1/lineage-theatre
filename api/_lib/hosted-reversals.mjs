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
function unavailable() {const error=new Error("Recorded payment reversals could not be verified.");error.code="HOSTED_REVERSALS_UNVERIFIED";error.status=503;return error;}
function reference(value) {if(!plain(value)||!id(value.value))throw unavailable();return value.value;}
function linked(value,context) {
  if(value===undefined)return false;
  if(!Array.isArray(value)||value.length>1000)throw unavailable();
  return value.some(link=>{
    if(!plain(link)||!id(link.TxnId)||typeof link.TxnType!=="string"||!link.TxnType||link.TxnType.length>100)throw unavailable();
    return link.TxnType==="Invoice"&&link.TxnId===context.invoiceId||link.TxnType==="Payment"&&context.paymentIds.includes(link.TxnId);
  });
}
function lines(value) {if(!Array.isArray(value)||value.length>1000)throw unavailable();return value;}
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
    customer=reference(value.CustomerRef);if(cents(value.TotalAmt)===null)throw unavailable();
  }
  if(entity==="Purchase") {
    payee=value.EntityRef===undefined?null:reference(value.EntityRef);
    for(const line of rows) {
      if(!plain(line)||!["AccountBasedExpenseLineDetail","ItemBasedExpenseLineDetail","DescriptionOnly"].includes(line.DetailType))throw unavailable();
      const detail=line[line.DetailType];
      if(line.DetailType!=="DescriptionOnly"&&!plain(detail))throw unavailable();
      if(detail?.CustomerRef!==undefined&&reference(detail.CustomerRef)===context.customerId)customerLine=true;
    }
  }
  if(entity==="JournalEntry")for(const line of rows) {
    if(!plain(line)||line.DetailType!=="JournalEntryLineDetail"||!plain(line.JournalEntryLineDetail))throw unavailable();
    const party=line.JournalEntryLineDetail.Entity;
    if(party!==undefined&&(!plain(party)||!["Customer","Vendor","Employee"].includes(party.Type)||!id(party.EntityRef?.value)))throw unavailable();
  }
  if(entity==="Deposit")for(const line of rows) {
    if(!plain(line)||cents(line.Amount)===null)throw unavailable();
    if(line.DetailType===undefined&&line.DepositLineDetail===undefined&&Array.isArray(line.LinkedTxn)&&line.LinkedTxn.length
      &&line.LinkedTxn.every(link=>["Payment","SalesReceipt"].includes(link.TxnType)))continue;
    if(line.DetailType!=="DepositLineDetail"||!plain(line.DepositLineDetail))throw unavailable();
    if(line.DepositLineDetail.Entity!==undefined)reference(line.DepositLineDetail.Entity);
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
      if(amount===null)throw unavailable();
      const detail=line.DepositLineDetail,party=detail?.Entity;
      if(party!==undefined)reference(party);
      if(amount<0&&(party?.value===context.customerId||party===undefined||direct||linked(line.LinkedTxn,context)))return true;
    }
    return false;
  }
  return false;
}
function paymentAllocation(value,context) {
  if(reference(value.CustomerRef)!==context.customerId||value.CurrencyRef?.value!==context.currency)throw unavailable();
  const total=cents(value.TotalAmt);
  if(total===null||total<0)throw unavailable();
  const rows=lines(value.Line);
  let allocated=0;
  for(const line of rows) {
    if(!plain(line)||!Array.isArray(line.LinkedTxn)||!line.LinkedTxn.length)throw unavailable();
    // Credits, refund expenses/checks, journals and credit-card credits can be
    // associated through a separate zero-total Payment, so inspect every
    // Payment for this customer, not just the invoice's original payment IDs.
    for(const link of line.LinkedTxn)if(!id(link?.TxnId)||link.TxnType!=="Invoice")throw unavailable();
    const amount=cents(line.Amount);if(amount===null||amount<=0)throw unavailable();
    if(line.LinkedTxn.some(link=>link.TxnId===context.invoiceId)) {
      if(line.LinkedTxn.length!==1||!context.paymentIds.includes(value.Id))throw unavailable();
      allocated+=amount;
    }
  }
  if(allocated>total||context.paymentIds.includes(value.Id)&&allocated<=0)throw unavailable();
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
      ||!Number.isFinite(saleTime)||saleTime>start||typeof transport?.request!=="function"||typeof transport?.binding!=="function")throw unavailable();
    const binding={environment:context.environment,grantId:context.grantId,realmId:context.realmId};
    let consumed=0;
    async function current() {if(now()-start>=MAX_TIME||!bindingEqual(binding,await transport.binding({allowRefresh:false})))throw unavailable();}
    async function readBody(response) {
      if(response?.status!==200||typeof response.body?.getReader!=="function") {
        await response?.body?.cancel?.().catch(()=>{});throw unavailable();
      }
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try {
        for(;;) {
          const remaining=start+MAX_TIME-now();if(remaining<=0)throw unavailable();
          let timer;
          const part=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),remaining);})]).finally(()=>clearTimeout(timer));
          if(part.done)break;
          if(!(part.value instanceof Uint8Array))throw unavailable();
          bytes+=part.value.byteLength;consumed+=part.value.byteLength;
          if(bytes>1_048_576||consumed>MAX_BYTES||now()-start>=MAX_TIME)throw unavailable();
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
          let data;try {data=JSON.parse(raw);}catch{throw unavailable();}
          const query=data?.QueryResponse;
          if(!plain(query)||data.Fault||Object.keys(query).some(key=>![entity,"startPosition","maxResults","totalCount"].includes(key)))throw unavailable();
          const records=Object.hasOwn(query,entity)?query[entity]:[];
          if(!Array.isArray(records)||records.length>PAGE||query.startPosition!==undefined&&query.startPosition!==position
            ||query.maxResults!==undefined&&query.maxResults!==records.length)throw unavailable();
          for(const value of records) {
            const entry=identity(entity,value,now());
            if(seen.has(entry.id)||seen.size>=MAX_RECORDS)throw unavailable();
            seen.add(entry.id);evidence.push(entry);
            if(entity==="Payment") {
              if(instant(value.MetaData.LastUpdatedTime)<saleTime&&!context.paymentIds.includes(value.Id))continue;
              allocated+=paymentAllocation(value,context);
              if(context.paymentIds.includes(value.Id))foundPayments.add(value.Id);
            }else if(relevantReversal(entity,value,context,saleTime))throw unavailable();
          }
          position+=records.length;finished=records.length<PAGE;
          if(query.totalCount!==undefined&&(!Number.isSafeInteger(query.totalCount)||query.totalCount<seen.size||finished&&query.totalCount!==seen.size))throw unavailable();
        }
      }
      if(foundPayments.size!==context.paymentIds.length||allocated!==context.amountCents)throw unavailable();
      await current();
      return evidence.sort((a,b)=>`${a.entity}:${a.id}`.localeCompare(`${b.entity}:${b.id}`));
    }
    await current();const first=await scan(),second=await scan();
    if(JSON.stringify(first)!==JSON.stringify(second))throw unavailable();
    await current();
    return {...structuredClone(context),version:1,outcome:"clear",scope:HOSTED_REVERSAL_SCOPE,
      evidenceHash:digest(JSON.stringify({scope:HOSTED_REVERSAL_SCOPE,context,records:second})),checkedAt:new Date(now()).toISOString(),
      expiresAt:new Date(Math.min(start+60_000,now()+15_000)).toISOString()};
  };
}
