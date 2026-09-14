import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {createPaymentsService,createIntuitPaymentsAdapter,PaymentError} from "../api/_lib/payments.mjs";
import {createQuickBooksPaymentsTransport,quickbooksConfig,encryptQuickBooksTokens,QUICKBOOKS_CONNECTION_PATH,QUICKBOOKS_SCOPES,verifyQuickBooksDiscovery,INTUIT_AUTHORIZE,INTUIT_TOKEN,INTUIT_REVOKE} from "../api/_lib/quickbooks.mjs";
import {tokenizeSandboxFixture,checkSandboxTokenCors} from "../scripts/test-intuit-sandbox-token.mjs";
import {digest,userPath} from "../api/_lib/auth.mjs";
import {OWNER_EMAIL} from "../api/_lib/access.mjs";

const CUSTOMER={email:"customer@example.invalid",role:"customer",status:"active"};
const OTHER={email:"other@example.invalid",role:"customer",status:"active"};
const ADMIN={email:"admin@example.invalid",role:"admin",status:"active"};
const OWNER={email:OWNER_EMAIL,role:"owner",status:"active",passwordHash:"synthetic-owner-password"};
const BINDING={environment:"sandbox",grantId:"a".repeat(64)};
const NOW=Date.parse("2026-09-14T12:00:00.000Z");
const TOKEN="synthetic-payment-token";
const REF=digest("synthetic-manifest");
const preparedId="synthetic-prepared-film-123";
const quoteKey="synthetic-quote-key-1234",checkoutKey="synthetic-checkout-key-1234";
const project={id:"synthetic-film-1234",title:"Fictional family garden",preparationConsent:true};
const processorResponse=(data,status=200)=>new Response(JSON.stringify(data),{status});
const chargeReply=(extra={})=>({id:"synthetic-charge-123",status:"CAPTURED",amount:"11.25",currency:"USD",card:{number:"4111111111111111",cvc:"123"},token:TOKEN,...extra});
const refundReply=(extra={})=>({id:"synthetic-refund-123",status:"ISSUED",amount:"1.00",...extra});
function fixture(options={}) {
  let time=NOW,version=0,currentBinding=structuredClone(BINDING),dispatch=options.dispatch;
  const records=new Map(),requests=[],quotes=[];
  const read=async path=>records.has(path)?structuredClone(records.get(path)):null;
  const write=async(path,value,etag)=>{
    await options.beforeWrite?.(path,value);
    const existing=records.get(path);
    if((existing&&existing.etag!==etag)||(!existing&&etag))throw new Error("Precondition failed");
    const result={value:structuredClone(value),etag:`etag-${++version}`};records.set(path,result);
    await options.afterWrite?.(path,value);
    return structuredClone(result);
  };
  const transport={binding:async()=>currentBinding,request:async(binding,operation)=>{
    requests.push(structuredClone(operation));
    if(dispatch)return dispatch(operation,binding);
    if(operation.path.includes("refunds"))return processorResponse(refundReply());
    return processorResponse(chargeReply());
  }};
  const dependencies={read,write,now:()=>time,provider:createIntuitPaymentsAdapter({transport}),
    readiness:async()=>({sandboxEnabled:true,merchantVerified:true}),
    pricingSettings:async()=>({markupBasisPoints:1250,revision:7}),
    quoteProvider:async(p,actor,opts)=>{
      quotes.push({p,actor,opts});
      return {preparedId,filmId:project.id,filmTitle:project.title,manifestHash:REF,quoteReference:"verified-quote-reference",environment:"sandbox",currency:"USD",providerCostCents:1000,
        expiresAt:new Date(time+5*60_000).toISOString(),apiVerified:true,qualityVerified:true,commercialTermsVerified:true,...options.quoteOverrides};
    },...options.overrides};
  const service=createPaymentsService(dependencies);
  const makeQuote=(actor=CUSTOMER,idempotencyKey=quoteKey)=>service.quote(actor,{project,idempotencyKey});
  const pay=async(actor=CUSTOMER,extra={})=>{const q=await makeQuote(actor);return service.checkout(actor,{quoteId:q.id,idempotencyKey:checkoutKey,paymentToken:TOKEN,consent:true,...extra});};
  return {service,records,requests,quotes,read,write,makeQuote,pay,peer:()=>createPaymentsService(dependencies),advance:ms=>{time+=ms;},setBinding:b=>{currentBinding=b;},setDispatch:f=>{dispatch=f;}};
}
const expectError=(promise,code)=>assert.rejects(promise,error=>error instanceof PaymentError&&error.code===code);
const noInternalData=value=>assert.doesNotMatch(JSON.stringify(value),/quickbooks|intuit|merchantBinding|providerCost|markup|quoteReference|synthetic-payment-token|4111111111111111|"cvc"/i);

test("default services and any production binding keep all transactions disabled",async()=>{
  let calls=0;
  const s=createPaymentsService({read:async()=>null,provider:{binding:async()=>{calls++;return BINDING;}}});
  await expectError(s.quote(CUSTOMER,{project,idempotencyKey:quoteKey}),"PRODUCTION_UNAVAILABLE");assert.equal(calls,0);
  const h=fixture();h.setBinding({...BINDING,environment:"production"});
  await expectError(h.makeQuote(),"PRODUCTION_UNAVAILABLE");assert.equal(h.requests.length,0);assert.equal(h.records.size,0);
});

test("quotes accept prices only from trusted verified manifests and current server markup",async()=>{
  const h=fixture(),q=await h.makeQuote();assert.equal(q.amountCents,1125);assert.equal(q.manifestHash,REF);noInternalData(q);
  const record=[...h.records.values()][0].value;
  assert.equal(record.providerCostCents,1000);assert.equal(record.markupCents,125);assert.equal(record.pricingRevision,7);
  assert.equal(h.quotes[0].actor.email,CUSTOMER.email);
  assert.deepEqual(await h.makeQuote(),q);assert.equal(h.records.size,1);
  for(const invalid of [{qualityVerified:false},{commercialTermsVerified:false},{apiVerified:false},{providerCostCents:-1},{currency:"EUR"},{expiresAt:"invalid"},{manifestHash:"untrusted"},{environment:"production"},{environment:undefined}])
    await expectError(fixture({quoteOverrides:invalid}).makeQuote(),"PRODUCTION_UNAVAILABLE");
  await expectError(h.service.quote(CUSTOMER,{project,idempotencyKey:quoteKey,amountCents:1}),"PAYMENT_REQUEST_INVALID");
  h.advance(5*60_000+1);await expectError(h.makeQuote(),"QUOTE_EXPIRED");
});

test("checkout never accepts card data, client amounts, missing consent, cross-tenant or expired quotes",async()=>{
  const h=fixture(),q=await h.makeQuote();
  const body={quoteId:q.id,idempotencyKey:checkoutKey,paymentToken:TOKEN,consent:true};
  for(const patch of [{amountCents:1},{card:{number:"4111111111111111"}},{currency:"EUR"},{environment:"production"},{consent:false},{paymentToken:"4111111111111111"}])
    await assert.rejects(h.service.checkout(CUSTOMER,{...body,...patch}),PaymentError);
  await assert.rejects(h.service.checkout(OTHER,body),error=>error.status===404);
  for(const status of ["suspended","invited","pending",undefined])
    await assert.rejects(h.service.checkout({...CUSTOMER,status},body),error=>error.status===401);
  h.advance(5*60_000+1);await expectError(h.service.checkout(CUSTOMER,body),"QUOTE_EXPIRED");
  assert.equal(h.requests.length,0);
});

test("a durable capture uses the quoted amount and returns a provider-neutral receipt without storing tokens or cards",async()=>{
  const h=fixture(),result=await h.pay();
  assert.equal(result.status,"captured");assert.equal(result.charged,true);noInternalData(result);
  const operation=h.requests[0];assert.equal(operation.method,"POST");assert.equal(operation.path,"/charges");
  assert.deepEqual(operation.body,{amount:"11.25",currency:"USD",token:TOKEN,capture:true,context:{mobile:false,isEcommerce:true}});
  assert.match(operation.requestId,/^[a-f0-9-]{36}$/);
  const stored=JSON.stringify([...h.records.values()]);assert.equal(stored.includes(TOKEN),false);assert.equal(stored.includes("4111111111111111"),false);assert.equal(stored.includes('"cvc"'),false);
  const receipt=await h.service.receipt(CUSTOMER,result.id);assert.equal(receipt.amountCents,1125);assert.equal(receipt.sandbox,true);noInternalData(receipt);
  const ledger=await h.service.accountingExport(ADMIN,result.id);assert.equal(ledger.postingReady,false);assert.equal(ledger.settlementVerified,false);assert.equal(ledger.feesCents,null);assert.equal(ledger.providerExpenseCents,null);assert.equal(ledger.events.length,1);
  assert.equal((await h.service.authorizeProduction({email:CUSTOMER.email,orderId:result.id,manifestHash:REF,preparedId})).allowed,true);
  await expectError(h.service.authorizeProduction({email:OTHER.email,orderId:result.id,manifestHash:REF,preparedId}),"PRODUCTION_UNAVAILABLE");
  h.advance(6*60_000);await expectError(h.service.authorizeProduction({email:CUSTOMER.email,orderId:result.id,manifestHash:REF,preparedId}),"PRODUCTION_UNAVAILABLE");
});

test("sequential and concurrent checkout retries make one POST across processes and new quotes for the same manifest",async()=>{
  const h=fixture(),q=await h.makeQuote();
  const body={quoteId:q.id,idempotencyKey:checkoutKey,paymentToken:TOKEN,consent:true};
  const results=await Promise.allSettled([h.service.checkout(CUSTOMER,body),h.peer().checkout(CUSTOMER,body)]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length>=1,true);assert.equal(h.requests.length,1);
  assert.equal((await h.service.checkout(CUSTOMER,body)).status,"captured");assert.equal(h.requests.length,1);
  const another=await h.makeQuote(CUSTOMER,"another-quote-request-1234");
  await expectError(h.service.checkout(CUSTOMER,{...body,quoteId:another.id,idempotencyKey:"another-checkout-key-1234"}),"PAYMENT_CONFLICT");assert.equal(h.requests.length,1);
});

test("network errors and unknown processor outcomes stay durable and cannot repeat the POST",async()=>{
  for(const dispatch of [async()=>{throw new Error("Network lost synthetic private credentials");},async()=>processorResponse({errors:[{detail:"card declined or private processor data"}]},500),async()=>new Response("invalid",{status:200}),async()=>processorResponse(chargeReply({status:"AUTHORIZED"})),async()=>processorResponse(chargeReply({amount:"0.01"}))]) {
    const h=fixture({dispatch}),result=await h.pay();assert.equal(result.status,"uncertain");assert.equal(result.charged,null);noInternalData(result);
    assert.equal((await h.pay()).status,"uncertain");assert.equal(h.requests.length,1);
    await assert.rejects(h.service.receipt(CUSTOMER,result.id));
    await expectError(h.service.authorizeProduction({email:CUSTOMER.email,orderId:result.id,manifestHash:REF,preparedId}),"PRODUCTION_UNAVAILABLE");
  }
});

test("reconciliation is administrator-only, reads only a known charge ID, and verifies amount/id before capture",async()=>{
  const h=fixture({dispatch:async()=>processorResponse(chargeReply({status:"AUTHORIZED"}))}),result=await h.pay();
  await assert.rejects(h.service.reconcile(CUSTOMER,{orderId:result.id}),error=>error.status===403);
  h.setDispatch(async()=>processorResponse(chargeReply({id:"wrong-charge-id"})));
  assert.equal((await h.service.reconcile(ADMIN,{orderId:result.id})).status,"uncertain");
  h.setDispatch(async()=>processorResponse(chargeReply()));
  assert.equal((await h.service.reconcile(ADMIN,{orderId:result.id})).status,"captured");
  assert.deepEqual(h.requests.map(request=>request.method),["POST","GET","GET"]);
  const lost=fixture({dispatch:async()=>{throw new Error("lost");}}),lostOrder=await lost.pay();
  await expectError(lost.service.reconcile(ADMIN,{orderId:lostOrder.id}),"PAYMENT_REVIEW_REQUIRED");assert.equal(lost.requests.length,1);
});

test("pre-send storage failures send nothing; ambiguous committed writes and failed final writes never double-charge",async()=>{
  const before=fixture({beforeWrite:async(path,value)=>{if(value.status==="submitting")throw new Error("storage offline");}});
  await expectError(before.pay(),"PAYMENT_CONFLICT");assert.equal(before.requests.length,0);
  const after=fixture({afterWrite:async(path,value)=>{if(value.status==="submitting"||value.status==="captured")throw new Error("write committed, reply lost");}});
  assert.equal((await after.pay()).status,"captured");assert.equal((await after.pay()).status,"captured");assert.equal(after.requests.length,1);
  const final=fixture({beforeWrite:async(path,value)=>{if(value.status==="captured")throw new Error("storage offline");}});
  await expectError(final.pay(),"PAYMENT_CONFLICT");assert.equal((await final.pay()).status,"submitting");assert.equal(final.requests.length,1);
});

test("orders are tenant-bound, refund requests reserve remaining balance atomically, and duplicate refunds never replay",async()=>{
  const h=fixture(),paid=await h.pay();
  await assert.rejects(h.service.order(OTHER,paid.id),error=>error.status===404);
  const body={orderId:paid.id,amountCents:100,reason:"Fictional customer requested a partial refund",idempotencyKey:"synthetic-refund-request-123"};
  await assert.rejects(h.service.refund(CUSTOMER,body),error=>error.status===403);
  await assert.rejects(h.service.refund(ADMIN,{...body,amountCents:1126}),PaymentError);
  const results=await Promise.allSettled([h.service.refund(ADMIN,body),h.peer().refund(ADMIN,body)]);
  assert.equal(results.some(result=>result.status==="fulfilled"),true);
  const result=await h.service.refund(ADMIN,body);assert.equal(result.status,"partially-refunded");assert.equal(result.refundedCents,100);assert.equal(result.charged,true);
  assert.equal(h.requests.filter(request=>request.method==="POST"&&request.path.includes("refunds")).length,1);
  assert.equal((await h.service.accountingExport(ADMIN,paid.id)).events.length,2);
  await expectError(h.service.refund(ADMIN,{...body,amountCents:101}),"PAYMENT_CONFLICT");
  await expectError(h.service.authorizeProduction({email:CUSTOMER.email,orderId:paid.id,manifestHash:REF,preparedId}),"PRODUCTION_UNAVAILABLE");
});

test("ambiguous refunds block further refunds and reconcile only the saved refund ID",async()=>{
  const h=fixture(),paid=await h.pay();
  h.setDispatch(async()=>processorResponse(refundReply({status:"UNKNOWN"})));
  const body={orderId:paid.id,amountCents:100,reason:"Fictional refund",idempotencyKey:"synthetic-refund-request-123"};
  const pending=await h.service.refund(ADMIN,body);assert.equal(pending.status,"refund-pending");assert.equal(pending.refundedCents,0);
  await expectError(h.service.refund(ADMIN,{...body,idempotencyKey:"different-refund-request-123"}),"PAYMENT_REVIEW_REQUIRED");
  h.setDispatch(async()=>processorResponse(refundReply()));
  const resolved=await h.service.reconcile(ADMIN,{orderId:paid.id});assert.equal(resolved.refundedCents,100);
  assert.equal(h.requests.at(-1).method,"GET");assert.equal(h.requests.at(-1).path,"/charges/synthetic-charge-123/refunds/synthetic-refund-123");
});

test("changing the saved merchant binding invalidates old quotes and blocks refunds/reconciliation",async()=>{
  const h=fixture(),q=await h.makeQuote();h.setBinding({...BINDING,grantId:"b".repeat(64)});
  await expectError(h.service.checkout(CUSTOMER,{quoteId:q.id,idempotencyKey:checkoutKey,paymentToken:TOKEN,consent:true}),"PAYMENT_CONFLICT");assert.equal(h.requests.length,0);
  const paidFixture=fixture(),paid=await paidFixture.pay();paidFixture.setBinding({...BINDING,grantId:"b".repeat(64)});
  await expectError(paidFixture.service.refund(ADMIN,{orderId:paid.id,amountCents:100,reason:"Fictional",idempotencyKey:"synthetic-refund-request-123"}),"PAYMENT_CONFLICT");
});

function grantFixture(overrides={}) {
  let time=NOW,sequence=0;
  const env={QUICKBOOKS_ENVIRONMENT:"sandbox",QUICKBOOKS_CLIENT_ID:"synthetic-client",QUICKBOOKS_CLIENT_SECRET:"synthetic-secret",QUICKBOOKS_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString("base64")};
  const config=quickbooksConfig(env),calls=[],records=new Map();
  const tokens={accessToken:"synthetic-access-token",refreshToken:"synthetic-refresh-token",realmId:"123456789",accessTokenExpiresAt:new Date(NOW+3600_000).toISOString(),grantedScopes:[...QUICKBOOKS_SCOPES]};
  const put=(path,value)=>records.set(path,{value:structuredClone(value),etag:`g-${++sequence}`});
  put(userPath(OWNER.email),OWNER);
  put(QUICKBOOKS_CONNECTION_PATH,{status:"authorized",revision:3,encryptedTokens:encryptQuickBooksTokens(tokens,config),fingerprint:config.fingerprint,credentialVersion:config.credentialVersion,authorizationAttemptId:"synthetic-authorization-attempt",connectedBy:OWNER.email});
  const read=async path=>{await overrides.beforeRead?.(path,records);return records.has(path)?structuredClone(records.get(path)):null;};
  const transport=createQuickBooksPaymentsTransport({read,env,now:()=>time,connection:{refresh:async(...args)=>{calls.push(["refresh",args]);await overrides.refresh?.({records,put,tokens,config});}},
    fetchImpl:async(...args)=>{calls.push(args);return processorResponse(chargeReply());}});
  return {transport,calls,records,env,put,tokens,config,advance:ms=>{time+=ms;}};
}
test("server payment transport binds to the current saved grant and never exposes credentials in its binding",async()=>{
  const h=grantFixture(),binding=await h.transport.binding();assert.equal(binding.environment,"sandbox");assert.match(binding.grantId,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(binding).includes("synthetic-access-token"),false);
  const adapter=createIntuitPaymentsAdapter({transport:h.transport});await adapter.charge(binding,{amountCents:1125,paymentToken:TOKEN,requestId:"synthetic-request-12345"});
  const [url,options]=h.calls[0];assert.equal(url,"https://sandbox.api.intuit.com/quickbooks/v4/payments/charges");assert.equal(options.redirect,"error");assert.equal(options.headers.Authorization,"Bearer synthetic-access-token");
  h.put(QUICKBOOKS_CONNECTION_PATH,{...h.records.get(QUICKBOOKS_CONNECTION_PATH).value,authorizationAttemptId:"replacement-grant"});
  await assert.rejects(adapter.charge(binding,{amountCents:1125,paymentToken:TOKEN,requestId:"synthetic-request-12345"}));assert.equal(h.calls.length,1);
});
test("payment transport rejects production, changed credentials, inactive owner, pending grants and arbitrary endpoints without requests",async()=>{
  for(const mutation of [h=>{h.env.QUICKBOOKS_CLIENT_SECRET="changed";},h=>h.put(userPath(OWNER.email),{...OWNER,status:"suspended"}),h=>h.put(QUICKBOOKS_CONNECTION_PATH,{...h.records.get(QUICKBOOKS_CONNECTION_PATH).value,remoteReviewRequired:true})]) {
    const h=grantFixture();mutation(h);await assert.rejects(h.transport.binding());assert.equal(h.calls.length,0);
  }
  const h=grantFixture(),binding=await h.transport.binding();
  for(const args of [{method:"POST",path:"/tokens"},{method:"GET",path:"https://example.invalid"},{method:"POST",path:"/charges",body:{card:{number:"4111111111111111"}}}])
    await assert.rejects(h.transport.request(binding,{...args,requestId:"synthetic-request-12345"}));
  await assert.rejects(h.transport.request({...binding,environment:"production"},{method:"GET",path:"/charges/test",requestId:"synthetic-request-12345"}));assert.equal(h.calls.length,0);
});
test("only an explicit internal payment operation may refresh a near-expired sandbox grant, with binding continuity",async()=>{
  const h=grantFixture({refresh:async({records,put,tokens,config})=>put(QUICKBOOKS_CONNECTION_PATH,{...records.get(QUICKBOOKS_CONNECTION_PATH).value,revision:5,encryptedTokens:encryptQuickBooksTokens({...tokens,accessTokenExpiresAt:new Date(NOW+7200_000).toISOString()},config)})});
  const original=await h.transport.binding();h.advance(3590_000);
  await assert.rejects(h.transport.binding());assert.equal(h.calls.length,0);
  const refreshed=await h.transport.binding({allowRefresh:true});assert.deepEqual(refreshed,original);assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],"refresh");
});

test("bounded processor diagnostics capture correlation IDs and HTTP outcomes without leaking raw failures to customers",async()=>{
  const tid="12345678-abcd-4321-baad-123456789abc";
  const h=fixture({dispatch:async()=>new Response(JSON.stringify({error:"sensitive token "+TOKEN,card:"4111111111111111"}),{status:503,headers:{intuit_tid:tid}})});
  const result=await h.pay();noInternalData(result);assert.equal(JSON.stringify(result).includes(tid),false);
  const report=await h.service.adminDiagnostics(ADMIN,result.id);
  assert.equal(report.diagnostics.length,1);assert.equal(report.diagnostics[0].intuitTid,tid);assert.equal(report.diagnostics[0].httpStatus,503);
  assert.equal(report.diagnostics[0].operation,"charge-create");assert.equal(report.diagnostics[0].code,"HTTP_ERROR");
  assert.equal(report.diagnostics[0].outcome,"http-error");assert.ok(Date.parse(report.diagnostics[0].at));assert.doesNotMatch(JSON.stringify(report),/synthetic-payment-token|4111111111111111|sensitive token|"card"|"cvc"/);
  await assert.rejects(h.service.adminDiagnostics(CUSTOMER,result.id),error=>error.status===403);
  const malicious=fixture({dispatch:async()=>new Response("invalid",{status:200,headers:{intuit_tid:"private-processor-token-value"}})});
  const bad=await malicious.pay();assert.equal((await malicious.service.adminDiagnostics(ADMIN,bad.id)).diagnostics[0].intuitTid,null);
});

test("official discovery is a bounded public GET and refuses endpoint substitutions",async()=>{
  const document={issuer:"https://oauth.platform.intuit.com/op/v1",authorization_endpoint:INTUIT_AUTHORIZE,token_endpoint:INTUIT_TOKEN,revocation_endpoint:INTUIT_REVOKE};
  for(const environment of ["sandbox","production"]) {
    const calls=[];const result=await verifyQuickBooksDiscovery({environment,now:()=>NOW,fetchImpl:async(...args)=>{calls.push(args);return processorResponse(document);}});
    assert.equal(result.environment,environment);assert.equal(result.tokenEndpoint,INTUIT_TOKEN);assert.equal(calls.length,1);
    assert.equal(calls[0][1].method,"GET");assert.equal(calls[0][1].redirect,"error");assert.equal(calls[0][1].headers.Authorization,undefined);
  }
  await assert.rejects(verifyQuickBooksDiscovery({fetchImpl:async()=>processorResponse({...document,token_endpoint:"https://example.invalid/token"})}),/endpoints changed/);
});

test("sandbox token driver uses only the fixed fabricated fixture without credentials or charges",async()=>{
  const calls=[];const value=await tokenizeSandboxFixture({now:()=>NOW,fetchImpl:async(...args)=>{calls.push(args);return processorResponse({value:"synthetic-card-token-value"});}});
  assert.equal(value,"synthetic-card-token-value");assert.equal(calls.length,1);assert.equal(calls[0][0],"https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens");
  assert.equal(calls[0][1].headers.Authorization,undefined);assert.equal(JSON.parse(calls[0][1].body).card.number,"4111111111111111");
  assert.equal(JSON.parse(calls[0][1].body).card.name,"emulate=0");
  const cors=await checkSandboxTokenCors({fetchImpl:async(url,options)=>{assert.equal(options.method,"OPTIONS");return new Response(null,{status:200,headers:{"access-control-allow-origin":"https://lineagetheater.com","access-control-allow-methods":"POST,OPTIONS","access-control-allow-headers":"content-type,request-id"}});}});
  assert.equal(cors.preflightAllowed,true);assert.equal(cors.actualBrowserTokenizationVerified,false);
});
