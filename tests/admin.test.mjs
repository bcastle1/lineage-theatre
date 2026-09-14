import test from "node:test";
import assert from "node:assert/strict";
import { createAdminHandler } from "../api/admin.mjs";
import { OWNER_EMAIL, roleForUser } from "../api/_lib/access.mjs";
import { userPath } from "../api/_lib/auth.mjs";
import { newInvitation, validateInvitation, validateUserAction, validateRefund, markupFromPercent, readPricingSettings, safeUser, PRICING_PATH } from "../api/_lib/admin.mjs";
const owner={email:OWNER_EMAIL,role:"owner",status:"active"};
const admin={email:"admin@example.invalid",role:"admin",status:"active"};
const customer={email:"customer@example.invalid",role:"customer",status:"active"};
function harness(actor=owner) {
  const records=new Map(),events=[];
  let writes=0;
  const read=async(path)=>records.has(path)?{value:structuredClone(records.get(path)),etag:"test-etag"}:null;
  const handler=createAdminHandler({getSession:async()=>actor?{user:structuredClone(actor)}:null,readRecord:read,
    writeRecord:async(path,value,etag)=>{if(records.has(path)&&!etag)throw new Error("Create conflict"); records.set(path,structuredClone(value));writes++;},
    limitAction:async()=>true,audit:async(...args)=>events.push(args),
    readPricingSettings:()=>readPricingSettings(read),recordPage:async()=>({records:[]}),connections:async()=>({connections:{},pricing:{}})});
  async function run(action,body,headers={}) {
    let status,output;
    await handler({method:body?"POST":"GET",url:`/api/admin?action=${action}`,headers:{host:"lineagetheater.com",origin:"https://lineagetheater.com",...headers},...(body?{body:{...body,action}}:{})},
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
    for(const action of ["overview","users","payments","audit","pricing"]) assert.equal((await h.run(action)).status,expected);
    for(const action of ["invite","revokeAdmin","suspend","activate","updatePricing","refund"])
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
});
test("pricing accepts precise bounded percentages and requires a current revision",async()=>{
  assert.equal(markupFromPercent(12.35),1235);assert.equal(markupFromPercent(1000),100000);
  for(const input of [-1,1000.01,0.001,"20",NaN,Infinity,null]) assert.throws(()=>markupFromPercent(input));
  const h=harness(admin);
  assert.equal((await h.run("pricing")).body.markupBasisPoints,0);
  const saved=await h.run("updatePricing",{markupPercent:25.5,expectedRevision:0});
  assert.equal(saved.status,200);assert.equal(saved.body.markupBasisPoints,2550);assert.equal(saved.body.revision,1);
  assert.equal(h.records.get(PRICING_PATH).updatedBy,admin.email);
  assert.equal((await h.run("updatePricing",{markupPercent:10,expectedRevision:0})).status,409);
  assert.equal(h.records.get(PRICING_PATH).markupBasisPoints,2550);
  assert.equal(h.events[0][1],"pricing.updated");
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
