import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createQuickBooksAccountingTransport, quickbooksConfig, encryptQuickBooksTokens, forgetQuickBooksAccessToken,
  QUICKBOOKS_CONNECTION_PATH } from "../api/_lib/quickbooks.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

// All accounts, credentials, requests and responses are fabricated in memory.
const NOW=Date.parse("2026-09-23T12:00:00.000Z"),REALM="123456789",REQUEST="d36681c1-991b-52da-86e4-69fe1c18b775";
const OWNER={email:OWNER_EMAIL,role:"owner",passwordHash:"synthetic-password"};
const customer=()=>({DisplayName:"customer@example.invalid",PrimaryEmailAddr:{Address:"customer@example.invalid"}});
const invoice=()=>({CustomerRef:{value:"12"},BillEmail:{Address:"customer@example.invalid"},
  Line:[{Amount:5.67,DetailType:"SalesItemLineDetail",Description:"Film production",SalesItemLineDetail:{ItemRef:{value:"42"},Qty:1,UnitPrice:5.67,TaxCodeRef:{value:"NON"}}}],
  CurrencyRef:{value:"USD"},AllowOnlineCreditCardPayment:true,AllowOnlineACHPayment:true,EmailStatus:"NotSet",PrivateNote:"Synthetic order only"});
function fixture(options={}) {
  let clock=NOW,revision=0,readHook;
  const records=new Map(),calls=[],refreshes=[];
  const env={QUICKBOOKS_ENVIRONMENT:options.environment||"production",QUICKBOOKS_CLIENT_ID:"synthetic-client",QUICKBOOKS_CLIENT_SECRET:"synthetic-secret",
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString("base64")};
  const config=quickbooksConfig(env);
  const tokens={accessToken:"synthetic-access-token",refreshToken:"synthetic-refresh-token",realmId:REALM,
    accessTokenExpiresAt:new Date(NOW+3600_000).toISOString(),refreshTokenExpiresAt:new Date(NOW+86400_000).toISOString(),
    grantedScopes:["com.intuit.quickbooks.accounting"],...options.tokens};
  const put=(path,value)=>records.set(path,{value:structuredClone(value),etag:`a-${++revision}`});
  put(userPath(OWNER_EMAIL),OWNER);
  put(QUICKBOOKS_CONNECTION_PATH,{status:"authorized",revision:1,connectedBy:OWNER_EMAIL,authorizationAttemptId:"synthetic-attempt",
    credentialVersion:config.credentialVersion,fingerprint:config.fingerprint,encryptedTokens:encryptQuickBooksTokens(tokens,config)});
  const read=async path=>{await readHook?.(path);return structuredClone(records.get(path)||null);};
  const binding={environment:config.environment,grantId:digest(`${config.credentialVersion}:${REALM}:synthetic-attempt`),realmId:REALM};
  const transport=createQuickBooksAccountingTransport({read,env,now:()=>clock,financeReadOnly:options.financeReadOnly===true,
    connection:{refresh:async(actor,body)=>{
      refreshes.push({actor:structuredClone(actor),body});
      const saved=records.get(QUICKBOOKS_CONNECTION_PATH).value;
      assert.equal(body.expectedRevision,saved.revision);
      put(QUICKBOOKS_CONNECTION_PATH,{...saved,revision:saved.revision+1,
        encryptedTokens:encryptQuickBooksTokens({...tokens,accessToken:"synthetic-new-access",accessTokenExpiresAt:new Date(clock+3600_000).toISOString()},config)});
      await options.afterRefresh?.({put,records,env});
    }},
    fetchImpl:async(...args)=>{calls.push(args);return options.fetchImpl?options.fetchImpl(...args):new Response('{"Invoice":{"Id":"93"}}',{status:200,headers:{"content-type":"application/json"}});}});
  return {transport,env,config,tokens,binding,records,put,calls,refreshes,advance:ms=>{clock+=ms;},hook:value=>{readHook=value;}};
}
const invalid=error=>error?.code==="ACCOUNTING_REQUEST_INVALID";
const unavailable=error=>error?.code==="ACCOUNTING_CONNECTION_UNAVAILABLE";

test("Accounting binding and reads use only the current environment/company without Payments approval",async()=>{
  for(const environment of ["production","sandbox"]) {
    const h=fixture({environment}),before=structuredClone([...h.records]);
    assert.deepEqual(await h.transport.binding(),h.binding);assert.deepEqual([...h.records],before);
    assert.equal(h.refreshes.length,0);assert.equal(h.calls.length,0);
    for(const path of ["/preferences","/item/42","/customer/12","/invoice/93","/payment/9"]) {
      const response=await h.transport.request(h.binding,{method:"GET",path});assert.equal(response.status,200);
      const [url,options]=h.calls.at(-1),parsed=new URL(url);
      assert.equal(parsed.origin,environment==="production"?"https://quickbooks.api.intuit.com":"https://sandbox-quickbooks.api.intuit.com");
      assert.equal(parsed.pathname,`/v3/company/${REALM}${path}`);
      assert.equal(parsed.searchParams.get("include"),path.startsWith("/invoice/")?"invoiceLink":null);
      assert.equal(options.headers.Authorization,"Bearer synthetic-access-token");assert.equal(options.redirect,"error");assert.equal(options.body,undefined);
    }
    assert.doesNotMatch(JSON.stringify(h.binding),/access|refresh|secret|paymentReady/i);
  }
});

test("Accounting requires the recorded scope when available and all current grant/owner gates",async()=>{
  for(const grantedScopes of [[],["com.intuit.quickbooks.payment"],"com.intuit.quickbooks.accounting"]) {
    const h=fixture({tokens:{grantedScopes}});await assert.rejects(h.transport.binding(),unavailable);assert.equal(h.calls.length,0);
  }
  for(const grantedScopes of [null,undefined])assert.ok(await fixture({tokens:{grantedScopes}}).transport.binding());
  for(const patch of [{status:"disconnected"},{pending:{}},{refreshOperation:{}},{remoteReviewRequired:true},
    {revocationStatus:"pending"},{remoteCleanup:{status:"pending"}},{authorizationAttemptId:""},{credentialVersion:"changed"},{fingerprint:"changed"}]) {
    const h=fixture();h.put(QUICKBOOKS_CONNECTION_PATH,{...h.records.get(QUICKBOOKS_CONNECTION_PATH).value,...patch});
    await assert.rejects(h.transport.binding(),unavailable);assert.equal(h.calls.length,0);assert.equal(h.refreshes.length,0);
  }
  for(const account of [null,{email:OWNER_EMAIL},{...OWNER,role:"admin"},{...OWNER,status:"suspended"},{...OWNER,mustChangePassword:true}]) {
    const h=fixture();if(account)h.put(userPath(OWNER_EMAIL),account);else h.records.delete(userPath(OWNER_EMAIL));
    await assert.rejects(h.transport.binding(),unavailable);assert.equal(h.calls.length,0);
  }
  const changed=fixture();changed.env.QUICKBOOKS_CLIENT_SECRET="changed-secret";
  await assert.rejects(changed.transport.binding(),unavailable);
});

test("metadata reads never refresh; explicit requests renew expired or missing memory access once on the same grant",async()=>{
  for(const cold of [false,true]) {
    const h=fixture();
    if(cold)forgetQuickBooksAccessToken(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens,h.config);else h.advance(3600_001);
    const before=structuredClone([...h.records]);
    if(cold)assert.deepEqual(await h.transport.binding(),h.binding);else await assert.rejects(h.transport.binding(),unavailable);
    assert.deepEqual([...h.records],before);assert.equal(h.refreshes.length,0);
    await h.transport.request(h.binding,{method:"GET",path:"/preferences"});
    assert.equal(h.refreshes.length,1);assert.deepEqual(h.refreshes[0],{actor:OWNER,body:{expectedRevision:1}});
    assert.equal(h.calls[0][1].headers.Authorization,"Bearer synthetic-new-access");
    assert.deepEqual(await h.transport.binding({allowRefresh:true}),h.binding);assert.equal(h.refreshes.length,1);
  }
  const changed=fixture({afterRefresh:({put,records})=>put(QUICKBOOKS_CONNECTION_PATH,{...records.get(QUICKBOOKS_CONNECTION_PATH).value,authorizationAttemptId:"new-grant"})});
  changed.advance(3600_001);await assert.rejects(changed.transport.request(changed.binding,{method:"GET",path:"/preferences"}),unavailable);
  assert.equal(changed.refreshes.length,1);assert.equal(changed.calls.length,0);
});

test("stale expected grants cannot refresh or send, and owner/configuration changes immediately before send fail closed",async()=>{
  for(const patch of [{environment:"sandbox"},{realmId:"999"},{grantId:"b".repeat(64)}]) {
    const h=fixture();h.advance(3600_001);
    await assert.rejects(h.transport.request({...h.binding,...patch},{method:"GET",path:"/preferences"}),unavailable);
    assert.equal(h.refreshes.length,0);assert.equal(h.calls.length,0);
  }
  for(const mutate of [h=>h.put(QUICKBOOKS_CONNECTION_PATH,{...h.records.get(QUICKBOOKS_CONNECTION_PATH).value,authorizationAttemptId:"replacement"}),
    h=>h.put(userPath(OWNER_EMAIL),{...OWNER,status:"suspended"}),h=>h.put(userPath(OWNER_EMAIL),{...OWNER,passwordHash:"replacement-password"}),
    h=>{h.env.QUICKBOOKS_CLIENT_SECRET="replacement-secret";},h=>h.advance(3600_001)]) {
    const h=fixture();let reads=0;h.hook(path=>{if(path===QUICKBOOKS_CONNECTION_PATH&&++reads===2)mutate(h);});
    await assert.rejects(h.transport.request(h.binding,{method:"GET",path:"/preferences"}),unavailable);assert.equal(h.calls.length,0);
  }
  const h=fixture();let ownerReads=0;
  h.hook(path=>{if(path===userPath(OWNER_EMAIL)&&++ownerReads===2)
    h.put(QUICKBOOKS_CONNECTION_PATH,{...h.records.get(QUICKBOOKS_CONNECTION_PATH).value,authorizationAttemptId:"replaced-during-owner-check"});});
  await assert.rejects(h.transport.request(h.binding,{method:"POST",path:"/invoice",body:invoice(),requestId:REQUEST}),unavailable);
  assert.equal(h.calls.length,0);
});

test("structured queries compile only bounded entity selects and conservative single-value filters",async()=>{
  const h=fixture();
  await h.transport.request(h.binding,{method:"GET",path:"/query",query:{entity:"Item",where:{field:"Active",value:true},startPosition:1,maxResults:1000}});
  assert.equal(new URL(h.calls[0][0]).searchParams.get("query"),"SELECT * FROM Item WHERE Active = true STARTPOSITION 1 MAXRESULTS 1000");
  await h.transport.request(h.binding,{method:"GET",path:"/query",query:{entity:"Customer",where:{field:"DisplayName",value:"film+owner@example.invalid"},maxResults:2}});
  assert.equal(new URL(h.calls[1][0]).searchParams.get("query"),"SELECT * FROM Customer WHERE DisplayName = 'film+owner@example.invalid' STARTPOSITION 1 MAXRESULTS 2");
  for(const entity of ["Invoice","Payment","Account"])await h.transport.request(h.binding,{method:"GET",path:"/query",query:{entity,where:{field:"Id",value:"123"}}});
  const before=h.calls.length;
  for(const query of ["SELECT * FROM Customer",{entity:"Vendor"},{entity:"Item; DELETE FROM Customer"},{entity:"Customer",query:"SELECT * FROM Customer"},
    {entity:"Customer",where:{field:"DisplayName",value:"a' OR '1'='1"}},{entity:"Customer",where:{field:"DisplayName",value:"a\\b"}},
    {entity:"Item",where:{field:"Active",value:"true"}},{entity:"Item",where:{field:"DisplayName",value:"A"}},
    {entity:"Customer",where:{field:"Id",value:"1 OR 1=1"}},{entity:"Customer",maxResults:1001},{entity:"Customer",startPosition:0},
    {entity:"Customer",maxResults:1.5},{entity:"Customer",where:{field:"Id",value:"1",operator:"LIKE"}}])
    await assert.rejects(h.transport.request(h.binding,{method:"GET",path:"/query",query}),invalid);
  assert.equal(h.calls.length,before);
});

test("allowlists reject arbitrary origins, paths, writes, email delivery and injected parameters before refresh",async()=>{
  const h=fixture();h.advance(3600_001);
  for(const operation of [{method:"GET",path:"https://evil.invalid"},{method:"GET",path:"/invoice/1?sendTo=a"},{method:"GET",path:"/invoice/../preferences"},
    {method:"GET",path:"/invoice/%31"},{method:"POST",path:"/invoice/1/send"},{method:"POST",path:"/payment"},{method:"DELETE",path:"/invoice/1"},
    {method:"GET",path:"/preferences",query:{minorversion:"999"}},{method:"GET",path:"/invoice/1",query:{include:"invoiceLink",sendTo:"a@example.invalid"}},
    {method:"GET",path:"/preferences",body:{}},{method:"GET",path:"/preferences",requestId:REQUEST},{method:"GET",path:"/preferences",allowRefresh:true},
    {method:"GET",path:{value:"/preferences"}},{method:"POST",path:"/customer",body:customer()},{method:"POST",path:"/customer",body:customer(),requestId:"not-uuid"}])
    await assert.rejects(h.transport.request(h.binding,operation),invalid);
  assert.equal(h.calls.length,0);assert.equal(h.refreshes.length,0);
});

test("recorded reversal entities allow only bounded selects with verified Id filters and no new mutation paths",async()=>{
  const h=fixture();
  for(const entity of ["RefundReceipt","CreditMemo","Purchase","JournalEntry","Deposit"]) {
    await h.transport.request(h.binding,{method:"GET",path:"/query",query:{entity,startPosition:101,maxResults:100}});
    assert.equal(new URL(h.calls.at(-1)[0]).searchParams.get("query"),`SELECT * FROM ${entity} STARTPOSITION 101 MAXRESULTS 100`);
    await assert.rejects(h.transport.request(h.binding,{method:"GET",path:"/query",query:{entity,where:{field:"CustomerRef",value:"12"}}}),invalid);
    await assert.rejects(h.transport.request(h.binding,{method:"POST",path:`/${entity.toLowerCase()}`,body:{},requestId:REQUEST}),invalid);
    await assert.rejects(h.transport.request(h.binding,{method:"GET",path:`/${entity.toLowerCase()}/12`}),invalid);
  }
  assert.equal(h.calls.length,5);
});

test("minimal customer/invoice creation uses the provided UUID requestid and never invents a new mutation identity",async()=>{
  const h=fixture();
  for(const [path,body] of [["/customer",customer()],["/invoice",invoice()]]) {
    await h.transport.request(h.binding,{method:"POST",path,body,requestId:REQUEST});
    const [url,options]=h.calls.at(-1),parsed=new URL(url);
    assert.equal(parsed.searchParams.get("requestid"),REQUEST);assert.equal(parsed.searchParams.size,1);
    assert.deepEqual(JSON.parse(options.body),body);assert.equal(options.headers["Content-Type"],"application/json");assert.equal(options.headers["Request-Id"],undefined);
  }
  const before=structuredClone([...h.records]);
  await h.transport.request(h.binding,{method:"POST",path:"/invoice",body:invoice(),requestId:REQUEST});
  assert.equal(h.calls[1][0],h.calls[2][0]);assert.equal(h.calls[1][1].body,h.calls[2][1].body);assert.deepEqual([...h.records],before);
});

test("creation rejects card/token/send fields, malformed nested data, different money, and unsupported tax/currency",async()=>{
  const h=fixture();
  const invalidCustomers=[{...customer(),card:{number:"4111111111111111"}},{...customer(),token:"secret"},{...customer(),PreferredDeliveryMethod:"Email"},
    {...customer(),PrimaryEmailAddr:{Address:"customer@example.invalid",token:"secret"}},{...customer(),PrimaryEmailAddr:{Address:"invalid"}}];
  for(const body of invalidCustomers)await assert.rejects(h.transport.request(h.binding,{method:"POST",path:"/customer",body,requestId:REQUEST}),invalid);
  for(const change of [body=>{body.EmailStatus="NeedToSend";},body=>{body.BillEmailCc={Address:"other@example.invalid"};},body=>{body.CreditCardPayment={};},
    body=>{body.SyncToken="0";},body=>{body.Id="93";},body=>{body.Line[0].Amount=5.68;},body=>{body.Line[0].Amount=NaN;},
    body=>{body.Line[0].SalesItemLineDetail.TaxCodeRef.value="TAX";},body=>{body.CurrencyRef.value="CAD";},body=>{body.Line[0].SalesItemLineDetail.Qty=2;},
    body=>{body.Line.push(structuredClone(body.Line[0]));},body=>{body.CustomerRef.value="../other";},body=>{body.Line[0].SalesItemLineDetail.card={};}]) {
    const body=invoice();change(body);await assert.rejects(h.transport.request(h.binding,{method:"POST",path:"/invoice",body,requestId:REQUEST}),invalid);
  }
  assert.equal(h.calls.length,0);assert.equal(h.refreshes.length,0);
});

test("known server secrets cannot be serialized into Accounting fields and network errors never leak or retry",async()=>{
  const h=fixture();
  for(const secret of [h.tokens.accessToken,h.tokens.refreshToken,h.env.QUICKBOOKS_CLIENT_SECRET,h.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY]) {
    const body=invoice();body.PrivateNote=`Unexpected ${secret}`;
    await assert.rejects(h.transport.request(h.binding,{method:"POST",path:"/invoice",body,requestId:REQUEST}),invalid);
  }
  assert.equal(h.calls.length,0);
  const broken=fixture({fetchImpl:async()=>{throw new Error("Private synthetic credential response");}});
  await assert.rejects(broken.transport.request(broken.binding,{method:"POST",path:"/invoice",body:invoice(),requestId:REQUEST}),error=>{
    assert.equal(error.code,"ACCOUNTING_REQUEST_UNCERTAIN");assert.doesNotMatch(error.message,/Private|credential response/);return true;
  });
  assert.equal(broken.calls.length,1);assert.equal(broken.refreshes.length,0);
});

test('finance transport adds report and entity reads while forbidding every accounting write',async()=>{
  const h=fixture({financeReadOnly:true});
  await h.transport.request(h.binding,{method:'GET',path:`/companyinfo/${REALM}`});
  await h.transport.request(h.binding,{method:'GET',path:'/query',query:{entity:'Vendor',where:'Balance > 0',page_size:20}});
  await h.transport.request(h.binding,{method:'GET',path:'/reports/ProfitAndLoss',query:{report:'ProfitAndLoss',start_date:'2026-01-01',end_date:'2026-09-25',accounting_method:'Cash'}});
  assert.equal(h.calls.length,3);assert.equal(h.calls.every(([,init])=>init.method==='GET'),true);
  assert.equal(new URL(h.calls[1][0]).searchParams.get('query'),'SELECT * FROM Vendor WHERE Balance > 0 STARTPOSITION 1 MAXRESULTS 20');
  for(const operation of [{method:'POST',path:'/customer',body:customer(),requestId:REQUEST},{method:'POST',path:'/invoice',body:invoice(),requestId:REQUEST},
    {method:'GET',path:'/companyinfo/999'},{method:'GET',path:'/reports/BalanceSheet',query:{report:'ProfitAndLoss',start_date:'2026-01-01',end_date:'2026-09-25',accounting_method:'Cash'}}])
    await assert.rejects(h.transport.request(h.binding,operation),invalid);
  assert.equal(h.calls.length,3);
});
