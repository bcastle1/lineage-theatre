import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createFalReviewHandler } from '../api/fal-review.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { digest,userPath } from '../api/_lib/auth.mjs';
const order='a'.repeat(64),hash='b'.repeat(64),id='11111111-1111-4111-8111-111111111111',bytes=Buffer.from('fictional test media bytes');
const actor={email:OWNER_EMAIL,role:'owner'},sha256=digest(bytes),pathname=`production/media/${digest(OWNER_EMAIL)}/${id}/${sha256}.mp4`;
class Capture extends Writable{constructor(){super();this.headers={};this.chunks=[];}setHeader(k,v){this.headers[k.toLowerCase()]=v;}removeHeader(k){delete this.headers[k.toLowerCase()];}_write(c,e,d){this.chunks.push(c);d();}}
function fixture({session=actor,changeCandidate=()=>{},changeBlob=()=>{}}={}){
 let downloads=0;
 const candidate={model:'wan',orderId:order,manifestHash:hash,artifact:{pathname,sha256,manifestHash:hash,contentType:'video/mp4',sizeBytes:bytes.length,playable:true,hasAudio:true,technicalSample:false}};changeCandidate(candidate);
 const handler=createFalReviewHandler({sessionFor:async()=>session?{user:session}:null,
  read:async path=>({value:path===userPath(OWNER_EMAIL)?actor:path.includes('/comparisons/')?{approvedBy:OWNER_EMAIL,customerEmail:OWNER_EMAIL,preparedId:id,manifestHash:hash}:candidate}),
  getBlob:async(path,opts)=>{downloads++;assert.equal(path,pathname);assert.equal(opts.access,'private');
   const partial=opts.headers.Range==='bytes=0-7',data=partial?bytes.subarray(0,8):bytes;
   const value={stream:new Response(data).body,blob:{pathname,contentType:'video/mp4',size:data.length},headers:new Headers({'content-length':String(data.length),...(partial?{'content-range':`bytes 0-7/${bytes.length}`}:{})})};changeBlob(value);return value;}});
 return {handler,downloads:()=>downloads};
}
async function run(f,headers={}){const r=new Capture();await f.handler({method:'GET',headers,url:`/api/fal-review?order=${order}&model=wan`},r);return r;}
test('private candidate streams exact owner-scoped bytes and ranges before customer completion',async()=>{
 const f=fixture(),r=await run(f,{range:'bytes=0-7'});assert.equal(r.statusCode,206);assert.deepEqual(Buffer.concat(r.chunks),bytes.subarray(0,8));assert.equal(r.headers['cache-control'],'private, no-store');
});
test('unauthenticated users, other roles and mismatched artifacts cannot read candidates',async()=>{
 for(const session of [null,{email:'other@example.invalid',role:'customer'}]){const f=fixture({session});assert.ok([401,403].includes((await run(f)).statusCode));assert.equal(f.downloads(),0);}
 const f=fixture({changeCandidate:c=>{c.artifact.pathname='production/media/sibling.mp4';}});assert.equal((await run(f)).statusCode,404);assert.equal(f.downloads(),0);
 const corrupt=fixture({changeBlob:b=>{b.blob.size++;}});assert.equal((await run(corrupt)).statusCode,503);
});
