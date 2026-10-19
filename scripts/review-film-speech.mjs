import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {markFinishingFailure} from '../api/_lib/film-finishing-diagnostics.mjs';

const failure=reason=>markFinishingFailure(Object.assign(new Error('The generated narration needs a production review. Your payment is saved.'),{code:'FILM_SPEECH_REVIEW_REQUIRED'}),'speech-review',reason);
export const normalizeSpeech=value=>String(value).normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
export function speechEdit(shot,transcript){
  const intended=normalizeSpeech(`${shot.narration||''} ${(shot.dialogue||'').replace(/(?:^|\n)[A-Z][A-Z\s'-]*:\s*/g,' ')}`);
  const actual=(transcript.words||[]).flatMap(word=>normalizeSpeech(word.word).map(token=>({token,start:word.start,end:word.end})));
  if(!Number.isFinite(transcript.duration)||transcript.duration<shot.targetDurationMs/1000-.05)throw failure('SPEECH_DURATION_INVALID');
  if(!intended.length){if(actual.length)throw failure('SPEECH_UNEXPECTED');return null;}
  // Never delete a missing/replaced scripted word or quietly rewrite a film.
  if(actual.length<intended.length||intended.some((word,i)=>actual[i].token!==word))throw failure('SPEECH_SCRIPT_MISMATCH');
  const end=actual[intended.length-1].end,seconds=shot.targetDurationMs/1000;
  if(!Number.isFinite(end)||end>seconds-.08||actual.some(w=>!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start))throw failure('SPEECH_TIMING_INVALID');
  const extra=actual[intended.length];
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
export async function reviewFilmSpeech({manifest,clips,ffmpeg,python=process.env.PYTHON_PATH||'python3',transcribe}){
  const reviews=[];
  for(const clip of clips){
    const shot=manifest.shots.find(s=>s.id===clip.shotId);if(!shot)throw failure('SPEECH_SHOT_INVALID');
    const readTranscript=async context=>{
      try{return transcribe?await transcribe(clip.path,{contextSilence:context}):JSON.parse(await run(python,[fileURLToPath(new URL('./transcribe-film.py',import.meta.url)),clip.path,...(context?['--context-silence']:[])]));}
      catch(error){throw markFinishingFailure(error,'speech-review','SPEECH_RECOGNITION_FAILED');}
    };
    let transcript=await readTranscript(false),edit,contextSilence=false;
    try { edit=speechEdit(shot,transcript); }
    catch(error){
      if(error.code!=='FILM_SPEECH_REVIEW_REQUIRED')throw error;
      // One local decoding pass with context silence may recover a clipped
      // recognition boundary. Never prompt the recognizer with expected words.
      transcript=await readTranscript(true);edit=speechEdit(shot,transcript);contextSilence=true;
    }
    if(edit){
      const output=join(clip.path.replace(/[^\\/]+$/,''),`${clip.shotId}-reviewed.wav`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',clip.path,'-map','0:a:0','-af',
        `atrim=duration=${edit.cut},afade=t=out:st=${edit.fadeStart}:d=${edit.fadeDuration},apad,atrim=duration=${Math.max(transcript.duration,shot.targetDurationMs/1000)}`,
        '-c:a','pcm_s16le',output],'SPEECH_AUDIO_EDIT_FAILED');
      clip.audioPath=output;
    }
    reviews.push({shotId:shot.id,scriptMatched:true,contextSilence,...(edit?{edit}:{})});
  }
  return {version:1,method:'local-speech-transcription',passed:true,shots:reviews};
}
