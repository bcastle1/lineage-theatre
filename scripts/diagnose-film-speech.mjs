// Mount read-only as /app/scripts/diagnose-film-speech.mjs in the worker image.
// Reads Blob records and existing allowlisted media only. No generation,
// payment, queue, publication, or persistent record writes are performed.
// --include-first-difference exposes bounded script tokens on the operator's
// private console only. Do not use that option in a service or public log.
// --model medium.en opts into a separately cached diagnostic recognizer.
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord, userPath } from '../api/_lib/auth.mjs';
import { accessStatusForUser } from '../api/_lib/access.mjs';
import { productionJobPath, validateProviderOutput } from '../api/_lib/film-production.mjs';
import { FAL_MEDIA_HOSTS } from '../api/_lib/fal-client.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { normalizeSpeech, speechEdit, intendedSpeechTokens } from './review-film-speech.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CLIP_BYTES = 250 * 1024 * 1024;
const RECOGNITION_MODELS = new Set(['small.en', 'medium.en']);
const diagnosticReasons = new Set(['ARGUMENTS_INVALID', 'ACCOUNT_UNAVAILABLE', 'JOB_UNAVAILABLE', 'JOB_NOT_READY',
  'PAYMENT_UNVERIFIED', 'RECORDS_CHANGED', 'SCENE_LIMIT_EXCEEDED', 'DIAGNOSTIC_TIME_LIMIT',
  'MEDIA_DOWNLOAD_FAILED', 'SPEECH_RECOGNITION_FAILED', 'TRANSCRIPT_INVALID', 'LOCAL_STORAGE_FAILED', 'DIAGNOSTIC_FAILED']);
const speechReasons = new Set(['SPEECH_DURATION_INVALID', 'SPEECH_UNEXPECTED', 'SPEECH_SCRIPT_MISMATCH',
  'SPEECH_TIMING_INVALID', 'SPEECH_BOUNDARY_UNCLEAR', 'SPEECH_REVIEW_REQUIRED']);
const numberWords = new Set(('zero oh o one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen '
  + 'sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million and').split(' '));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => { throw Object.assign(new Error('The private diagnostic could not complete.'), { diagnosticReason: reason }); };
const safeFailure = error => diagnosticReasons.has(error?.diagnosticReason) ? error.diagnosticReason : 'DIAGNOSTIC_FAILED';
const deadline = Date.now() + 30 * 60_000;
function remaining(maximum) {
  const value = deadline - Date.now();
  if (value <= 0) fail('DIAGNOSTIC_TIME_LIMIT');
  return Math.min(maximum, value);
}

function argumentsForRun(args) {
  const values = new Map();
  let includeFirstDifference = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--include-first-difference') {
      if (includeFirstDifference) fail('ARGUMENTS_INVALID');
      includeFirstDifference = true;
      continue;
    }
    const value = args[++index];
    if (!['--email', '--id', '--max-scenes', '--model'].includes(key) || values.has(key) || !value) fail('ARGUMENTS_INVALID');
    values.set(key, value);
  }
  const email = values.get('--email'), id = values.get('--id');
  const maxScenes = values.has('--max-scenes') ? Number(values.get('--max-scenes')) : 6;
  const model = values.get('--model') || 'small.en';
  if (typeof email !== 'string' || email !== email.trim().toLowerCase() || email.length > 254
    || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email) || !UUID.test(id || '')
    || !Number.isSafeInteger(maxScenes) || maxScenes < 1 || maxScenes > 200
    || !RECOGNITION_MODELS.has(model)) fail('ARGUMENTS_INVALID');
  return { email, id, maxScenes, includeFirstDifference, model };
}

async function downloadExistingClip(output, path) {
  let response, handle;
  try {
    const verified = validateProviderOutput(output, FAL_MEDIA_HOSTS);
    if (verified.sizeBytes > MAX_CLIP_BYTES) fail('MEDIA_DOWNLOAD_FAILED');
    response = await fetch(verified.url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: verified.contentType }, signal: AbortSignal.timeout(remaining(120_000)) });
    const length = response.headers.get('content-length');
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== verified.contentType
      || (length !== null && Number(length) !== verified.sizeBytes) || !response.body
      || verified.sizeBytes > MAX_CLIP_BYTES) fail('MEDIA_DOWNLOAD_FAILED');
    handle = await open(path, 'wx', 0o600);
    let received = 0;
    for await (const chunk of response.body) {
      remaining(1);
      received += chunk.byteLength;
      if (received > verified.sizeBytes || received > MAX_CLIP_BYTES) fail('MEDIA_DOWNLOAD_FAILED');
      await handle.writeFile(chunk);
    }
    if (received !== verified.sizeBytes) fail('MEDIA_DOWNLOAD_FAILED');
  } catch (error) {
    if (diagnosticReasons.has(error?.diagnosticReason)) throw error;
    fail('MEDIA_DOWNLOAD_FAILED');
  } finally {
    await handle?.close().catch(() => {});
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

function transcribe(path, contextSilence, model) {
  const timeout = remaining(300_000);
  return new Promise((resolveTranscript, reject) => {
    const child = spawn(process.env.PYTHON_PATH || 'python3', [fileURLToPath(new URL('./transcribe-film.py', import.meta.url)),
      path, '--model', model, ...(contextSilence ? ['--context-silence'] : [])], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      // Local cached recognition only; do not pass Blob, fal or Accounting secrets.
      env: { PATH: process.env.PATH || '', HF_HOME: process.env.HF_HOME || '/opt/whisper',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1',
        OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2' },
    });
    const stdout = [];
    let bytes = 0, settled = false;
    const rejectSafe = reason => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill('SIGKILL');
      reject(Object.assign(new Error('Local recognition did not complete.'), { diagnosticReason: reason }));
    };
    const timer = setTimeout(() => rejectSafe(Date.now() >= deadline ? 'DIAGNOSTIC_TIME_LIMIT' : 'SPEECH_RECOGNITION_FAILED'), timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.byteLength;
      if (bytes > 500_000) { rejectSafe('TRANSCRIPT_INVALID'); return; }
      stdout.push(chunk);
    });
    child.once('error', () => rejectSafe('SPEECH_RECOGNITION_FAILED'));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { rejectSafe('SPEECH_RECOGNITION_FAILED'); return; }
      try {
        const value = JSON.parse(Buffer.concat(stdout, bytes).toString('utf8'));
        if (!plain(value) || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 60
          || !Array.isArray(value.words) || value.words.length > 4_000
          || value.words.some(word => !plain(word) || typeof word.word !== 'string' || word.word.length > 200
            || !Number.isFinite(word.start) || !Number.isFinite(word.end))) {
          rejectSafe('TRANSCRIPT_INVALID'); return;
        }
        settled = true; clearTimeout(timer); resolveTranscript(value);
      } catch { rejectSafe('TRANSCRIPT_INVALID'); }
    });
  });
}

const tokensForTranscript = transcript => transcript.words.flatMap(word => normalizeSpeech(word.word));
function firstDifference(shot, transcript, manifest) {
  const expected = intendedSpeechTokens(shot, { manifest });
  const actual = transcript.words.flatMap(word => {
    const confidence = [word.probability, word.confidence].find(value => Number.isFinite(value) && value >= 0 && value <= 1);
    return normalizeSpeech(word.word).map(token => ({ token, confidence }));
  });
  let offset = 0;
  while (offset < expected.length && offset < actual.length && expected[offset] === actual[offset].token) offset++;
  if (offset === expected.length && offset === actual.length) return null;
  const left = expected.slice(offset, offset + 4), right = actual.slice(offset, offset + 4);
  return { tokenOffset: offset, offsetBasis: 'zero-based', expectedTokenCount: expected.length, actualTokenCount: actual.length,
    expectedTokens: left.map(token => token.slice(0, 80)), actualTokens: right.map(word => word.token.slice(0, 80)),
    tokensTruncated: left.some(token => token.length > 80) || right.some(word => word.token.length > 80),
    ...(right.some(word => word.confidence !== undefined) ? { actualTokenConfidence: right.map(word => word.confidence ?? null) } : {}) };
}
function numeralCandidate(expected, actual) {
  let start = 0, endExpected = expected.length, endActual = actual.length;
  while (start < endExpected && start < endActual && expected[start] === actual[start]) start++;
  while (endExpected > start && endActual > start && expected[endExpected - 1] === actual[endActual - 1]) { endExpected--; endActual--; }
  const left = expected.slice(start, endExpected), right = actual.slice(start, endActual);
  const digits = tokens => tokens.length === 1 && /^\d{1,9}$/.test(tokens[0]);
  const words = tokens => tokens.length > 0 && tokens.length <= 12 && tokens.every(token => numberWords.has(token));
  // A hint only: no semantic equivalence is asserted and no words are accepted
  // or modified based on this classification.
  return digits(left) && words(right) || digits(right) && words(left);
}
function compareSpeech(shot, transcript, manifest) {
  try {
    const edit = speechEdit(shot, transcript, { manifest });
    return { matched: true, reason: 'NONE', trailingAudioEditRequired: Boolean(edit) };
  } catch (error) {
    const reason = finishingFailure(error, 'speech-review')?.reason;
    return { matched: false, reason: speechReasons.has(reason) ? reason : 'SPEECH_REVIEW_REQUIRED', trailingAudioEditRequired: false };
  }
}
async function inspectScene(shot, path, sceneIndex, includeFirstDifference, model, manifest) {
  const normal = await transcribe(path, false, model), first = compareSpeech(shot, normal, manifest);
  if (first.matched) return { sceneIndex, reason: 'NONE', normalMatched: true, contextMatched: null,
    mismatchCategory: 'none', trailingAudioEditRequired: first.trailingAudioEditRequired,
    ...(includeFirstDifference ? { firstDifferences: { normal: firstDifference(shot, normal, manifest), context: null } } : {}) };
  const context = await transcribe(path, true, model), second = compareSpeech(shot, context, manifest);
  const expected = intendedSpeechTokens(shot, { manifest }), normalTokens = tokensForTranscript(normal), contextTokens = tokensForTranscript(context);
  const mismatchCategory = second.matched ? 'context-recovered'
    : numeralCandidate(expected, normalTokens) || numeralCandidate(expected, contextTokens) ? 'possible-numeral-format'
    : JSON.stringify(normalTokens) !== JSON.stringify(contextTokens) ? 'recognizer-disagreement' : 'unclassified';
  return { sceneIndex, reason: second.matched ? 'NONE' : second.reason, normalMatched: false, contextMatched: second.matched,
    mismatchCategory, trailingAudioEditRequired: second.trailingAudioEditRequired,
    ...(includeFirstDifference ? { firstDifferences: { normal: firstDifference(shot, normal, manifest), context: firstDifference(shot, context, manifest) } } : {}) };
}

async function main() {
  const { email, id, maxScenes, includeFirstDifference, model } = argumentsForRun(process.argv.slice(2));
  const snapshots = new Map();
  const read = async path => {
    remaining(1);
    const record = await readRecord(path), signature = JSON.stringify([record?.etag ?? null, record?.value ?? null]);
    if (snapshots.has(path) && snapshots.get(path) !== signature) fail('RECORDS_CHANGED');
    snapshots.set(path, signature);
    return record;
  };
  const actorRecord = await read(userPath(email)), actor = actorRecord?.value;
  if (!actorRecord?.etag || actor?.email !== email || actor.mustChangePassword || accessStatusForUser(actor) !== 'approved') fail('ACCOUNT_UNAVAILABLE');
  const record = await read(productionJobPath(email, id)), job = record?.value;
  if (!record?.etag || job?.id !== id || job.ownerHash !== digest(email) || job.mode !== 'customer'
    || job.provider?.id !== 'fal' || !['wan', 'seedance'].includes(job.provider.model)
    || !HASH.test(job.manifestHash || '') || !plain(job.manifest) || digest(JSON.stringify(job.manifest)) !== job.manifestHash
    || job.filmId !== job.manifest.filmId) fail('JOB_UNAVAILABLE');
  if (job.status !== 'awaiting-assembly' || !Array.isArray(job.shots) || !Array.isArray(job.manifest.shots)
    || job.shots.length < 1 || job.shots.length > 200 || job.shots.length !== job.manifest.shots.length
    || new Set(job.shots.map(shot => shot.id)).size !== job.shots.length
    || job.shots.some((shot, index) => shot.status !== 'completed' || shot.id !== job.manifest.shots[index].id)
    || job.manifest.shots.some(shot => !Number.isSafeInteger(shot.targetDurationMs) || shot.targetDurationMs < 1_000 || shot.targetDurationMs > 30_000
      || typeof shot.narration !== 'string' || typeof shot.dialogue !== 'string')) fail('JOB_NOT_READY');
  if (job.shots.length > maxScenes) fail('SCENE_LIMIT_EXCEEDED');
  try { await requireFinishedFilmPayment({ job, email, actor, read, now: Date.now }); }
  catch (error) { if (diagnosticReasons.has(error?.diagnosticReason)) throw error; fail('PAYMENT_UNVERIFIED'); }

  const tempRoot = resolve(tmpdir());
  let work;
  const results = [];
  try {
    work = await mkdtemp(join(tempRoot, 'lineage-speech-diagnostic-'));
    for (const [index, shot] of job.shots.entries()) {
      remaining(1);
      const path = join(work, `scene-${index + 1}.${shot.output?.contentType === 'video/webm' ? 'webm' : 'mp4'}`);
      try {
        await downloadExistingClip(shot.output, path);
        results.push(await inspectScene(job.manifest.shots[index], path, index + 1, includeFirstDifference, model, job.manifest));
      } catch (error) {
        if (error?.diagnosticReason === 'DIAGNOSTIC_TIME_LIMIT') throw error;
        results.push({ sceneIndex: index + 1, reason: safeFailure(error), normalMatched: null, contextMatched: null,
          mismatchCategory: 'unclassified', trailingAudioEditRequired: false });
      } finally {
        // This is only a fixed filename inside this invocation's new directory.
        await rm(path, { force: true }).catch(() => {});
      }
    }
    for (const [path, signature] of snapshots) {
      remaining(1);
      const latest = await readRecord(path);
      if (JSON.stringify([latest?.etag ?? null, latest?.value ?? null]) !== signature) fail('RECORDS_CHANGED');
    }
  } finally {
    if (work && dirname(resolve(work)) === tempRoot && basename(work).startsWith('lineage-speech-diagnostic-')) {
      try { await rm(work, { recursive: true, force: true }); }
      catch { fail('LOCAL_STORAGE_FAILED'); }
    }
  }
  const passed = results.every(result => result.reason === 'NONE');
  process.stdout.write(`${JSON.stringify({ status: passed ? 'speech-comparison-passed' : 'review-required', recognitionModel: model, scenesChecked: results.length, results })}\n`);
  process.exitCode = passed ? 0 : 1;
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ status: 'diagnostic-failed', reason: safeFailure(error), scenesChecked: 0, results: [] })}\n`);
  process.exitCode = 1;
});
