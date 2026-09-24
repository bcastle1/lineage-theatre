import test from "node:test";
import assert from "node:assert/strict";
import { createAdminHandler } from "../api/admin.mjs";
import { OWNER_EMAIL, roleForUser, accessStatusForUser } from "../api/_lib/access.mjs";
import { userPath } from "../api/_lib/auth.mjs";
import { builtInSourceAgreement, sourceAgreementVersionPath, SOURCE_AGREEMENT_PATH } from "../api/_lib/source-agreement.mjs";
import { newInvitation, validateInvitation, validateUserAction, validateRefund, markupFromPercent, readPricingSettings, safeUser, PRICING_PATH } from "../api/_lib/admin.mjs";
const owner={email:OWNER_EMAIL,role:"owner",status:"active"};
const admin={email:"admin@example.invalid",role:"admin",status:"active"};
const customer={email:"customer@example.invalid",role:"customer",status:"active"};
function harness(actor=owner,overrides={}) {
  const records=new Map(),events=[];
  let writes=0;
  const read=async(path)=>records.has(path)?{value:structuredClone(records.get(path)),etag:"test-etag"}:null;
  const handler=createAdminHandler({getSession:async()=>actor?{user:structuredClone(actor)}:null,readRecord:read,
    writeRecord:async(path,value,etag)=>{if(records.has(path)&&!etag)throw new Error("Create conflict"); records.set(path,structuredClone(value));writes++;},
    limitAction:async()=>true,audit:async(...args)=>events.push(args),
    readPricingSettings:()=>readPricingSettings(read),recordPage:async()=>({records:[]}),connections:async()=>({connections:{},pricing:{}}),...overrides});
  async function run(action,body,headers={},id) {
    let status,output;
    await handler({method:body?"POST":"GET",url:`/api/admin?action=${action}${id?`&id=${id}`:""}`,headers:{host:"lineagetheater.com",origin:"https://lineagetheater.com",...headers},...(body?{body:{...body,action}}:{})},
      {set statusCode(v){status=v;},setHeader(){},end(v){output=JSON.parse(v);}});
    return {status,body:output};
  }
  return {records,events,run,get writes(){return writes;}};
}
test("email alone never creates owner/admin access; inactive privileges are not trusted",()=>{
  assert.equal(roleForUser({email:OWNER_EMAIL}),"customer");
  assert.equal(roleForUser({...customer,role:"owner"}),"customer");
  assert.equal(roleForUser({...owner,status:"suspended"}),"customer");
  assert.equal(safeUser({...admin,status:"suspended"}).role,"admin");
});
test("unsigned and customer requests cannot read admin data or mutate roles/pricing/refunds",async()=>{
  for(const actor of [null,customer]){
    const h=harness(actor),expected=actor?403:401;
    for(const action of ["overview","users","payments","audit","pricing","registrationPolicy","agreement"]) assert.equal((await h.run(action)).status,expected);
    for(const action of ["invite","revokeAdmin","suspend","activate","approve","updatePricing","updateRegistrationPolicy","updateAgreement","refund"])
      assert.equal((await h.run(action,{email:admin.email,markupPercent:50,expectedRevision:0})).status,expected);
    assert.equal(h.writes,0);
  }
});
test("cross-origin admin writes and admin role delegation fail closed",async()=>{
  const h=harness(admin);
  assert.equal((await h.run("updatePricing",{markupPercent:50,expectedRevision:0},{origin:"https://attacker.invalid"})).status,403);
  assert.equal((await h.run("invite",{email:customer.email})).status,403);
  assert.equal(h.writes,0);
});
test("owner and administrator account protections include suspended administrators",()=>{
  for(const action of ["revokeAdmin","suspend","activate"]){
    assert.throws(()=>validateUserAction(admin,owner,action),/owner account/);
    assert.throws(()=>validateUserAction(owner,owner,action),/owner account/);
    assert.throws(()=>validateUserAction(admin,admin,action),/own administrative/);
  }
  assert.throws(()=>validateUserAction(admin,{...admin,email:"second@example.invalid",status:"suspended"},"activate"),/Only the owner/);
  assert.throws(()=>validateUserAction(admin,customer,"revokeAdmin"),/Only the owner/);
  assert.doesNotThrow(()=>validateUserAction(admin,customer,"suspend"));
});
test("invitations are hashed, expire, and only grant the exact invited account",async()=>{
  const invited=newInvitation(customer.email,owner.email);
  assert.match(invited.token,/^[a-f0-9]{64}$/);
  assert.equal(invited.path.includes(invited.token),false);
  assert.equal(JSON.stringify(invited.record).includes(invited.token),false);
  assert.throws(()=>validateInvitation(invited.record,admin),/email address/);
  assert.throws(()=>validateInvitation(invited.record,customer,Date.parse(invited.record.expiresAt)),/expired/);
  const h=harness(customer);h.records.set(invited.path,invited.record);h.records.set(userPath(customer.email),customer);
  const result=await h.run("acceptInvite",{token:invited.token});
  assert.equal(result.status,200);assert.equal(result.body.user.role,"admin");
  assert.equal(result.body.user.accessStatus,"approved");
  assert.equal(h.records.get(userPath(customer.email)).approvedBy,owner.email);
  assert.equal(h.records.get(invited.path).usedBy,customer.email);
  assert.equal(h.events[0][1],"administrator.invitation.accepted");
  assert.equal(JSON.stringify(h.events).includes(invited.token),false);
});
test("revoked access cannot be regranted by replaying an old or unclaimed invitation",async()=>{
  const invited=newInvitation(customer.email,owner.email,Date.now()-1000);
  const revoked={...customer,adminRevokedAt:new Date().toISOString()};
  for(const used of [false,true]){
    const h=harness(revoked);
    h.records.set(invited.path,{...invited.record,...(used?{usedBy:customer.email,usedAt:new Date().toISOString()}:{})});
    h.records.set(userPath(customer.email),revoked);
    assert.equal((await h.run("acceptInvite",{token:invited.token})).status,400);
    assert.equal(h.records.get(userPath(customer.email)).role,"customer");
    assert.equal(h.writes,0);
  }
});
test("revocation persists a cutoff while preserving the password and account",async()=>{
  const h=harness();h.records.set(userPath(admin.email),{...admin,passwordHash:"preserved-hash"});
  const result=await h.run("revokeAdmin",{email:admin.email});
  assert.equal(result.status,200);
  const stored=h.records.get(userPath(admin.email));
  assert.equal(stored.role,"customer");assert.equal(stored.passwordHash,"preserved-hash");assert.ok(Date.parse(stored.adminRevokedAt));
  assert.equal(accessStatusForUser(stored),"approved");assert.equal(stored.approvedBy,owner.email);
});
test("pricing accepts precise bounded percentages and requires a current revision",async()=>{
  assert.equal(markupFromPercent(12.35),1235);assert.equal(markupFromPercent(1000),100000);
  for(const input of [-1,1000.01,0.001,"20",NaN,Infinity,null]) assert.throws(()=>markupFromPercent(input));
  const h=harness(admin);
  assert.equal((await h.run("pricing")).body.markupBasisPoints,5000);
  const saved=await h.run("updatePricing",{markupPercent:25.5,expectedRevision:0});
  assert.equal(saved.status,200);assert.equal(saved.body.markupBasisPoints,2550);assert.equal(saved.body.revision,1);
  assert.equal(h.records.get(PRICING_PATH).updatedBy,admin.email);
  assert.equal((await h.run("updatePricing",{markupPercent:10,expectedRevision:0})).status,409);
  assert.equal(h.records.get(PRICING_PATH).markupBasisPoints,2550);
  assert.equal(h.events[0][1],"pricing.updated");
});

test("administrators publish revisioned source statements with immutable history and a minimal audit",async()=>{
  const h=harness(admin),original=builtInSourceAgreement();
  assert.deepEqual((await h.run("agreement")).body,{agreement:original});
  const input={revision:0,title:"Source ownership and permissions",body:"The account holder supplies authorized source material.",consentLabel:"I accept this source agreement."};
  const saved=await h.run("updateAgreement",input);
  assert.equal(saved.status,200);assert.equal(saved.body.agreement.revision,1);
  assert.deepEqual((await h.run("agreement")).body,saved.body);
  assert.deepEqual(h.records.get(sourceAgreementVersionPath(original.version)).agreement,original);
  const archive=h.records.get(sourceAgreementVersionPath(saved.body.agreement.version));
  assert.equal(archive.updatedBy,admin.email);assert.equal(archive.previousVersion,original.version);
  assert.equal(h.records.get(SOURCE_AGREEMENT_PATH).version,saved.body.agreement.version);
  assert.deepEqual(h.events,[[admin.email,"source.agreement.updated",saved.body.agreement.version,
    {revision:1,contentHash:saved.body.agreement.contentHash}]]);
  const conflict=await h.run("updateAgreement",input);
  assert.equal(conflict.status,409);assert.equal(conflict.body.code,"AGREEMENT_CONFLICT");assert.equal(h.events.length,1);
  const historical=await h.run(`agreement&version=${encodeURIComponent(original.version)}`);
  assert.equal(historical.status,200);assert.deepEqual(historical.body.agreement,original);
});

test("source statement saves retain same-origin and rate limits and accept bounded Unicode multiline text",async()=>{
  const input={revision:0,title:"Fictional source agreement",body:("É\n").repeat(4900),consentLabel:"I accept."};
  const h=harness(admin);
  assert.equal((await h.run("updateAgreement",input,{origin:"https://other.invalid"})).status,403);
  assert.equal(h.writes,0);
  const limited=harness(admin,{limitAction:async()=>false});
  assert.equal((await limited.run("updateAgreement",input)).status,429);assert.equal(limited.writes,0);
  const invalid=await h.run("updateAgreement",{...input,updatedBy:"other@example.invalid"});
  assert.equal(invalid.status,400);assert.equal(h.writes,0);
  const saved=await h.run("updateAgreement",input);
  assert.equal(saved.status,200);assert.equal(saved.body.agreement.body,input.body.trim());
});
test("pricing defaults to 50 percent with labeled planning inputs while preserving explicit saved markup",async()=>{
  const defaults=await readPricingSettings(async()=>null);
  assert.deepEqual(defaults,{markupBasisPoints:5000,planningCreditsPerClip:286,planningSecondsPerClip:6,planningRendersPerClip:1,revision:0,updatedAt:null,updatedBy:null});
  const h=harness(admin);
  h.records.set(PRICING_PATH,{markupBasisPoints:0,revision:3,updatedAt:"2026-09-20T00:00:00.000Z",updatedBy:owner.email});
  const current=await h.run("pricing");
  assert.equal(current.status,200);assert.equal(current.body.markupBasisPoints,0);
  assert.equal(current.body.planningCreditsPerClip,286);assert.equal(current.body.planningSecondsPerClip,6);assert.equal(current.body.planningRendersPerClip,1);
  assert.equal(h.writes,0);assert.equal(h.records.get(PRICING_PATH).planningCreditsPerClip,undefined);
});
test("planning assumptions save with the markup revision and legacy markup-only updates preserve them",async()=>{
  const h=harness(admin);
  const saved=await h.run("updatePricing",{markupPercent:50,planningCreditsPerClip:500,planningSecondsPerClip:8,planningRendersPerClip:2,expectedRevision:0});
  assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
  for(const [field,value] of Object.entries({markupBasisPoints:5000,planningCreditsPerClip:500,planningSecondsPerClip:8,planningRendersPerClip:2}))
    assert.equal(h.records.get(PRICING_PATH)[field],value);
  const legacy=await h.run("updatePricing",{markupPercent:30,expectedRevision:1});
  assert.equal(legacy.status,200);assert.equal(legacy.body.markupBasisPoints,3000);assert.equal(legacy.body.revision,2);
  assert.equal(legacy.body.planningCreditsPerClip,500);assert.equal(legacy.body.planningSecondsPerClip,8);assert.equal(legacy.body.planningRendersPerClip,2);
  assert.equal((await h.run("updatePricing",{markupPercent:50,planningRendersPerClip:3,expectedRevision:1})).status,409);
  assert.equal(h.records.get(PRICING_PATH).planningRendersPerClip,2);
});
test("planning fields require bounded integers when supplied and reject corrupt saved assumptions",async()=>{
  const bounds={planningCreditsPerClip:1_000_000,planningSecondsPerClip:60,planningRendersPerClip:20};
  for(const [field,max] of Object.entries(bounds)){
    for(const value of [0,-1,max+1,1.5,"6",null,NaN,Infinity]){
      const h=harness(admin);
      const result=await h.run("updatePricing",{markupPercent:50,expectedRevision:0,[field]:value});
      assert.equal(result.status,400,`${field}: ${String(value)}`);assert.equal(h.writes,0);assert.equal(h.events.length,0);
    }
    for(const value of [1,max]){
      const h=harness(admin);
      const result=await h.run("updatePricing",{markupPercent:50,expectedRevision:0,[field]:value});
      assert.equal(result.status,200);assert.equal(result.body[field],value);
    }
    await assert.rejects(readPricingSettings(async()=>({value:{markupBasisPoints:0,revision:1,[field]:null}})),/whole number/);
  }
});
test("refund validation prevents over-refunds and the pending connection cannot claim success",async()=>{
  const order={id:"synthetic-order-123",provider:"quickbooks",providerChargeId:"synthetic-provider-reference",status:"partially-refunded",currency:"USD",amountCents:1000,refundedCents:200};
  const body={orderId:order.id,amountCents:800,reason:"Requested by fictional customer",idempotencyKey:"synthetic-refund-123"};
  assert.equal(validateRefund(order,body).amountCents,800);
  for(const amountCents of [0,-1,801,1000,0.5,"800"]) assert.throws(()=>validateRefund(order,{...body,amountCents}));
  assert.throws(()=>validateRefund({...order,refundedCents:-1},body));
  assert.throws(()=>validateRefund({...order,providerChargeId:null},body));
  const h=harness();h.records.set(`payments/orders/${order.id}.json`,order);
  const result=await h.run("refund",body);
  assert.equal(result.status,503);assert.equal(result.body.refunded,false);assert.equal(h.writes,0);
});

test("payment diagnostics, accounting exports and reconciliation use separate administrator-only services",async()=>{
  const calls=[];
  const payments=Object.fromEntries(["adminDiagnostics","accountingExport","reconcile"].map(method=>[method,async(...args)=>{calls.push([method,...args]);return {operation:method};}]));
  const h=harness(admin,{payments}),id="a".repeat(64);
  assert.equal((await h.run("paymentDiagnostics",undefined,{},id)).body.operation,"adminDiagnostics");
  assert.equal((await h.run("accountingExport",undefined,{},id)).body.operation,"accountingExport");
  assert.equal((await h.run("reconcilePayment",{orderId:id})).body.operation,"reconcile");
  assert.deepEqual(calls,[["adminDiagnostics",admin,id],["accountingExport",admin,id],["reconcile",admin,{orderId:id}]]);
  for(const actor of [null,customer]) {
    const denied=harness(actor,{payments});
    for(const action of ["paymentDiagnostics","accountingExport","productionReadiness"])
      assert.equal((await denied.run(action,undefined,{},id)).status,actor?403:401);
    assert.equal((await denied.run("reconcilePayment",{orderId:id})).status,actor?403:401);
  }
  assert.equal((await h.run("reconcilePayment",{orderId:id},{origin:"https://other.invalid"})).status,403);
  assert.equal(calls.length,3);
});

test("hosted diagnostics remain limited to authenticated administrator support exports",async()=>{
  const id="a".repeat(64),calls=[];
  const diagnostics={lastCheckAttemptedAt:"2026-09-24T00:00:00.000Z",reason:"invoice_link_invalid"};
  const hostedCheckout={ownsOrder:async()=>true,order:async()=>({id,status:"uncertain",amountCents:330,currency:"USD",requiresReview:true}),
    adminDiagnostics:async(...args)=>{calls.push(args);return diagnostics;}};
  const h=harness(admin,{hostedCheckout});
  const support=await h.run("paymentDiagnostics",undefined,{},id);
  assert.equal(support.status,200);assert.deepEqual(support.body.diagnostics,diagnostics);
  assert.equal(Object.hasOwn((await h.run("accountingExport",undefined,{},id)).body,"diagnostics"),false);
  for(const actor of [null,customer])assert.equal((await harness(actor,{hostedCheckout}).run("paymentDiagnostics",undefined,{},id)).status,actor?403:401);
  assert.deepEqual(calls,[[admin,id]]);
});

test("only durable managed orders enter the refund service and same-origin/admin gates still apply",async()=>{
  const calls=[],id="a".repeat(64),payments={refund:async(...args)=>{calls.push(args);return {id,status:"partially-refunded",refundedCents:100,sandbox:true};}};
  const body={orderId:id,amountCents:100,reason:"Fictional test refund",idempotencyKey:"synthetic-refund-123"};
  const order={version:1,id,manifestHash:"b".repeat(64),merchantBinding:{environment:"sandbox",grantId:"c".repeat(64)},status:"captured",provider:"quickbooks"};
  const h=harness(admin,{payments});h.records.set(`payments/orders/${id}.json`,order);
  assert.equal((await h.run("refund",body)).body.status,"partially-refunded");assert.deepEqual(calls,[[admin,body]]);
  assert.equal((await h.run("refund",body,{origin:"https://other.invalid"})).status,403);
  assert.equal((await harness(customer,{payments}).run("refund",body)).status,403);
  h.records.set(`payments/orders/${id}.json`,{...order,version:undefined});
  assert.equal((await h.run("refund",body)).status,400);assert.equal(calls.length,1);
});

test("test orders are labeled and excluded from live totals while captured live records are counted",async()=>{
  const orders=[
    {id:"live-paid",status:"paid",currency:"USD",amountCents:1000,refundedCents:0},
    {id:"live-captured",status:"captured",currency:"USD",amountCents:2000,refundedCents:0},
    {id:"live-refunded",status:"partially-refunded",currency:"USD",amountCents:3000,refundedCents:1000},
    {id:"a".repeat(64),version:1,manifestHash:"b".repeat(64),merchantBinding:{environment:"sandbox",grantId:"c".repeat(64)},status:"captured",currency:"USD",amountCents:99999,refundedCents:0},
    {id:"test-refunded",sandbox:true,status:"refunded",currency:"USD",amountCents:99999,refundedCents:99999},
    {id:"uncertain",status:"uncertain",currency:"USD",amountCents:99999,refundedCents:0},
  ];
  const h=harness(admin,{recordPage:async prefix=>({records:prefix==="payments/orders/"?orders:[]})});
  const overview=await h.run("overview");
  assert.equal(overview.body.stats.paymentTotalCents,6000);assert.equal(overview.body.stats.refundTotalCents,1000);
  assert.equal(overview.body.stats.paidOrders,3);assert.equal(overview.body.stats.testOrders,2);
  const list=await h.run("payments");assert.equal(list.body.orders[3].sandbox,true);assert.equal(list.body.orders[3].managedPayment,true);
  assert.equal(list.body.orders[2].sandbox,false);assert.equal(list.body.orders[5].requiresReview,true);
  assert.doesNotMatch(JSON.stringify(list.body),/manifestHash|merchantBinding|grantId/);
});

test("hosted accounting payments expose unverified refunds separately from confirmed refund totals",async()=>{
  const orders=[{id:"hosted",status:"captured",currency:"USD",amountCents:1000,refundedCents:500,checkoutMethod:"quickbooks-hosted-invoice"},
    {id:"legacy",status:"captured",currency:"USD",amountCents:2000,refundedCents:200}];
  const h=harness(admin,{recordPage:async prefix=>({records:prefix==="payments/orders/"?orders:[]})});
  const result=await h.run("overview");
  assert.equal(result.body.stats.paymentTotalCents,3000);
  assert.equal(result.body.stats.refundTotalCents,200);
  assert.equal(result.body.stats.hostedRefundsUnverified,1);
});

test("fictional production test preparation is owner-only and retains write guards",async()=>{
  const calls=[],filmProduction={prepareOperatorTest:async input=>{calls.push(input);return {id:"fictional-test",manifestHash:"a".repeat(64)};}};
  const input={idempotencyKey:"synthetic-operator-123"};
  for(const actor of [null,customer,admin])assert.equal((await harness(actor,{filmProduction}).run("prepareProductionTest",input)).status,actor?403:401);
  const h=harness(owner,{filmProduction});
  assert.equal((await h.run("prepareProductionTest",input,{origin:"https://other.invalid"})).status,403);
  const result=await h.run("prepareProductionTest",input);assert.equal(result.status,201);assert.match(result.body.message,/No render request or charge/);
  assert.deepEqual(calls,[{actor:owner,...input}]);assert.equal(h.events[0][1],"production.test.prepared");
});
