// Read-only private-cache diagnostic. No synthesis, ASR rerun, provider request,
// Blob mutation, payment action, queue change, or durable construction attempt.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, list } from '@vercel/blob';
import { digest, readRecord } from '../api/_lib/auth.mjs';
import { productionJobPath } from '../api/_lib/film-production.mjs';
import { standardFilmVoices, constructionFiles } from './automatic-film-soundtrack.mjs';
import { readSoundtrackCasting } from './authored-soundtrack-casting.mjs';
import { soundtrackPlan } from './rebuild-film-soundtrack.mjs';
import { createRepairSpeechResolver } from './repair-name-proof.mjs';
import { createAdjacentAuthoredSpeechContext, joinAuthoredPcm } from './adjacent-authored-speech.mjs';
import { reviewFilmSpeech } from './review-film-speech.mjs';

const hash = value => createHash('sha256').update(value).digest('hex'), sha = value => hash(JSON.stringify(value));
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9-]{36}$/, SHOT = /^[A-Za-z0-9_-]{1,100}$/;
const check = condition => { if (!condition) throw Object.assign(new Error('The cached authored-scene diagnostic could not be verified.'), { code: 'SCENE_DIAGNOSTIC_UNVERIFIED' }); };
async function localJson(path, maximum = 500_000) {
  const info = await lstat(path); check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum);
  return JSON.parse(await readFile(path, 'utf8'));
}
async function privateBytes(path, descriptor) {
  check(Number.isSafeInteger(descriptor.sizeBytes) && descriptor.sizeBytes >= 44 && descriptor.sizeBytes <= 6_000_000 && HASH.test(descriptor.sha256));
  const response = await get(path, { access: 'private', useCache: false });
  check(response?.stream && response.blob.size === descriptor.sizeBytes);
  const reader = response.stream.getReader(), chunks = []; let length = 0;
  try { for (;;) { const value = await reader.read(); if (value.done) break; length += value.value.byteLength;
    check(length <= descriptor.sizeBytes); chunks.push(value.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks, length); check(length === descriptor.sizeBytes && hash(bytes) === descriptor.sha256); return bytes;
}

// Passing the already read job avoids copying private screenplay text into a
// command line. The live private record is still rechecked before and afterward.
export async function diagnoseAuthoredSceneContext({ job, email, manifestHash, bindingHash, shotId, contextDirectory }) {
  let stage = 'input';
  try {
    check(typeof email === 'string' && email === email.trim().toLowerCase() && job?.ownerHash === digest(email)
      && ID.test(job.id || '') && job.mode === 'customer' && job.status === 'awaiting-assembly' && !job.lease
      && HASH.test(manifestHash || '') && job.manifestHash === manifestHash && sha(job.manifest) === manifestHash
      && HASH.test(bindingHash || '') && SHOT.test(shotId || '') && isAbsolute(contextDirectory || ''));
    const index = job.manifest.shots.findIndex(shot => shot.id === shotId), shots = job.manifest.shots.slice(index - 1, index + 1);
    check(index > 0 && shots.length === 2 && shots[1].id === shotId);
    const jobSha = sha(job), jobPath = productionJobPath(email, job.id), prefix = `production/soundtracks/${job.ownerHash}/${job.id}/${bindingHash}`;
    const defaults = standardFilmVoices(job.manifest, manifestHash);
    const casting = await readSoundtrackCasting({ job, defaultVoices: defaults }); check(casting);
    const voices = casting.voices, plan = soundtrackPlan({ manifest: job.manifest, manifestHash, ...voices });
    stage = 'construction';
    const saved = await readRecord(`${prefix}/construction.json`), receipt = saved?.value;
    check(receipt?.kind === 'automatic-stock-soundtrack-v1' && receipt.state === 'constructed' && receipt.attempts === 2
      && receipt.bindingHash === bindingHash && sha(receipt.binding) === bindingHash && receipt.binding.id === job.id
      && receipt.binding.ownerHash === job.ownerHash && receipt.binding.manifestHash === manifestHash
      && receipt.binding.sourceOutputsSha256 === sha(job.shots.map(shot => ({ id: shot.id, output: shot.output })))
      && sha(receipt.binding.sources) === sha(casting.sources) && sha(receipt.binding.voices) === sha(voices)
      && receipt.binding.castingApproval?.approvalSha256 === casting.approvalSha256
      && receipt.provenanceSha256 === sha(receipt.provenance));
    const provenance = receipt.provenance, allFiles = constructionFiles(provenance, plan), receiptSha = sha(receipt);
    const guard = async () => {
      check(sha((await readRecord(jobPath))?.value) === jobSha && sha((await readRecord(`${prefix}/construction.json`))?.value) === receiptSha);
      check(sha(await readSoundtrackCasting({ job, defaultVoices: defaults })) === sha(casting));
    };
    await guard();
    stage = 'hydrate';
    const contextRoot = resolve(contextDirectory), work = await mkdtemp(join(contextRoot, 'review-'));
    const directory = join(work, 'soundtrack'); await mkdir(directory, { mode: 0o700 });
    const scenes = shots.map(shot => provenance.scenes.find(scene => scene.shotId === shot.id)); check(scenes.every(Boolean));
    const descriptors = new Map();
    for (const scene of scenes) for (const descriptor of [scene.mix, ...scene.turns.map(turn => turn.audio)]) descriptors.set(descriptor.file, descriptor);
    check(descriptors.size <= 42); let totalBytes = 0;
    for (const descriptor of descriptors.values()) {
      check(allFiles.some(file => sha(file) === sha(descriptor))); totalBytes += descriptor.sizeBytes; check(totalBytes <= 60_000_000);
      const bytes = await privateBytes(`${prefix}/media/${descriptor.sha256}.wav`, descriptor);
      await writeFile(join(directory, descriptor.file), bytes, { flag: 'wx', mode: 0o600 });
    }
    const clips = scenes.map(scene => ({ shotId: scene.shotId, path: join(directory, scene.mix.file) }));
    stage = 'window-evidence';
    const pcm = await localJson(join(contextRoot, 'pcm-evidence.json'));
    check(pcm.manifestHash === manifestHash && pcm.bindingHash === bindingHash && pcm.provenanceSha256 === receipt.provenanceSha256
      && pcm.pcmUnchanged === true && pcm.sources.length === 2 && pcm.sources.every((source, i) => source.shotId === shots[i].id
        && source.sha256 === scenes[i].mix.sha256 && source.sizeBytes === scenes[i].mix.sizeBytes));
    const joined = joinAuthoredPcm(await Promise.all(clips.map(clip => readFile(clip.path))), shots.map(shot => shot.targetDurationMs));
    check(pcm.joinedSha256 === joined.sha256 && pcm.joinedPcmSha256 === joined.pcmSha256);
    const joinedInfo = await lstat(join(contextRoot, 'adjacent.wav')); check(joinedInfo.isFile() && !joinedInfo.isSymbolicLink() && joinedInfo.size === joined.bytes.length);
    check(hash(await readFile(join(contextRoot, 'adjacent.wav'))) === joined.sha256);
    const windowTranscripts = [await localJson(join(contextRoot, 'normal.json')), await localJson(join(contextRoot, 'context.json'))];
    stage = 'standalone-evidence';
    const standalone = new Map();
    for (const scene of scenes) {
      const transcriptPrefix = `${prefix}/transcriptions/${scene.shotId}/${scene.mix.sha256}/`;
      const page = await list({ prefix: transcriptPrefix, limit: 100 }); check(!page.hasMore && page.blobs.length <= 100);
      for (const item of page.blobs) {
        check(item.pathname.startsWith(transcriptPrefix) && item.size <= 600_000);
        const evidence = (await readRecord(item.pathname))?.value;
        check(evidence?.kind === 'authored-soundtrack-transcription' && evidence.bindingHash === bindingHash
          && evidence.manifestHash === manifestHash && evidence.shotId === scene.shotId && evidence.audioSha256 === scene.mix.sha256
          && evidence.model === 'medium.en' && typeof evidence.contextSilence === 'boolean'
          && evidence.transcriptSha256 === sha(evidence.transcript));
        const key = `${scene.shotId}:${evidence.contextSilence}`;
        check(!standalone.has(key) || sha(standalone.get(key)) === sha(evidence.transcript)); standalone.set(key, evidence.transcript);
      }
      check(standalone.has(`${scene.shotId}:false`));
    }
    stage = 'review';
    let windowCalls = 0;
    const resolver = createAdjacentAuthoredSpeechContext({ manifest: job.manifest, manifestHash, voices, provenance,
      constructionRoot: work, bindingHash, prefix, guard, read: readRecord, persist: false,
      write: async () => { throw new Error('Diagnostic cannot write private records.'); },
      transcribe: async (path, { contextSilence }) => { check(hash(await readFile(path)) === joined.sha256); windowCalls++;
        return structuredClone(windowTranscripts[contextSilence ? 1 : 0]); } });
    const review = await reviewFilmSpeech({ manifest: job.manifest, clips, speakerAliases: voices.speakerAliases,
      ffmpeg: 'diagnostic-audio-edits-forbidden',
      transcribe: async (path, { contextSilence }) => { const clip = clips.find(clip => clip.path === path); check(clip);
        const value = standalone.get(`${clip.shotId}:${contextSilence}`); check(value); return structuredClone(value); },
      resolveSpeechDifferences: createRepairSpeechResolver({ manifest: job.manifest, manifestHash, voices, provenance, constructionRoot: work, receiptRoot: work }),
      resolveAdjacentSpeechContext: resolver });
    check(review.passed === true && review.shots.length === 2 && !review.shots[0].edit && !review.shots[1].edit
      && review.shots[1].verificationScope === 'authored-scene-window' && windowCalls === 2);
    await guard();
    const proof = review.shots[1].adjacentContextProof;
    await writeFile(join(work, 'diagnostic-review.json'), JSON.stringify(review), { flag: 'wx', mode: 0o600 });
    return { passed: true, verificationScope: 'authored-scene-window', perCutLocalization: false, bindingHash,
      unchangedConstructionAttempts: receipt.attempts, sourceAudio: proof.sourceAudio, combinedAudioSha256: proof.combinedAudioSha256,
      evidenceSha256: proof.evidenceSha256, priorPassedWithoutEdit: true, evidencePersisted: false,
      providerGenerationCalls: 0, synthesisCalls: 0, recognitionCalls: 0, privateWrites: 0, workDirectory: work };
  } catch (error) { error.diagnosticStage = stage; throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log('Read-only: node scripts/diagnose-authored-scene-context.mjs --input /absolute/private-input.json\nInput: email, preparedId, manifestHash, bindingHash, shotId, contextDirectory. Existing cached PCM/recognition evidence only.');
  else {
    try {
      check(process.argv.length === 4 && process.argv[2] === '--input' && isAbsolute(process.argv[3]));
      const input = await localJson(process.argv[3], 4096); check(ID.test(input.preparedId || ''));
      const job = (await readRecord(productionJobPath(input.email, input.preparedId)))?.value;
      console.log(JSON.stringify(await diagnoseAuthoredSceneContext({ ...input, job })));
    } catch (error) { console.log(JSON.stringify({ passed: false, code: 'SCENE_DIAGNOSTIC_UNVERIFIED', stage: error?.diagnosticStage || 'input', privateWrites: 0, providerGenerationCalls: 0 })); process.exitCode = 1; }
  }
}
