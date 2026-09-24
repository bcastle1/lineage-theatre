import test from "node:test";
import assert from "node:assert/strict";
import {checkHostedReversals} from "../api/_lib/hosted-reversal-diagnostics.mjs";
import {runHostedReversalCheck,REQUIRED_ENV} from "../scripts/check-hosted-reversals.mjs";

const NOW=Date.parse("2026-09-23T18:00:00Z"),ORDER="a".repeat(64),BINDING={environment:"production",grantId:"b".repeat(64),realmId:"1234"};
const stamp=ms=>new Date(ms).toISOString();
function fixture() {
  let time=NOW,reads=0,effect;
  const order={version:1,id:ORDER,provider:"quickbooks",checkoutMethod:"quickbooks-hosted-invoice",confirmationSource:"quickbooks-accounting",
    status:"captured",createdAt:stamp(NOW-3600_000),capturedAt:stamp(NOW-1800_000),accountingCheckedAt:stamp(NOW-1000),
    merchantBinding:{...BINDING},currency:"USD",amountCents:330,customerId:"20",invoiceId:"30",balanceCents:0,refundedCents:0,
    lastCheckStage:"complete",lastCheckFailureReason:null,paymentIds:["40"],accountingPayments:[{id:"40",allocatedCents:330}],
    customerEmail:"private-customer-SENTINEL@example.com",filmTitle:"private-story-SENTINEL"};
  const metadata={CreateTime:stamp(NOW-3600_000),LastUpdatedTime:stamp(NOW-1000)};
  const entities={RefundReceipt:[],CreditMemo:[],Purchase:[],JournalEntry:[],Deposit:[],Payment:[{Id:"40",SyncToken:"0",MetaData:metadata,
    CustomerRef:{value:"20"},CurrencyRef:{value:"USD"},TotalAmt:3.3,PrivateNote:"private-provider-SENTINEL",
    Line:[{Amount:3.3,LinkedTxn:[{TxnType:"Invoice",TxnId:"30"}]}]}]};
  let etag="version-1",binding={...BINDING};const requests=[],bindings=[];
  const read=async path=>{assert.equal(path,`payments/orders/${ORDER}.json`);reads++;await effect?.("read",reads);return {value:structuredClone(order),etag};};
  const transport={binding:async options=>{bindings.push(options);await effect?.("binding",bindings.length);return {...binding};},
    request:async(expected,operation)=>{assert.deepEqual(expected,binding);assert.equal(operation.method,"GET");assert.equal(operation.path,"/query");
      assert.equal(operation.body,undefined);requests.push(operation);const override=await effect?.("request",requests.length);if(override)return override;
      const entity=operation.query.entity,rows=entities[entity];return new Response(JSON.stringify({QueryResponse:rows.length?{[entity]:rows,startPosition:1,maxResults:rows.length}:{}}));}};
  return {order,entities,requests,bindings,check:()=>checkHostedReversals({orderId:ORDER,read,transport,now:()=>time}),
    effect:value=>{effect=value;},changeOrder:()=>{etag="version-2";},reconnect:()=>{binding.grantId="c".repeat(64);},
    otherCompany:()=>{binding.realmId="9876";},advance:ms=>{time+=ms;},get reads(){return reads;},metadata};
}

test("saved paid order runs the actual verifier with GET-only stable snapshots and sanitized output",async()=>{
  const h=fixture(),result=await h.check();
  assert.deepEqual(result,{recordedReversalsVerified:true,productionReady:false,scope:"quickbooks-accounting-recorded-reversals",
    code:"RECORDED_REVERSALS_VERIFIED",totals:{accountingReads:12,paymentCount:1,amountCents:330}});
  assert.equal(h.reads,2);assert.deepEqual(h.bindings[0],{allowRefresh:true});assert.ok(h.bindings.slice(1).every(value=>value.allowRefresh===false));
  assert.doesNotMatch(JSON.stringify(result),/SENTINEL|1234|customerId|invoiceId|paymentIds|grantId|evidenceHash/);
});

test("invalid, unpaid, refunded, or inconsistent saved contexts never query Accounting",async()=>{
  for(const patch of [{status:"awaiting-payment"},{refundedCents:1},{refunds:[{}]},{checkOperation:"pending"},
    {accountingPayments:[{id:"40",allocatedCents:329}]},{paymentIds:["40","40"]},{capturedAt:stamp(NOW+1)},
    {checkoutMethod:"other"},{lastCheckStage:"payment-read"},{customerId:20},{merchantBinding:{...BINDING,realmId:"bad"}}]) {
    const h=fixture();Object.assign(h.order,patch);const result=await h.check();assert.equal(result.code,"ORDER_INVALID");
    assert.equal(h.requests.length,0);assert.equal(h.bindings.length,0);
  }
  let reads=0;assert.equal((await checkHostedReversals({orderId:"../private-SENTINEL",read:()=>{reads++;}})).code,"ORDER_INVALID");assert.equal(reads,0);
});

test("current-company mismatch blocks all queries and a rotated same-company grant remains usable",async()=>{
  const wrong=fixture();wrong.otherCompany();assert.equal((await wrong.check()).code,"ACCOUNTING_COMPANY_MISMATCH");assert.equal(wrong.requests.length,0);
  const rotated=fixture();rotated.reconnect();assert.equal((await rotated.check()).recordedReversalsVerified,true);
});

test("a recorded refund or changed payment allocation fails actual verifier acceptance",async()=>{
  const refund=fixture();refund.entities.RefundReceipt.push({Id:"50",SyncToken:"0",MetaData:refund.metadata,Line:[],CustomerRef:{value:"20"},TotalAmt:3.3});
  assert.equal((await refund.check()).code,"HOSTED_REVERSALS_UNVERIFIED");
  const changed=fixture();changed.entities.Payment[0].Line[0].Amount=3.2;assert.equal((await changed.check()).code,"HOSTED_REVERSALS_UNVERIFIED");
});

test("concurrent order edits or binding changes cannot emit successful acceptance",async()=>{
  const order=fixture();order.effect((stage,count)=>{if(stage==="read"&&count===2)order.changeOrder();});assert.equal((await order.check()).code,"ORDER_CHANGED");
  const baseline=fixture();assert.equal((await baseline.check()).recordedReversalsVerified,true);
  const binding=fixture();binding.effect((stage,count)=>{if(stage==="binding"&&count===baseline.bindings.length)binding.reconnect();});
  assert.equal((await binding.check()).code,"ACCOUNTING_BINDING_CHANGED");
});

test("an order refund or check edit during the final binding await is read before acceptance",async()=>{
  const baseline=fixture();assert.equal((await baseline.check()).recordedReversalsVerified,true);
  for(const patch of [{refundedCents:330},{checkOperation:"in-progress"}]) {
    const h=fixture();let changed=false;
    h.effect(async(stage,count)=>{
      if(stage==="binding"&&count===baseline.bindings.length) {
        await Promise.resolve();Object.assign(h.order,patch);h.changeOrder();changed=true;
      }
    });
    const result=await h.check();assert.equal(changed,true);assert.equal(result.recordedReversalsVerified,false);
    assert.equal(result.productionReady,false);assert.equal(result.code,"ORDER_CHANGED");assert.equal(h.reads,2);
  }
});

test("the overall deadline prevents a scan after slow refresh and errors never expose provider bodies",async()=>{
  const slow=fixture();slow.effect(stage=>{if(stage==="binding")slow.advance(50_000);});assert.equal((await slow.check()).code,"CHECK_TIMED_OUT");assert.equal(slow.requests.length,0);
  const failure=fixture();failure.effect(stage=>{if(stage==="request")throw Object.assign(new Error("secret-token-SENTINEL"),{code:"private-error-SENTINEL"});});
  const result=await failure.check();assert.equal(result.code,"RECORDED_REVERSAL_CHECK_FAILED");assert.doesNotMatch(JSON.stringify(result),/SENTINEL/);
});

test("CLI rejects missing runtime or invalid arguments before checking and prints no secrets on failure",async()=>{
  const output=[],env=Object.fromEntries(REQUIRED_ENV.map(key=>[key,"secret-SENTINEL"]));let calls=0;
  const check=async()=>{calls++;throw new Error("secret-SENTINEL");},options={env,check,output:value=>output.push(value)};
  assert.equal(await runHostedReversalCheck(["--order-id",ORDER],{...options,env:{}}),1);assert.equal(calls,0);
  assert.equal(await runHostedReversalCheck(["--order-id",ORDER,"--unsafe"],options),1);assert.equal(calls,0);
  assert.equal(await runHostedReversalCheck(["--order-id",ORDER],options),1);assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(output),/SENTINEL/);
  assert.equal(await runHostedReversalCheck(["--help"],options),0);assert.equal(calls,1);
});
