import test from 'node:test';
import assert from 'node:assert/strict';
import {speechEdit} from '../scripts/review-film-speech.mjs';
import {productionProgressSnapshot} from '../api/_lib/production-progress.mjs';
import {localVideoHandler,aiVideoHandler} from '../api/_lib/local-video-handler.mjs';
import {createFalProductionAdapter, FAL_RECIPE_VERSION} from '../api/_lib/fal-production.mjs';
import {buildFilmManifest,fictionalOperatorProject} from '../api/_lib/film-production.mjs';

test('speech verification rejects missing, changed and truncated narration; trims only trailing extra speech',()=>{
 const shot={narration:'They returned home.',dialogue:'',targetDurationMs:5000};
 const words=[{word:'They',start:.1,end:.4},{word:'returned',start:.5,end:1},{word:'home.',start:1.1,end:1.5}];
 assert.equal(speechEdit(shot,{duration:5,words}),null);
 const edit=speechEdit(shot,{duration:5,words:[...words,{word:'extra',start:2,end:2.4}]});
 assert.equal(edit.removedExtraSpeech,true);assert.ok(edit.cut<2&&edit.fadeStart>1.5);
 for(const transcript of [{duration:4,words},{duration:5,words:words.slice(1)},
  {duration:5,words:words.map((w,i)=>i===1?{...w,word:'never'}:w)},
  {duration:5,words:[...words.slice(0,2),{...words[2],end:5}]},
  {duration:5,words:[...words,{word:'extra',start:1.55,end:2}]}])
  assert.throws(()=>speechEdit(shot,transcript),{code:'FILM_SPEECH_REVIEW_REQUIRED'});
});

test('new realistic films receive an explicitly initial estimate that cannot drift or pretend completion',()=>{
 const now=Date.parse('2026-10-19T00:00:00Z'),at=new Date(now).toISOString();
 const job={provider:{id:'fal',model:'wan'},status:'processing',productionStartedAt:at,lastCheckedAt:at,
  manifest:{shots:[{id:'one',targetDurationMs:30000,characterIds:['person']}]},shots:[{id:'one',status:'processing',submittedAt:at}]};
 const first=productionProgressSnapshot({job,now});assert.equal(first.estimate.source,'initial');assert.equal(first.estimate.sampleCount,0);
 const next=productionProgressSnapshot({job:{...job,lastCheckedAt:new Date(now+60000).toISOString()},now:now+60000});
 assert.equal(first.estimate.latestAt,next.estimate.latestAt);assert.ok(next.percent>first.percent&&next.percent<90);
 const delayed=productionProgressSnapshot({job:{...job,lastCheckedAt:new Date(now+3600000).toISOString()},now:now+3600000});
 assert.equal(delayed.estimate,null);assert.equal(delayed.timing,'delayed');assert.ok(delayed.percent<90);
});

test('retired public video handlers cannot submit with any previously configured key',async()=>{
 for(const handler of [localVideoHandler,aiVideoHandler])for(const query of ['local=1','local=ltx&worker=1']){
  let status,body;await handler({method:'POST',url:`/api/studio?${query}`,headers:{host:'lineagetheater.com'},body:{action:'poll'}},
   {setHeader(){},set statusCode(v){status=v},end(v){body=JSON.parse(v)}});
  assert.equal(status,410);assert.match(body.message,/retired/);
 }
});

test('checkout cannot obtain a quote with missing, stale, wrong-model or future worker health',async()=>{
 const now=Date.parse('2026-10-19T03:00:00Z'),{manifest}=buildFilmManifest(fictionalOperatorProject());
 const good={ready:true,model:'wan',recipe:FAL_RECIPE_VERSION,checkedAt:new Date(now).toISOString()};
 let pricingCalls=0;
 for(const health of [null,{...good,ready:false},{...good,model:'seedance'},{...good,checkedAt:new Date(now-181000).toISOString()},{...good,checkedAt:new Date(now+1).toISOString()}]){
  const adapter=createFalProductionAdapter({key:'synthetic',requireWorker:true,now:()=>now,read:async()=>({value:health}),pricing:async()=>{pricingCalls++;}});
  await assert.rejects(adapter.validateManifest(manifest));
 }
 assert.equal(pricingCalls,0);
});
