import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { createRemoteProductionAuthorization } from '../api/_lib/remote-production-authorization.mjs';
import { digest } from '../api/_lib/auth.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { FILM_PERFORMANCE_RECIPE, validateFilmPerformance } from '../api/_lib/film-performance.mjs';

const secret='a'.repeat(64), at=1792372000000;
const input={email:'family@example.invalid',preparedId:'11111111-1111-4111-8111-111111111111',manifestHash:'b'.repeat(64),orderId:'c'.repeat(64)};
const adapter={model:'wan',modelVersion:'fixture-recipe',available:true};
function fixture(change={}){
  let calls=0;
  const handler=createProductionWorkerHandler({env:{LINEAGE_WORKER_SECRET:secret},adapter,now:()=>at,
    read:async()=>({value:{state:'pending',email:input.email,id:input.preparedId,orderId:input.orderId,manifestHash:input.manifestHash,lease:{expiresAt:at+10000}}}),
    limiter:async()=>true,paymentService:{authorizeProduction:async value=>{calls++;assert.deepEqual(value,input);return {allowed:true,manifestHash:input.manifestHash};}},...change});
  return {handler,calls:()=>calls};
}
async function invoke(f,change={}){const res={setHeader(){},end(body){this.body=JSON.parse(body);}};
  await f.handler({method:'POST',headers:{authorization:`Bearer ${secret}`},body:{...input,model:adapter.model,recipe:adapter.modelVersion},...change},res);return res;}
test('media worker receives a grant only after the existing live payment authorizer runs',async()=>{
  const f=fixture(),r=await invoke(f);assert.equal(r.statusCode,200);assert.equal(r.body.allowed,true);assert.equal(f.calls(),1);
});
test('wrong secret, provider recipe, absent lease and unexpected fields cannot issue worker grants',async()=>{
  for(const change of [{headers:{}},{headers:{authorization:'Bearer wrong'}},{method:'GET'},
    {body:{...input,model:'seedance',recipe:adapter.modelVersion}},
    {body:{...input,model:adapter.model,recipe:adapter.modelVersion,paid:true}}]){
    const f=fixture();assert.notEqual((await invoke(f,change)).statusCode,200);assert.equal(f.calls(),0);
  }
  for(const ticket of [null,{state:'pending',lease:{expiresAt:at-1}},{state:'completed'}]){
    const f=fixture({read:async()=>({value:ticket})});assert.equal((await invoke(f)).statusCode,409);assert.equal(f.calls(),0);
  }
});
test('remote authorization uses a fixed origin, no redirects and bounded response bytes',async()=>{
  const service=createRemoteProductionAuthorization({adapter,env:{LINEAGE_WORKER_SECRET:secret},fetchImpl:async(url,options)=>{
    assert.equal(url,'https://lineagetheater.com/api/production-worker');assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{...input,model:adapter.model,recipe:adapter.modelVersion});return new Response('{"allowed":true}');
  }});assert.equal((await service.authorizeProduction(input)).allowed,true);
  for(const response of [new Response('',{status:302}),new Response(' '.repeat(4097))])
    await assert.rejects(createRemoteProductionAuthorization({adapter,env:{LINEAGE_WORKER_SECRET:secret},fetchImpl:async()=>response}).authorizeProduction(input));
});

test('both worker and web authorize the exact saved performance recipe, rejecting mismatched job bindings before payment calls', async () => {
  const manifest = planKlingShots(buildFilmManifest({ ...fictionalOperatorProject(), performanceControlsVersion: 1 }).manifest);
  const request = { ...input, manifestHash: digest(JSON.stringify(manifest)) };
  const provider = { model: 'kling', modelVersion: 'legacy-recipe', available: true,
    recipeForManifest: value => validateFilmPerformance(value) ? FILM_PERFORMANCE_RECIPE : 'legacy-recipe' };
  const job = { id: request.preparedId, ownerHash: digest(request.email), manifestHash: request.manifestHash, manifest,
    provider: { id: 'fal', model: 'kling', recipe: FILM_PERFORMANCE_RECIPE } };
  let observed, grants = 0;
  const read = async path => ({ value: path.startsWith('production/jobs/') ? job : { ...request, id: request.preparedId,
    state: 'pending', lease: { expiresAt: at + 10000 } } });
  const web = createProductionWorkerHandler({ env: { LINEAGE_WORKER_SECRET: secret }, adapter: provider, read,
    now: () => at, limiter: async () => true, paymentService: { authorizeProduction: async value => {
      grants++; assert.deepEqual(value, request); return { allowed: true, manifestHash: request.manifestHash };
    } } });
  const remote = createRemoteProductionAuthorization({ adapter: provider, env: { LINEAGE_WORKER_SECRET: secret }, read,
    fetchImpl: async (url, options) => {
      observed = JSON.parse(options.body);
      const res = { setHeader() {}, end(body) { this.body = body; } };
      await web({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: observed }, res);
      return new Response(res.body, { status: res.statusCode });
    } });
  assert.equal((await remote.authorizeProduction(request)).allowed, true);
  assert.equal(observed.recipe, FILM_PERFORMANCE_RECIPE); assert.equal(grants, 1);
  const denied = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await web({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: { ...observed, recipe: provider.modelVersion } }, denied);
  assert.equal(denied.statusCode, 409); assert.equal(grants, 1);
  job.manifestHash = 'd'.repeat(64);
  await assert.rejects(remote.authorizeProduction(request), /binding/); assert.equal(grants, 1);
});
test('reviewed delivery uses the worker credential, exact artifact binding and separate service even while generation is unqualified',async()=>{
  let delivered=0;const f=fixture({adapter:{...adapter,available:false},delivery:{deliver:async value=>{delivered++;assert.deepEqual(value,{orderId:input.orderId,artifactSha256:'d'.repeat(64)});return {status:'completed'};}}});
  const body={action:'deliver-reviewed-film',orderId:input.orderId,artifactSha256:'d'.repeat(64)};
  assert.equal((await invoke(f,{body,headers:{}})).statusCode,401);assert.equal(delivered,0);
  assert.equal((await invoke(f,{body:{...body,paid:true}})).statusCode,400);assert.equal(delivered,0);
  assert.equal((await invoke(f,{body})).body.status,'completed');assert.equal(delivered,1);assert.equal(f.calls(),0);
});

test('reviewed replacement forwards the exact previous digest and rejects invalid replacement fields',async()=>{
  const body={action:'deliver-reviewed-film',orderId:input.orderId,artifactSha256:'d'.repeat(64),previousArtifactSha256:'e'.repeat(64)};
  let calls=0;const f=fixture({delivery:{deliver:async value=>{calls++;const {action,...expected}=body;assert.deepEqual(value,expected);return {status:'completed'};}}});
  assert.equal((await invoke(f,{body:{...body,previousArtifactSha256:null}})).statusCode,400);assert.equal(calls,0);
  assert.equal((await invoke(f,{body})).statusCode,200);assert.equal(calls,1);
});

test('reviewed delivery accepts an explicit supported candidate model but rejects unknown models',async()=>{
  const body={action:'deliver-reviewed-film',orderId:input.orderId,artifactSha256:'d'.repeat(64),model:'wan'};
  let calls=0;const f=fixture({delivery:{deliver:async value=>{calls++;assert.equal(value.model,'wan');return {status:'completed'};}}});
  assert.equal((await invoke(f,{body:{...body,model:'unknown'}})).statusCode,400);assert.equal(calls,0);
  assert.equal((await invoke(f,{body})).statusCode,200);assert.equal(calls,1);
});

test('explicit failed-shot recovery uses a separate immutable-claim gate without relaxing ordinary worker leases', async () => {
  const request = { action: 'authorize-failed-shot-recovery', email: input.email, preparedId: input.preparedId,
    manifestHash: input.manifestHash, correctionId: input.orderId, recoveryId: 'd'.repeat(64),
    originalIdentity: 'e'.repeat(64), originalRequestId: 'original-request-id', replacementIdentity: 'f'.repeat(64),
    model: 'kling', recipe: adapter.modelVersion };
  let calls = 0;
  const f = fixture({ adapter: { ...adapter, model: 'kling' }, read: async () => null,
    corrections: { authorizeFailedShotRecovery: async value => {
      const { action, model, recipe, ...expected } = request; assert.deepEqual(value, expected); calls++;
      return { allowed: true, recoveryId: value.recoveryId };
    } } });
  for (const change of [{ headers: {} }, { body: { ...request, paid: true } }, { body: { ...request, model: 'wan' } },
    { body: { ...request, replacementIdentity: 'invalid' } }, { body: { ...request, preparedId: '../other' } }]) {
    assert.notEqual((await invoke(f, { body: request, ...change })).statusCode, 200); assert.equal(calls, 0);
  }
  const result = await invoke(f, { body: request }); assert.equal(result.statusCode, 200); assert.equal(result.body.allowed, true);
  assert.equal(calls, 1); assert.equal(f.calls(), 0);
  assert.equal((await invoke(f, { body: { ...input, model: 'kling', recipe: adapter.modelVersion } })).statusCode, 409);
  const unavailable = fixture({ adapter: { ...adapter, model: 'kling', available: false } });
  assert.equal((await invoke(unavailable, { body: request })).statusCode, 400);
});
