import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {markFinishingFailure,finishingFailure} from '../api/_lib/film-finishing-diagnostics.mjs';

const failure=reason=>markFinishingFailure(Object.assign(new Error('The generated narration needs a production review. Your payment is saved.'),{code:'FILM_SPEECH_REVIEW_REQUIRED'}),'speech-review',reason);
export const normalizeSpeech=value=>String(value).normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
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
        ||!['full-name','unique-first-name'].includes(span.nameScope))return false;
    }else if(span.kind==='cardinal'){
      const a=repairCardinalSpan(expected,expectedStart),b=repairCardinalSpan(actual,actualStart);
      if(!a||!b||a.end!==expectedEnd||b.end!==actualEnd||a.form===b.form||a.value!==b.value
        ||span.canonicalValue!==a.value||span.method!=='canonical-cardinal-0-99-v1')return false;
    }else return false;
    left=expectedEnd;right=actualEnd;
  }
  return exactGap(expected.length,actual.length);
}
export function speechEdit(shot,transcript,{repairProof}={}){
  const intended=normalizeSpeech(`${shot.narration||''} ${(shot.dialogue||'').replace(/(?:^|\n)[A-Z][A-Z\s'-]*:\s*/g,' ')}`);
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
export async function reviewFilmSpeech({manifest,clips,ffmpeg,python=process.env.PYTHON_PATH||'python3',transcribe,resolveSpeechDifferences}){
  const reviews=[];
  for(const clip of clips){
    const shot=manifest.shots.find(s=>s.id===clip.shotId);if(!shot)throw failure('SPEECH_SHOT_INVALID');
    // Review the same track that assembly will deliver, including a separately
    // provided soundtrack. Never validate embedded audio then publish another.
    const audioPath=clip.audioPath||clip.path;
    const readTranscript=async context=>{
      try{return transcribe?await transcribe(audioPath,{contextSilence:context}):JSON.parse(await run(python,[fileURLToPath(new URL('./transcribe-film.py',import.meta.url)),audioPath,...(context?['--context-silence']:[])]));}
      catch(error){throw markFinishingFailure(error,'speech-review','SPEECH_RECOGNITION_FAILED');}
    };
    let transcript=await readTranscript(false),edit,contextSilence=false,repairProof;
    const normalTranscript=transcript;
    try { edit=speechEdit(shot,transcript); }
    catch(error){
      if(error.code!=='FILM_SPEECH_REVIEW_REQUIRED')throw error;
      // One local decoding pass with context silence may recover a clipped
      // recognition boundary. Never prompt the recognizer with expected words.
      transcript=await readTranscript(true);contextSilence=true;
      try{edit=speechEdit(shot,transcript);}
      catch(contextError){
        if(finishingFailure(error)?.reason!=='SPEECH_SCRIPT_MISMATCH'
          ||finishingFailure(contextError)?.reason!=='SPEECH_SCRIPT_MISMATCH'||typeof resolveSpeechDifferences!=='function')throw contextError;
        // A separately configured operator recovery may prove an exact saved
        // cast pronunciation or cardinal form. Ordinary production never does.
        // Raw transcripts remain unchanged and all timing checks still run.
        repairProof=await resolveSpeechDifferences({manifest:structuredClone(manifest),shot:structuredClone(shot),audioPath,
          normalTranscript:structuredClone(normalTranscript),contextTranscript:structuredClone(transcript)});
        if(repairProof?.kind!=='repair-speech-equivalence-proof-v2'||repairProof.version!==2||repairProof.shotId!==shot.id
          ||repairProof.manifestHash!==hash(JSON.stringify(manifest))||repairProof.audioSha256!==hash(await readFile(audioPath))
          ||repairProof.normalTranscriptSha256!==hash(JSON.stringify(normalTranscript))
          ||repairProof.contextTranscriptSha256!==hash(JSON.stringify(transcript))||!Array.isArray(repairProof.spans)
          ||!repairProof.spans.length||repairProof.spans.length>64)throw contextError;
        edit=speechEdit(shot,transcript,{repairProof});
      }
    }
    if(edit){
      const output=join(clip.path.replace(/[^\\/]+$/,''),`${clip.shotId}-reviewed.wav`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',audioPath,'-map','0:a:0','-af',
        `atrim=duration=${edit.cut},afade=t=out:st=${edit.fadeStart}:d=${edit.fadeDuration},apad,atrim=duration=${Math.max(transcript.duration,shot.targetDurationMs/1000)}`,
        '-c:a','pcm_s16le',output],'SPEECH_AUDIO_EDIT_FAILED');
      clip.audioPath=output;
    }
    reviews.push({shotId:shot.id,scriptMatched:true,contextSilence,...(edit?{edit}:{}),...(repairProof?{repairProof}:{})});
  }
  return {version:1,method:reviews.some(review=>review.repairProof)?'local-speech-transcription-with-repair-proof':'local-speech-transcription',passed:true,shots:reviews};
}
