import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createQuickBooksAccountingTransport, quickbooksConfig, encryptQuickBooksTokens, forgetQuickBooksAccessToken,
  QUICKBOOKS_CONNECTION_PATH } from "../api/_lib/quickbooks.mjs";
import { createHostedCheckoutService, HOSTED_CHECKOUT_SETTINGS_PATH } from "../api/_lib/hosted-checkout.mjs";
import { createAdminHandler } from "../api/admin.mjs";
import { connections } from "../api/studio.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";

const NOW=Date.parse("2026-09-24T10:00:00Z"),stamp=time=>new Date(time).toISOString();
const owner={email:OWNER_EMAIL,role:"owner",passwordHash:"fictional-password"};
function fixture(overrides={}) {
  let time=NOW,revision=0,hook;
  const records=new Map(),refreshes=[],calls=[];
  const env={QUICKBOOKS_ENVIRONMENT:"production",QUICKBOOKS_CLIENT_ID:"fictional-client",QUICKBOOKS_CLIENT_SECRET:"fictional-secret",
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString("base64")};
  const config=quickbooksConfig(env),binding={environment:"production",realmId:"12345",grantId:digest(`${config.credentialVersion}:12345:fictional-grant`)};
  const tokens={accessToken:"fictional-access-token",refreshToken:"fictional-refresh-token",realmId:binding.realmId,
    accessTokenExpiresAt:stamp(NOW+3600_000),refreshTokenExpiresAt:stamp(NOW+86400_000),refreshTokenHardExpiresAt:null,
    grantedScopes:["com.intuit.quickbooks.accounting"],...overrides.tokens};
  const put=(path,value)=>records.set(path,{value:structuredClone(value),etag:`synthetic-${++revision}`});
  const patch=(path,value)=>put(path,{...records.get(path).value,...value});
  const read=async path=>{await hook?.(path);return structuredClone(records.get(path)||null);};
  put(userPath(owner.email),owner);
  put(QUICKBOOKS_CONNECTION_PATH,{status:"authorized",revision:1,connectedBy:owner.email,authorizationAttemptId:"fictional-grant",
    credentialVersion:config.credentialVersion,fingerprint:config.fingerprint,encryptedTokens:encryptQuickBooksTokens(tokens,config),...overrides.connection});
  put(HOSTED_CHECKOUT_SETTINGS_PATH,{revision:1,enabled:true,serviceItemId:"2",serviceItemName:"Film production",taxCode:"NON",
    deliveryTerms:"Fictional delivery terms",refundTerms:"Fictional refund terms",merchantConfirmed:true,pciAcknowledged:true,
    automaticInvoiceEmailDisabled:true,merchantBinding:binding,...overrides.settings});
  const transport=createQuickBooksAccountingTransport({read,env,now:()=>time,fetchImpl:async()=>{calls.push("accounting");throw Error("Unexpected network call");},
    connection:{refresh:async(actor,body)=>{
      refreshes.push({actor,body});
      patch(QUICKBOOKS_CONNECTION_PATH,{revision:body.expectedRevision+1,encryptedTokens:encryptQuickBooksTokens({...tokens,accessTokenExpiresAt:stamp(time+3600_000)},config)});
    }}});
  const service=createHostedCheckoutService({read,env,transport,now:()=>time,write:async()=>{assert.fail("Status must not write settings or financial records");}});
  return {service,transport,records,refreshes,calls,binding,config,env,read,patch,advance:delta=>{time+=delta;},setHook:value=>{hook=value;}};
}

test("expired access keeps configured admin setup distinct from unavailable customer metadata without rotating tokens",async()=>{
  const h=fixture();h.advance(3600_001);
  const before=structuredClone([...h.records]);
  const state=await h.service.adminConfiguration(owner),settings=await h.service.settings(owner);
  assert.equal(state.available,false);assert.equal(state.configured,true);assert.equal(state.connectionStatus,"renewal-due");
  assert.match(state.reason,/next checkout action will attempt renewal automatically/);
  assert.equal(settings.configured,true);assert.equal(settings.connectionStatus,"renewal-due");
  assert.equal(settings.serviceItemId,"2");assert.equal(settings.revision,1);
  assert.deepEqual(await h.service.configuration(owner),{available:false});
  assert.deepEqual(await h.transport.readiness(),{binding:h.binding,status:"renewal-due"});
  assert.deepEqual([...h.records],before);assert.equal(h.refreshes.length,0);assert.equal(h.calls.length,0);
  assert.doesNotMatch(JSON.stringify(state),/fictional-(?:access|refresh)|realmId|grantId|merchantBinding/);
  const current=await h.service.configuration(owner,{allowRefresh:true});
  assert.equal(current.available,true);assert.equal(h.refreshes.length,1);
  assert.deepEqual(await h.transport.binding(),h.binding);
  assert.equal((await h.service.adminConfiguration(owner)).connectionStatus,"ready");
  assert.deepEqual(h.records.get(HOSTED_CHECKOUT_SETTINGS_PATH),before.find(([path])=>path===HOSTED_CHECKOUT_SETTINGS_PATH)[1]);
});

test("near-expiry and cold-memory grants describe renewal only when saved refresh metadata is usable",async()=>{
  for(const cold of [false,true]) {
    const h=fixture();
    if(cold)forgetQuickBooksAccessToken(h.records.get(QUICKBOOKS_CONNECTION_PATH).value.encryptedTokens,h.config);
    else h.advance(3540_000);
    assert.equal((await h.service.adminConfiguration(owner)).connectionStatus,"renewal-due");
    assert.equal(h.refreshes.length,0);assert.equal(h.calls.length,0);
  }
  for(const tokens of [{refreshToken:undefined},{refreshToken:""},{refreshToken:"bad token"},{refreshToken:"x".repeat(16_385)},
    {refreshTokenExpiresAt:null},{refreshTokenExpiresAt:"invalid"},{refreshTokenExpiresAt:stamp(NOW)},
    {refreshTokenHardExpiresAt:stamp(NOW)},{refreshTokenHardExpiresAt:"invalid"},{refreshTokenHardExpiresAt:""}]) {
    const h=fixture({tokens});h.advance(3600_001);
    const state=await h.service.adminConfiguration(owner);
    assert.equal(state.configured,false);assert.equal(state.available,false);assert.equal(state.connectionStatus,"needs-attention");
    assert.equal(h.refreshes.length,0);assert.equal(h.calls.length,0);
  }
});

test("blocked, rejected, uncertain, replaced and revoked grants cannot be labeled renewable",async()=>{
  for(const connection of [{status:"refresh-blocked",refreshStatus:"reconnect-required"},{status:"refresh-blocked",refreshStatus:"credentials-rejected"},
    {remoteReviewRequired:true},{refreshOperation:{}},{pending:{}},{revocationStatus:"pending"},{remoteCleanup:{status:"pending"}},
    {fingerprint:"changed"},{credentialVersion:"changed"},{status:"disconnected"}]) {
    const h=fixture({connection});h.advance(3600_001);
    assert.equal((await h.service.adminConfiguration(owner)).connectionStatus,"needs-attention");
    assert.equal((await h.service.settings(owner)).configured,false);
    assert.deepEqual(await h.service.configuration(owner),{available:false});
    assert.equal(h.refreshes.length,0);assert.equal(h.calls.length,0);
  }
  const changed=fixture({connection:{authorizationAttemptId:"different-grant"}});changed.advance(3600_001);
  assert.equal((await changed.service.adminConfiguration(owner)).connectionStatus,"setup-required");
  const revoked=fixture();revoked.patch(userPath(owner.email),{status:"suspended"});
  await assert.rejects(revoked.service.adminConfiguration(owner));await assert.rejects(revoked.service.settings(owner));
  const customer={email:"customer@example.invalid",role:"customer",status:"active",approvedAt:stamp(NOW),approvedBy:owner.email};
  revoked.records.set(userPath(customer.email),{value:customer,etag:"customer"});
  await assert.rejects(revoked.service.adminConfiguration(customer),error=>error.status===403);
});

test("missing checkout setup remains distinct and races fail closed without refresh or writes",async()=>{
  const missing=fixture({settings:{serviceItemId:""}});missing.advance(3600_001);
  assert.equal((await missing.service.adminConfiguration(owner)).connectionStatus,"setup-required");
  for(const mutation of [h=>h.patch(QUICKBOOKS_CONNECTION_PATH,{authorizationAttemptId:"changed"}),
    h=>h.patch(userPath(owner.email),{status:"suspended"}),h=>h.patch(userPath(owner.email),{passwordHash:"changed"}),
    h=>{h.env.QUICKBOOKS_CLIENT_SECRET="changed";}]) {
    const h=fixture();h.advance(3600_001);let connectionReads=0;
    h.setHook(path=>{if(path===QUICKBOOKS_CONNECTION_PATH&&++connectionReads===2)mutation(h);});
    await assert.rejects(h.transport.readiness());assert.equal(h.refreshes.length,0);assert.equal(h.calls.length,0);
  }
  const changing=fixture();let settingsReads=0;
  changing.setHook(path=>{if(path===HOSTED_CHECKOUT_SETTINGS_PATH&&++settingsReads===2)changing.patch(path,{enabled:false});});
  assert.equal((await changing.service.adminConfiguration(owner)).connectionStatus,"needs-attention");
});

test("admin overview and payment list use read-only renewable status without claiming payment or production availability",async()=>{
  const h=fixture();h.advance(3600_001);
  const handler=createAdminHandler({getSession:async()=>({user:owner}),hostedCheckout:h.service,readRecord:h.read,
    recordPage:async()=>({records:[]}),readPricingSettings:async()=>({markupBasisPoints:0,revision:0}),
    connections:options=>connections({...options,key:null}),writeRecord:async()=>assert.fail("No writes on GET")});
  async function get(action) {
    let status,result;await handler({method:"GET",url:`/api/admin?action=${action}`,headers:{host:"lineagetheater.com"}},
      {set statusCode(value){status=value;},setHeader(){},end(value){result=JSON.parse(value);}});
    assert.equal(status,200);return result;
  }
  const payments=await get("payments"),overview=await get("overview");
  assert.equal(payments.configured,true);assert.equal(payments.connectionReady,false);assert.equal(payments.connectionStatus,"renewal-due");
  assert.equal(overview.connections.billing.status,"renewal-due");assert.equal(overview.connections.billing.available,false);
  assert.equal(overview.connections.magiclight.available,false);assert.match(overview.connections.magiclight.reason,/Generation settings and finished-film delivery still need verification/);
  assert.doesNotMatch(overview.connections.magiclight.reason,/awaiting.*API connection/);
  assert.equal(h.calls.length,0);assert.equal(h.refreshes.length,0);
});
