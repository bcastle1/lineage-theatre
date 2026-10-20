import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {digest,userPath} from '../api/_lib/auth.mjs';
import {productionJobPath} from '../api/_lib/film-production.mjs';
import {planKlingShots} from '../api/_lib/kling-film-plan.mjs';
import {authoredPcm,createAdjacentAuthoredSpeechContext} from '../scripts/adjacent-authored-speech.mjs';
import {createAutomaticSoundtrackFallback,standardFilmVoices} from '../scripts/automatic-film-soundtrack.mjs';
import {soundtrackPlan} from '../scripts/rebuild-film-soundtrack.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex'),sha=value=>hash(JSON.stringify(value));
const clone=structuredClone,error={code:'FILM_SPEECH_REVIEW_REQUIRED'};
const words=(text,offset=0)=>text.split(' ').map((word,index)=>({word,start:offset+.1+index*.4,end:offset+.35+index*.4}));
function pcm(durationMs,marker,channels=2){
  const data=Buffer.alloc(durationMs*48*channels*2);data.writeInt16LE(marker,0);data.writeInt16LE(marker,data.length-2);
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(data.length+36,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(channels,22);header.writeUInt32LE(48000,24);
  header.writeUInt32LE(48000*channels*2,28);header.writeUInt16LE(channels*2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(data.length,40);return Buffer.concat([header,data]);
}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'lineage-scene-context-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'soundtrack');await mkdir(directory);
  const scene={title:'A quiet afternoon',narration:'The afternoon was quiet. They returned home.',dialogue:'',characterIds:[]};
  const manifest=planKlingShots({version:1,filmId:'12345678-1234-1234-1234-123456789abd',targetDurationSeconds:20,
    screenplay:{characters:[],scenes:[clone(scene)]},sound:{musicRequested:false},
    shots:[{...scene,id:'shot-001',sceneIndex:0,startMs:0,targetDurationMs:20000,continuity:{precedingShotId:null}}]});
  const manifestHash=sha(manifest),voices=standardFilmVoices(manifest,manifestHash),plan=soundtrackPlan({manifest,manifestHash,...voices});
  const fileBytes=new Map();
  const file=async(name,bytes)=>{
    fileBytes.set(name,bytes);await writeFile(join(directory,name),bytes);
    return {file:name,sha256:hash(bytes),sizeBytes:bytes.length};
  };
  const scenes=[];
  for(const [index,planned] of plan.scenes.entries()){
    const mix=await file(`scene-${index+1}-mix.wav`,pcm(planned.durationMs,index+1));
    const turns=[];
    for(const turn of planned.turns)turns.push({...turn,text:undefined,speed:1,synthesisTextSha256:turn.textSha256,
      phonemesSha256:'f'.repeat(64),startSeconds:.1,endSeconds:3,
      audio:await file(`scene-${index+1}-turn-${turn.turnIndex}.wav`,pcm(3000,index+11))});
    scenes.push({shotId:planned.shotId,durationMs:planned.durationMs,narrationSha256:planned.narrationSha256,
      dialogueSha256:planned.dialogueSha256,originalProviderAudioIncluded:false,mix,speech:clone(mix),turns});
  }
  const provenance={manifestHash,recipe:plan.recipe,status:'constructed-needs-review',engine:'kokoro-82m-v1.0-cpu',
    sourceTextRewritten:false,speed:1,providerGenerationCalls:0,durationMs:plan.durationMs,musicRequested:false,
    narratorVoice:plan.narratorVoice,characterVoices:plan.characterVoices,runtimeVersions:{misaki:'0.9.4'},scenes};
  const [first,second]=manifest.shots,sourcePaths=scenes.map(value=>join(directory,value.mix.file));
  const previousTranscript={duration:10,words:words(first.narration)};
  const normal={duration:10,words:words('It returned home.')},context={duration:10,words:words('Means returned home.')};
  const fullNormal={duration:20,words:[...previousTranscript.words,...words(second.narration,10)]},fullContext=clone(fullNormal);
  fullNormal.words[4].start=9.7;fullContext.words[4].start=9;
  const input={manifest:clone(manifest),shot:clone(second),audioPath:sourcePaths[1],normalTranscript:normal,contextTranscript:context,
    previous:{shot:clone(first),clip:{shotId:first.id,path:sourcePaths[0]},audioPath:sourcePaths[0],audioSha256:scenes[0].mix.sha256,
      audioSizeBytes:scenes[0].mix.sizeBytes,review:{shotId:first.id,scriptMatched:true,contextSilence:false}}};
  const records=new Map(),writes=[],transcriptions=[];let guardCount=0;
  const read=async path=>clone(records.get(path)||null);
  const write=async(path,value,etag)=>{
    const previous=records.get(path);if(previous?previous.etag!==etag:etag!==undefined)throw Error('immutable or etag conflict');
    records.set(path,{value:clone(value),etag:`write-${writes.length+1}`});writes.push({path,value:clone(value)});
  };
  const guard=async()=>{guardCount++;};
  const transcribe=async(path,options)=>{
    transcriptions.push({path,options:clone(options)});return clone(options.contextSilence?fullContext:fullNormal);
  };
  const bindingHash='a'.repeat(64),prefix=`production/soundtracks/${'b'.repeat(64)}/12345678-1234-1234-1234-123456789abc/${bindingHash}`;
  const options={manifest,manifestHash,voices,provenance,constructionRoot:root,bindingHash,prefix,read,write,guard,transcribe};
  return {root,directory,manifest,manifestHash,voices,provenance,fileBytes,sourcePaths,input,previousTranscript,normal,context,
    fullNormal,fullContext,records,writes,transcriptions,read,write,options,guards:()=>guardCount};
}

test('context factory preserves exact PCM and distinct raw full-window receipts with immutable proof',async t=>{
  const f=await fixture(t),before=await Promise.all(f.sourcePaths.map(path=>readFile(path))),input=clone(f.input);
  const resolve=createAdjacentAuthoredSpeechContext(f.options),result=await resolve(f.input);
  assert.deepEqual(f.input,input);
  assert.deepEqual(result.normalTranscript,f.fullNormal);assert.deepEqual(result.contextTranscript,f.fullContext);
  assert.equal(result.equivalenceProof,null);assert.equal(result.proof.perCutLocalization,false);
  assert.equal(result.proof.standaloneNormalTranscriptSha256,sha(f.normal));
  assert.equal(result.proof.standaloneContextTranscriptSha256,sha(f.context));
  const combined=await readFile(f.transcriptions[0].path);
  const expectedPcm=Buffer.concat(before.map(value=>authoredPcm(value).data));
  assert.ok(authoredPcm(combined).data.equals(expectedPcm));
  assert.equal(result.proof.combinedAudioSha256,hash(combined));assert.equal(result.proof.combinedPcmSha256,hash(expectedPcm));
  assert.deepEqual(await Promise.all(f.sourcePaths.map(path=>readFile(path))),before);
  assert.deepEqual(f.transcriptions.map(value=>value.options.contextSilence),[false,true]);
  assert.equal(f.writes.length,3);assert.ok(f.guards()>3);
  const raw=f.writes.filter(value=>value.value.kind==='authored-scene-window-transcription');
  assert.equal(raw.length,2);assert.ok(raw.every(value=>value.path.includes('/scene-context/')&&!value.path.includes('/transcriptions/')));
  assert.deepEqual(raw.map(value=>value.value.transcript),[f.fullNormal,f.fullContext]);
  assert.equal(raw[0].value.transcript.words[4].start,9.7);assert.equal(raw[1].value.transcript.words[4].start,9);
  const bytes=await readFile(result.proof.evidencePath);
  assert.equal(hash(bytes),result.proof.evidenceSha256);
  assert.deepEqual(JSON.parse(bytes),f.records.get(result.proof.receiptPath).value);
  await assert.rejects(resolve(f.input),error);assert.equal(f.transcriptions.length,2);
});

test('context factory rejects changed source PCM before recognition and changed combined PCM during recognition',async t=>{
  for(const mode of ['source-before','source-during','combined-during']){
    const f=await fixture(t);let calls=0;
    if(mode==='source-before')await writeFile(f.sourcePaths[1],pcm(10000,99));
    const resolve=createAdjacentAuthoredSpeechContext({...f.options,transcribe:async(path,options)=>{
      calls++;
      if(mode==='source-during')await writeFile(f.sourcePaths[0],pcm(10000,99));
      if(mode==='combined-during')await writeFile(path,pcm(20000,99));
      return f.options.transcribe(path,options);
    }});
    await assert.rejects(resolve(f.input),error);
    if(mode==='source-before')assert.equal(calls,0);
    assert.ok(f.writes.every(value=>value.value.kind!=='adjacent-authored-scene-proof-v1'));
  }
});

test('context factory requires exact immutable raw and proof readbacks while tolerating lost write responses',async t=>{
  for(const mode of ['raw-corrupt','proof-corrupt','lost-response']){
    const f=await fixture(t);
    const resolve=createAdjacentAuthoredSpeechContext({...f.options,write:async(path,value,etag)=>{
      const changed=clone(value);
      if(mode==='raw-corrupt'&&changed.kind==='authored-scene-window-transcription')changed.transcript.words[0].word='changed';
      if(mode==='proof-corrupt'&&changed.kind==='adjacent-authored-scene-proof-v1')changed.pcmUnchanged=false;
      await f.write(path,changed,etag);if(mode==='lost-response')throw Error('lost response');
    }});
    if(mode==='lost-response')assert.equal((await resolve(f.input)).proof.pcmUnchanged,true);
    else await assert.rejects(resolve(f.input),error);
  }
});

test('context factory stops on lost ownership and rejects altered original scene text',async t=>{
  const claim=await fixture(t);let calls=0;
  const resolver=createAdjacentAuthoredSpeechContext({...claim.options,guard:async()=>{throw Error('claim expired');},
    transcribe:async()=>{calls++;throw Error('must not recognize');}});
  await assert.rejects(resolver(claim.input),/claim expired/);assert.equal(calls,0);assert.equal(claim.writes.length,0);
  const f=await fixture(t);f.manifest.screenplay.scenes[0].narration='The afternoon was quiet. They never returned.';
  f.manifestHash=sha(f.manifest);f.provenance.manifestHash=f.manifestHash;f.input.manifest=clone(f.manifest);
  await assert.rejects(createAdjacentAuthoredSpeechContext({...f.options,manifestHash:f.manifestHash})(f.input),error);
});

test('losing the claim between full-window recognition passes prevents a completed proof',async t=>{
  const f=await fixture(t);let active=true;
  const resolver=createAdjacentAuthoredSpeechContext({...f.options,
    guard:async()=>{if(!active)throw Error('claim changed during review');},
    transcribe:async(path,options)=>{const result=await f.options.transcribe(path,options);active=false;return result;}});
  await assert.rejects(resolver(f.input),/claim changed during review/);
  assert.equal(f.transcriptions.length,1);assert.equal(f.writes.length,0);
});

async function cachedAutomatic(t){
  const f=await fixture(t),work=join(f.root,'automatic');await mkdir(work);
  const email='approved-customer@example.test',id='12345678-1234-1234-1234-123456789abc',now=1800000000000;
  const clips=[],sources=[];
  for(const shot of f.manifest.shots){
    const bytes=Buffer.from(`verified source video ${shot.id}`),path=join(work,`${shot.id}.mp4`);await writeFile(path,bytes);
    clips.push({shotId:shot.id,path});sources.push({shotId:shot.id,sha256:hash(bytes),sizeBytes:bytes.length});
  }
  const job={id,ownerHash:digest(email),filmId:f.manifest.filmId,mode:'customer',status:'awaiting-assembly',manifest:f.manifest,
    manifestHash:f.manifestHash,provider:{id:'fal',model:'kling'},authorization:{environment:'production',manifestHash:f.manifestHash},
    shots:f.manifest.shots.map(shot=>({id:shot.id,status:'completed',output:{sha256:'f'.repeat(64)}}))};
  const binding={version:1,recipe:'automatic-stock-soundtrack-v1',ownerHash:job.ownerHash,id,manifestHash:f.manifestHash,
    sources,sourceOutputsSha256:sha(job.shots.map(shot=>({id:shot.id,output:shot.output}))),voices:f.voices};
  const bindingHash=sha(binding),prefix=`production/soundtracks/${job.ownerHash}/${id}/${bindingHash}`,receiptPath=`${prefix}/construction.json`;
  const cached={kind:'automatic-stock-soundtrack-v1',bindingHash,binding,state:'constructed',attempts:2,attemptId:'cached-second-attempt',
    provenance:f.provenance,provenanceSha256:sha(f.provenance)};
  const orderId=digest(`${email}:production:${f.manifestHash}`),orderPath=`payments/orders/${orderId}.json`;
  const order={id:orderId,customerEmail:email,preparedId:id,manifestHash:f.manifestHash,filmId:job.filmId,status:'captured',
    capturedAt:new Date(now-1000).toISOString(),currency:'USD',amountCents:3870,refundedCents:0,provider:'quickbooks',
    merchantBinding:{environment:'production',grantId:'a'.repeat(64)},providerChargeId:'existing-original-payment'};
  for(const [path,value] of [[productionJobPath(email,id),job],[receiptPath,cached],[orderPath,order],
    [userPath(email),{email,status:'active',approvedAt:new Date(now-1000).toISOString(),approvedBy:'owner@example.test'}]])
    f.records.set(path,{value:clone(value),etag:'initial'});
  const blobs=new Map();
  for(const [name,bytes] of f.fileBytes)blobs.set(`${prefix}/media/${hash(bytes)}.${name.split('.').at(-1)}`,bytes);
  let builds=0,uploads=0;const observed=[];
  const dependencies={read:f.read,write:f.write,now:()=>now,
    build:async()=>{builds++;throw Error('cached construction must not synthesize');},
    putBlob:async()=>{uploads++;throw Error('cached construction must not upload audio');},
    getBlob:async path=>{
      const bytes=blobs.get(path);assert.ok(bytes,`unexpected cache path ${path}`);
      return {blob:{size:bytes.length},stream:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})};
    },
    transcribe:async(path,options)=>{
      observed.push({path,options:clone(options)});
      if(basename(path)==='scene-1-mix.wav')return clone(f.previousTranscript);
      if(basename(path)==='scene-2-mix.wav')return clone(options.contextSilence?f.context:f.normal);
      return clone(options.contextSilence?f.fullContext:f.fullNormal);
    }};
  return {...f,job,work,clips,receiptPath,orderPath,order,cached,dependencies,observed,
    execute:()=>createAutomaticSoundtrackFallback(dependencies)({email,id,job,clips,work,ffmpeg:'must-not-run',stillOwned:async()=>true}),
    counts:()=>({builds,uploads})};
}

test('cached second construction attempt performs exact scene review with no synthesis or new audio uploads',async t=>{
  const f=await cachedAutomatic(t),result=await f.execute();
  assert.equal(result.passed,true);assert.equal(result.method,'local-speech-transcription-with-authored-scene-context');
  assert.deepEqual(f.counts(),{builds:0,uploads:0});assert.equal(f.observed.length,5);
  const saved=f.records.get(f.receiptPath).value;
  assert.equal(saved.state,'reviewed');assert.equal(saved.attempts,2);assert.equal(saved.attemptId,f.cached.attemptId);
  assert.equal(saved.provenanceSha256,f.cached.provenanceSha256);
  assert.equal(result.transcriptionReceipts.length,3);
  assert.equal(f.writes.filter(value=>value.value.kind==='authored-soundtrack-transcription').length,3);
  assert.equal(f.writes.filter(value=>value.value.kind==='authored-scene-window-transcription').length,2);
  const last=result.shots.at(-1);assert.equal(last.verificationScope,'authored-scene-window');
  assert.equal(last.adjacentContextProof.standaloneNormalTranscriptSha256,sha(f.normal));
  assert.equal(last.adjacentContextProof.standaloneContextTranscriptSha256,sha(f.context));
  assert.deepEqual(f.records.get(f.orderPath).value,f.order);
  assert.ok(f.writes.every(value=>!value.path.startsWith('payments/')&&!value.path.includes('/jobs/')));
  for(const [index,clip] of f.clips.entries())assert.equal(hash(await readFile(clip.audioPath)),f.provenance.scenes[index].mix.sha256);
});

test('cached attempt two cannot publish a reviewed construction after saved job or payment changes',async t=>{
  for(const change of ['job','payment']){
    const f=await cachedAutomatic(t),originalTranscribe=f.dependencies.transcribe;let changed=false;
    f.dependencies.transcribe=async(path,options)=>{
      const result=await originalTranscribe(path,options);
      if(!changed){
        changed=true;
        if(change==='job')f.records.get(productionJobPath('approved-customer@example.test',f.job.id)).value.shots[0].output.sha256='0'.repeat(64);
        else f.records.get(f.orderPath).value.refundedCents=1;
      }
      return result;
    };
    await assert.rejects(f.execute(),error);
    assert.equal(f.records.get(f.receiptPath).value.state,'constructed');
    assert.equal(f.records.get(f.receiptPath).value.attempts,2);assert.deepEqual(f.counts(),{builds:0,uploads:0});
    assert.ok(f.writes.every(value=>value.value.state!=='reviewed'));
  }
});
