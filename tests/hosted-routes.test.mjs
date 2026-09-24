import test from "node:test";
import assert from "node:assert/strict";
import { connections, createStudioHandler } from "../api/studio.mjs";
import { createAdminHandler } from "../api/admin.mjs";
import { createPaymentsService } from "../api/_lib/payments.mjs";
import { digest } from "../api/_lib/auth.mjs";

const OWNER={email:"erik@brocotech.ai",role:"owner",status:"active"};
const CUSTOMER={email:"fictional@example.invalid",role:"customer",status:"active",approvedAt:"2026-09-23T00:00:00.000Z",approvedBy:OWNER.email};
const ID="a".repeat(64),QUOTE="b".repeat(64);
async function invoke(handler,action,{method="POST",body={},origin="https://lineagetheater.com",id}={}) {
  let statusCode,output;
  await handler({method,url:`/api/studio?action=${action}${id?`&id=${id}`:""}`,headers:{host:"lineagetheater.com",origin},
    ...(method==="POST"?{body:{action,...body}}:{})},
    {set statusCode(value){statusCode=value;},setHeader(){},end(value){output=JSON.parse(value);}});
  return {statusCode,body:output};
}
function studio(user=CUSTOMER) {
  const calls=[];
  const hosted={configuration:async(actor,options)=>{calls.push(["configuration",options]);return {available:true,method:"quickbooks-hosted-invoice",environment:"production"};},
    quote:async()=>({id:QUOTE}),checkout:async(actor,input)=>{calls.push(["checkout",input]);return {id:ID,status:"awaiting-payment"};},
    ownsOrder:async id=>id===ID,order:async()=>{calls.push(["saved-order"]);return {id:ID};},
    receipt:async()=>({receiptId:ID}),check:async(actor,input)=>{calls.push(["check",input]);return {id:ID,status:"awaiting-payment"};}};
  const handler=createStudioHandler({hostedCheckout:hosted,getSession:async()=>user&&user.status!=="suspended"?{user}:null,limitAction:async()=>true,
    captcha:{consumeCheckout:async(email,q,proof)=>{calls.push(["proof",q,proof]);if(proof!=="valid-proof")throw new Error("bad proof");},prepareCheckout:async()=>({checkoutProof:"valid-proof"})},
    payments:{order:async()=>({id:"legacy"})}});
  return {handler,calls};
}
test("hosted checkout routes retain session, same-origin and CAPTCHA protections without a card token",async()=>{
  const input={quoteId:QUOTE,idempotencyKey:"synthetic-checkout-key",consent:true,checkoutProof:"valid-proof"};
  for(const [user,expected] of [[null,401],[{...CUSTOMER,status:"suspended"},401]])
    assert.equal((await invoke(studio(user).handler,"checkout",{body:input})).statusCode,expected);
  const h=studio();
  assert.equal((await invoke(h.handler,"checkout",{origin:"https://wrong.invalid",body:input})).statusCode,403);
  assert.equal(h.calls.length,0);
  assert.equal((await invoke(h.handler,"checkout",{body:{...input,checkoutProof:"invalid"}})).statusCode,503);
  assert.equal(h.calls.filter(call=>call[0]==="checkout").length,0);
  const result=await invoke(h.handler,"checkout",{body:input});
  assert.equal(result.statusCode,200);assert.equal(result.body.status,"awaiting-payment");
  assert.deepEqual(h.calls.at(-1),["checkout",{quoteId:QUOTE,idempotencyKey:"synthetic-checkout-key",consent:true}]);
});
test("GET order only reads saved hosted state; provider status checking is an explicit bounded POST",async()=>{
  const h=studio();
  assert.equal((await invoke(h.handler,"order",{method:"GET",id:ID})).statusCode,200);
  assert.deepEqual(h.calls,[["saved-order"]]);
  assert.equal((await invoke(h.handler,"checkPayment",{origin:"https://wrong.invalid",body:{orderId:ID}})).statusCode,403);
  assert.equal((await invoke(h.handler,"checkPayment",{body:{orderId:ID,amountCents:1}})).statusCode,400);
  assert.equal((await invoke(h.handler,"checkPayment",{body:{orderId:ID}})).statusCode,200);
  assert.deepEqual(h.calls.at(-1),["check",{orderId:ID}]);
  assert.equal((await invoke(h.handler,"order",{method:"GET",id:QUOTE})).body.id,"legacy");
});
test("hosted invoice settings are owner-only and hosted refunds never reach the card refund adapter",async()=>{
  const calls=[];
  const setup=user=>createAdminHandler({getSession:async()=>({user}),limitAction:async()=>true,audit:async()=>{},
    readRecord:async()=>({value:{checkoutMethod:"quickbooks-hosted-invoice"}}),
    hostedCheckout:{catalog:async()=>{calls.push("catalog");return {items:[]};},saveSettings:async()=>{calls.push("save");return {revision:1};}},
    payments:{refund:async()=>{calls.push("refund");throw new Error("must not run");}}});
  const administrator={email:"admin@example.invalid",role:"admin",status:"active"};
  assert.equal((await invoke(setup(administrator),"hostedCheckoutCatalog")).statusCode,403);
  assert.equal((await invoke(setup(administrator),"saveHostedCheckout")).statusCode,403);
  assert.equal((await invoke(setup(OWNER),"hostedCheckoutCatalog",{body:{query:"arbitrary"}})).statusCode,400);
  assert.equal((await invoke(setup(OWNER),"hostedCheckoutCatalog")).statusCode,200);
  assert.deepEqual(calls,["catalog"]);
  const refunded=await invoke(setup(OWNER),"refund",{body:{orderId:ID}});
  assert.equal(refunded.statusCode,409);assert.equal(refunded.body.refunded,false);
  assert.deepEqual(calls,["catalog"]);
});
test("a hosted accounting payment cannot become legacy processor authorization for rendering",async()=>{
  let providerCalls=0;
  const saved={id:ID,checkoutMethod:"quickbooks-hosted-invoice",customerEmail:CUSTOMER.email,
    manifestHash:digest("fictional-manifest"),preparedId:"synthetic-prepared-reference",status:"captured",
    capturedAt:"2026-09-23T00:00:00.000Z",refundedCents:0,merchantBinding:{environment:"production",grantId:QUOTE}};
  const service=createPaymentsService({read:async()=>({value:saved,etag:"synthetic-etag"}),provider:{binding:async()=>{providerCalls++;throw new Error();}}});
  await assert.rejects(service.authorizeProduction({email:CUSTOMER.email,orderId:ID,manifestHash:saved.manifestHash,preparedId:saved.preparedId}),error=>error.code==="PRODUCTION_UNAVAILABLE");
  assert.equal(providerCalls,0);
});

test("legacy refund and reconcile services reject hosted invoice records before processor dispatch",async()=>{
  let providerCalls=0;
  const saved={id:ID,customerEmail:OWNER.email,checkoutMethod:"quickbooks-hosted-invoice",status:"captured",refunds:[],amountCents:1000,refundedCents:0};
  const service=createPaymentsService({read:async()=>({value:saved,etag:"synthetic-etag"}),provider:{binding:async()=>{providerCalls++;throw new Error();}}});
  await assert.rejects(service.reconcile(OWNER,{orderId:ID}),error=>error.code==="HOSTED_INVOICE_REQUIRED");
  await assert.rejects(service.refund(OWNER,{orderId:ID,amountCents:1000,reason:"Synthetic refund",idempotencyKey:"synthetic-refund-key"}),error=>error.code==="HOSTED_REFUND_IN_QUICKBOOKS");
  assert.equal(providerCalls,0);
});

test("hosted payment readiness is separate from unavailable video production",async()=>{
  const ready=await connections({key:"",checkoutConfiguration:{available:true}});
  assert.equal(ready.billing,true);assert.equal(ready.magiclight,false);
  assert.equal(ready.payment.status,"configured");
  assert.match(ready.connections.billing.reason,/bank settlement, and film delivery are tracked separately/);
  assert.equal((await connections({key:"",checkoutConfiguration:{available:false}})).billing,false);
});
