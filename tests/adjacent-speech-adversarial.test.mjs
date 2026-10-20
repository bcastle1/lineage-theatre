import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewFilmSpeech} from '../scripts/review-film-speech.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=value=>hash(JSON.stringify(value));
const denied={code:'FILM_SPEECH_REVIEW_REQUIRED'};
const words=(text,offset=0)=>text.split(' ').map((word,index)=>({word,start:offset+.1+index*.5,end:offset+.35+index*.5}));

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'lineage-adjacent-adversarial-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const first={id:'opening',sceneIndex:0,scenePart:1,sceneParts:2,startMs:0,targetDurationMs:5000,
    narration:'Before the journey.',dialogue:'',continuity:{precedingShotId:null}};
  const second={...first,id:'arrival',scenePart:2,startMs:5000,narration:'We arrived home.',continuity:{precedingShotId:first.id}};
  const manifest={shots:[first,second]};
  const clips=[first,second].map(shot=>({shotId:shot.id,path:join(directory,`${shot.id}.wav`)}));
  for(const clip of clips)await writeFile(clip.path,`fixed synthetic source ${clip.shotId}`);
  const previous={duration:5,words:words(first.narration)};
  const standalone={duration:5,words:words('They arrived home.')};
  const complete={duration:10,words:[...previous.words,...words(second.narration,5)]};
  const transcribe=async path=>structuredClone(path===clips[0].path?previous:standalone);
  const prove=async(input,transcript=complete)=>{
    const normalTranscript=structuredClone(transcript),contextTranscript=structuredClone(transcript);
    const metadata={kind:'adjacent-authored-scene-proof-v1',version:1,verificationScope:'authored-scene-window',
      perCutLocalization:false,pcmUnchanged:true,manifestHash:sha(manifest),sceneIndex:0,shotIds:[first.id,second.id],durationSeconds:10,
      sourceAudio:await Promise.all(clips.map(async clip=>{const bytes=await readFile(clip.path);
        return {shotId:clip.shotId,sha256:hash(bytes),sizeBytes:bytes.length};})),
      previousReviewSha256:sha(input.previous.review),standaloneNormalTranscriptSha256:sha(standalone),
      standaloneContextTranscriptSha256:sha(standalone),fullNormalTranscriptSha256:sha(normalTranscript),
      fullContextTranscriptSha256:sha(contextTranscript),combinedAudioSha256:'a'.repeat(64),combinedPcmSha256:'b'.repeat(64),
      provenanceSha256:'c'.repeat(64),voiceAssignmentsSha256:'d'.repeat(64),bindingHash:'e'.repeat(64)};
    const serialized=JSON.stringify({...metadata,normalTranscript,contextTranscript,equivalenceProof:null});
    const evidencePath=join(directory,'context-proof.json');await writeFile(evidencePath,serialized);
    return {normalTranscript,contextTranscript,equivalenceProof:null,proof:{...metadata,evidencePath,
      evidenceSha256:hash(serialized),receiptPath:'production/authored-soundtrack/context/adversarial-fixture.json'}};
  };
  return {manifest,clips,previous,standalone,complete,transcribe,prove};
}

test('complete-scene end guard covers every recognized word, including overlapping decoder spans',async t=>{
  const f=await fixture(t),crossing=structuredClone(f.complete);
  // The last token ends early, but the preceding decoder word reaches the
  // final frame. A last-token-only end check cannot prove the scene end guard.
  crossing.words.at(-2).end=10;
  await assert.rejects(reviewFilmSpeech({...f,resolveAdjacentSpeechContext:input=>f.prove(input,crossing)}),denied);
});

test('changing a previously passed audio track during the next isolated recognition blocks context before it runs',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects(reviewFilmSpeech({...f,transcribe:async(path,options)=>{
    if(path===f.clips[1].path)await writeFile(f.clips[0].path,'different source after its passed review');
    return f.transcribe(path,options);
  },resolveAdjacentSpeechContext:async input=>{calls++;return f.prove(input);}}),denied);
  assert.equal(calls,0);
});

test('a failed preceding clip cannot supply context by claiming the later exact full-window transcript',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects(reviewFilmSpeech({...f,transcribe:async()=>structuredClone(f.standalone),
    resolveAdjacentSpeechContext:async input=>{calls++;return f.prove(input);}}),denied);
  assert.equal(calls,0);
});
