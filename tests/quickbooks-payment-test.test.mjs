import test from "node:test";
import assert from "node:assert/strict";
import {createQuickBooksPaymentTestService} from "../api/_lib/quickbooks-payment-test.mjs";
import {createIntuitPaymentsAdapter} from "../api/_lib/payments.mjs";
import {createQuickBooksHandler} from "../api/quickbooks.mjs";
import {paymentAuthorizationMatches} from "../api/_lib/payment-authorization.mjs";
import {userPath} from "../api/_lib/auth.mjs";
import {OWNER_EMAIL} from "../api/_lib/access.mjs";

const OWNER={email:OWNER_EMAIL,role:"owner",status:"active"};
const BINDING={environment:"sandbox",grantId:"a".repeat(64)};
const NOW=Date.parse("2026-09-22T12:00:00Z");
const TOKEN="fictional-token-not-for-output";
const reply=(id,status,extra={})=>new Response(JSON.stringify({id,status,amount:"1.00",currency:"USD",...extra}),{status:200});

function fixture(options={}) {
  let version=0,configEnvironment="sandbox",binding={...BINDING},dispatch=options.dispatch;
  const records=new Map([[userPath(OWNER.email),{value:{...OWNER},etag:"owner-1"}]]),requests=[],permissions=[];
  let tokens=0,providerCreated=0;
  const read=async path=>records.has(path)?structuredClone(records.get(path)):null;
  const write=async(path,value,etag)=>{
    await options.beforeWrite?.(path,value);
    const previous=records.get(path);
    if(previous?previous.etag!==etag:Boolean(etag))throw new Error("Precondition failed");
    const result={value:structuredClone(value),etag:`test-${++version}`};records.set(path,result);
    await options.afterWrite?.(path,value);
    return structuredClone(result);
  };
  const deps={read,write,now:()=>NOW,environment:()=>configEnvironment,
    tokenize:async()=>{tokens++;await options.beforeToken?.();return TOKEN;},
    createProvider:({authorizeSandbox,authorizeProduction})=>{
      providerCreated++;
      const authorize=async(operation,current=binding)=>{
        const value=await (current.environment==="sandbox"?authorizeSandbox:authorizeProduction)({binding:current,operation});
        permissions.push({value,operation});
        if(!paymentAuthorizationMatches(value,current,operation,NOW))throw new Error("Unauthorized transport");
      };
      return createIntuitPaymentsAdapter({now:()=>NOW,transport:{
        binding:async({allowRefresh})=>{
          if(options.refresh&&allowRefresh)await authorize("refresh");
          return {...binding};
        },
        request:async(expected,operation)=>{
          await authorize(operation.method==="GET"?"read":operation.path==="/charges"?"charge":"refund");
          if(JSON.stringify(expected)!==JSON.stringify(binding))throw new Error("Grant changed");
          requests.push(structuredClone(operation));
          if(dispatch)return dispatch(operation);
          return operation.path.includes("refunds")?reply("refund-123","ISSUED"):reply("charge-123","CAPTURED");
        },
      }});
    },...options.overrides};
  const service=createQuickBooksPaymentTestService(deps);
  return {service,records,requests,permissions,peer:()=>createQuickBooksPaymentTestService(deps),
    run:operation=>service.run(OWNER,{operation}),status:()=>service.status(OWNER),
    providerCount:()=>providerCreated,tokenCount:()=>tokens,
    environment:value=>{configEnvironment=value;},binding:value=>{binding=value;},dispatch:value=>{dispatch=value;}};
}

test("fixed sandbox charge, provider readback, full refund and refund readback work without a film",async()=>{
  const h=fixture({refresh:true});
  assert.equal((await h.status()).test,null);
  const captured=await h.run("charge");
  assert.equal(captured.test.status,"captured");assert.equal(captured.test.chargeVerified,false);
  await assert.rejects(h.run("refund"),/Verify the captured/);
  const checked=await h.run("check");assert.equal(checked.test.chargeVerified,true);
  const refunded=await h.run("refund");assert.equal(refunded.test.status,"refunded");assert.equal(refunded.test.refundVerified,false);
  const verified=await h.run("check");assert.equal(verified.test.refundVerified,true);
  assert.equal(verified.amountCents,100);assert.equal(verified.environment,"sandbox");
  assert.deepEqual(h.requests.map(x=>[x.method,x.path]),[
    ["POST","/charges"],["GET","/charges/charge-123"],["POST","/charges/charge-123/refunds"],["GET","/charges/charge-123/refunds/refund-123"]]);
  assert.deepEqual(h.requests[0].body,{amount:"1.00",currency:"USD",token:TOKEN,capture:true,context:{mobile:false,isEcommerce:true}});
  assert.equal(h.requests[2].body.amount,"1.00");
  assert.equal(verified.test.requestId,h.requests[0].requestId);
  assert.equal(verified.test.refundRequestId,h.requests[2].requestId);
  assert.notEqual(verified.test.refundRequestId,verified.test.requestId);
  assert.equal(h.permissions.some(x=>x.operation==="refresh"),true);
  assert.equal(h.permissions.some(x=>x.value.operations.includes("card-entry")||x.value.operations.includes("render")),false);
  for(const value of [verified,[...h.records]])assert.doesNotMatch(JSON.stringify(value),/fictional-token-not-for-output|4111111111111111|"cvc"/);
  assert.equal([...h.records.keys()].some(x=>x.startsWith("payments/")||x.includes("reviews/")),false);
});

test("production, nonowners, suspended owners and unpersisted owner claims cannot reach a processor",async()=>{
  const prod=fixture();prod.environment("production");
  const status=await prod.status();assert.equal(status.available,false);assert.match(status.message,/sandbox connection/);
  await assert.rejects(prod.run("charge"),e=>e.code==="PAYMENT_TEST_SANDBOX_REQUIRED");
  assert.equal(prod.providerCount(),0);assert.equal(prod.tokenCount(),0);
  for(const actor of [null,{email:OWNER_EMAIL},{...OWNER,role:"admin"},{...OWNER,status:"suspended"},{...OWNER,mustChangePassword:true},{...OWNER,email:"other@example.invalid"}]) {
    const h=fixture();await assert.rejects(h.service.run(actor,{operation:"charge"}),e=>e.status===403);
    await assert.rejects(h.service.status(actor),e=>e.status===403);assert.equal(h.providerCount(),0);
  }
  for(const current of [null,{email:OWNER_EMAIL},{...OWNER,role:"customer"},{...OWNER,status:"suspended"},{...OWNER,mustChangePassword:true}]) {
    const h=fixture();h.records.set(userPath(OWNER.email),{value:current,etag:"owner-2"});
    await assert.rejects(h.run("charge"),e=>e.status===403);assert.equal(h.tokenCount(),0);
  }
});

test("legacy owners reach sandbox configuration checks without enabling a fictional test in production",async()=>{
  const legacy={email:OWNER_EMAIL,role:"owner"};
  for(const [actor,current] of [[legacy,legacy],[OWNER,legacy],[legacy,OWNER]]) {
    const h=fixture();h.environment("production");
    h.records.set(userPath(OWNER_EMAIL),{value:current,etag:"legacy-owner"});
    const before=structuredClone([...h.records]);
    const status=await h.service.status(actor);
    assert.equal(status.available,false);assert.match(status.message,/sandbox connection/);
    await assert.rejects(h.service.run(actor,{operation:"charge"}),error=>error.code==="PAYMENT_TEST_SANDBOX_REQUIRED");
    assert.equal(h.providerCount(),0);assert.equal(h.tokenCount(),0);assert.equal(h.requests.length,0);
    assert.deepEqual([...h.records],before);
  }
});

test("client cannot supply amounts, cards, tokens, merchant identity, environment or URLs",async()=>{
  for(const body of [null,[],{}, {operation:"reset"},...["amountCents","card","paymentToken","grantId","environment","url","requestId"].map(key=>({operation:"charge",[key]:"untrusted"}))]) {
    const h=fixture();await assert.rejects(h.service.run(OWNER,body),e=>e.status===400);assert.equal(h.providerCount(),0);
  }
});

test("concurrent and repeated mutations submit only one charge and one refund across processes",async()=>{
  const h=fixture();
  await Promise.allSettled([h.run("charge"),h.peer().run(OWNER,{operation:"charge"})]);
  await h.run("charge");assert.equal(h.tokenCount(),1);assert.equal(h.requests.length,1);
  await h.run("check");
  await Promise.allSettled([h.run("refund"),h.peer().run(OWNER,{operation:"refund"})]);
  await h.run("refund");await h.run("charge");
  assert.equal(h.requests.filter(x=>x.method==="POST"&&x.path==="/charges").length,1);
  assert.equal(h.requests.filter(x=>x.method==="POST"&&x.path.endsWith("refunds")).length,1);
});

test("tokenization failure allows a safe retry with the same saved request references",async()=>{
  let unavailable=true;
  const h=fixture({beforeToken:async()=>{if(unavailable)throw new Error("private-tokenization-error");}});
  const failed=await h.run("charge");
  assert.equal(failed.test.status,"tokenization-failed");assert.equal(h.requests.length,0);
  assert.match(failed.message,/No charge was attempted.*retry/);
  assert.doesNotMatch(JSON.stringify(failed),/private-tokenization-error/);
  assert.equal((await h.status()).message,failed.message);
  assert.equal((await h.run("check")).message,failed.message);
  await assert.rejects(h.run("refund"));
  unavailable=false;
  const captured=await h.run("charge");
  assert.equal(captured.test.status,"captured");assert.equal(h.tokenCount(),2);assert.equal(h.requests.length,1);
  assert.equal(captured.test.requestId,failed.test.requestId);
  assert.equal(captured.test.refundRequestId,failed.test.refundRequestId);
  assert.equal(captured.test.createdAt,failed.test.createdAt);
  assert.equal(h.requests[0].requestId,failed.test.requestId);
  await h.run("charge");assert.equal(h.requests.length,1);assert.equal(h.tokenCount(),2);
});

test("concurrent retries of a tokenization failure claim only one processor attempt",async()=>{
  let unavailable=true;
  const h=fixture({beforeToken:async()=>{if(unavailable)throw new Error("tokenization unavailable");}});
  const failed=await h.run("charge");unavailable=false;
  await Promise.allSettled([h.run("charge"),h.peer().run(OWNER,{operation:"charge"})]);
  assert.equal(h.tokenCount(),2);assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].requestId,failed.test.requestId);
  assert.equal((await h.status()).test.status,"captured");
  await h.run("charge");assert.equal(h.requests.length,1);
});

test("uncertain results never retry a charge or refund and do not leak processor data",async()=>{
  for(const dispatch of [async()=>{throw new Error("private-processor-data");},async()=>new Response("private-processor-data",{status:500}),
    async()=>reply("charge-123","CAPTURED",{amount:"9.00"}),async()=>reply("charge-123","AUTHORIZED")]) {
    const h=fixture({dispatch});const value=await h.run("charge");assert.equal(value.test.status,"uncertain");
    await h.run("charge");assert.equal(h.requests.length,1);assert.doesNotMatch(JSON.stringify(value),/private-processor-data/);
    await assert.rejects(h.run("refund"));
  }
  const h=fixture();await h.run("charge");await h.run("check");h.dispatch(async()=>{throw new Error("private-refund-data");});
  const pending=await h.run("refund");assert.equal(pending.test.status,"refund-pending");
  assert.equal(pending.test.refundRequestId,h.requests[2].requestId);
  await h.run("refund");await h.run("check");assert.equal(h.requests.length,3);
  assert.doesNotMatch(JSON.stringify(pending),/private-refund-data/);
});

test("unconfirmed writes stop processor operations, committed writes with lost replies do not duplicate them",async()=>{
  const failed=fixture({beforeWrite:async()=>{throw new Error("write unavailable");}});
  await assert.rejects(failed.run("charge"));assert.equal(failed.requests.length,0);assert.equal(failed.tokenCount(),0);
  const lost=fixture({afterWrite:async()=>{throw new Error("write response lost");}});
  assert.equal((await lost.run("charge")).test.status,"captured");await lost.run("charge");assert.equal(lost.requests.length,1);
  let denySave=false;
  const finalLost=fixture({beforeWrite:async(path,value)=>{if(denySave&&value.status!=="submitting")throw new Error("down");}});
  denySave=true;await assert.rejects(finalLost.run("charge"));await finalLost.run("charge");
  assert.equal(finalLost.requests.length,1);assert.equal((await finalLost.status()).test.status,"submitting");
});

test("owner revocation and environment/grant switches after tokenization prevent submission",async()=>{
  for(const change of [h=>h.environment("production"),h=>h.binding({...BINDING,environment:"production"}),
    h=>h.binding({...BINDING,grantId:"b".repeat(64)}),h=>h.records.set(userPath(OWNER.email),{value:{...OWNER,status:"suspended"},etag:"owner-2"})]) {
    let h;h=fixture({beforeToken:async()=>change(h)});
    const result=await h.run("charge");assert.equal(result.test.status,"uncertain");assert.equal(h.requests.length,0);
  }
});

test("readback must match the exact transaction ID, amount and terminal status",async()=>{
  const h=fixture();await h.run("charge");
  for(const extra of [{id:"unrelated-id"},{amount:"2.00"},{currency:"EUR"},{status:"AUTHORIZED"}]) {
    h.dispatch(async()=>reply("charge-123","CAPTURED",extra));
    assert.equal((await h.run("check")).test.chargeVerified,false);await assert.rejects(h.run("refund"));
  }
  h.dispatch(null);await h.run("check");await h.run("refund");
  h.dispatch(async()=>reply("different-refund","ISSUED"));assert.equal((await h.run("check")).test.refundVerified,false);
});

function routeHarness(actor=OWNER) {
  const calls=[];
  const handler=createQuickBooksHandler({sessionFor:async()=>actor?{user:actor}:null,limiter:async()=>true,
    paymentTest:{status:async(...args)=>{calls.push(args);return {available:true};},run:async(...args)=>{calls.push(args);return {available:true};}}});
  return {calls,async request({method="POST",action="testPayment",body={action:"testPayment",operation:"charge"},headers={}}={}) {
    let status,result;const returnedHeaders={};
    await handler({method,url:`/api/quickbooks?action=${action}`,body,headers:{host:"lineagetheater.com",origin:"https://lineagetheater.com",...headers}},
      {set statusCode(v){status=v;},setHeader(k,v){returnedHeaders[k]=v;},end(value){result=JSON.parse(value);}});
    return {status,result,headers:returnedHeaders};
  }};
}

test("payment test routes require an owner and same-origin POST; GET only reads saved status",async()=>{
  const h=routeHarness();assert.equal((await h.request()).status,200);
  assert.deepEqual(h.calls,[[OWNER,{operation:"charge"}]]);
  const get=await h.request({method:"GET",action:"paymentTest"});assert.equal(get.status,200);assert.match(get.headers["Cache-Control"],/no-store/);
  for(const [actor,status] of [[null,401],[{...OWNER,role:"admin"},403],[{...OWNER,role:"customer"},403]]) {
    const r=routeHarness(actor);assert.equal((await r.request()).status,status);
    assert.equal((await r.request({method:"GET",action:"paymentTest"})).status,status);assert.equal(r.calls.length,0);
  }
  for(const headers of [{origin:"https://other.invalid"},{host:"other.invalid"},{origin:undefined}]) {
    const r=routeHarness();assert.equal((await r.request({headers})).status,403);assert.equal(r.calls.length,0);
  }
  const r=routeHarness();assert.equal((await r.request({method:"GET"})).status,405);assert.equal(r.calls.length,0);
  assert.equal((await r.request({body:{action:"testPayment",operation:"charge",amountCents:2}})).status,400);assert.equal(r.calls.length,0);
});
