import test from "node:test";
import assert from "node:assert/strict";
import { connections, createStudioHandler } from "../api/studio.mjs";
import { digest } from "../api/_lib/auth.mjs";
import { generateStory, prepareStory } from "../api/_lib/story.mjs";

const actor={email:"customer@example.invalid",role:"customer",status:"active"};
const internalDetails=/OpenAI|GPT-6|Astra|MagicLight|QuickBooks|Intuit|BROCOTech|supplier|markup|referenceRate|providerCredits|providerCost|storyModel|connections|credential/i;
const ready=()=>({story:true,storyModel:"gpt-6-astra",magiclight:false,billing:false,
  connections:{story:{available:true,reason:"OpenAI GPT-6 Astra connected"},magiclight:{available:false,reason:"MagicLight API connection pending"}},
  payment:{provider:"quickbooks",label:"QuickBooks"},
  quality:{preference:"highest",label:"MagicLight supplier quality",verified:false},
  pricing:{currency:"USD",referenceRate:{amountCents:110},markupBasisPoints:1250,providerCostCents:2500,
    estimate:{amountCents:2813,providerCredits:1000,reason:"Supplier cost with BROCOTech markup"},chargeReady:true}});
const coverage=()=>({totalSources:1,readSources:1,textCharacters:50,photoSources:0,photosRead:0,notesOnlySources:0,warnings:[]});
const story=()=>({themes:[{title:"A fictional family garden",plot:"A family grows a garden",climax:"A shared harvest",reason:"Supplied family memory"}],
  sourceCoverage:coverage(),generatedBy:"GPT-6 Astra",model:"gpt-6-astra",generatedAt:"2026-09-14T12:00:00.000Z"});

function harness(overrides={},user=actor) {
  const calls={connections:0,pricing:0,generation:[],limits:[],reads:[]};
  const handler=createStudioHandler({getSession:async()=>user?{user}:null,
    connections:async()=>{calls.connections++;return ready();},
    readPricingSettings:async()=>{calls.pricing++;return {markupBasisPoints:1250,revision:2};},
    generateStory:async body=>{calls.generation.push(body);return story();},
    limitAction:async(...args)=>{calls.limits.push(args);return true;},
    readRecord:async path=>{calls.reads.push(path);return null;},...overrides});
  async function run(action,{method="GET",body={},headers={},id}={}) {
    let status,output;
    await handler({method,url:`/api/studio?action=${action}${id?`&id=${id}`:""}`,
      headers:{host:"lineagetheater.com",origin:"https://lineagetheater.com",...headers},
      ...(method==="POST"?{body:{...body,action}}:{})},
      {set statusCode(v){status=v;},setHeader(){},end(value){output=JSON.parse(value);}});
    return {status,body:output};
  }
  return {calls,run};
}
const post=(body={})=>({method:"POST",body});
const assertCustomerSafe=result=>assert.doesNotMatch(JSON.stringify(result.body),internalDetails);

test("customer capabilities are an explicit allowlist, excluding detailed supplier diagnostics and prices",async()=>{
  const h=harness();
  const result=await h.run("capabilities");
  assert.equal(result.status,200);
  assert.deepEqual(result.body,{
    story:true,production:false,billing:false,
    pricing:{currency:"USD",estimate:{status:"unavailable",amountCents:null,reason:"Your film's price will be confirmed before you approve a payment."},chargeReady:false},
    quality:{label:"Animation quality will be confirmed before production",verified:false},
  });
  assertCustomerSafe(result);
  const unverified=await harness({connections:async()=>({...ready(),story:"true",magiclight:"true",billing:1,quality:{verified:"true",label:"Unverified supplier tier"}})}).run("capabilities");
  assert.equal(unverified.body.story,false);assert.equal(unverified.body.production,false);
  assert.equal(unverified.body.billing,false);assert.equal(unverified.body.quality.verified,false);
  assertCustomerSafe(unverified);
});

test("admin connection diagnostics still retain model, provider, merchant, and pricing setup information",async()=>{
  const result=await connections({key:"synthetic-test-key",fetchImpl:async()=>new Response("",{status:200}),pricingSettings:{markupBasisPoints:1250,revision:2}});
  assert.equal(result.storyModel,"gpt-6-astra");assert.equal(result.story,true);
  assert.match(result.connections.story.reason,/GPT-6 Astra/);
  assert.match(result.connections.magiclight.reason,/MagicLight/);
  assert.match(result.connections.billing.reason,/QuickBooks/);
  assert.match(result.connections.billing.reason,/12.5% BROCOTech markup/);
  assert.equal(result.pricing.markupBasisPoints,1250);
  assert.equal(result.magiclight,false);assert.equal(result.billing,false);
});

test("story responses retain screenplay and evidence content but expose only Lineage Theatre metadata",async()=>{
  for(const action of ["themes","plan"]) {
    const generated={...story(),logline:"A fictional family garden",selectedThemes:story().themes,
      characters:[{id:"ada",name:"Fictional Ada"}],assumptions:[],scenes:[{title:"The harvest"}],
      provider:"OpenAI",providerCostCents:1,sourceCoverage:{...coverage(),supplier:"OpenAI"}};
    const h=harness({generateStory:async()=>generated});
    const result=await h.run(action,post({storyConsent:true}));
    assert.equal(result.status,200);assert.equal(result.body.generatedBy,"Lineage Theatre");
    assert.equal(result.body.generatedAt,generated.generatedAt);
    assert.deepEqual(result.body.sourceCoverage,coverage());
    assert.deepEqual(Object.keys(result.body).sort(),(action==="themes"?
      ["themes","sourceCoverage","generatedBy","generatedAt"]:
      ["logline","selectedThemes","characters","assumptions","scenes","sourceCoverage","generatedBy","generatedAt"]).sort());
    assert.deepEqual(result.body[action==="themes"?"themes":"scenes"],generated[action==="themes"?"themes":"scenes"]);
    assert.equal(generated.model,"gpt-6-astra");
    assertCustomerSafe(result);
  }
});

test("provider availability, output validation, and unknown failures never echo internal error details",async()=>{
  for(const status of [401,403,404,429,500]) {
    const h=harness({generateStory:body=>generateStory(body,{key:"synthetic-test-key",fetchImpl:async()=>new Response("",{status})})});
    const result=await h.run("themes",post({storyConsent:true,project:{ancestor:"Fictional Ada",sources:[]}}));
    assert.equal(result.status,503);assert.match(result.body.message,/Story development is temporarily unavailable/);
    assertCustomerSafe(result);
  }
  for(const message of ["Astra returned an incomplete screenplay. Your sources are saved; try again.",
    "The screenplay supplier cost is 100 and the credential expired.","Confirm that OpenAI may read these family materials to develop your film.","private diagnostic detail"]) {
    const result=await harness({generateStory:async()=>{throw new Error(message);}}).run("plan",post({storyConsent:true}));
    assert.equal(result.status,503);assertCustomerSafe(result);assert.equal(result.body.message.includes(message),false);
  }
  const failedCapabilities=await harness({connections:async()=>{throw new Error("QuickBooks merchant credential is unavailable");}}).run("capabilities");
  assert.equal(failedCapabilities.status,503);assertCustomerSafe(failedCapabilities);
});

test("source validation keeps actionable customer feedback without calling a provider",async()=>{
  const h=harness({generateStory:async body=>prepareStory(body)});
  const result=await h.run("plan",post({storyConsent:true,project:{ancestor:"",sources:[]}}));
  assert.equal(result.status,503);assert.equal(result.body.message,"Add the ancestor or family at the heart of the film.");
  assertCustomerSafe(result);
});

test("studio requests require a session and same-origin writes before reading or generating anything",async()=>{
  const unsigned=harness({},null);
  for(const [action,options] of [["capabilities",{}],["themes",post({storyConsent:true})],["checkout",post()]]) {
    assert.equal((await unsigned.run(action,options)).status,401);
  }
  assert.deepEqual(unsigned.calls,{connections:0,pricing:0,generation:[],limits:[],reads:[]});
  const signed=harness();
  for(const action of ["plan","generate","quote","checkout"]) {
    const result=await signed.run(action,{...post({storyConsent:true}),headers:{origin:"https://other.example.invalid"}});
    assert.equal(result.status,403);assertCustomerSafe(result);
  }
  assert.deepEqual(signed.calls,{connections:0,pricing:0,generation:[],limits:[],reads:[]});
});

test("explicit story consent and per-user rate limits remain required before generation",async()=>{
  const h=harness();
  for(const storyConsent of [undefined,false,"true"]) {
    const result=await h.run("themes",post({storyConsent}));
    assert.equal(result.status,400);assert.match(result.body.message,/AI-assisted story development/);assertCustomerSafe(result);
  }
  assert.equal(h.calls.generation.length,0);assert.equal(h.calls.limits.length,0);
  const result=await h.run("themes",post({storyConsent:true}));
  assert.equal(result.status,200);assert.equal(h.calls.generation.length,1);
  assert.deepEqual(h.calls.limits,[[`story:${actor.email}`,20,3600_000]]);
  const limited=harness({limitAction:async()=>false});
  assert.equal((await limited.run("plan",post({storyConsent:true}))).status,429);
  assert.equal(limited.calls.generation.length,0);
});

test("production, quotes, and checkout fail closed without client provider names or charge claims",async()=>{
  const h=harness();
  for(const action of ["generate","quote","checkout"]) {
    for(const provider of [undefined,"magiclight","another-provider"]) {
      const result=await h.run(action,post({provider,amountCents:1,charged:true}));
      assert.equal(result.status,503);assert.equal(result.body.code,"PRODUCTION_UNAVAILABLE");
      assert.equal(result.body.charged,false);assert.match(result.body.message,/continue writing and saving/);
      assertCustomerSafe(result);
    }
  }
  assert.deepEqual(h.calls,{connections:0,pricing:0,generation:[],limits:[],reads:[]});
});

test("legacy production messages are neutral and records remain scoped to the signed-in customer",async()=>{
  const id="synthetic-production-123456";
  const h=harness();
  assert.equal((await h.run("status",{id:"invalid"})).status,400);assert.equal(h.calls.reads.length,0);
  assert.equal((await h.run("status",{id})).status,404);
  assert.deepEqual(h.calls.reads,[`jobs/${digest(actor.email)}/${id}.json`]);
  for(const action of ["status","media"]) {
    const result=await harness({readRecord:async()=>({value:{provider:"MagicLight"}})}).run(action,{id});
    assert.equal(result.status,409);assert.match(result.body.message,/Downloaded films remain in your library/);assertCustomerSafe(result);
  }
});
