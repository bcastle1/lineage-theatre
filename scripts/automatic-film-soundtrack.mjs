// Bounded local finishing fallback. It never submits video or payment requests.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, put } from '@vercel/blob';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { accessStatusForUser } from '../api/_lib/access.mjs';
import { productionJobPath } from '../api/_lib/film-production.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { rebuildFilmSoundtrack, soundtrackPlan, soundtrackFailureDiagnostic, validateBoundarySilence } from './rebuild-film-soundtrack.mjs';
import { createRepairSpeechResolver } from './repair-name-proof.mjs';
import { reviewFilmSpeech } from './review-film-speech.mjs';
import { readSoundtrackCasting } from './authored-soundtrack-casting.mjs';
import { createAdjacentAuthoredSpeechContext } from './adjacent-authored-speech.mjs';

const RECIPE = 'automatic-stock-soundtrack-v1';
const HASH = /^[a-f0-9]{64}$/;
const FILE = /^[a-z0-9-]{1,80}\.(?:wav|mid)$/;
const MAX_FILE = 250 * 1024 * 1024, MAX_TOTAL = 512 * 1024 * 1024;
const MAX_SCENES = 200, MAX_TURNS = 600, MAX_SCORE_FILES = 2;
const MAX_CONSTRUCTION_FILES = MAX_SCENES * 2 + MAX_TURNS * 2 + MAX_SCORE_FILES;
const failureReasons = new Set(['SOUNDTRACK_BINDING_INVALID', 'STOCK_CAST_UNAVAILABLE', 'SOUNDTRACK_CACHE_UNAVAILABLE',
  'SOUNDTRACK_RECOGNITION_FAILED', 'SOUNDTRACK_CLAIM_EXPIRED', 'SOUNDTRACK_CONTEXT_CHANGED', 'SOUNDTRACK_SCRATCH_UNAVAILABLE',
  'SOUNDTRACK_ATTEMPTS_EXHAUSTED', 'SOUNDTRACK_SPEECH_UNVERIFIED', 'SOUNDTRACK_SOURCE_CHANGED']);
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const label = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const fail = reason => markFinishingFailure(Object.assign(new Error('The saved soundtrack needs production review.'),
  { code: 'FILM_SPEECH_REVIEW_REQUIRED', soundtrackReason: reason }), 'speech-review', 'SPEECH_REVIEW_REQUIRED');
const requireValue = (value, reason = 'SOUNDTRACK_BINDING_INVALID') => { if (!value) throw fail(reason); };

// Stock actors, not cloned voices. Honor an explicit gender in the opening
// description; never infer it from names, photos, ancestry, or other characters.
// The resulting voice map is part of the durable soundtrack binding.
const STOCK_VOICES = Object.freeze(['af_heart', 'am_fenrir', 'af_bella', 'am_adam', 'af_nicole', 'am_echo',
  'af_sarah', 'am_liam', 'af_nova', 'am_onyx', 'af_jessica', 'am_puck', 'af_kore', 'am_santa', 'af_aoede', 'am_eric']);
export function standardFilmVoices(manifest, manifestHash) {
  const cast = manifest?.screenplay?.characters;
  requireValue(Array.isArray(cast) && cast.length <= STOCK_VOICES.length, 'STOCK_CAST_UNAVAILABLE');
  const voices = { narratorVoice: 'am_michael', characterVoices: {}, speakerAliases: {} };
  const fullLabels = new Set(['narrator']);
  for (const character of cast) {
    requireValue(typeof character?.id === 'string' && typeof character.name === 'string', 'STOCK_CAST_UNAVAILABLE');
    fullLabels.add(label(character.id)); fullLabels.add(label(character.name));
  }
  const assigned = new Set(), explicit = new Map();
  for (const character of cast) {
    const opening = String(character.description || '').split(/[.!?]/, 1)[0];
    const male = /\b(?:man|male)\b/i.test(opening), female = /\b(?:woman|female)\b/i.test(opening);
    if (male === female) continue;
    const voice = STOCK_VOICES.find(candidate => candidate.startsWith(male ? 'am_' : 'af_') && !assigned.has(candidate));
    requireValue(voice, 'STOCK_CAST_UNAVAILABLE');
    assigned.add(voice); explicit.set(character.id, voice);
  }
  for (const [index, character] of cast.entries()) {
    const preferred = STOCK_VOICES[index];
    const voice = explicit.get(character.id) || (!assigned.has(preferred) ? preferred : STOCK_VOICES.find(candidate => !assigned.has(candidate)));
    requireValue(voice, 'STOCK_CAST_UNAVAILABLE');
    assigned.add(voice); voices.characterVoices[character.id] = voice;
    const first = label(character.name).split(' ')[0];
    if (/^[a-z][a-z'-]{1,63}$/.test(first) && !fullLabels.has(first)
      && cast.filter(other => label(other.name).split(' ')[0] === first).length === 1) voices.speakerAliases[first] = character.id;
  }
  soundtrackPlan({ manifest, manifestHash, ...voices });
  return voices;
}

export function nextSoundtrackAttempt(savedAttempts, inheritedAttempts = 0) {
  const consumed = savedAttempts ?? inheritedAttempts;
  requireValue(Number.isSafeInteger(inheritedAttempts) && inheritedAttempts >= 0 && inheritedAttempts <= 2
    && Number.isSafeInteger(consumed) && consumed >= inheritedAttempts && consumed < 2, 'SOUNDTRACK_ATTEMPTS_EXHAUSTED');
  return consumed + 1;
}

export function constructionFiles(provenance, plan) {
  requireValue(provenance?.manifestHash === plan.manifestHash && provenance.recipe === plan.recipe
    && provenance.status === 'constructed-needs-review' && provenance.engine === 'kokoro-82m-v1.0-cpu'
    && provenance.sourceTextRewritten === false && provenance.speed === 1 && provenance.providerGenerationCalls === 0
    && provenance.durationMs === plan.durationMs && provenance.musicRequested === plan.musicRequested
    && Boolean(provenance.score) === plan.musicRequested && provenance.narratorVoice === plan.narratorVoice
    && jsonHash(provenance.characterVoices) === jsonHash(plan.characterVoices)
    && Array.isArray(provenance.scenes) && provenance.scenes.length === plan.scenes.length);
  const files = new Map();
  const add = file => {
    requireValue(file && FILE.test(file.file || '') && HASH.test(file.sha256 || '')
      && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 16 && file.sizeBytes <= MAX_FILE);
    const previous = files.get(file.file);
    requireValue(!previous || previous.sha256 === file.sha256 && previous.sizeBytes === file.sizeBytes);
    files.set(file.file, { file: file.file, sha256: file.sha256, sizeBytes: file.sizeBytes });
  };
  for (const [index, scene] of provenance.scenes.entries()) {
    const expected = plan.scenes[index];
    requireValue(scene.shotId === expected.shotId && scene.durationMs === expected.durationMs
      && scene.narrationSha256 === expected.narrationSha256 && scene.dialogueSha256 === expected.dialogueSha256
      && scene.originalProviderAudioIncluded === false && Array.isArray(scene.turns) && scene.turns.length === expected.turns.length);
    add(scene.mix); add(scene.speech);
    let previousEnd = 0;
    for (const [turnIndex, turn] of scene.turns.entries()) {
      const wanted = expected.turns[turnIndex];
      requireValue(turn.turnIndex === wanted.turnIndex && turn.textSha256 === wanted.textSha256
        && turn.synthesisTextSha256 === wanted.textSha256 && turn.source === wanted.source
        && turn.speakerId === wanted.speakerId && turn.voice === wanted.voice && turn.speed === 1
        && HASH.test(turn.phonemesSha256 || '') && Number.isFinite(turn.startSeconds) && Number.isFinite(turn.endSeconds)
        && turn.startSeconds >= previousEnd && turn.endSeconds > turn.startSeconds
        && turn.endSeconds <= expected.durationMs / 1000 - .19);
      if (validateBoundarySilence(turn)) add(turn.originalAudio);
      add(turn.audio); previousEnd = turn.endSeconds;
    }
  }
  if (provenance.score) { add(provenance.score.midi); add(provenance.score.audio); }
  const result = [...files.values()];
  requireValue(result.length <= MAX_CONSTRUCTION_FILES && result.reduce((total, file) => total + file.sizeBytes, 0) <= MAX_TOTAL);
  return result;
}

async function localBytes(directory, descriptor) {
  const path = join(directory, descriptor.file), info = await lstat(path), actual = await realpath(path);
  requireValue(info.isFile() && !info.isSymbolicLink() && dirname(actual) === await realpath(directory)
    && info.size === descriptor.sizeBytes);
  const bytes = await readFile(actual);
  requireValue(bytes.length === descriptor.sizeBytes && hash(bytes) === descriptor.sha256);
  return bytes;
}

async function storedBytes(getBlob, pathname, descriptor) {
  const stored = await getBlob(pathname, { access: 'private', useCache: false });
  if (!stored?.stream || stored.blob?.size !== descriptor.sizeBytes) {
    await stored?.stream?.cancel().catch(() => {});
    throw fail('SOUNDTRACK_CACHE_UNAVAILABLE');
  }
  const reader = stored.stream.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength; requireValue(length <= descriptor.sizeBytes, 'SOUNDTRACK_CACHE_UNAVAILABLE');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks, length);
  requireValue(length === descriptor.sizeBytes && hash(bytes) === descriptor.sha256, 'SOUNDTRACK_CACHE_UNAVAILABLE');
  return bytes;
}

function transcribeAuthored(path, { contextSilence = false } = {}) {
  return new Promise((resolveTranscript, reject) => {
    const child = spawn(process.env.PYTHON_PATH || '/opt/speech/bin/python',
      [fileURLToPath(new URL('./transcribe-film.py', import.meta.url)), path, '--model', 'medium.en',
        ...(contextSilence ? ['--context-silence'] : [])], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', TMPDIR: process.env.TMPDIR || '/tmp',
          HF_HOME: process.env.HF_HOME || '/opt/whisper', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
          PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2' },
      });
    const chunks = []; let length = 0, finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolveTranscript(value);
    };
    const timer = setTimeout(() => finish(fail('SOUNDTRACK_RECOGNITION_FAILED')), 300_000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 500_000) finish(fail('SOUNDTRACK_RECOGNITION_FAILED')); else chunks.push(chunk);
    });
    child.once('error', () => finish(fail('SOUNDTRACK_RECOGNITION_FAILED')));
    child.once('close', code => {
      if (finished) return;
      try {
        requireValue(code === 0, 'SOUNDTRACK_RECOGNITION_FAILED');
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch { finish(fail('SOUNDTRACK_RECOGNITION_FAILED')); }
    });
  });
}

export function createAutomaticSoundtrackFallback({ read = readRecord, write = writeRecord, getBlob = get, putBlob = put,
  build = rebuildFilmSoundtrack, reviewSpeech = reviewFilmSpeech, transcribe = transcribeAuthored, now = Date.now } = {}) {
  return async ({ email, id, job, clips, work, ffmpeg, stillOwned }) => {
    let saved;
    try {
      requireValue(typeof stillOwned === 'function' && job?.id === id && job.mode === 'customer'
        && job.status === 'awaiting-assembly' && job.ownerHash === digest(email) && HASH.test(job.manifestHash || '')
        && jsonHash(job.manifest) === job.manifestHash && job.provider?.id === 'fal'
        && Array.isArray(job.shots) && job.shots.length === job.manifest.shots.length && job.shots.length === clips.length
        && job.shots.every((shot, index) => shot.status === 'completed' && shot.id === job.manifest.shots[index].id));
      const jobHash = jsonHash(job), jobPath = productionJobPath(email, id);
      const defaultVoices = standardFilmVoices(job.manifest, job.manifestHash);
      const casting = await readSoundtrackCasting({ job, defaultVoices, read });
      const guard = async () => {
        requireValue(await stillOwned(), 'SOUNDTRACK_CLAIM_EXPIRED');
        const current = await read(jobPath), account = (await read(userPath(email)))?.value;
        requireValue(current?.value && jsonHash(current.value) === jobHash && account?.email === email
          && !account.mustChangePassword && accessStatusForUser(account) === 'approved', 'SOUNDTRACK_CONTEXT_CHANGED');
        const activeCasting = await readSoundtrackCasting({ job: current.value, defaultVoices, read });
        requireValue(jsonHash(activeCasting) === jsonHash(casting), 'SOUNDTRACK_CONTEXT_CHANGED');
        await requireFinishedFilmPayment({ job: current.value, email, actor: account, read, now });
        requireValue(await stillOwned(), 'SOUNDTRACK_CLAIM_EXPIRED');
      };
      await guard();
      const originalPaths = new Map(), sources = [];
      for (const shot of job.manifest.shots) {
        const matches = clips.filter(clip => clip.shotId === shot.id); requireValue(matches.length === 1);
        const clip = matches[0], path = await realpath(clip.path), info = await lstat(clip.path);
        requireValue(info.isFile() && !info.isSymbolicLink() && info.size > 16 && info.size <= MAX_FILE);
        originalPaths.set(shot.id, path);
        sources.push({ shotId: shot.id, sha256: hash(await readFile(path)), sizeBytes: info.size });
      }
      const voices = casting?.voices || defaultVoices;
      if (casting) requireValue(jsonHash(sources) === jsonHash(casting.sources), 'SOUNDTRACK_SOURCE_CHANGED');
      const plan = soundtrackPlan({ manifest: job.manifest, manifestHash: job.manifestHash, ...voices });
      // Sources are already present and are never copied. Reserve bounded room
      // for all PCM stems, score/render transients, reviewed audio and final MP4.
      const space = await statfs(work);
      const requiredSpace = Math.ceil(plan.durationMs / 1000 * 1_000_000) + MAX_FILE + 16 * 1024 * 1024;
      requireValue(Number.isFinite(space.bavail * space.bsize) && space.bavail * space.bsize >= requiredSpace,
        'SOUNDTRACK_SCRATCH_UNAVAILABLE');
      const binding = { version: 1, recipe: RECIPE, ownerHash: job.ownerHash, id, manifestHash: job.manifestHash,
        sources, sourceOutputsSha256: jsonHash(job.shots.map(shot => ({ id: shot.id, output: shot.output }))), voices,
        ...(casting ? { castingApproval: { approvalSha256: casting.approvalSha256, priorBindingHash: casting.priorBindingHash,
          priorReceiptSha256: casting.priorReceiptSha256, priorAttempts: casting.priorAttempts } } : {}) };
      const bindingHash = jsonHash(binding), prefix = `production/soundtracks/${job.ownerHash}/${id}/${bindingHash}`;
      const receiptPath = `${prefix}/construction.json`, directory = join(resolve(work), 'soundtrack');
      const mediaPath = descriptor => `${prefix}/media/${descriptor.sha256}.${descriptor.file.split('.').at(-1)}`;
      const validateSaved = record => {
        requireValue(record?.etag && record.value?.kind === RECIPE && record.value.bindingHash === bindingHash
          && jsonHash(record.value.binding) === bindingHash && Number.isSafeInteger(record.value.attempts)
          && record.value.attempts >= (casting?.priorAttempts || 0) + 1 && record.value.attempts <= 2
          && ['building', 'failed', 'constructed', 'reviewed'].includes(record.value.state));
        return record;
      };
      saved = await read(receiptPath);
      if (saved) validateSaved(saved);
      let provenance;
      if (saved && ['constructed', 'reviewed'].includes(saved.value.state)) {
        provenance = saved.value.provenance;
        requireValue(jsonHash(provenance) === saved.value.provenanceSha256);
        const files = constructionFiles(provenance, plan);
        await mkdir(directory, { mode: 0o700 });
        for (const descriptor of files) {
          await guard();
          const bytes = await storedBytes(getBlob, mediaPath(descriptor), descriptor);
          await writeFile(join(directory, descriptor.file), bytes, { flag: 'wx', mode: 0o600 });
        }
        await writeFile(join(directory, 'provenance.json'), JSON.stringify(provenance), { flag: 'wx', mode: 0o600 });
      } else {
        const attempts = nextSoundtrackAttempt(saved?.value.attempts, casting?.priorAttempts || 0);
        const attemptId = randomUUID(), state = { kind: RECIPE, bindingHash, binding, state: 'building',
          attempts, attemptId, updatedAt: new Date(now()).toISOString() };
        await guard();
        try { await write(receiptPath, state, saved?.etag); }
        catch { /* A readback must prove this exact claim before any synthesis. */ }
        saved = validateSaved(await read(receiptPath));
        requireValue(saved.value.attemptId === attemptId && saved.value.state === 'building', 'SOUNDTRACK_CLAIM_EXPIRED');
        // Voice assignments and all source bindings are durable before use.
        const result = await build({ manifest: job.manifest, manifestHash: job.manifestHash,
          clips: clips.map(clip => ({ ...clip })), workDir: work, ffmpeg, ...voices });
        provenance = result.provenance;
        const files = constructionFiles(provenance, plan);
        for (const descriptor of files) {
          await guard();
          const bytes = await localBytes(directory, descriptor), pathname = mediaPath(descriptor);
          try { await putBlob(pathname, bytes, { access: 'private', allowOverwrite: false, addRandomSuffix: false,
            contentType: descriptor.file.endsWith('.mid') ? 'audio/midi' : 'audio/wav', cacheControlMaxAge: 60 }); }
          catch { /* Only matching private readback establishes durable audio. */ }
          await storedBytes(getBlob, pathname, descriptor);
        }
        await guard();
        const constructed = { ...saved.value, state: 'constructed', provenance, provenanceSha256: jsonHash(provenance),
          updatedAt: new Date(now()).toISOString() };
        try { await write(receiptPath, constructed, saved.etag); }
        catch { /* Recover an acknowledged write with a lost response. */ }
        saved = validateSaved(await read(receiptPath));
        requireValue(saved.value.attemptId === attemptId && saved.value.state === 'constructed'
          && saved.value.provenanceSha256 === constructed.provenanceSha256, 'SOUNDTRACK_CACHE_UNAVAILABLE');
      }
      await guard();
      const selected = clips.map(clip => ({ ...clip, audioPath: join(directory,
        provenance.scenes.find(scene => scene.shotId === clip.shotId).mix.file) }));
      const transcriptionReceipts = [];
      const recordTranscript = async (path, options = {}) => {
        await guard();
        const clip = selected.find(value => value.audioPath === path);
        requireValue(clip && transcriptionReceipts.length < selected.length * 2, 'SOUNDTRACK_RECOGNITION_FAILED');
        const descriptor = provenance.scenes.find(scene => scene.shotId === clip.shotId).mix;
        await localBytes(directory, descriptor);
        const transcript = await transcribe(path, options), serialized = JSON.stringify(transcript);
        requireValue(serialized && Buffer.byteLength(serialized) <= 500_000 && Array.isArray(transcript?.words)
          && transcript.words.length <= 10_000 && Number.isFinite(transcript.duration), 'SOUNDTRACK_RECOGNITION_FAILED');
        const transcriptSha256 = hash(serialized), contextSilence = options.contextSilence === true;
        const pathname = `${prefix}/transcriptions/${clip.shotId}/${descriptor.sha256}/${contextSilence ? 'context' : 'normal'}-${transcriptSha256}.json`;
        const evidence = { version: 1, kind: 'authored-soundtrack-transcription', bindingHash, manifestHash: job.manifestHash,
          shotId: clip.shotId, model: 'medium.en', audioSha256: descriptor.sha256, transcriptSha256, contextSilence, transcript };
        await guard();
        try { await write(pathname, evidence); }
        catch { /* An immutable duplicate is accepted only after exact readback. */ }
        const stored = await read(pathname);
        requireValue(stored?.value && jsonHash(stored.value) === jsonHash(evidence), 'SOUNDTRACK_CACHE_UNAVAILABLE');
        await localBytes(directory, descriptor);
        transcriptionReceipts.push({ shotId: clip.shotId, model: 'medium.en', audioSha256: descriptor.sha256,
          transcriptSha256, contextSilence, pathname });
        return transcript;
      };
      const resolveSpeechDifferences = createRepairSpeechResolver({ manifest: job.manifest, manifestHash: job.manifestHash,
        voices, provenance, constructionRoot: work, receiptRoot: work });
      const resolveAdjacentSpeechContext = createAdjacentAuthoredSpeechContext({ manifest: job.manifest, manifestHash: job.manifestHash,
        voices, provenance, constructionRoot: work, bindingHash, prefix, guard, transcribe, read, write });
      const reviewedSpeech = await reviewSpeech({ manifest: job.manifest, clips: selected, ffmpeg,
        transcribe: recordTranscript, resolveSpeechDifferences, resolveAdjacentSpeechContext, speakerAliases: voices.speakerAliases });
      const speechReview = { ...reviewedSpeech, transcriptionReceipts };
      requireValue(speechReview?.passed === true, 'SOUNDTRACK_SPEECH_UNVERIFIED');
      await guard();
      const selectedAudio = [];
      for (const clip of selected) {
        const source = sources.find(value => value.shotId === clip.shotId);
        requireValue(await realpath(clip.path) === originalPaths.get(clip.shotId)
          && hash(await readFile(clip.path)) === source.sha256, 'SOUNDTRACK_SOURCE_CHANGED');
        const bytes = await readFile(clip.audioPath);
        selectedAudio.push({ shotId: clip.shotId, sha256: hash(bytes), sizeBytes: bytes.length });
      }
      const receipt = { version: 1, recipe: RECIPE, bindingHash, receiptPath, provenanceSha256: jsonHash(provenance),
        voiceAssignmentsSha256: jsonHash(voices), sourceVideos: sources, selectedAudio, providerGenerationCalls: 0 };
      const reviewed = { ...saved.value, state: 'reviewed', speechReview, selectedAudio,
        updatedAt: new Date(now()).toISOString() };
      try { await write(receiptPath, reviewed, saved.etag); }
      catch { /* Reusing construction remains safe; require the same review readback. */ }
      saved = validateSaved(await read(receiptPath));
      requireValue(saved.value.state === 'reviewed' && saved.value.provenanceSha256 === receipt.provenanceSha256
        && jsonHash(saved.value.speechReview) === jsonHash(speechReview)
        && jsonHash(saved.value.selectedAudio) === jsonHash(selectedAudio), 'SOUNDTRACK_CACHE_UNAVAILABLE');
      await guard();
      for (const clip of clips) clip.audioPath = selected.find(value => value.shotId === clip.shotId).audioPath;
      return { ...speechReview, soundtrack: receipt };
    } catch (error) {
      // Only bounded diagnostics may leave this local finishing component.
      const diagnostic = soundtrackFailureDiagnostic(error?.diagnostic);
      if (diagnostic) console.warn('FILM_SOUNDTRACK_CONSTRUCTION_FAILED', diagnostic);
      if (failureReasons.has(error?.soundtrackReason)) console.warn('FILM_SOUNDTRACK_FALLBACK_FAILED', { reason: error.soundtrackReason });
      throw markFinishingFailure(Object.assign(error instanceof Error ? error : new Error('Soundtrack review failed.'),
        { code: 'FILM_SPEECH_REVIEW_REQUIRED' }), 'speech-review');
    }
  };
}
