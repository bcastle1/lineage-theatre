import { resolveBrowserTestImports } from './helpers/browser-imports.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
const compile=async path=>ts.transpileModule(await readFile(new URL(path,import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const url=source=>`data:text/javascript;base64,${Buffer.from(resolveBrowserTestImports(source)).toString("base64")}`;
const model=url(await compile("../src/studio/model.ts"));
const library=url(await compile("../src/studio/film-library.ts"));
const {prepareFilmPrice,normalizeFilmPrice}=await import(url((await compile("../src/studio/film-pricing.ts"))
  .replace('"./model"',JSON.stringify(model)).replace('"./film-library"',JSON.stringify(library))));
const {productionInputHash}=await import(model);
const NOW=Date.now(),input=JSON.stringify({id:"film-example",title:"Fictional garden"});
const prepared={id:"00000000-0000-4000-8000-000000000001",manifestHash:"a".repeat(64),status:"prepared",sceneCount:4,shotCount:4,durationSeconds:30,createdAt:new Date(NOW).toISOString(),issues:[]};
const price={preparedId:prepared.id,manifestHash:prepared.manifestHash,filmId:"film-example",filmTitle:"Fictional garden",currency:"USD",amountCents:378,
  expiresAt:new Date(NOW+60_000).toISOString(),sandbox:false,kind:"confirmed",note:"This is the fixed price for this saved film."};
const options={input,filmId:"film-example",preparationKey:"00000000-0000-4000-8000-000000000002",priceKey:"price-key-12345678",preparationConsent:true,now:()=>NOW};

test("one action saves the plan and gets a fixed price without a screenplay-review flag or payment configuration",async()=>{
  const events=[];
  const result=await prepareFilmPrice({...options,persist:value=>{events.push("persist");assert.equal(value.id,prepared.id);},
    request:async(path,body)=>{
      events.push(body.action);assert.equal(path,"/api/studio");assert.equal(Object.hasOwn(body,"reviewed"),false);
      if(body.action==="prepare")assert.deepEqual(body,{action:"prepare",project:JSON.parse(input),preparationConsent:true,idempotencyKey:options.preparationKey});
      return body.action==="prepare"?prepared:price;
    }});
  assert.deepEqual(events,["prepare","persist","price"]);assert.equal(result.price.amountCents,378);
});
test("an unchanged saved plan can be priced again without another preparation or a new storage consent",async()=>{
  const existing={...prepared,inputHash:await productionInputHash(input),requestId:options.preparationKey},calls=[];
  const result=await prepareFilmPrice({...options,existing,preparationConsent:false,persist:()=>assert.fail(),request:async(path,body)=>{calls.push(body);return price;}});
  assert.deepEqual(result.prepared,existing);assert.equal(calls.length,1);assert.equal(calls[0].action,"price");
});
test("saving a new or changed plan still requires storage consent before any request",async()=>{
  const existing={...prepared,inputHash:await productionInputHash(JSON.stringify({id:"film-example",title:"Earlier draft"})),requestId:options.preparationKey};
  for(const preparationConsent of [false,undefined]) {
    for(const prior of [undefined,existing])await assert.rejects(prepareFilmPrice({...options,existing:prior,preparationConsent,
      request:async()=>assert.fail("No request without storage consent"),persist:()=>assert.fail("No saved reference without storage consent")}),/Allow your production plan to be saved/);
  }
});
test("a price failure retains the persisted plan and never starts checkout",async()=>{
  const events=[];
  await assert.rejects(prepareFilmPrice({...options,persist:()=>events.push("persist"),request:async(path,body)=>{
    events.push(body.action);if(body.action==="prepare")return prepared;throw new Error("temporary pricing outage");}}),/temporary pricing outage/);
  assert.deepEqual(events,["prepare","persist","price"]);
});
test("price response must match saved film/manifest and an unexpired supported dollar amount",async()=>{
  for(const patch of [{filmId:"different"},{preparedId:"00000000-0000-4000-8000-000000000002"},{manifestHash:"b".repeat(64)},
    {expiresAt:new Date(NOW-1).toISOString()},{amountCents:0},{amountCents:100_000_001},{currency:"EUR"}]) {
    await assert.rejects(prepareFilmPrice({...options,persist:()=>{},request:async(path,body)=>body.action==="prepare"?prepared:{...price,...patch}}));
  }
  assert.equal(normalizeFilmPrice({...price,paymentToken:"must-not-retain"}).paymentToken,undefined);
});

const renewed={...prepared,id:"00000000-0000-4000-8000-000000000003",manifestHash:"b".repeat(64)};
const renewedPrice={...price,preparedId:renewed.id,manifestHash:renewed.manifestHash};
const renewalOptions={...options,preparationKey:"00000000-0000-4000-8000-000000000004",renewSavedPlan:true};
const unpaidEntry=()=>({kind:"plan",id:prepared.id,manifestHash:prepared.manifestHash,filmId:options.filmId,title:price.filmTitle,
  durationSeconds:prepared.durationSeconds,createdAt:prepared.createdAt,updatedAt:prepared.createdAt,libraryState:"active",revision:0,
  production:{status:"prepared",completedShots:0,shotCount:4,mediaReady:false,needsAttention:false},payments:[]});
const existingPlan=async()=>({...prepared,inputHash:await productionInputHash(input),requestId:options.preparationKey});

test("a changed server plan never automatically creates another preparation",async()=>{
  const calls=[],error=Object.assign(new Error("Plan changed"),{code:"PRODUCTION_PLAN_CHANGED"});
  await assert.rejects(prepareFilmPrice({...options,existing:await existingPlan(),preparationConsent:false,persist:()=>assert.fail(),
    request:async(path,body)=>{calls.push(body.action);throw error;}}),value=>value===error);
  assert.deepEqual(calls,["price"]);
});

test("explicit unpaid-plan renewal checks the saved library version and creates one separate preparation before pricing",async()=>{
  const existing=await existingPlan(),before=structuredClone(existing),events=[];
  const result=await prepareFilmPrice({...renewalOptions,existing,persist:value=>{events.push("persist");assert.equal(value.id,renewed.id);},
    request:async(path,body)=>{
      if(!body){assert.equal(path,`/api/library?action=detail&kind=plan&id=${prepared.id}`);events.push("verify");return {entry:unpaidEntry()};}
      events.push(body.action);
      if(body.action==="prepare"){assert.equal(body.idempotencyKey,renewalOptions.preparationKey);return renewed;}
      assert.equal(body.action,"price");assert.equal(body.preparedId,renewed.id);return renewedPrice;
    }});
  assert.deepEqual(events,["verify","prepare","persist","price"]);
  assert.deepEqual(existing,before);
  assert.equal(result.prepared.requestId,renewalOptions.preparationKey);
});

test("renewal requires explicit storage consent, a distinct key and no local payment reference",async()=>{
  const existing=await existingPlan();
  for(const patch of [{preparationConsent:false},{paymentReference:{orderId:"a".repeat(64)}},
    {preparationKey:existing.requestId},{existing:{...existing,status:"processing"}},{existing:undefined}])
    await assert.rejects(prepareFilmPrice({...renewalOptions,existing,...patch,persist:()=>assert.fail(),
      request:async()=>assert.fail("Blocked renewal must not make any request")}));
});

test("any existing payment, production activity, changed identity or unavailable library blocks renewal",async()=>{
  const existing=await existingPlan();
  const payment={id:"c".repeat(64),status:"captured",amountCents:378,currency:"USD",refundedCents:0,sandbox:false,requiresReview:false,receiptAvailable:true};
  const changes=[
    entry=>entry.payments=[payment],
    entry=>entry.payments=[{...payment,status:"awaiting-payment",receiptAvailable:false}],
    entry=>entry.payments=[{...payment,status:"uncertain",requiresReview:true,receiptAvailable:false}],
    entry=>entry.payments=[{...payment,status:"declined",receiptAvailable:false}],
    entry=>entry.production.status="queued",
    entry=>entry.production.completedShots=1,
    entry=>entry.production.needsAttention=true,
    entry=>entry.manifestHash="c".repeat(64),
    entry=>entry.filmId="another-film",
    entry=>entry.id=renewed.id,
    entry=>entry.libraryState="archived",
    entry=>delete entry.payments,
  ];
  for(const change of changes) {
    const entry=unpaidEntry();change(entry);
    await assert.rejects(prepareFilmPrice({...renewalOptions,existing,persist:()=>assert.fail(),
      request:async(path,body)=>{assert.equal(body,undefined,"No preparation or payment POST is allowed");return {entry};}}));
  }
  await assert.rejects(prepareFilmPrice({...renewalOptions,existing,persist:()=>assert.fail(),
    request:async()=>{throw new Error("Library unavailable");}}),/Library unavailable/);
});

test("lost renewal replies retry the same new key and a later price failure retains the new preparation",async()=>{
  const existing=await existingPlan(),keys=[];let attempts=0,persisted;
  const request=async(path,body)=>{
    if(!body)return {entry:unpaidEntry()};
    if(body.action==="prepare"){keys.push(body.idempotencyKey);if(++attempts===1)throw new Error("Lost reply");return renewed;}
    throw new Error("Pricing unavailable");
  };
  const args={...renewalOptions,existing,request,persist:value=>{persisted=value;}};
  await assert.rejects(prepareFilmPrice(args),/Lost reply/);
  assert.equal(persisted,undefined);
  await assert.rejects(prepareFilmPrice(args),/Pricing unavailable/);
  assert.deepEqual(keys,[renewalOptions.preparationKey,renewalOptions.preparationKey]);
  assert.equal(persisted.id,renewed.id);
  const result=await prepareFilmPrice({...options,existing:persisted,preparationConsent:false,persist:()=>assert.fail(),
    request:async(path,body)=>{assert.equal(body.action,"price");return renewedPrice;}});
  assert.equal(result.price.preparedId,renewed.id);
});

test("renewal cannot persist an unchanged or already-started replacement plan",async()=>{
  for(const value of [prepared,{...renewed,manifestHash:prepared.manifestHash},{...renewed,status:"processing"}])
    await assert.rejects(prepareFilmPrice({...renewalOptions,existing:await existingPlan(),persist:()=>assert.fail(),
      request:async(path,body)=>body?value:{entry:unpaidEntry()}}),/refreshed production plan could not be verified/);
});
