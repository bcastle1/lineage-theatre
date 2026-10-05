import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPacQuickBooksWrite } from '../api/_lib/pac-quickbooks-write.mjs';
import { createPacQuickBooksWriteHandler } from '../api/pac-quickbooks-write.mjs';
import { validateQboWriteArguments } from '../api/_lib/pac-quickbooks-write-contract.mjs';

const operation_id='5a91938d-898f-4ed1-8ef5-de041e64f2fb', action_digest='a'.repeat(64);
const binding={environment:'production',realmId:'123',grantId:'b'.repeat(64)};
const request=(name='quickbooks_create',args={entity:'Customer',data:{DisplayName:'Synthetic customer'}})=>({name,arguments:args,operation_id,action_digest});
function fixture(options={}) {
  const records=new Map(),calls=[];let revision=0;
  const read=async path=>structuredClone(records.get(path)??null);
  const write=async(path,value,etag)=>{
    const existing=records.get(path);if(existing?.etag!==etag)throw Error('CAS_CONFLICT');
    records.set(path,{value:structuredClone(value),etag:String(++revision)});return {etag:String(revision)};
  };
  const transport={readiness:async()=>({binding:{...binding,...options.binding}}),request:async(bound,op)=>{
    calls.push(op);
    if(op.path.startsWith('/companyinfo/'))return Response.json({CompanyInfo:{CompanyName:options.company??'BROCO Tech'}});
    if(op.method==='POST'){
      if(options.post) return options.post(op);
      if(op.path==='/upload')return Response.json({AttachableResponse:[{Attachable:{Id:'8',SyncToken:'0',FileName:op.body.name,ContentType:op.body.media_type,Size:3,AttachableRef:[{EntityRef:{type:'Invoice',value:'2'}}]}}]});
      return Response.json({[op.entity]:{...op.body,Id:'2',SyncToken:op.body.Id?'4':'0'}});
    }
    if(options.get)return options.get(op);
    if(op.path==='/attachable/8')return Response.json({Attachable:{Id:'8',SyncToken:'0',FileName:'invoice.txt',ContentType:'text/plain',Size:3,AttachableRef:[{EntityRef:{type:'Invoice',value:'2'}}]}});
    return Response.json({[op.entity]:{Id:'2',SyncToken:options.readVersion??'3',DisplayName:'Synthetic customer'}});
  }};
  return {records,calls,service:createPacQuickBooksWrite({env:{PAC_QUICKBOOKS_REALM_ID:'123'},transport,read,write}),read,write};
}
test('create pins company and retains a replayable receipt without another POST',async()=>{
  const h=fixture(),input=request(); const first=await h.service.execute(input);
  assert.equal(first.state,'succeeded');assert.equal(first.receipt.entity_id,'2');
  const again=await h.service.execute(input);assert.deepEqual(again,first);
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  assert.doesNotMatch(JSON.stringify([...h.records]),/Synthetic customer/);
  await assert.rejects(h.service.execute({...input,arguments:{entity:'Customer',data:{DisplayName:'changed'}}}),/QBO_OPERATION_CONFLICT/);
});
test('concurrent submissions claim one durable operation before posting',async()=>{
  const h=fixture();const results=await Promise.allSettled([h.service.execute(request()),h.service.execute(request())]);
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  assert.ok(results.some(r=>r.status==='fulfilled'&&r.value.state==='succeeded'));
});
test('wrong company or environment cannot cause a write',async()=>{
  for(const options of [{binding:{environment:'sandbox'}},{binding:{realmId:'999'}},{company:'Another business'}]){
    const h=fixture(options);await assert.rejects(h.service.execute(request()),/QBO_COMPANY_MISMATCH/);
    assert.equal(h.calls.some(c=>c.method==='POST'),false);
  }
});
test('edits require the observed SyncToken and force sparse updates',async()=>{
  const args={entity:'Customer',id:'2',expected_version:'3',data:{DisplayName:'Changed by assigned task'}};
  const h=fixture();assert.equal((await h.service.execute(request('quickbooks_update',args))).state,'succeeded');
  assert.deepEqual(h.calls.find(c=>c.method==='POST').body,{DisplayName:'Changed by assigned task',Id:'2',SyncToken:'3',sparse:true});
  const stale=fixture({readVersion:'4'});await assert.rejects(stale.service.execute(request('quickbooks_update',args)),/QBO_VERSION_CONFLICT/);
  assert.equal(stale.calls.some(c=>c.method==='POST'),false);
});
test('ambiguous network, server, malformed and oversized responses remain uncertain without resubmission',async()=>{
  for(const post of [async()=>{throw Error('network failed')},async()=>new Response('bad gateway',{status:502}),async()=>new Response('{'),async()=>new Response('x'.repeat(150001))]){
    const h=fixture({post}),first=await h.service.execute(request());assert.equal(first.state,'outcome_unknown');
    assert.equal((await h.service.execute(request())).state,'outcome_unknown');
    assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  }
});
test('an explicit provider rejection is failed, not a completed write',async()=>{
  const h=fixture({post:async()=>Response.json({Fault:{Error:[{code:'5010',Message:'Private data'}]}},{status:400})});
  const r=await h.service.execute(request());assert.equal(r.state,'failed');assert.equal(r.error_code,'QBO_VERSION_CONFLICT');
  assert.doesNotMatch(JSON.stringify(r),/Private data/);
});
test('an accepted write can finish readback through status without posting again',async()=>{
  let unavailable=true;
  const h=fixture({get:async()=>{if(unavailable)throw Error('read interrupted');return Response.json({Customer:{Id:'2',SyncToken:'0'}})}});
  const first=await h.service.execute(request());assert.equal(first.state,'pending_verification');
  unavailable=false;
  const recovered=await h.service.status({operation_id,action_digest});assert.equal(recovered.state,'succeeded');
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  await assert.rejects(h.service.status({operation_id,action_digest:'f'.repeat(64)}),/QBO_OPERATION_NOT_FOUND/);
});
test('attachments verify bytes and target, submit multipart metadata, and read back the linked receipt',async()=>{
  const h=fixture(),file={name:'invoice.txt',media_type:'text/plain',base64:'YWJj',sha256:createHash('sha256').update('abc').digest('hex')};
  const input={...request('quickbooks_attach',{entity:'Invoice',id:'2',file_id:'registered-file',file_version:'"v1"'}),file};
  const r=await h.service.execute(input);assert.equal(r.state,'succeeded');assert.equal(r.receipt.entity_id,'8');
  assert.equal(r.receipt.sha256,file.sha256);assert.equal(h.calls.filter(c=>c.path==='/upload').length,1);
  assert.ok(h.calls.some(c=>c.path==='/attachable/8'));
  const bad=fixture();await assert.rejects(bad.service.execute({...input,file:{...file,base64:'eHl6'}}),/QBO_ATTACHMENT_INVALID/);
  assert.equal(bad.calls.length,0);
});
test('unsafe entity, metadata override, empty edits and poisoned fields are rejected',()=>{
  for(const args of [{entity:'CompanyInfo',data:{DisplayName:'x'}},{entity:'Customer',data:{Id:'2'}},{entity:'Customer',data:{}},{entity:'Customer',data:JSON.parse('{"__proto__":{}}')},{entity:'Invoice',data:{sparse:false}}])
    assert.throws(()=>validateQboWriteArguments('quickbooks_create',args));
});
test('new endpoint never accepts the existing read key or a browser session',async()=>{
  let calls=0;const handler=createPacQuickBooksWriteHandler({env:{PAC_QUICKBOOKS_WRITE_KEY:'w'.repeat(43)},service:{execute:async()=>{calls++;return {state:'succeeded'}}},limiter:async()=>true,auditImpl:async()=>{}});
  const invoke=async key=>{let code,body;await handler({method:'POST',headers:{authorization:`Bearer ${key}`,cookie:'session'},body:request()}, {setHeader(){},set statusCode(v){code=v},end(v){body=JSON.parse(v)}});return {code,body}};
  assert.equal((await invoke('r'.repeat(43))).code,401);assert.equal(calls,0);
  assert.equal((await invoke('w'.repeat(43))).code,200);assert.equal(calls,1);
});
