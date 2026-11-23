import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { createRemoteProductionAuthorization } from '../api/_lib/remote-production-authorization.mjs';

const secret='a'.repeat(64), at=1792372000000;
import { digest } from '../api/_lib/auth.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
const manifest = { productionPlan: { provider: 'seedance', version: 1 } };
const input={email:'family@example.invalid',preparedId:'11111111-1111-4111-8111-111111111111',manifestHash:digest(JSON.stringify(manifest)),orderId:'c'.repeat(64)};
const adapter={model:'seedance',modelVersion:SEEDANCE_RECIPE_VERSION,available:true};
const job = { id: input.preparedId, manifest, manifestHash: input.manifestHash, provider: { id: 'fal', model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION }, ownerHash: digest(input.email) };
const ticket = {state:'pending', email:input.email, id:input.preparedId, orderId:input.orderId, manifestHash:input.manifestHash, lease:{expiresAt:at+10000}};
function fixture(change={}){
  let calls=0;
  const handler=createProductionWorkerHandler({env:{LINEAGE_WORKER_SECRET:secret},adapter,now:()=>at,
    read:async path=>({value:path.startsWith('production/jobs/') ? job : ticket}),
    limiter:async()=>true,paymentService:{authorizeProduction:async value=>{calls++;assert.deepEqual(value,input);return {allowed:true,manifestHash:input.manifestHash};}},...change});
  return {handler,calls:()=>calls};
}
async function invoke(f,change={}){const res={setHeader(){},end(body){this.body=JSON.parse(body);}};
  await f.handler({method:'POST',headers:{authorization:`Bearer ${secret}`},body:{...input,model:adapter.model,recipe:adapter.modelVersion,workerProtocol:2},...change},res);return res;}
test('media worker receives a grant only after the existing live payment authorizer runs',async()=>{
  const f=fixture(),r=await invoke(f);assert.equal(r.statusCode,200);assert.equal(r.body.allowed,true);assert.equal(f.calls(),1);
});
test('wrong secret, provider recipe, absent lease and unexpected fields cannot issue worker grants',async()=>{
  for(const change of [{headers:{}},{headers:{authorization:'Bearer wrong'}},{method:'GET'},
    {body:{...input,model:'kling',recipe:'lineage-realistic-kling-o3-v1'}},
    {body:{...input,model:adapter.model,recipe:adapter.modelVersion}},
    {body:{...input,model:adapter.model,recipe:adapter.modelVersion,workerProtocol:2,paid:true}}]){
    const f=fixture();assert.notEqual((await invoke(f,change)).statusCode,200);assert.equal(f.calls(),0);
  }
  for (const change of [{provider: {...job.provider, model:'kling'}}, {manifest: {productionPlan: {provider:'kling',version:1}}}, {ownerHash:digest('someone else')}]) {
    const f = fixture({read:async path=>({value:path.startsWith('production/jobs/') ? {...job,...change} : ticket})});
    assert.equal((await invoke(f)).statusCode,409); assert.equal(f.calls(),0);
  }
  for(const ticket of [null,{state:'pending',lease:{expiresAt:at-1}},{state:'completed'}]){
    const f=fixture({read:async()=>({value:ticket})});assert.equal((await invoke(f)).statusCode,409);assert.equal(f.calls(),0);
  }
});
test('remote authorization uses a fixed origin, no redirects and bounded response bytes',async()=>{
  const service=createRemoteProductionAuthorization({adapter,env:{LINEAGE_WORKER_SECRET:secret},fetchImpl:async(url,options)=>{
    assert.equal(url,'https://lineagetheater.com/api/production-worker');assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{...input,model:adapter.model,recipe:adapter.modelVersion,workerProtocol:2,partialCorrectionVersion:1,partialCorrectionRetryVersion:1,narrationSuccessorVersion:1});return new Response('{"allowed":true}');
  }});assert.equal((await service.authorizeProduction(input)).allowed,true);
  for(const response of [new Response('',{status:302}),new Response(' '.repeat(4097))])
    await assert.rejects(createRemoteProductionAuthorization({adapter,env:{LINEAGE_WORKER_SECRET:secret},fetchImpl:async()=>response}).authorizeProduction(input));
});

test('an older worker cannot receive spending authorization for a partial correction', async () => {
  const corrected = { ...job, partialCorrection: { version: 1, correctionId: input.orderId, planHash: 'e'.repeat(64) } };
  const make = () => fixture({ read: async path => ({ value: path.startsWith('production/jobs/') ? corrected : ticket }) });
  const oldWorker = make(), denied = await invoke(oldWorker);
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.body.code, 'WORKER_PARTIAL_CORRECTION_REQUIRED');
  assert.equal(oldWorker.calls(), 0);

  for (const version of [0, 2, '1', null]) {
    const unsupported = make();
    const result = await invoke(unsupported, { body: { ...input, model: adapter.model,
      recipe: adapter.modelVersion, workerProtocol: 2, partialCorrectionVersion: version } });
    assert.equal(result.statusCode, 400);
    assert.equal(unsupported.calls(), 0);
  }

  const currentWorker = make();
  const result = await invoke(currentWorker, { body: { ...input, model: adapter.model,
    recipe: adapter.modelVersion, workerProtocol: 2, partialCorrectionVersion: 1 } });
  assert.equal(result.statusCode, 200);
  assert.equal(currentWorker.calls(), 1);
});
test('reviewed delivery uses the worker credential, exact artifact binding and separate service even while generation is unqualified',async()=>{
  let delivered=0;const f=fixture({adapter:{...adapter,available:false},delivery:{deliver:async value=>{delivered++;assert.deepEqual(value,{orderId:input.orderId,artifactSha256:'d'.repeat(64)});return {status:'completed'};}}});
  const body={action:'deliver-reviewed-film',orderId:input.orderId,artifactSha256:'d'.repeat(64)};
  assert.equal((await invoke(f,{body,headers:{}})).statusCode,401);assert.equal(delivered,0);
  assert.equal((await invoke(f,{body:{...body,paid:true}})).statusCode,400);assert.equal(delivered,0);
  assert.equal((await invoke(f,{body})).body.status,'completed');assert.equal(delivered,1);assert.equal(f.calls(),0);
});

test('a partial-retry target requires the new worker capability before any paid authorization', async () => {
  const corrected = { ...job, partialCorrection: { version: 1 }, partialCorrectionRetry: { version: 1 } };
  const make = () => fixture({ read: async path => ({ value: path.startsWith('production/jobs/') ? corrected : ticket }) });
  const body = { ...input, model: adapter.model, recipe: adapter.modelVersion, workerProtocol: 2, partialCorrectionVersion: 1 };
  const old = make(), denied = await invoke(old, { body });
  assert.equal(denied.statusCode, 409); assert.equal(denied.body.code, 'WORKER_PARTIAL_RETRY_REQUIRED'); assert.equal(old.calls(), 0);
  for (const partialCorrectionRetryVersion of [0, 2, '1', null]) {
    const unsupported = make(); assert.equal((await invoke(unsupported, { body: { ...body, partialCorrectionRetryVersion } })).statusCode, 400);
    assert.equal(unsupported.calls(), 0);
  }
  const current = make(); assert.equal((await invoke(current, { body: { ...body, partialCorrectionRetryVersion: 1 } })).statusCode, 200);
  assert.equal(current.calls(), 1);
});

test('the prior worker cannot authorize a narration successor, while the new capability retains normal authorization', async () => {
  const corrected = { ...job, partialCorrection: { version: 1 }, narrationSuccessor: { version: 1 } };
  const make = () => fixture({ read: async path => ({ value: path.startsWith('production/jobs/') ? corrected : ticket }) });
  const body = { ...input, model: adapter.model, recipe: adapter.modelVersion, workerProtocol: 2,
    partialCorrectionVersion: 1, partialCorrectionRetryVersion: 1 };
  const old = make(), denied = await invoke(old, { body });
  assert.equal(denied.statusCode, 409); assert.equal(denied.body.code, 'WORKER_NARRATION_SUCCESSOR_REQUIRED'); assert.equal(old.calls(), 0);
  for (const narrationSuccessorVersion of [0, 2, '1', null]) {
    const unsupported = make(); assert.equal((await invoke(unsupported, { body: { ...body, narrationSuccessorVersion } })).statusCode, 400);
    assert.equal(unsupported.calls(), 0);
  }
  const current = make(); assert.equal((await invoke(current, { body: { ...body, narrationSuccessorVersion: 1 } })).statusCode, 200);
  assert.equal(current.calls(), 1);
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

test('retired Kling recovery cannot issue worker spending grants', async () => {
  const f = fixture();
  const result = await invoke(f, {body: {action: 'authorize-failed-shot-recovery', ...input, model: 'kling', recipe: 'lineage-realistic-kling-o3-v1'}});
  assert.equal(result.statusCode, 410);
  assert.equal(f.calls(), 0);
});
