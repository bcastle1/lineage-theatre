import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewFilmSpeech} from '../scripts/review-film-speech.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=value=>hash(JSON.stringify(value));
const error={code:'FILM_SPEECH_REVIEW_REQUIRED'};
const words=(text,offset=0)=>text.split(' ').map((word,index)=>({word,start:offset+.1+index*.4,end:offset+.35+index*.4}));
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'lineage-adjacent-review-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const first={id:'first',sceneIndex:0,scenePart:1,sceneParts:2,startMs:0,targetDurationMs:5000,
    narration:'The afternoon was quiet.',dialogue:'',continuity:{precedingShotId:null}};
  const second={...first,id:'second',scenePart:2,startMs:5000,narration:'They returned home.',continuity:{precedingShotId:'first'}};
  const manifest={shots:[first,second]},clips=[first,second].map(shot=>({shotId:shot.id,path:join(directory,`${shot.id}.wav`)}));
  for(const clip of clips)await writeFile(clip.path,`unchanged original audio for ${clip.shotId}`);
  const previous={duration:5,words:words(first.narration)};
  const normal={duration:5,words:words('It returned home.')},context={duration:5,words:words('Means returned home.')};
  const full={duration:10,words:[...previous.words,...words(second.narration,5)]};
  // A whole-window recognizer may attach the first target word to prior silence.
  // These timestamps remain unchanged rather than being projected into a cut.
  full.words[4].start=4.7;full.words[4].end=5.3;
  const calls=[];
  const transcribe=async(path,{contextSilence})=>{
    calls.push({path,contextSilence});
    return structuredClone(path===clips[0].path?previous:contextSilence?context:normal);
  };
  const result=async(input,change={})=>{
    const normalTranscript=structuredClone(change.normalTranscript||full),contextTranscript=structuredClone(change.contextTranscript||full);
    const metadata={kind:'adjacent-authored-scene-proof-v1',version:1,verificationScope:'authored-scene-window',perCutLocalization:false,
      manifestHash:sha(manifest),shotIds:[first.id,second.id],sourceAudio:await Promise.all(clips.map(async clip=>{
        const bytes=await readFile(clip.path);return {shotId:clip.shotId,sha256:hash(bytes),sizeBytes:bytes.length};
      })),combinedAudioSha256:'a'.repeat(64),combinedPcmSha256:'b'.repeat(64),durationSeconds:10,sceneIndex:0,
      previousReviewSha256:sha(input.previous.review),standaloneNormalTranscriptSha256:sha(normal),standaloneContextTranscriptSha256:sha(context),
      fullNormalTranscriptSha256:sha(normalTranscript),fullContextTranscriptSha256:sha(contextTranscript),provenanceSha256:'c'.repeat(64),
      voiceAssignmentsSha256:'d'.repeat(64),bindingHash:'e'.repeat(64),pcmUnchanged:true,...change.metadata};
    const equivalenceProof=change.equivalenceProof??null;
    const serialized=JSON.stringify({...metadata,normalTranscript,contextTranscript,equivalenceProof});
    const evidencePath=join(directory,'evidence.json');await writeFile(evidencePath,serialized);
    return {normalTranscript,contextTranscript,equivalenceProof,proof:{...metadata,evidencePath,
      receiptPath:'production/authored-soundtrack/context/evidence.json',evidenceSha256:hash(serialized)}};
  };
  return {directory,manifest,clips,previous,normal,context,full,calls,transcribe,result};
}

test('ordinary speech review still rejects both isolated mismatches without an explicit adjacent hook',async t=>{
  const f=await fixture(t);
  await assert.rejects(reviewFilmSpeech(f),error);
  assert.equal(f.calls.length,3);
});

test('explicit whole-scene evidence preserves raw boundary timestamps and both failed standalone transcripts',async t=>{
  const f=await fixture(t),before=await Promise.all(f.clips.map(clip=>readFile(clip.path)));
  let received;
  const review=await reviewFilmSpeech({...f,resolveAdjacentSpeechContext:async input=>{
    received=structuredClone(input);return f.result(input);
  }});
  assert.equal(review.passed,true);
  assert.equal(review.method,'local-speech-transcription-with-authored-scene-context');
  assert.equal(review.shots[0].verificationScope,undefined);
  assert.equal(review.shots[1].verificationScope,'authored-scene-window');
  assert.equal(review.shots[1].edit,undefined);
  assert.equal(review.shots[1].repairProof,undefined);
  assert.deepEqual(received.normalTranscript,f.normal);
  assert.deepEqual(received.contextTranscript,f.context);
  assert.deepEqual(received.previous.review,review.shots[0]);
  assert.equal(received.previous.audioSha256,hash(before[0]));
  const evidence=JSON.parse(await readFile(review.shots[1].adjacentContextProof.evidencePath,'utf8'));
  assert.deepEqual(evidence.normalTranscript,f.full);
  assert.equal(evidence.normalTranscript.words[4].start,4.7);
  assert.equal(evidence.normalTranscript.words[4].end,5.3);
  assert.deepEqual(await Promise.all(f.clips.map(clip=>readFile(clip.path))),before);
});

test('adjacent hook is never used after an isolated pass or a non-script failure',async t=>{
  for(const mode of ['pass','duration']){
    const f=await fixture(t);let called=0;
    const options={...f,resolveAdjacentSpeechContext:async()=>{called++;throw new Error('must not run');},
      transcribe:async(path,options)=>path===f.clips[0].path?f.previous:mode==='pass'
        ?{duration:5,words:words(f.manifest.shots[1].narration)}
        :options.contextSilence?f.context:{...f.normal,duration:1}};
    if(mode==='pass')assert.equal((await reviewFilmSpeech(options)).passed,true);
    else await assert.rejects(reviewFilmSpeech(options),error);
    assert.equal(called,0);
  }
});

test('existing isolated cardinal proof retains precedence over optional scene context',async t=>{
  const f=await fixture(t);let called=0;
  f.manifest.shots[1].narration='They returned two times.';
  const recognized={duration:5,words:words('They returned 2 times.')};
  const reviewed=await reviewFilmSpeech({...f,
    transcribe:async path=>path===f.clips[0].path?f.previous:recognized,
    resolveAdjacentSpeechContext:async()=>{called++;throw new Error('must not run');},
    resolveSpeechDifferences:async input=>({kind:'repair-speech-equivalence-proof-v2',version:2,
      shotId:input.shot.id,manifestHash:sha(f.manifest),audioSha256:hash(await readFile(input.audioPath)),
      normalTranscriptSha256:sha(input.normalTranscript),contextTranscriptSha256:sha(input.contextTranscript),
      expectedWordCount:4,actualWordCount:4,spans:[{kind:'cardinal',expectedStart:2,expectedEnd:3,actualStart:2,actualEnd:3,
        expectedTokensSha256:sha(['two']),recognizedTokensSha256:sha(['2']),canonicalValue:2,method:'canonical-cardinal-0-99-v1'}]})});
  assert.equal(reviewed.passed,true);assert.equal(called,0);
  assert.equal(reviewed.method,'local-speech-transcription-with-repair-proof');
  assert.equal(reviewed.shots[1].verificationScope,undefined);
});

test('whole-scene evidence cannot accept changed, missing or extra ordinary words',async t=>{
  for(const mode of ['changed','missing','extra','one-pass-changed','nonmonotonic','beyond-window']){
    const f=await fixture(t),full=structuredClone(f.full);
    if(mode==='changed'||mode==='one-pass-changed')full.words[5].word='never';
    if(mode==='missing')full.words.splice(5,1);
    if(mode==='extra')full.words.push({word:'extra',start:8,end:8.2});
    if(mode==='nonmonotonic')full.words[6].start=1;
    if(mode==='beyond-window')full.words[6].end=10.1;
    await assert.rejects(reviewFilmSpeech({...f,resolveAdjacentSpeechContext:input=>f.result(input,
      {normalTranscript:full,contextTranscript:mode==='one-pass-changed'?f.full:full})}),error);
  }
});

test('context recovery requires the complete two-part scene and the immediately preceding passed cut',async t=>{
  for(const mode of ['first-cut','other-scene','three-parts','gap','wrong-continuity','reverse-order','overlong']){
    const f=await fixture(t);let called=0;
    if(mode==='first-cut')f.clips=f.clips.slice(1);
    if(mode==='other-scene')f.manifest.shots[1].sceneIndex=1;
    if(mode==='three-parts')for(const shot of f.manifest.shots)shot.sceneParts=3;
    if(mode==='gap')f.manifest.shots[1].startMs++;
    if(mode==='wrong-continuity')f.manifest.shots[1].continuity.precedingShotId='unrelated';
    if(mode==='reverse-order')f.clips.reverse();
    if(mode==='overlong')f.manifest.shots[1].targetDurationMs=16000;
    await assert.rejects(reviewFilmSpeech({...f,resolveAdjacentSpeechContext:async()=>{called++;throw new Error('must not run');}}),error);
    assert.equal(called,0,mode);
  }
});

test('context proof rejects replayed bindings, localization claims and missing immutable evidence',async t=>{
  const mutations=[
    value=>{value.proof.manifestHash='f'.repeat(64);},
    value=>{value.proof.previousReviewSha256='f'.repeat(64);},
    value=>{value.proof.standaloneContextTranscriptSha256='f'.repeat(64);},
    value=>{value.proof.sourceAudio[0].sha256='f'.repeat(64);},
    value=>{value.proof.perCutLocalization=true;},
    value=>{value.proof.shotIds.reverse();},
    value=>{value.proof.durationSeconds=5;},
    value=>{value.normalTranscript.words[4].start=0;},
    value=>{value.proof.evidencePath=join(value.proof.evidencePath,'missing');},
    value=>{value.proof.receiptPath='';},
  ];
  for(const mutate of mutations){
    const f=await fixture(t);
    await assert.rejects(reviewFilmSpeech({...f,resolveAdjacentSpeechContext:async input=>{
      const value=await f.result(input);mutate(value);return value;
    }}),error);
  }
});

test('changing either accepted source audio while resolving context invalidates the result',async t=>{
  for(const index of [0,1]){
    const f=await fixture(t);
    await assert.rejects(reviewFilmSpeech({...f,resolveAdjacentSpeechContext:async input=>{
      const value=await f.result(input);await writeFile(f.clips[index].path,'changed audio');return value;
    }}),error);
  }
});
