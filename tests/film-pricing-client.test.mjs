import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
const compile=async path=>ts.transpileModule(await readFile(new URL(path,import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const url=source=>`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const model=url(await compile("../src/studio/model.ts"));
const {prepareFilmPrice,normalizeFilmPrice}=await import(url((await compile("../src/studio/film-pricing.ts")).replace('"./model"',JSON.stringify(model))));
const {productionInputHash}=await import(model);
const NOW=Date.now(),input=JSON.stringify({id:"film-example",title:"Fictional garden"});
const prepared={id:"00000000-0000-4000-8000-000000000001",manifestHash:"a".repeat(64),status:"prepared",sceneCount:4,shotCount:4,durationSeconds:30,createdAt:new Date(NOW).toISOString(),issues:[]};
const price={preparedId:prepared.id,manifestHash:prepared.manifestHash,filmId:"film-example",filmTitle:"Fictional garden",currency:"USD",amountCents:378,
  expiresAt:new Date(NOW+60_000).toISOString(),sandbox:false,kind:"confirmed",note:"This is the fixed price for this saved film."};
const options={input,filmId:"film-example",preparationKey:"00000000-0000-4000-8000-000000000002",priceKey:"price-key-12345678",reviewed:true,preparationConsent:true,now:()=>NOW};

test("one action saves the reviewed plan, persists its reference and gets a fixed price without payment configuration",async()=>{
  const events=[];
  const result=await prepareFilmPrice({...options,persist:value=>{events.push("persist");assert.equal(value.id,prepared.id);},
    request:async(path,body)=>{events.push(body.action);assert.equal(path,"/api/studio");return body.action==="prepare"?prepared:price;}});
  assert.deepEqual(events,["prepare","persist","price"]);assert.equal(result.price.amountCents,378);
});
test("an unchanged saved plan can be priced again without another preparation or a new storage consent",async()=>{
  const existing={...prepared,inputHash:await productionInputHash(input),requestId:options.preparationKey},calls=[];
  const result=await prepareFilmPrice({...options,existing,preparationConsent:false,persist:()=>assert.fail(),request:async(path,body)=>{calls.push(body);return price;}});
  assert.deepEqual(result.prepared,existing);assert.equal(calls.length,1);assert.equal(calls[0].action,"price");
});
test("review and new-plan consent remain required before saving or pricing",async()=>{
  for(const patch of [{reviewed:false},{preparationConsent:false}]) {
    await assert.rejects(prepareFilmPrice({...options,...patch,request:async()=>assert.fail(),persist:()=>assert.fail()}));
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
