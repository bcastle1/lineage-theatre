import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {isAbsolute,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {markFinishingFailure,finishingFailure} from '../api/_lib/film-finishing-diagnostics.mjs';

const failure=reason=>markFinishingFailure(Object.assign(new Error('The generated narration needs a production review. Your payment is saved.'),{code:'FILM_SPEECH_REVIEW_REQUIRED'}),'speech-review',reason);
export const normalizeSpeech=value=>String(value).normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
// Speaker labels are metadata only when they identify one saved cast member
// in this scene (or the narrator). Preserve arbitrary colon-bearing prose.
export function intendedSpeechTokens(shot,{manifest,speakerAliases={}}={}){
  const label=value=>String(value).normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  const cast=Array.isArray(manifest?.screenplay?.characters)?manifest.screenplay.characters:[];
  const labels=new Map([['narrator',new Set([null])]]);
  const add=(name,id)=>{if(typeof name!=='string'||!name.trim())return;const key=label(name);if(!labels.has(key))labels.set(key,new Set());labels.get(key).add(id);};
  for(const character of cast){add(character.id,character.id);add(character.name,character.id);}
  for(const character of cast){
    const first=label(character.name).split(' ')[0];
    if(/^[a-z][a-z'-]{1,63}$/.test(first)&&!labels.has(first)
      &&cast.filter(other=>label(other.name).split(' ')[0]===first).length===1)add(first,character.id);
  }
  for(const [name,id] of Object.entries(speakerAliases||{}))if(cast.some(character=>character.id===id))add(name,id);
  const present=new Set(Array.isArray(shot.characterIds)?shot.characterIds:[]);
  const dialogue=String(shot.dialogue||'').split(/\r?\n/).map(line=>{
    const match=/^\s*([^:\r\n]{1,120}):\s*(.*)$/.exec(line);
    const speakers=match?labels.get(label(match[1])):null;
    if(speakers?.size!==1)return line;
    const speaker=[...speakers][0];
    return speaker===null||present.has(speaker)?match[2]:line;
  }).join('\n');
  return normalizeSpeech(`${shot.narration||''} ${dialogue}`);
}
const hash=value=>createHash('sha256').update(value).digest('hex');
const smallCardinals='zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const tensCardinals=new Map('twenty thirty forty fifty sixty seventy eighty ninety'.split(' ').map((word,index)=>[word,(index+2)*10]));
const ordinalTerms=new Set('first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth millionth billionth trillionth'.split(' '));
const numberTerm=word=>/^[0-9]+(?:st|nd|rd|th)?$/.test(word||'')||smallCardinals.includes(word)||tensCardinals.has(word)
  ||ordinalTerms.has(word)||ordinalTerms.has(word?.replace(/s$/,''))
  ||['hundred','thousand','million','billion','trillion','point','decimal','minus','plus','negative','positive','over','slash','dot','half','halves','quarter','quarters'].includes(word);
// Used only by the explicit repair proof. No general ASR normalization changes.
// Reject fragments of larger numbers, leading zeroes, decimals and ordinals.
export function repairCardinalSpan(tokens,start){
  const word=tokens[start];let value,end=start+1,form;
  if(/^(?:0|[1-9][0-9]?)$/.test(word||'')){value=Number(word);form='digits';}
  else if(smallCardinals.includes(word)){value=smallCardinals.indexOf(word);form='words';}
  else if(tensCardinals.has(word)){
    value=tensCardinals.get(word);form='words';
    const unit=smallCardinals.indexOf(tokens[end]);if(unit>=1&&unit<=9){value+=unit;end++;}
  }else return null;
  if(numberTerm(tokens[start-1])||numberTerm(tokens[end])
    ||tokens[start-1]==='and'&&numberTerm(tokens[start-2])||tokens[end]==='and'&&numberTerm(tokens[end+1]))return null;
  return {start,end,value,form};
}
function repairMatches(expected,actual,proof){
  if(proof?.kind!=='repair-speech-equivalence-proof-v2'||proof.version!==2
    ||proof.expectedWordCount!==expected.length||proof.actualWordCount!==actual.length
    ||!Array.isArray(proof.spans)||!proof.spans.length||proof.spans.length>64)return false;
  let left=0,right=0;
  const exactGap=(endLeft,endRight)=>endLeft-left===endRight-right
    &&expected.slice(left,endLeft).every((word,index)=>word===actual[right+index]);
  for(const span of proof.spans){
    const {expectedStart,expectedEnd,actualStart,actualEnd}=span;
    if(![expectedStart,expectedEnd,actualStart,actualEnd].every(Number.isSafeInteger)
      ||expectedStart<left||actualStart<right||expectedEnd<=expectedStart||actualEnd<=actualStart
      ||expectedEnd>expected.length||actualEnd>actual.length||!exactGap(expectedStart,actualStart)
      ||span.expectedTokensSha256!==hash(JSON.stringify(expected.slice(expectedStart,expectedEnd)))
      ||span.recognizedTokensSha256!==hash(JSON.stringify(actual.slice(actualStart,actualEnd))))return false;
    if(span.kind==='cast-name'){
      if(expectedEnd!==expectedStart+1||actualEnd!==actualStart+1||expected[expectedStart]===actual[actualStart]
        ||!['full-name','unique-first-name','honorific-surname'].includes(span.nameScope))return false;
      if(span.nameScope==='honorific-surname'&&(expectedStart<1||actualStart<1
        ||!['mr','mrs','ms','dr'].includes(expected[expectedStart-1])||actual[actualStart-1]!==expected[expectedStart-1]
        ||span.honorific?.token!==expected[expectedStart-1]||span.honorific.expectedWordIndex!==expectedStart-1
        ||span.honorific.actualWordIndex!==actualStart-1))return false;
    }else if(span.kind==='cardinal'){
      const a=repairCardinalSpan(expected,expectedStart),b=repairCardinalSpan(actual,actualStart);
      if(!a||!b||a.end!==expectedEnd||b.end!==actualEnd||a.form===b.form||a.value!==b.value
        ||span.canonicalValue!==a.value||span.method!=='canonical-cardinal-0-99-v1')return false;
    }else return false;
    left=expectedEnd;right=actualEnd;
  }
  return exactGap(expected.length,actual.length);
}
export function speechEdit(shot,transcript,{repairProof,manifest,speakerAliases}={}){
  const intended=intendedSpeechTokens(shot,{manifest,speakerAliases});
  const actual=(transcript.words||[]).flatMap(word=>normalizeSpeech(word.word).map(token=>({token,start:word.start,end:word.end})));
  if(!Number.isFinite(transcript.duration)||transcript.duration<shot.targetDurationMs/1000-.05)throw failure('SPEECH_DURATION_INVALID');
  if(!intended.length){if(actual.length)throw failure('SPEECH_UNEXPECTED');return null;}
  // Never delete a missing/replaced scripted word or quietly rewrite a film.
  const mismatches=intended.flatMap((word,index)=>actual[index]?.token===word?[]:[index]);
  const resolved=repairProof&&repairMatches(intended,actual.map(word=>word.token),repairProof);
  if(repairProof&&!resolved||!resolved&&(actual.length<intended.length||mismatches.length))throw failure('SPEECH_SCRIPT_MISMATCH');
  const reviewedWords=resolved?actual.length:intended.length;
  const end=actual[reviewedWords-1].end,seconds=shot.targetDurationMs/1000;
  if(!Number.isFinite(end)||end>seconds-.08||actual.some(w=>!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start))throw failure('SPEECH_TIMING_INVALID');
  const extra=actual[reviewedWords];
  if(!extra)return null;
  if(extra.start<end+.15)throw failure('SPEECH_BOUNDARY_UNCLEAR');
  const cut=Math.min(seconds,extra.start-.1),fadeStart=Math.max(end+.03,cut-.2);
  return {cut,fadeStart,fadeDuration:cut-fadeStart,scriptedSpeechEnd:end,removedExtraSpeech:true};
}
function run(binary,args,reason='SPEECH_RECOGNITION_FAILED'){return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});let output='';
  const timer=setTimeout(()=>{child.kill();reject(failure(reason));},300000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>500000){child.kill();reject(failure(reason));}});
  child.stderr.resume();child.once('error',()=>{clearTimeout(timer);reject(failure(reason));});
  child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(failure(reason));});
});}
const audioSnapshot=async path=>{const bytes=await readFile(path);return {sha256:hash(bytes),sizeBytes:bytes.length};};
function adjacentSceneShot(manifest,shot,previous,speakerAliases){
  const index=manifest.shots.findIndex(value=>value.id===shot.id),prior=previous?.shot;
  const sameScene=manifest.shots.filter(value=>value.sceneIndex===shot.sceneIndex);
  if(index<1||!prior||manifest.shots[index-1].id!==prior.id
    ||!isDeepStrictEqual(manifest.shots[index-1],prior)||!isDeepStrictEqual(manifest.shots[index],shot)
    ||!Number.isSafeInteger(shot.sceneIndex)||shot.sceneIndex<0||prior.sceneIndex!==shot.sceneIndex
    ||sameScene.length!==2||sameScene[0].id!==prior.id||sameScene[1].id!==shot.id
    ||prior.sceneParts!==2||shot.sceneParts!==2||prior.scenePart!==1||shot.scenePart!==2
    ||shot.continuity?.precedingShotId!==prior.id||prior.startMs+prior.targetDurationMs!==shot.startMs
    ||![prior,shot].every(value=>Number.isSafeInteger(value.startMs)&&value.startMs>=0
      &&Number.isSafeInteger(value.targetDurationMs)&&value.targetDurationMs>0&&value.targetDurationMs<=15000)
    ||previous.review?.shotId!==prior.id||previous.review.scriptMatched!==true||previous.review.edit
    ||previous.review.adjacentContextProof||previous.review.verificationScope==='authored-scene-window')throw failure('SPEECH_SCRIPT_MISMATCH');
  // This ephemeral aggregate checks the complete authored scene only. It is
  // never saved as a manifest and never assigns window timestamps to a cut.
  return {id:`${prior.id}+${shot.id}`,narration:[prior,shot]
    .flatMap(value=>intendedSpeechTokens(value,{manifest,speakerAliases})).join(' '),dialogue:'',
    targetDurationMs:prior.targetDurationMs+shot.targetDurationMs};
}
async function verifyAdjacentScene({result,manifest,shot,previous,currentAudio,normalTranscript,contextTranscript,speakerAliases}){
  const windowShot=adjacentSceneShot(manifest,shot,previous,speakerAliases),proof=result?.proof;
  const fullNormal=result?.normalTranscript,fullContext=result?.contextTranscript,equivalence=result?.equivalenceProof??null;
  const sha=value=>hash(JSON.stringify(value)),validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const ids=[previous.shot.id,shot.id],duration=windowShot.targetDurationMs/1000;
  const sources=[{shotId:ids[0],sha256:previous.audioSha256,sizeBytes:previous.audioSizeBytes},
    {shotId:ids[1],sha256:currentAudio.sha256,sizeBytes:currentAudio.sizeBytes}];
  if(proof?.kind!=='adjacent-authored-scene-proof-v1'||proof.version!==1
    ||proof.verificationScope!=='authored-scene-window'||proof.perCutLocalization!==false||proof.pcmUnchanged!==true
    ||proof.manifestHash!==sha(manifest)||!isDeepStrictEqual(proof.shotIds,ids)||!isDeepStrictEqual(proof.sourceAudio,sources)
    ||proof.sceneIndex!==shot.sceneIndex||proof.durationSeconds!==duration
    ||proof.previousReviewSha256!==sha(previous.review)
    ||proof.standaloneNormalTranscriptSha256!==sha(normalTranscript)||proof.standaloneContextTranscriptSha256!==sha(contextTranscript)
    ||!fullNormal||!fullContext||proof.fullNormalTranscriptSha256!==sha(fullNormal)||proof.fullContextTranscriptSha256!==sha(fullContext)
    ||!['combinedAudioSha256','combinedPcmSha256','provenanceSha256','voiceAssignmentsSha256','bindingHash','evidenceSha256'].every(key=>validHash(proof[key]))
    ||typeof proof.evidencePath!=='string'||!isAbsolute(proof.evidencePath)||proof.evidencePath.length>4096
    ||typeof proof.receiptPath!=='string'||!proof.receiptPath.startsWith('production/')||proof.receiptPath.length>2048
    ||proof.receiptPath.split('/').some(part=>part==='..'))throw failure('SPEECH_SCRIPT_MISMATCH');
  let bytes;try{bytes=await readFile(proof.evidencePath);}catch{throw failure('SPEECH_SCRIPT_MISMATCH');}
  if(bytes.length>1500000||hash(bytes)!==proof.evidenceSha256)throw failure('SPEECH_SCRIPT_MISMATCH');
  let evidence;try{evidence=JSON.parse(bytes.toString('utf8'));}catch{throw failure('SPEECH_SCRIPT_MISMATCH');}
  const {evidencePath,receiptPath,evidenceSha256,...metadata}=proof;
  if(!isDeepStrictEqual(evidence,{...metadata,normalTranscript:fullNormal,contextTranscript:fullContext,equivalenceProof:equivalence}))throw failure('SPEECH_SCRIPT_MISMATCH');
  if(equivalence&&(equivalence.kind!=='repair-speech-equivalence-proof-v2'||equivalence.version!==2
    ||equivalence.scope!=='authored-scene-window'||Object.hasOwn(equivalence,'shotId')
    ||!isDeepStrictEqual(equivalence.shotIds,ids)||equivalence.manifestHash!==proof.manifestHash
    ||equivalence.audioSha256!==proof.combinedAudioSha256||equivalence.normalTranscriptSha256!==proof.fullNormalTranscriptSha256
    ||equivalence.contextTranscriptSha256!==proof.fullContextTranscriptSha256||equivalence.provenanceSha256!==proof.provenanceSha256
    ||equivalence.voiceAssignmentsSha256!==proof.voiceAssignmentsSha256))throw failure('SPEECH_SCRIPT_MISMATCH');
  const tokens=value=>value.words.flatMap(word=>normalizeSpeech(word.word));
  for(const full of [fullNormal,fullContext]){
    if(!Number.isFinite(full.duration)||Math.abs(full.duration-duration)>.05||!Array.isArray(full.words)||full.words.length>10000
      ||full.words.some((word,index)=>typeof word.word!=='string'||!Number.isFinite(word.start)||!Number.isFinite(word.end)
        ||word.start<0||word.end<word.start||word.end>duration-.08||index>0&&word.start<full.words[index-1].start)
      ||speechEdit(windowShot,full,{repairProof:equivalence})!==null)throw failure('SPEECH_SCRIPT_MISMATCH');
  }
  if(!isDeepStrictEqual(tokens(fullNormal),tokens(fullContext)))throw failure('SPEECH_SCRIPT_MISMATCH');
  return structuredClone(proof);
}
export async function reviewFilmSpeech({manifest,clips,ffmpeg,python=process.env.PYTHON_PATH||'python3',transcribe,resolveSpeechDifferences,resolveAdjacentSpeechContext,speakerAliases,allowAudioEdits=true}){
  if(typeof allowAudioEdits!=='boolean')throw failure('SPEECH_REVIEW_REQUIRED');
  const reviews=[],reviewedSources=new Map(),adjacentEnabled=typeof resolveAdjacentSpeechContext==='function';
  for(const clip of clips){
    const shot=manifest.shots.find(s=>s.id===clip.shotId);if(!shot)throw failure('SPEECH_SHOT_INVALID');
    // Review the same track that assembly will deliver, including a separately
    // provided soundtrack. Never validate embedded audio then publish another.
    const audioPath=clip.audioPath||clip.path;
    const initialAudio=adjacentEnabled?await audioSnapshot(audioPath):null;
    const readTranscript=async context=>{
      try{return transcribe?await transcribe(audioPath,{contextSilence:context}):JSON.parse(await run(python,[fileURLToPath(new URL('./transcribe-film.py',import.meta.url)),audioPath,...(context?['--context-silence']:[])]));}
      catch(error){throw markFinishingFailure(error,'speech-review','SPEECH_RECOGNITION_FAILED');}
    };
    let transcript=await readTranscript(false),edit,contextSilence=false,repairProof,adjacentContextProof;
    const normalTranscript=transcript;
    try { edit=speechEdit(shot,transcript,{manifest,speakerAliases}); }
    catch(error){
      if(error.code!=='FILM_SPEECH_REVIEW_REQUIRED')throw error;
      // One local decoding pass with context silence may recover a clipped
      // recognition boundary. Never prompt the recognizer with expected words.
      transcript=await readTranscript(true);contextSilence=true;
      try{edit=speechEdit(shot,transcript,{manifest,speakerAliases});}
      catch(contextError){
        if(finishingFailure(error)?.reason!=='SPEECH_SCRIPT_MISMATCH'
          ||finishingFailure(contextError)?.reason!=='SPEECH_SCRIPT_MISMATCH')throw contextError;
        // Only separately configured, provenance-bound authored-audio recovery
        // may prove an exact saved cast pronunciation or cardinal form.
        // Raw transcripts remain unchanged and all timing checks still run.
        let resolved=false;
        if(typeof resolveSpeechDifferences==='function'){
          try{
            repairProof=await resolveSpeechDifferences({manifest:structuredClone(manifest),shot:structuredClone(shot),audioPath,
              normalTranscript:structuredClone(normalTranscript),contextTranscript:structuredClone(transcript)});
            if(repairProof?.kind!=='repair-speech-equivalence-proof-v2'||repairProof.version!==2||repairProof.shotId!==shot.id
              ||repairProof.manifestHash!==hash(JSON.stringify(manifest))||repairProof.audioSha256!==hash(await readFile(audioPath))
              ||repairProof.normalTranscriptSha256!==hash(JSON.stringify(normalTranscript))
              ||repairProof.contextTranscriptSha256!==hash(JSON.stringify(transcript))||!Array.isArray(repairProof.spans)
              ||!repairProof.spans.length||repairProof.spans.length>64)throw contextError;
            edit=speechEdit(shot,transcript,{repairProof,manifest,speakerAliases});resolved=true;
          }catch(repairError){
            if(!adjacentEnabled||finishingFailure(repairError)?.reason!=='SPEECH_SCRIPT_MISMATCH')throw repairError;
            repairProof=undefined;
          }
        }
        if(!resolved){
          if(!adjacentEnabled)throw contextError;
          const index=manifest.shots.findIndex(value=>value.id===shot.id);
          const previous=reviewedSources.get(manifest.shots[index-1]?.id);
          adjacentSceneShot(manifest,shot,previous,speakerAliases);
          if(reviews.at(-1)?.shotId!==previous.shot.id
            ||!isDeepStrictEqual(await audioSnapshot(previous.audioPath),{sha256:previous.audioSha256,sizeBytes:previous.audioSizeBytes})
            ||!isDeepStrictEqual(await audioSnapshot(audioPath),initialAudio))throw contextError;
          const result=await resolveAdjacentSpeechContext({manifest:structuredClone(manifest),shot:structuredClone(shot),audioPath,
            normalTranscript:structuredClone(normalTranscript),contextTranscript:structuredClone(transcript),previous:structuredClone(previous)});
          adjacentContextProof=await verifyAdjacentScene({result,manifest,shot,previous,currentAudio:initialAudio,
            normalTranscript,contextTranscript:transcript,speakerAliases});
          if(!isDeepStrictEqual(await audioSnapshot(previous.audioPath),{sha256:previous.audioSha256,sizeBytes:previous.audioSizeBytes})
            ||!isDeepStrictEqual(await audioSnapshot(audioPath),initialAudio))throw contextError;
          // The isolated transcripts above stay unchanged. Acceptance is of
          // the whole authored scene; it never produces a cut-level edit.
          edit=null;
        }
      }
    }
    if(edit){
      if(!allowAudioEdits)throw failure('SPEECH_UNEXPECTED');
      const output=join(clip.path.replace(/[^\\/]+$/,''),`${clip.shotId}-reviewed.wav`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',audioPath,'-map','0:a:0','-af',
        `atrim=duration=${edit.cut},afade=t=out:st=${edit.fadeStart}:d=${edit.fadeDuration},apad,atrim=duration=${Math.max(transcript.duration,shot.targetDurationMs/1000)}`,
        '-c:a','pcm_s16le',output],'SPEECH_AUDIO_EDIT_FAILED');
      clip.audioPath=output;
    }
    const review={shotId:shot.id,scriptMatched:true,contextSilence,...(edit?{edit}:{}),...(repairProof?{repairProof}:{}),
      ...(adjacentContextProof?{verificationScope:'authored-scene-window',adjacentContextProof}:{})};
    reviews.push(review);
    if(adjacentEnabled){
      const acceptedAudio=await audioSnapshot(clip.audioPath||clip.path);
      if(!edit&&!isDeepStrictEqual(acceptedAudio,initialAudio))throw failure('SPEECH_SCRIPT_MISMATCH');
      reviewedSources.set(shot.id,{shot:structuredClone(shot),clip:structuredClone(clip),review:structuredClone(review),
        audioPath:clip.audioPath||clip.path,audioSha256:acceptedAudio.sha256,audioSizeBytes:acceptedAudio.sizeBytes});
    }
  }
  return {version:1,method:reviews.some(review=>review.adjacentContextProof)?'local-speech-transcription-with-authored-scene-context'
    :reviews.some(review=>review.repairProof)?'local-speech-transcription-with-repair-proof':'local-speech-transcription',passed:true,shots:reviews};
}
