import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { createFalClient, FAL_MODELS, falRequestUrl, falMediaUrl } from '../api/_lib/fal-client.mjs';
import { createFalProductionAdapter, falAdapterForSavedProvider, qualifiedFalRelease, falPlan, falShotInput, FalProductionPlanError, FAL_RECIPE_VERSION, FAL_LEGACY_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';

// All qualification, prices, requests and media here are synthetic test data.
// They are not live provider or customer-film completion evidence.
const at = Date.parse('2026-10-18T00:00:00Z');
const qualification = model => ({ version: 2, model, endpoint: FAL_MODELS[model], recipeVersion: FAL_RECIPE_VERSION,
  commercialUse: true, commercialUseSource:`https://fal.ai/models/${FAL_MODELS.kling}`,
  technicalSample:{requestId:'fixture-request-123',mediaSha256:'b'.repeat(64),durationMs:12042,width:1920,height:1080,
    videoCodec:'h264',audioCodec:'aac',fullDecodePassed:true,browserPlaybackPassed:true,nativeAudio:true},
  qualityScope:'technical-media-with-per-film-speech-gate',knownLimitations:['Synthetic fixture does not qualify visual fidelity.'],
  requiredDeliveryChecks:['full-decode','exact-duration','script-speech','private-artifact'],
  reviewedAt: new Date(at).toISOString(), rates: { expiresAt: new Date(at + 86400000).toISOString(), videoMicroUsdPerSecond: 1200000, referenceMicroUsd: 300000 } });
function storage() {
  const records = new Map(); let serial = 0;
  return { records, read: async path => structuredClone(records.get(path) || null),
    write: async (path, value, etag) => {
      if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw Error('precondition failed');
      records.set(path, { value: structuredClone(value), etag: String(++serial) });
    } };
}
const receipt = { request_id: 'fixture-request-123', status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/fixture-request-123/status',
  response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/fixture-request-123' };
const json = value => new Response(JSON.stringify(value));
const submit = { identity: digest('fictional request'), endpoint: FAL_MODELS.kling, input: { prompt: 'Fictional test.' } };
function klingFixture() {
  const {manifest}=buildFilmManifest(fictionalOperatorProject());
  manifest.shots.forEach((shot,index)=>{shot.startMs=index*12000;shot.targetDurationMs=12000;});
  manifest.targetDurationSeconds=manifest.shots.length*12;
  return {manifest,manifestHash:digest(JSON.stringify(manifest))};
}

test('durable fal operations submit once across racing and restarted clients', async () => {
  const data = storage(); let posts = 0;
  const options = { ...data, key: 'fixture-key', fetchImpl: async () => { posts++; return json(receipt); } };
  const client = createFalClient(options);
  await Promise.all(Array.from({ length: 12 }, () => client.submit(submit)));
  assert.equal(posts, 1);
  const reused = await createFalClient(options).submit(submit);
  assert.equal(reused.requestId, receipt.request_id); assert.equal(posts, 1);
  await assert.rejects(client.submit({ ...submit, input: { prompt: 'Changed content' } }), { code: 'FAL_IDEMPOTENCY_CONFLICT' });
});

test('lost response or missing receipt never permits a second paid POST', async () => {
  for (const response of [() => { throw Error('timeout'); }, () => json({}), () => new Response('', { status: 402 })]) {
    const data = storage(); let posts = 0;
    const client = createFalClient({ ...data, key: 'fixture-key', fetchImpl: async () => { posts++; return response(); } });
    assert.equal((await client.submit(submit)).state, 'uncertain');
    assert.equal((await client.submit(submit)).state, 'uncertain');
    assert.equal((await client.poll(submit.identity)).state, 'uncertain'); assert.equal(posts, 1);
  }
});

test('receipt persistence retry never repeats submission', async () => {
  const data = storage(); let posts = 0, failures = 0;
  const client = createFalClient({ ...data, key: 'fixture-key', write: async (path, value, etag) => {
    if (value.requestId && failures++ === 0) throw Error('storage timeout');
    return data.write(path, value, etag);
  }, fetchImpl: async () => { posts++; return json(receipt); } });
  assert.equal((await client.submit(submit)).requestId, receipt.request_id); assert.equal(posts, 1);
});

test('missing configuration is detected before reserving a new paid operation', async () => {
  const data = storage(), client = createFalClient({ ...data, key: null, fetchImpl: () => assert.fail() });
  await assert.rejects(client.submit(submit), { code: 'FAL_KEY_REQUIRED' }); assert.equal(data.records.size, 0);
});

test('fal status and media URLs cannot forward credentials to arbitrary hosts or another request', () => {
  for (const url of ['https://evil.invalid/r', 'http://queue.fal.run/r', receipt.status_url + '?token=unsafe', receipt.status_url.replace('fixture-request-123', 'another-request-1'), receipt.status_url.replace('/fal-ai/kling-video/', '/other/model/'), receipt.status_url.replace('https://', 'https://user:secret@')]) {
    assert.throws(() => falRequestUrl(url, FAL_MODELS.kling, receipt.request_id, 'status'));
  }
  assert.equal(falRequestUrl(receipt.status_url, FAL_MODELS.kling, receipt.request_id, 'status'), receipt.status_url);
  for (const url of ['https://fal.media.evil.invalid/file.mp4', 'http://v3.fal.media/file.mp4', 'https://127.0.0.1/file.mp4', 'https://user:secret@v3.fal.media/file.mp4']) assert.throws(() => falMediaUrl(url));
});

test('polling checks terminal provider errors and caches completed results', async () => {
  for (const failed of [false, true]) {
    const data = storage(), methods = [];
    const client = createFalClient({ ...data, key: 'fixture-key', fetchImpl: async (url, options) => {
      methods.push(options.method); assert.equal(options.redirect, 'error');
      if (options.method === 'POST') return json(receipt);
      if (url.endsWith('/status')) return json({ status: 'COMPLETED', request_id: receipt.request_id, ...(failed ? { error: 'fixture' } : {}) });
      return json({ video: { url: 'https://v3.fal.media/fixture.mp4' } });
    } });
    await client.submit(submit); assert.equal((await client.poll(submit.identity)).state, failed ? 'failed' : 'completed');
    await client.poll(submit.identity); assert.deepEqual(methods, failed ? ['POST', 'GET'] : ['POST', 'GET', 'GET']);
  }
});

test('a terminal size rejection is recorded without resubmitting or retaining untrusted details', async () => {
  const data=storage();let posts=0;
  const client=createFalClient({...data,key:'fixture',fetchImpl:async(url,options)=>{
    if(options.method==='POST'){posts++;return json(receipt);}
    return url.endsWith('/status')?json({status:'COMPLETED'}):new Response(JSON.stringify({detail:[{type:'file_too_large',input:'private-reference',msg:'untrusted'}]}),{status:422});
  }});
  await client.submit(submit);const result=await client.poll(submit.identity);
  assert.equal(result.state,'failed');assert.equal(result.failureCode,'FAL_REFERENCE_TOO_LARGE');assert.ok(!JSON.stringify(result).includes('private-reference'));
  await client.poll(submit.identity);assert.equal(posts,1);
});

test('both providers preserve exact speech, references, 1080p and rounded edit handles', () => {
  const { manifest } = buildFilmManifest(fictionalOperatorProject());
  for (const model of ['seedance', 'wan']) {
    const references = Object.fromEntries(manifest.screenplay.characters.map(c => [c.id, `https://v3.fal.media/${c.id}.png`]));
    const body = falShotInput(manifest, manifest.shots[0], model, references);
    assert.equal(body.resolution, '1080p'); assert.ok(body.prompt.includes(manifest.shots[0].narration));
    assert.ok(body.prompt.includes(manifest.shots[0].dialogue));
    assert.ok(Number(body.duration) * 1000 >= manifest.shots[0].targetDurationMs);
    assert.equal((body.image_urls || body.reference_image_urls).length, manifest.shots[0].characterIds.length);
  }
});

test('approved on-screen captions remain in the manifest but are excluded from generated lettering',()=>{
  const {manifest}=buildFilmManifest(fictionalOperatorProject());
  manifest.shots[0].visual+=' Caption: “Fictional place • 1832.”';
  const refs=Object.fromEntries(manifest.screenplay.characters.map(c=>[c.id,'https://v3.fal.media/reference.png']));
  const body=falShotInput(manifest,manifest.shots[0],'seedance',refs);
  assert.ok(!body.prompt.includes('Fictional place'));assert.ok(manifest.shots[0].visual.includes('Fictional place'));
  assert.match(body.prompt,/Start narration within the first 0.2 seconds/);assert.match(body.prompt,/Never show, pan across, fade from/);
});

test('legacy cinematic direction produces photographic prompts without altering the paid screenplay',()=>{
  const {manifest}=buildFilmManifest(fictionalOperatorProject());
  manifest.shots[0].visual='Premium cinematic animation. Two relatives sit by the window.';
  manifest.screenplay.characters[0].description='Animation maintains the same attentive eyes.';
  const before=JSON.stringify(manifest);
  const refs=Object.fromEntries(manifest.screenplay.characters.map(c=>[c.id,'https://v3.fal.media/reference.png']));
  for(const model of ['seedance','wan']){
    const body=falShotInput(manifest,manifest.shots[0],model,refs);
    assert.match(body.prompt,/Photorealistic live-action/);assert.match(body.prompt,/visible skin texture/);
    assert.doesNotMatch(body.prompt,/Premium cinematic animation|Animation maintains|hand-drawn 2D/);
    assert.ok(body.prompt.includes(manifest.shots[0].narration));
  }
  assert.equal(JSON.stringify(manifest),before);
  assert.notEqual(FAL_RECIPE_VERSION,'lineage-cinematic-v1');
});

test('reviewed editorial replacements stay bound to the original paid shot and cannot trigger new spending',async()=>{
  const {manifest,manifestHash}=buildFilmManifest(fictionalOperatorProject()),key=digest('fixture-shot'),identity=digest(`${FAL_LEGACY_RECIPE_VERSION}:seedance:${key}`),replacement=digest('fixture-replacement');
  const choice={version:1,originalIdentity:identity,productionId:'fixture-production',manifestHash,model:'seedance',approvedBy:OWNER_EMAIL,promptVersion:FAL_LEGACY_RECIPE_VERSION,replacementIdentity:replacement,requestId:'fixture-replacement-id'};
  const read=async path=>({value:path===userPath(OWNER_EMAIL)?{email:OWNER_EMAIL,role:'owner'}:choice});
  const client={get:async id=>id===replacement?{state:'completed',endpoint:FAL_MODELS.seedance,requestId:choice.requestId,result:{video:{url:'https://v3.fal.media/reviewed.mp4'}}}:null,submit:()=>assert.fail('No new spending'),poll:()=>assert.fail('A completed choice does not need polling')};
  const adapter=createFalProductionAdapter({model:'seedance',client,read,fetchImpl:async()=>new Response(null,{headers:{'content-type':'video/mp4','content-length':'100'}})});
  const input={manifest,manifestHash,shot:manifest.shots[0],productionId:choice.productionId,idempotencyKey:key};
  assert.equal((await adapter.reconcileShot(input)).status,'completed');
  choice.manifestHash='c'.repeat(64);await assert.rejects(adapter.reconcileShot(input));
});

test('unsupported plans and missing quality evidence cannot enable production', async () => {
  const { manifest } = buildFilmManifest(fictionalOperatorProject());
  assert.equal(createFalProductionAdapter({ key: 'fixture-key', qualification: null }).available, false);
  for (const change of [m => { m.shots[0].targetDurationMs = 31000; }, m => { m.shots[0].characterIds = ['missing']; }, m => { m.shots[0].narration = 'word '.repeat(500); }, m => { m.shots[1].startMs++; }]) {
    const changed = structuredClone(manifest); change(changed); assert.throws(() => falPlan(changed, 'seedance'));
  }
  const q = qualification('kling'), adapter = createFalProductionAdapter({ model: 'kling', key: 'fixture-key', qualification: q, now: () => at, pricing: async () => q.rates });
  const planned=klingFixture().manifest;
  assert.equal(adapter.available, true);
  assert.equal((await adapter.validateManifest(planned)).maximumCostCents,
    Math.ceil((falPlan(planned, 'kling').generatedSeconds * 1200000 + 2 * 300000) / 10000));
});

test('reference and render stages require separate current spending approval and reuse saved requests', async () => {
  const { manifest, manifestHash } = klingFixture();
  const operations = new Map(), submitted = []; let allowed = true, grantChecks = 0;
  const client = { get: async id => operations.get(id), submit: async request => {
    submitted.push(request); const value = { state: 'queued', requestId: `fixture-${submitted.length}`, ...request }; operations.set(request.identity, value); return value;
  }, poll: async id => { const value = operations.get(id); value.state = 'completed';
    value.result = value.endpoint === FAL_MODELS.reference ? { images: [{ url: 'https://v3.fal.media/reference.png' }] } : { video: { url: 'https://v3.fal.media/film.mp4' } }; return value; } };
  const adapter = createFalProductionAdapter({ model: 'kling', qualification:qualification('kling'), client, read:async()=>null, now: () => at, normalizeKlingReference: async url => url, fetchImpl: async () => new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '100' } }) });
  const input = { manifest, manifestHash, shot: manifest.shots[0], productionId: 'fixture-production', idempotencyKey: digest('fixture-scene'), authorizeSpend: async () => { grantChecks++; return allowed; } };
  assert.equal((await adapter.submitShot(input)).status, 'processing'); assert.equal(submitted.length, 2);
  allowed = false; await assert.rejects(adapter.pollShot(input), /spending is not authorized/); assert.equal(submitted.length, 2);
  allowed = true; await adapter.pollShot(input); await adapter.pollShot(input); const result = await adapter.pollShot(input);
  assert.equal(result.status, 'completed'); assert.equal(submitted.length, 3); assert.equal(grantChecks, 4);
  await adapter.pollShot(input); assert.equal(submitted.length, 3);
  const peer = createFalProductionAdapter({ model: 'seedance', client, read:async()=>null, now: () => at });
  assert.equal((await peer.submitShot(input)).status,'uncertain'); assert.equal(submitted.filter(r => r.endpoint === FAL_MODELS.reference).length, 2);
});

test('Kling request matches the live schema and preserves exact script and explicit identity',()=>{
  const {manifest}=klingFixture(),shot=manifest.shots[0];
  shot.dialogue='Mara: We remember this together.';
  manifest.screenplay.characters[0].description='A Black American adult with an attentive expression and period-appropriate clothing.';
  const before=JSON.stringify(manifest),refs=Object.fromEntries(manifest.screenplay.characters.map(c=>[c.id,`https://v3.fal.media/${c.id}.jpg`]));
  const input=falShotInput(manifest,shot,'kling',refs);
  assert.deepEqual(Object.keys(input).sort(),['aspect_ratio','duration','enable_safety_checker','generate_audio','image_urls','prompt','shot_type']);
  assert.equal(input.duration,'12');assert.equal(input.generate_audio,true);assert.equal(input.aspect_ratio,'16:9');assert.equal(input.enable_safety_checker,true);
  assert.ok(input.prompt.length<=2500);assert.ok(input.prompt.includes('Black American'));
  assert.ok(input.prompt.includes(shot.narration));assert.ok(input.prompt.includes(shot.dialogue));
  assert.equal(input.prompt.split(shot.narration).length-1,1);
  assert.equal(input.prompt.split(shot.dialogue).length-1,1);
  assert.ok(input.prompt.includes('@Image1'));assert.equal(input.image_urls.length,shot.characterIds.length);
  assert.equal(JSON.stringify(manifest),before);
});

test('Kling rejects unsupported duration, excessive references and long prompts without truncation',()=>{
  for(const mutate of [
    m=>{m.shots[0].targetDurationMs=2999;},
    m=>{m.shots[0].targetDurationMs=15001;},
    m=>{m.shots[0].characterIds=Array(5).fill(m.screenplay.characters[0].id);},
    m=>{m.screenplay.characters[0].description='Exact saved description '.repeat(130);},
  ]){
    const {manifest}=klingFixture();mutate(manifest);const before=JSON.stringify(manifest);
    assert.throws(()=>falPlan(manifest,'kling'));assert.equal(JSON.stringify(manifest),before);
  }
  const {manifest}=klingFixture(),original=manifest.shots[0];
  manifest.shots=Array.from({length:200},(_,i)=>({...original,id:`shot-${i}`,startMs:i*3000,targetDurationMs:3000,narration:'A brief memory.',dialogue:''}));
  manifest.targetDurationSeconds=600;
  assert.equal(falPlan(manifest,'kling').shots.length,200);
  assert.throws(()=>falPlan(manifest,'wan'));
});

test('Kling qualification is scoped technical evidence and requires the current delivery worker contract',async()=>{
  const q=qualification('kling');assert.equal(qualifiedFalRelease(q,'kling'),true);
  for(const mutate of [v=>{v.version=1;},v=>{v.technicalSample.fullDecodePassed=false;},
    v=>{v.technicalSample.nativeAudio=false;},v=>{v.requiredDeliveryChecks=['full-decode'];},
    v=>{v.commercialUseSource='https://example.invalid';}]){
    const changed=structuredClone(q);mutate(changed);assert.equal(qualifiedFalRelease(changed,'kling'),false);
  }
  const heartbeat={recipe:FAL_RECIPE_VERSION,model:'kling',ready:true,checkedAt:new Date(at).toISOString()};
  const adapter=createFalProductionAdapter({qualification:q,key:'fixture',requireWorker:true,read:async()=>({value:heartbeat}),
    now:()=>at,pricing:async()=>q.rates});
  await assert.rejects(adapter.validateManifest(klingFixture().manifest),/temporarily unavailable/);
  heartbeat.deliveryChecksVersion=1;
  assert.ok((await adapter.validateManifest(klingFixture().manifest)).ready);
  assert.equal(adapter.evidence.qualityScope,'technical-media-with-per-film-speech-gate');
  assert.deepEqual(adapter.evidence.knownLimitations,q.knownLimitations);
});

test('legacy endpoints cannot make a new POST but their exact saved operations remain readable',async()=>{
  for(const endpoint of [FAL_MODELS.wan,FAL_MODELS.seedance]){
    const data=storage(),client=createFalClient({...data,key:'fixture',fetchImpl:()=>assert.fail('No legacy submission')});
    await assert.rejects(client.submit({...submit,endpoint}),{code:'FAL_LEGACY_SUBMISSION_DISABLED'});
    assert.equal(data.records.size,0);
    const saved={version:1,identity:submit.identity,endpoint,inputHash:digest(JSON.stringify(submit.input)),state:'completed',result:{}};
    await data.write(`production/fal/requests/${submit.identity}.json`,saved);
    assert.deepEqual(await client.submit({...submit,endpoint}),saved);
  }
});

test('saved legacy jobs poll the original model and never switch to Kling or regenerate references',async()=>{
  const {manifest,manifestHash}=buildFilmManifest(fictionalOperatorProject()),idempotencyKey=digest('legacy-queued'),productionId='fixture-production';
  for(const model of ['wan','seedance']){
    const identity=digest(`${FAL_LEGACY_RECIPE_VERSION}:${model}:${idempotencyKey}`);
    let polls=0;
    const request={identity,endpoint:FAL_MODELS[model],state:'queued',requestId:'fixture-legacy-request'};
    const client={get:async id=>id===identity?request:null,submit:()=>assert.fail('Never submit historical jobs'),poll:async id=>{
      assert.equal(id,identity);polls++;return {...request,state:'completed',result:{video:{url:'https://v3.fal.media/legacy.mp4'}}};
    }};
    const adapter=falAdapterForSavedProvider({id:'fal',model,recipe:FAL_LEGACY_RECIPE_VERSION},{client,read:async()=>null,
      selectedPhoto:()=>assert.fail('Do not re-read references for completed videos'),
      fetchImpl:async()=>new Response(null,{headers:{'content-type':'video/mp4','content-length':'100'}})});
    const result=await adapter.reconcileShot({manifest,manifestHash,shot:manifest.shots[0],productionId,idempotencyKey,authorizeSpend:()=>assert.fail('No fresh spend authorization')});
    assert.equal(result.status,'completed');assert.equal(result.providerJobId,`fal-${identity}`);assert.equal(polls,1);
    assert.equal(adapter.available,false);
    assert.throws(()=>falAdapterForSavedProvider({id:'fal',model,recipe:FAL_RECIPE_VERSION}));
  }
});

test('historical unfinished references are reconciled without creating a missing video',async()=>{
  const {manifest,manifestHash}=buildFilmManifest(fictionalOperatorProject()),productionId='fixture-production',idempotencyKey=digest('old-reference');
  const referenceId=digest(`${FAL_LEGACY_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${manifest.screenplay.characters[0].id}`);
  let polls=0;
  const reference={endpoint:FAL_MODELS.reference,state:'queued',requestId:'old-reference-request'};
  const client={get:async id=>id===referenceId?reference:null,submit:()=>assert.fail('No new operation'),
    poll:async id=>{assert.equal(id,referenceId);polls++;return reference;}};
  const adapter=createFalProductionAdapter({model:'wan',client,read:async()=>null});
  const input={manifest,manifestHash,productionId,idempotencyKey,shot:manifest.shots[0]};
  assert.equal((await adapter.reconcileShot(input)).status,'processing');assert.equal(polls,1);
  reference.state='completed';
  assert.equal((await adapter.reconcileShot(input)).status,'uncertain');
});

test('a wrong-model durable request cannot be reused or polled under a Kling identity',async()=>{
  const {manifest,manifestHash}=klingFixture(),idempotencyKey=digest('wrong-model');
  const adapter=createFalProductionAdapter({client:{get:async()=>({endpoint:FAL_MODELS.wan,state:'queued',requestId:'wrong-model-request'}),
    poll:()=>assert.fail('Do not poll a mismatched record'),submit:()=>assert.fail()},read:async()=>null});
  await assert.rejects(adapter.reconcileShot({manifest,manifestHash,shot:manifest.shots[0],productionId:'fixture',idempotencyKey}));
});

test('the in-flight fictional canary keeps the exact original prompt bytes',()=>{
  const manifest=planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest);
  const refs=Object.fromEntries(manifest.screenplay.characters.map(c=>[c.id,'https://v3.fal.media/reference.jpg']));
  const expected=['06b1b10017c9ce4f1f224cc30808015a79b3f8064075a670460310109f150496',
    '12cab436f52e4d9936c1b73fe46198f579377d9589e9a2b65d5dd9443ed10156',
    '9f53b1ab585e41deacf4701a3493c6cc7c49c9c24b7bdaff31eb14fee2172081'];
  assert.deepEqual(manifest.shots.map(shot=>digest(falShotInput(manifest,shot,'kling',refs).prompt)),expected);
});

test('long scene prompts compact only generic directions and retain every saved creative field',()=>{
  const {manifest}=klingFixture(),shot=manifest.shots[0];
  const fill=(text,length)=>text.repeat(Math.ceil(length/text.length)).slice(0,length);
  manifest.screenplay.characters[0].description=fill('A Black American adult in a green apron with an attentive expression. ',580);
  manifest.screenplay.characters[1].description=fill('A fictional adult gardener wearing a blue apron. ',201);
  manifest.screenplay.logline=fill('Two fictional gardeners share the harvest in their imaginary village. ',196);
  shot.visual=fill('A photographic garden scene with warm natural lighting and realistic clothing. ',762);
  shot.dramatization=fill('An entirely fictional interaction without claims about real people. ',282);
  shot.narration='The two fictional sisters share their memories and their harvest.';
  shot.dialogue='Fictional Ada: We planted this together.\nFictional Alice: We can share it together.';
  const before=JSON.stringify(manifest),refs=Object.fromEntries(manifest.screenplay.characters.map(c=>[c.id,'https://v3.fal.media/reference.jpg']));
  const prompt=falShotInput(manifest,shot,'kling',refs).prompt;
  assert.ok(prompt.length<=2500);assert.match(prompt,/Verbatim once/);
  for(const value of [manifest.screenplay.logline,...manifest.screenplay.characters.map(c=>c.description),
    shot.visual,shot.dramatization,shot.narration,shot.dialogue])assert.ok(prompt.includes(value));
  assert.equal(JSON.stringify(manifest),before);
  shot.visual+=' More visual details.'.repeat(60);
  assert.throws(()=>falPlan(manifest,'kling'),error=>error instanceof FalProductionPlanError
    && error.status===422&&error.code==='FILM_PROMPT_TOO_LONG'&&/Scene 1.*Shorten/.test(error.message));
});
