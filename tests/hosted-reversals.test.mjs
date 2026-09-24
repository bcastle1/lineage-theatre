import test from "node:test";
import assert from "node:assert/strict";
import {createHostedReversalVerifier,HOSTED_REVERSAL_SCOPE} from "../api/_lib/hosted-reversals.mjs";
import {digest} from "../api/_lib/auth.mjs";

const NOW=Date.parse("2026-09-23T18:00:00Z"),SALE=NOW-3600_000;
const context={orderId:digest("synthetic-paid-film"),environment:"production",grantId:"a".repeat(64),realmId:"1234",customerId:"20",invoiceId:"30",
  currency:"USD",amountCents:450,paymentIds:["40"],saleCreatedAt:new Date(SALE).toISOString()};
const metadata=(updated=NOW-1000)=>({CreateTime:new Date(Math.min(SALE-1000,updated)).toISOString(),LastUpdatedTime:new Date(updated).toISOString()});
const record=(Id,extra={})=>({Id,SyncToken:"0",MetaData:metadata(),Line:[],...extra});
const payment=()=>record("40",{CustomerRef:{value:"20"},CurrencyRef:{value:"USD"},TotalAmt:4.5,
  Line:[{Amount:4.5,LinkedTxn:[{TxnType:"Invoice",TxnId:"30"}]}]});
function fixture(options={}) {
  let time=NOW,binding={environment:context.environment,grantId:context.grantId,realmId:context.realmId},effect;
  const records={RefundReceipt:[],CreditMemo:[],Purchase:[],JournalEntry:[],Deposit:[],Payment:[payment()],...options.records};
  const calls=[];
  const transport={binding:async()=>structuredClone(binding),request:async(expected,operation)=>{
    assert.deepEqual(expected,binding);assert.equal(operation.method,"GET");assert.equal(operation.path,"/query");calls.push(structuredClone(operation));
    const {entity,startPosition,maxResults}=operation.query;
    if(entity==="Payment")assert.deepEqual(operation.query.where,{field:"CustomerRef",value:context.customerId});
    else assert.equal(operation.query.where,undefined);
    const override=await effect?.(operation,calls.length);if(override)return override;
    const entries=records[entity].slice(startPosition-1,startPosition-1+maxResults);
    return new Response(JSON.stringify({QueryResponse:entries.length?{[entity]:entries,startPosition,maxResults:entries.length}:{}}));
  }};
  return {records,calls,verify:createHostedReversalVerifier({transport,now:()=>time}),setEffect:value=>{effect=value;},
    reconnect:()=>{binding={...binding,grantId:"b".repeat(64)};},advance:ms=>{time+=ms;}};
}
const blocked=promise=>assert.rejects(promise,error=>error.code==="HOSTED_REVERSALS_UNVERIFIED");

test("complete stable scans emit short exact-sale evidence scoped only to recorded Accounting reversals",async()=>{
  const h=fixture(),proof=await h.verify(context);
  assert.equal(proof.scope,HOSTED_REVERSAL_SCOPE);assert.equal(proof.outcome,"clear");assert.equal(proof.amountCents,450);
  assert.equal(proof.checkedAt,new Date(NOW).toISOString());assert.equal(proof.expiresAt,new Date(NOW+15_000).toISOString());
  assert.match(proof.evidenceHash,/^[a-f0-9]{64}$/);assert.equal(h.calls.length,12);
  for(const field of Object.keys(context))assert.deepEqual(proof[field],context[field]);
  assert.doesNotMatch(JSON.stringify(proof),/settlementVerified|processorVerified|bankVerified/);
});

test("separate RefundReceipt or CreditMemo blocks unchanged original paid invoice allocations",async()=>{
  for(const entity of ["RefundReceipt","CreditMemo"]) {
    const original=payment(),h=fixture({records:{[entity]:[record("50",{CustomerRef:{value:"20"},TotalAmt:4.5})]}});
    await blocked(h.verify(context));assert.deepEqual(h.records.Payment,[original]);
  }
});

test("customer refund expenses/checks, line customer references and ambiguous missing payees block",async()=>{
  for(const extra of [{EntityRef:{value:"20",type:"Customer"},PaymentType:"Cash"},
    {EntityRef:{value:"20",type:"Customer"},PaymentType:"Check"},
    {EntityRef:{value:"99",type:"Vendor"},Line:[{DetailType:"AccountBasedExpenseLineDetail",AccountBasedExpenseLineDetail:{CustomerRef:{value:"20"}}}]},
    {PaymentType:"Check"}])await blocked(fixture({records:{Purchase:[record("50",extra)]}}).verify(context));
});

test("separate credit settlement Payments, customer journals and negative customer deposits block",async()=>{
  for(const type of ["CreditMemo","Expense","Check","CreditCardCredit","JournalEntry"]) {
    const extra=record("41",{CustomerRef:{value:"20"},CurrencyRef:{value:"USD"},TotalAmt:0,
      Line:[{Amount:4.5,LinkedTxn:[{TxnType:type,TxnId:"50"}]}]});
    await blocked(fixture({records:{Payment:[payment(),extra]}}).verify(context));
  }
  await blocked(fixture({records:{JournalEntry:[record("50",{Line:[{DetailType:"JournalEntryLineDetail",
    JournalEntryLineDetail:{Entity:{Type:"Customer",EntityRef:{value:"20"}}}}]})]}}).verify(context));
  for(const extra of [{DepositLineDetail:{Entity:{value:"20"}}},{}])
    await blocked(fixture({records:{Deposit:[record("50",{Line:[{Amount:-4.5,...extra}]})]}}).verify(context));
});

test("clearly different customers and metadata strictly predating the sale are excluded without amount/date guessing",async()=>{
  const h=fixture({records:{RefundReceipt:[record("50",{CustomerRef:{value:"99"},TotalAmt:4.5}),
    record("51",{CustomerRef:{value:"20"},TotalAmt:4.5,MetaData:metadata(SALE-1)})],
    Purchase:[record("52",{EntityRef:{value:"99",type:"Vendor"},TotalAmt:4.5})],
    CreditMemo:[record("53",{CustomerRef:{value:"99"},TotalAmt:4.5,LinkedTxn:[{TxnType:"Bill",TxnId:"30"}]})],
    Deposit:[record("54",{Line:[{Amount:4.5,LinkedTxn:[{TxnType:"Payment",TxnId:"40"}]}]})]}});
  assert.equal((await h.verify(context)).outcome,"clear");
  const edited=fixture({records:{RefundReceipt:[record("50",{CustomerRef:{value:"20"},TotalAmt:4.5,TxnDate:"2020-01-01",MetaData:metadata(NOW-1)})]}});
  await blocked(edited.verify(context));
  const linked=fixture({records:{RefundReceipt:[record("50",{CustomerRef:{value:"99"},TotalAmt:4.5,MetaData:metadata(SALE-1),LinkedTxn:[{TxnType:"Invoice",TxnId:"30"}]})]}});
  await blocked(linked.verify(context));
});

test("pagination must complete within the fixed bound and duplicate or changed pages cannot emit evidence",async()=>{
  const historical=Array.from({length:101},(_,index)=>record(String(index+100),{CustomerRef:{value:"99"},TotalAmt:1}));
  const h=fixture({records:{RefundReceipt:historical}});assert.equal((await h.verify(context)).outcome,"clear");
  assert.equal(h.calls.filter(call=>call.query.entity==="RefundReceipt").length,4);
  const over=fixture({records:{RefundReceipt:Array.from({length:1001},(_,index)=>record(String(index+100),{CustomerRef:{value:"99"},TotalAmt:1}))}});
  await blocked(over.verify(context));
  const duplicate=fixture({records:{RefundReceipt:[...historical.slice(0,100),historical[0]]}});await blocked(duplicate.verify(context));
});

test("malformed or incomplete query replies, unknown entities and oversized responses fail closed",async()=>{
  for(const data of [{},{Fault:{Error:[]}},{QueryResponse:{RefundReceipt:null}},{QueryResponse:{RefundReceipt:{}}},
    {QueryResponse:{RefundReceipt:[],totalCount:1}},{QueryResponse:{RefundReceipt:[],startPosition:2}},
    {QueryResponse:{RefundReceipt:[],maxResults:100}},{QueryResponse:{Unknown:[]}},
    {QueryResponse:{RefundReceipt:[record("50",{CustomerRef:{value:"99"},TotalAmt:1,MetaData:{}})]}},
    {QueryResponse:{RefundReceipt:[record("50",{CustomerRef:{value:"99"},TotalAmt:1,sparse:true})]}}]) {
    const h=fixture();h.setEffect(()=>new Response(JSON.stringify(data)));await blocked(h.verify(context));
  }
  for(const response of [new Response("not json"),new Response("x".repeat(1_048_577)),new Response("{}",{status:500})]) {
    const h=fixture();h.setEffect(()=>response);await blocked(h.verify(context));
  }
});

test("two full snapshots must agree and reconnection or elapsed scan window revokes evidence",async()=>{
  const h=fixture();h.setEffect((_op,count)=>{if(count===7)h.records.RefundReceipt.push(record("50",{CustomerRef:{value:"99"},TotalAmt:1}));});
  await blocked(h.verify(context));
  const refund=fixture();refund.setEffect((_op,count)=>{if(count===7)refund.records.RefundReceipt.push(record("50",{CustomerRef:{value:"20"},TotalAmt:4.5}));});
  await blocked(refund.verify(context));
  const reconnected=fixture();reconnected.setEffect(()=>{reconnected.reconnect();});await blocked(reconnected.verify(context));
  const slow=fixture();slow.setEffect(()=>{slow.advance(45_000);});await blocked(slow.verify(context));
});

test("exact payment set, customer, allocation and context are mandatory",async()=>{
  for(const change of [{Id:"41"},{CustomerRef:{value:"99"}},{CurrencyRef:{value:"EUR"}},{TotalAmt:0},
    {Line:[{Amount:4,LinkedTxn:[{TxnType:"Invoice",TxnId:"30"}]}]}]) {
    await blocked(fixture({records:{Payment:[{...payment(),...change}]}}).verify(context));
  }
  for(const change of [{realmId:"x"},{invoiceId:""},{orderId:"x"},{saleCreatedAt:"bad"},{paymentIds:["40","40"]},{amountCents:0}]) {
    const h=fixture();await blocked(h.verify({...context,...change}));assert.equal(h.calls.length,0);
  }
});

test("unrelated transaction IDs are scoped by entity type and unknown or missing reference structures stay unavailable",async()=>{
  const h=fixture({records:{Purchase:[record("80",{EntityRef:{value:"900",type:"Vendor"},MetaData:metadata(SALE-1),
    LinkedTxn:[{TxnType:"Bill",TxnId:context.invoiceId}]})]}});
  assert.equal((await h.verify(context)).outcome,"clear");
  for(const records of [{Deposit:[record("50",{Line:[{Amount:1,DetailType:"UnknownDetail"}]})]},
    {Deposit:[record("50",{Line:[{Amount:1}]})]},
    {JournalEntry:[record("50",{Line:[{DetailType:"JournalEntryLineDetail",JournalEntryLineDetail:{Entity:{Type:"Customer"}}}]})]}])
    await blocked(fixture({records}).verify(context));
});

test("page/error streams cancel before unbounded allocation and the overall byte budget is enforced",async()=>{
  for(const status of [200,500]) {
    const h=fixture();let cancelled=false,pulls=0;
    h.setEffect(()=>new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(600_000));},
      cancel(){cancelled=true;}}),{status}));
    await blocked(h.verify(context));assert.equal(cancelled,true);assert.ok(pulls<=3);
  }
  const h=fixture();h.setEffect(operation=>{
    const entity=operation.query.entity,entries=entity==="Payment"?[payment()]:[];
    return new Response(JSON.stringify({QueryResponse:entries.length?{[entity]:entries,startPosition:1,maxResults:1}:{},padding:"x".repeat(900_000)}));
  });
  await blocked(h.verify(context));assert.ok(h.calls.length<12);
});
