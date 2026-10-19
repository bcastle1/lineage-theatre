// Explicit operator recovery for an exact already-paid film identified by its
// order, prepared-job reference and immutable manifest hash.
// This entry point has no generation, quote, payment, or provider-submit calls.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { get, put } from '@vercel/blob';
import { mkdir, readFile, writeFile, lstat, realpath, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL, isOwner, accessStatusForUser } from '../api/_lib/access.mjs';
import { createFilmProductionService, productionJobPath } from '../api/_lib/film-production.mjs';
import { productionQueuePath } from '../api/_lib/production-queue.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { falProductionAdapter, FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { createWorkerAssembly, downloadProductionClip, verifyPublishedFilm } from './production-worker.mjs';
import { reviewFilmSpeech } from './review-film-speech.mjs';
import { rebuildFilmSoundtrack } from './rebuild-film-soundtrack.mjs';
import { assembleFilm } from './assemble-film.mjs';

const HASH = /^[a-f0-9]{64}$/;
const KIND = 'lineage-paid-soundtrack-repair-v1';
const MAX_AGE = 24 * 3600_000, LEASE_MS = 30 * 60_000;
const hash = value => digest(JSON.stringify(value));
const fail = code => Object.assign(new Error('The exact paid-film soundtrack recovery could not be confirmed.'), { code });
const same = (a, b) => hash(a) === hash(b);
const expectedSourceName = (index, contentType) => `source-${String(index + 1).padStart(2, '0')}.${contentType === 'video/mp4' ? 'mp4' : 'webm'}`;
function assertIdentity(input) {
  if (!HASH.test(input?.orderId || '') || !HASH.test(input.manifestHash || '')) throw fail('REPAIR_IDENTITY_INVALID');
  productionJobPath(OWNER_EMAIL, input.preparedId);
}

async function context(identity, { read = readRecord, now = Date.now } = {}) {
  assertIdentity(identity);
  const owner = await read(userPath(OWNER_EMAIL));
  if (!owner?.etag || !isOwner(owner.value) || owner.value.mustChangePassword) throw fail('REPAIR_OWNER_REQUIRED');
  const order = await read(`payments/orders/${identity.orderId}.json`), value = order?.value;
  if (!order?.etag || value?.id !== identity.orderId || value.preparedId !== identity.preparedId
    || value.manifestHash !== identity.manifestHash || value.customerEmail !== OWNER_EMAIL
    || value.productionConsent !== true || value.sandbox === true
    || value.checkoutMethod !== 'quickbooks-hosted-invoice') throw fail('REPAIR_ORDER_CHANGED');
  const email = value.customerEmail, account = await read(userPath(email));
  if (!account?.etag || account.value.email !== email || account.value.mustChangePassword
    || accessStatusForUser(account.value) !== 'approved') throw fail('REPAIR_ACCOUNT_REQUIRED');
  const jobPath = productionJobPath(email, identity.preparedId), job = await read(jobPath);
  const saved = job?.value;
  if (!job?.etag || saved?.id !== identity.preparedId || saved.ownerHash !== digest(email)
    || saved.status !== 'awaiting-assembly' || saved.mode !== 'customer' || saved.manifestHash !== identity.manifestHash
    || hash(saved.manifest) !== identity.manifestHash
    || saved.filmId !== value.filmId || saved.manifest.filmId !== value.filmId || saved.media
    || saved.provider?.id !== 'fal' || saved.provider.model !== 'wan' || saved.provider.recipe !== FAL_RECIPE_VERSION
    || !Number.isSafeInteger(saved.revision) || saved.lease?.expiresAt > now()
    || !Array.isArray(saved.shots) || saved.shots.length < 1 || saved.shots.length > 6 || saved.manifest.shots?.length !== saved.shots.length
    || saved.shots.some((shot, index) => shot.status !== 'completed' || shot.id !== saved.manifest.shots[index].id || !shot.output))
    throw fail('REPAIR_JOB_CHANGED');
  await requireFinishedFilmPayment({ job: saved, email, actor: account.value, read, now });
  const queuePath = productionQueuePath(email, identity.preparedId), queue = await read(queuePath);
  if (!queue?.etag || queue.value.version !== 1 || queue.value.email !== email || queue.value.id !== identity.preparedId
    || queue.value.orderId !== identity.orderId || queue.value.manifestHash !== identity.manifestHash
    || queue.value.state !== 'attention') throw fail('REPAIR_QUEUE_CHANGED');
  return { email, owner, account, order, job, queue, jobPath, queuePath };
}
function revisions(value) {
  return { owner: value.owner.etag, account: value.account.etag, order: value.order.etag, job: value.job.etag,
    orderHash: hash(value.order.value), jobHash: hash(value.job.value) };
}
function assertSnapshot(snapshot, current, now) {
  if (snapshot?.kind !== KIND || snapshot.version !== 1 || snapshot.owner !== OWNER_EMAIL || snapshot.email !== current.email
    || !Number.isFinite(Date.parse(snapshot.createdAt)) || Date.parse(snapshot.createdAt) > now
    || now - Date.parse(snapshot.createdAt) > MAX_AGE || !same(snapshot.revisions, revisions(current))
    || !same(snapshot.originalJob, current.job.value) || !Array.isArray(snapshot.sources) || snapshot.sources.length !== current.job.value.shots.length)
    throw fail('REPAIR_SNAPSHOT_CHANGED');
}
async function localFile(path, root) {
  const stat = await lstat(path), actual = await realpath(path), inside = relative(await realpath(root), actual);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > 250 * 1024 * 1024
    || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw fail('REPAIR_LOCAL_MEDIA_INVALID');
  const bytes = await readFile(actual);
  if (bytes.length !== stat.size) throw fail('REPAIR_LOCAL_MEDIA_CHANGED');
  return { path: actual, sizeBytes: bytes.length, sha256: digest(bytes) };
}
async function readJsonSnapshot(path, sha256) {
  if (!HASH.test(sha256 || '')) throw fail('REPAIR_SNAPSHOT_HASH_REQUIRED');
  const fullPath = resolve(path), info = await lstat(fullPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw fail('REPAIR_SNAPSHOT_INVALID');
  const bytes = await readFile(fullPath);
  if (digest(bytes) !== sha256) throw fail('REPAIR_SNAPSHOT_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
}
async function validateLocalSources(snapshot, root) {
  for (const [index, shot] of snapshot.originalJob.shots.entries()) {
    const source = snapshot.sources[index];
    if (source.shotId !== shot.id || source.filename !== expectedSourceName(index, shot.output.contentType)
      || source.outputHash !== hash(shot.output) || !HASH.test(source.sha256 || '')) throw fail('REPAIR_SOURCE_CHANGED');
    const actual = await localFile(join(root, source.filename), root);
    if (actual.sha256 !== source.sha256 || actual.sizeBytes !== source.sizeBytes) throw fail('REPAIR_SOURCE_CHANGED');
  }
}

// Operator recovery uses the already-cached medium recognizer. Raw words and
// timestamps stay in the private work directory even if exact matching fails.
// No script text or recognition hint is supplied to the recognizer.
function repairTranscriber(root, { python = process.env.PYTHON_PATH || 'python3', now = Date.now, receiptRoot = root } = {}) {
  const reviewDirectory = join(receiptRoot, 'review', randomUUID());
  return async (audioPath, { contextSilence = false } = {}) => {
    const before = await localFile(audioPath, root);
    await mkdir(reviewDirectory, { recursive: true, mode: 0o700 });
    const transcript = await new Promise((resolveTranscript, reject) => {
      const args = [fileURLToPath(new URL('./transcribe-film.py', import.meta.url)), before.path, '--model', 'medium.en',
        ...(contextSilence ? ['--context-silence'] : [])];
      const child = spawn(python, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let length = 0, finished = false;
      const end = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolveTranscript(value); };
      const timer = setTimeout(() => { child.kill(); end(fail('REPAIR_TRANSCRIPTION_TIMEOUT')); }, 10 * 60_000);
      child.stdout.on('data', chunk => {
        length += chunk.length;
        if (length > 500_000) { child.kill(); end(fail('REPAIR_TRANSCRIPTION_INVALID')); }
        else chunks.push(chunk);
      });
      child.once('error', () => end(fail('REPAIR_TRANSCRIPTION_FAILED')));
      child.once('close', code => {
        if (code !== 0) { end(fail('REPAIR_TRANSCRIPTION_FAILED')); return; }
        try { end(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { end(fail('REPAIR_TRANSCRIPTION_INVALID')); }
      });
    });
    const after = await localFile(audioPath, root);
    if (after.sha256 !== before.sha256) throw fail('REPAIR_AUDIO_CHANGED');
    const receipt = { version: 1, model: 'medium.en', sourceSha256: before.sha256, sourceFile: relative(root, before.path),
      contextSilence, checkedAt: new Date(now()).toISOString(), transcript };
    await writeFile(join(reviewDirectory, `${before.sha256}-${contextSilence ? 'context' : 'normal'}.json`),
      JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    return transcript;
  };
}

async function finishSoundtrackBuild({ snapshot, snapshotSha256, root, clips, voices, provenance, ffmpeg }, dependencies) {
  const read = dependencies.read || readRecord, now = dependencies.now || Date.now;
  const speechReview = await reviewFilmSpeech({ manifest: snapshot.originalJob.manifest, clips, ffmpeg,
    transcribe: repairTranscriber(root, { now }) });
  if (speechReview?.passed !== true) throw fail('REPAIR_SPEECH_UNVERIFIED');
  const selectedAudio = [];
  for (const [index, clip] of clips.entries()) {
    const audio = await localFile(clip.audioPath, root), visual = await localFile(clip.path, root);
    if (visual.sha256 !== snapshot.sources[index].sha256 || audio.sha256 === visual.sha256) throw fail('REPAIR_SOURCE_CHANGED');
    selectedAudio.push({ shotId: clip.shotId, filename: relative(root, audio.path), sha256: audio.sha256, sizeBytes: audio.sizeBytes });
  }
  const preview = await assembleFilm({ manifest: snapshot.originalJob.manifest, manifestHash: snapshot.manifestHash,
    clips, outputPath: join(root, 'preview.mp4'), ffmpeg, technicalSample: false });
  const fresh = await context(snapshot, { read, now }); assertSnapshot(snapshot, fresh, now());
  if (fresh.queue.etag !== snapshot.queueEtag) throw fail('REPAIR_QUEUE_CHANGED');
  const build = { kind: KIND, version: 1, state: 'preview-ready', snapshotSha256, orderId: snapshot.orderId,
    preparedId: snapshot.preparedId, manifestHash: snapshot.manifestHash, createdAt: new Date(now()).toISOString(),
    voices, provenance, sources: snapshot.sources, selectedAudio, speechReview, preview, recognitionModel: 'medium.en' };
  const bytes = Buffer.from(JSON.stringify(build, null, 2)), buildPath = join(root, 'build.json');
  await writeFile(buildPath, bytes, { flag: 'wx', mode: 0o600 });
  return { state: 'preview-ready', buildPath, buildSha256: digest(bytes), previewPath: preview.outputPath,
    previewSha256: preview.sha256, durationSeconds: preview.durationSeconds, speechVerified: true, providerSubmissions: 0 };
}

// Preparation is read-only against storage and the video provider. Its local
// snapshot and unchanged source clips remain available if recovery fails.
export async function preparePaidFilmSoundtrackRepair({ orderId, preparedId, manifestHash, outputDir }, dependencies = {}) {
  const read = dependencies.read || readRecord, now = dependencies.now || Date.now;
  const identity = { orderId, preparedId, manifestHash }, current = await context(identity, { read, now });
  if (current.queue.value.lease?.expiresAt > now()) throw fail('REPAIR_ALREADY_LEASED');
  const root = resolve(outputDir);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  const sources = [];
  for (const [index, shot] of current.job.value.shots.entries()) {
    const bytes = await downloadProductionClip(shot.output, falProductionAdapter.outputHosts, dependencies);
    const filename = expectedSourceName(index, shot.output.contentType);
    await writeFile(join(root, filename), bytes, { flag: 'wx', mode: 0o600 });
    sources.push({ shotId: shot.id, filename, sizeBytes: bytes.length, sha256: digest(bytes), outputHash: hash(shot.output) });
  }
  const fresh = await context(identity, { read, now });
  if (!same(revisions(current), revisions(fresh)) || fresh.queue.etag !== current.queue.etag) throw fail('REPAIR_CHANGED_DURING_SNAPSHOT');
  const snapshot = { kind: KIND, version: 1, ...identity, owner: OWNER_EMAIL, email: current.email,
    createdAt: new Date(now()).toISOString(), revisions: revisions(current), queueEtag: current.queue.etag,
    originalJob: current.job.value, originalQueue: current.queue.value, sources,
    scope: 'Replace soundtrack only; preserve every paid video source and exact saved narration/dialogue; no provider spending.' };
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2));
  const snapshotPath = join(root, 'snapshot.json');
  await writeFile(snapshotPath, bytes, { flag: 'wx', mode: 0o600 });
  return { state: 'prepared', snapshotPath, snapshotSha256: digest(bytes), sourceCount: sources.length };
}

// Build and inspect the real replacement soundtrack before any remote state is
// changed. The subsequent apply copies these exact reviewed audio bytes.
export async function buildPaidFilmSoundtrackRepair({ snapshotPath, snapshotSha256, outputDir, voices,
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg' }, dependencies = {}) {
  const read = dependencies.read || readRecord, now = dependencies.now || Date.now;
  const snapshot = await readJsonSnapshot(snapshotPath, snapshotSha256), current = await context(snapshot, { read, now });
  assertSnapshot(snapshot, current, now());
  if (current.queue.etag !== snapshot.queueEtag || current.queue.value.lease?.expiresAt > now()) throw fail('REPAIR_QUEUE_CHANGED');
  const sourceRoot = dirname(resolve(snapshotPath));
  await validateLocalSources(snapshot, sourceRoot);
  if (!voices || typeof voices !== 'object' || Array.isArray(voices)
    || Object.keys(voices).some(key => !['narratorVoice', 'characterVoices', 'speakerAliases'].includes(key))) throw fail('REPAIR_VOICES_INVALID');
  const root = resolve(outputDir);
  await mkdir(dirname(root), { recursive: true }); await mkdir(root, { mode: 0o700 });
  const clips = [];
  for (const source of snapshot.sources) {
    const path = join(root, source.filename);
    await copyFile(join(sourceRoot, source.filename), path);
    clips.push({ shotId: source.shotId, path });
  }
  const rebuilt = await rebuildFilmSoundtrack({ manifest: current.job.value.manifest, manifestHash: snapshot.manifestHash,
    clips, workDir: root, ffmpeg, music: true, ...voices });
  if (!Array.isArray(rebuilt?.clips) || rebuilt.clips.length !== snapshot.sources.length) throw fail('REPAIR_AUDIO_INVALID');
  for (const [index, clip] of rebuilt.clips.entries()) if (clip.shotId !== clips[index].shotId
    || clip.path !== clips[index].path || typeof clip.audioPath !== 'string' || clip.audioPath === clip.path) throw fail('REPAIR_AUDIO_INVALID');
  const selectedAudio = [];
  for (const [index, clip] of rebuilt.clips.entries()) {
    const audio = await localFile(clip.audioPath, root), visual = await localFile(clip.path, root);
    if (visual.sha256 !== snapshot.sources[index].sha256 || audio.sha256 === visual.sha256) throw fail('REPAIR_SOURCE_CHANGED');
    selectedAudio.push({ shotId: clip.shotId, filename: relative(root, audio.path), sha256: audio.sha256, sizeBytes: audio.sizeBytes });
  }
  const constructed = { kind: KIND, version: 1, state: 'constructed-needs-review', snapshotSha256, orderId: snapshot.orderId,
    preparedId: snapshot.preparedId, manifestHash: snapshot.manifestHash, createdAt: new Date(now()).toISOString(),
    voices, provenance: rebuilt.provenance, sources: snapshot.sources, selectedAudio };
  const bytes = Buffer.from(JSON.stringify(constructed, null, 2)), constructedPath = join(root, 'constructed.json');
  await writeFile(constructedPath, bytes, { flag: 'wx', mode: 0o600 });
  try { return await finishSoundtrackBuild({ snapshot, snapshotSha256, root, clips: rebuilt.clips, voices, provenance: rebuilt.provenance, ffmpeg }, dependencies); }
  catch (error) { error.repairRecovery = { constructedPath, constructedSha256: digest(bytes) }; throw error; }
}

export async function reviewConstructedFilmSoundtrack({ snapshotPath, snapshotSha256, constructedPath, constructedSha256, outputDir,
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg' }, dependencies = {}) {
  const read = dependencies.read || readRecord, now = dependencies.now || Date.now;
  const snapshot = await readJsonSnapshot(snapshotPath, snapshotSha256), current = await context(snapshot, { read, now });
  assertSnapshot(snapshot, current, now());
  if (current.queue.etag !== snapshot.queueEtag || current.queue.value.lease?.expiresAt > now()) throw fail('REPAIR_QUEUE_CHANGED');
  const constructed = await readJsonSnapshot(constructedPath, constructedSha256), originalRoot = dirname(resolve(constructedPath));
  if (constructed.kind !== KIND || constructed.version !== 1 || constructed.state !== 'constructed-needs-review'
    || constructed.snapshotSha256 !== snapshotSha256 || constructed.orderId !== snapshot.orderId
    || constructed.preparedId !== snapshot.preparedId || constructed.manifestHash !== snapshot.manifestHash
    || !same(constructed.sources, snapshot.sources) || !Array.isArray(constructed.selectedAudio)
    || constructed.selectedAudio.length !== snapshot.sources.length) throw fail('REPAIR_CONSTRUCTION_CHANGED');
  await validateLocalSources(snapshot, originalRoot);
  const root = resolve(outputDir);
  await mkdir(dirname(root), { recursive: true }); await mkdir(root, { mode: 0o700 });
  const clips = [];
  for (const [index, source] of snapshot.sources.entries()) {
    const selected = constructed.selectedAudio[index];
    if (selected.shotId !== source.shotId || typeof selected.filename !== 'string') throw fail('REPAIR_AUDIO_INVALID');
    const audio = await localFile(resolve(originalRoot, selected.filename), originalRoot);
    if (audio.sha256 !== selected.sha256 || audio.sizeBytes !== selected.sizeBytes) throw fail('REPAIR_AUDIO_CHANGED');
    const path = join(root, source.filename), audioPath = join(root, `replacement-${index + 1}.wav`);
    await copyFile(join(originalRoot, source.filename), path); await copyFile(audio.path, audioPath);
    clips.push({ shotId: source.shotId, path, audioPath });
  }
  return finishSoundtrackBuild({ snapshot, snapshotSha256, root, clips, voices: constructed.voices, provenance: constructed.provenance, ffmpeg }, dependencies);
}

// An authenticated draft preview is separate from delivered paid-film media.
// Uploading it neither completes the production job nor changes its queue.
export async function publishPaidFilmSoundtrackPreview({ snapshotPath, snapshotSha256, buildPath, buildSha256 }, dependencies = {}) {
  const read = dependencies.read || readRecord, write = dependencies.write || writeRecord, now = dependencies.now || Date.now;
  const putBlob = dependencies.putBlob || put, getBlob = dependencies.getBlob || get;
  const snapshot = await readJsonSnapshot(snapshotPath, snapshotSha256), current = await context(snapshot, { read, now });
  assertSnapshot(snapshot, current, now());
  if (current.queue.etag !== snapshot.queueEtag || current.queue.value.lease?.expiresAt > now()) throw fail('REPAIR_QUEUE_CHANGED');
  await validateLocalSources(snapshot, dirname(resolve(snapshotPath)));
  const build = await readJsonSnapshot(buildPath, buildSha256), buildRoot = dirname(resolve(buildPath));
  if (build.kind !== KIND || build.version !== 1 || build.state !== 'preview-ready' || build.snapshotSha256 !== snapshotSha256
    || build.orderId !== snapshot.orderId || build.preparedId !== snapshot.preparedId || build.manifestHash !== snapshot.manifestHash
    || !same(build.sources, snapshot.sources) || build.speechReview?.passed !== true || !HASH.test(build.preview?.sha256 || '')
    || build.preview.manifestHash !== snapshot.manifestHash || build.preview.contentType !== 'video/mp4'
    || build.preview.technicalSample !== false || build.preview.playable !== true || build.preview.hasAudio !== true
    || !Number.isFinite(build.preview.durationSeconds)
    || Math.abs(build.preview.durationSeconds - current.job.value.manifest.targetDurationSeconds) > 1
    || !Array.isArray(build.selectedAudio) || build.selectedAudio.length !== snapshot.sources.length) throw fail('REPAIR_PREVIEW_UNCONFIRMED');
  for (const [index, selected] of build.selectedAudio.entries()) {
    if (selected.shotId !== snapshot.sources[index].shotId || typeof selected.filename !== 'string') throw fail('REPAIR_AUDIO_INVALID');
    const audio = await localFile(resolve(buildRoot, selected.filename), buildRoot);
    if (audio.sha256 !== selected.sha256 || audio.sizeBytes !== selected.sizeBytes) throw fail('REPAIR_AUDIO_CHANGED');
  }
  const preview = await localFile(join(buildRoot, 'preview.mp4'), buildRoot);
  if (preview.sha256 !== build.preview.sha256 || preview.sizeBytes !== build.preview.sizeBytes) throw fail('REPAIR_PREVIEW_CHANGED');
  const ownerHash = digest(current.email), prefix = `production/repair-previews/${ownerHash}/${snapshot.preparedId}/`;
  const pathname = `${prefix}${preview.sha256}.mp4`, metadataPath = `${prefix}current.json`;
  const before = await read(metadataPath);
  const local = await readFile(preview.path);
  if (digest(local) !== preview.sha256) throw fail('REPAIR_PREVIEW_CHANGED');
  try { await putBlob(pathname, local, { access: 'private', addRandomSuffix: false, allowOverwrite: false,
    contentType: 'video/mp4', cacheControlMaxAge: 60 }); } catch { /* Only exact private readback confirms an immutable upload. */ }
  const stored = await getBlob(pathname, { access: 'private', useCache: false });
  if (!stored?.stream || stored.blob?.pathname !== pathname || stored.blob.size !== preview.sizeBytes || stored.blob.contentType !== 'video/mp4') {
    await stored?.stream?.cancel().catch(() => {}); throw fail('REPAIR_PREVIEW_UPLOAD_UNCONFIRMED');
  }
  const reader = stored.stream.getReader(), checksum = createHash('sha256'); let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length;
      if (length > preview.sizeBytes) throw fail('REPAIR_PREVIEW_UPLOAD_UNCONFIRMED');
      checksum.update(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (length !== preview.sizeBytes || checksum.digest('hex') !== preview.sha256) throw fail('REPAIR_PREVIEW_UPLOAD_UNCONFIRMED');
  const fresh = await context(snapshot, { read, now }); assertSnapshot(snapshot, fresh, now());
  if (fresh.queue.etag !== snapshot.queueEtag) throw fail('REPAIR_QUEUE_CHANGED');
  const metadata = { kind: 'soundtrack-repair-preview-v1', version: 1, preview: true, ownerHash,
    preparedId: snapshot.preparedId, orderId: snapshot.orderId, filmId: fresh.job.value.filmId, manifestHash: snapshot.manifestHash,
    jobRevision: fresh.job.value.revision, jobHash: hash(fresh.job.value), jobEtag: fresh.job.etag, orderEtag: fresh.order.etag,
    snapshotSha256, buildSha256, sha256: preview.sha256, sizeBytes: preview.sizeBytes, contentType: 'video/mp4',
    durationSeconds: build.preview.durationSeconds, pathname, createdAt: new Date(now()).toISOString() };
  await write(metadataPath, metadata, before?.etag);
  if (!same((await read(metadataPath))?.value, metadata)) throw fail('REPAIR_PREVIEW_RECORD_UNCONFIRMED');
  return { state: 'preview-published', preparedId: snapshot.preparedId, sha256: preview.sha256,
    mediaUrl: `/api/studio?action=productionRepairPreview&id=${snapshot.preparedId}&artifact=${preview.sha256}`,
    completed: false, providerSubmissions: 0 };
}

export async function applyPaidFilmSoundtrackRepair({ snapshotPath, snapshotSha256, buildPath, buildSha256, reviewedPreviewSha256,
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg' }, dependencies = {}) {
  const read = dependencies.read || readRecord, write = dependencies.write || writeRecord, now = dependencies.now || Date.now;
  const snapshotFile = resolve(snapshotPath), root = dirname(snapshotFile);
  const snapshot = await readJsonSnapshot(snapshotFile, snapshotSha256);
  const current = await context(snapshot, { read, now });
  assertSnapshot(snapshot, current, now());
  if (current.queue.etag !== snapshot.queueEtag || !same(current.queue.value, snapshot.originalQueue)
    || current.queue.value.lease?.expiresAt > now()) throw fail('REPAIR_QUEUE_CHANGED');
  await validateLocalSources(snapshot, root);
  const build = await readJsonSnapshot(buildPath, buildSha256), buildRoot = dirname(resolve(buildPath));
  if (build.kind !== KIND || build.version !== 1 || build.state !== 'preview-ready' || build.snapshotSha256 !== snapshotSha256
    || build.orderId !== snapshot.orderId || build.preparedId !== snapshot.preparedId || build.manifestHash !== snapshot.manifestHash
    || !same(build.sources, snapshot.sources) || build.speechReview?.passed !== true || !HASH.test(reviewedPreviewSha256 || '')
    || build.preview?.sha256 !== reviewedPreviewSha256 || !Array.isArray(build.selectedAudio) || build.selectedAudio.length !== snapshot.sources.length)
    throw fail('REPAIR_PREVIEW_UNCONFIRMED');
  const preview = await localFile(join(buildRoot, 'preview.mp4'), buildRoot);
  if (preview.sha256 !== reviewedPreviewSha256 || preview.sizeBytes !== build.preview.sizeBytes) throw fail('REPAIR_PREVIEW_CHANGED');
  for (const [index, selected] of build.selectedAudio.entries()) {
    if (selected.shotId !== snapshot.sources[index].shotId || typeof selected.filename !== 'string') throw fail('REPAIR_AUDIO_INVALID');
    const audio = await localFile(resolve(buildRoot, selected.filename), buildRoot);
    if (audio.sha256 !== selected.sha256 || audio.sizeBytes !== selected.sizeBytes) throw fail('REPAIR_AUDIO_CHANGED');
  }
  const operationPath = `production/soundtrack-repairs/${snapshot.orderId}/${snapshotSha256}.json`;
  if (await read(operationPath)) throw fail('REPAIR_ALREADY_ATTEMPTED');
  const token = randomUUID();
  // Preserve attention state so ordinary workers cannot race into the original
  // soundtrack. Only this exact operator recovery owns this renewable lease.
  await write(current.queuePath, { ...current.queue.value, lease: { token, expiresAt: now() + LEASE_MS },
    soundtrackRepair: { snapshotSha256, startedAt: new Date(now()).toISOString() } }, current.queue.etag);
  let renewal = Promise.resolve(), lost = false, artifact, selectedAudio, originalAudio;
  const provenance = build.provenance;
  async function owns() {
    const queue = await read(current.queuePath);
    if (lost || queue?.value.lease?.token !== token || queue.value.lease.expiresAt <= now()
      || queue.value.state !== 'attention' || queue.value.soundtrackRepair?.snapshotSha256 !== snapshotSha256) return false;
    const fresh = await context(snapshot, { read, now });
    assertSnapshot(snapshot, fresh, now());
    return true;
  }
  async function renew() {
    if (!await owns()) { lost = true; return; }
    const queue = await read(current.queuePath);
    if (queue?.value.lease?.token !== token || queue.value.lease.expiresAt <= now()) { lost = true; return; }
    await write(current.queuePath, { ...queue.value, lease: { token, expiresAt: now() + LEASE_MS } }, queue.etag);
  }
  const timer = setInterval(() => { renewal = renewal.then(renew).catch(() => { lost = true; }); }, 30_000);
  timer.unref?.();
  async function saveReceipt(state, extra = {}) {
    const previous = await read(operationPath);
    if (previous && (previous.value.snapshotSha256 !== snapshotSha256 || previous.value.leaseToken !== token)) throw fail('REPAIR_RECEIPT_CHANGED');
    await write(operationPath, { kind: KIND, version: 1, state, owner: OWNER_EMAIL, email: snapshot.email,
      orderId: snapshot.orderId, preparedId: snapshot.preparedId, manifestHash: snapshot.manifestHash, snapshotSha256,
      leaseToken: token, originalJob: snapshot.originalJob, originalQueue: snapshot.originalQueue, sources: snapshot.sources,
      buildSha256, reviewedPreviewSha256, updatedAt: new Date(now()).toISOString(), ...extra }, previous?.etag);
  }
  async function finishQueue(completed) {
    clearInterval(timer); await renewal;
    const queue = await read(current.queuePath);
    if (queue?.value.lease?.token !== token || queue.value.lease.expiresAt <= now()) throw fail('REPAIR_LEASE_LOST');
    const { lease, ...value } = queue.value;
    await write(current.queuePath, { ...value, state: completed ? 'completed' : 'attention', updatedAt: new Date(now()).toISOString(),
      lastResult: completed ? 'COMPLETED' : 'REVIEW_REQUIRED', ...(completed ? { lastFailure: null } : {}),
      soundtrackRepair: { ...value.soundtrackRepair, state: completed ? 'completed' : 'attention' } }, queue.etag);
  }
  try {
    if (!await owns()) throw fail('REPAIR_LEASE_LOST');
    await saveReceipt('running');
    const prepareClips = async ({ job, clips, work }) => {
      if (!same(job, snapshot.originalJob) || !await owns()) throw fail('REPAIR_JOB_CHANGED');
      const originals = await Promise.all(clips.map(clip => localFile(clip.path, work)));
      for (const [index, clip] of clips.entries()) if (clip.shotId !== snapshot.sources[index].shotId
        || originals[index].sha256 !== snapshot.sources[index].sha256) throw fail('REPAIR_SOURCE_CHANGED');
      originalAudio = new Set(clips.map(clip => clip.audioPath || clip.path));
      const originalAudioHashes = new Set(await Promise.all(clips.map(async clip => (await localFile(clip.audioPath || clip.path, work)).sha256)));
      for (const [index, clip] of clips.entries()) {
        const selected = build.selectedAudio[index], audioPath = join(work, `replacement-${index + 1}.wav`);
        const original = await localFile(resolve(buildRoot, selected.filename), buildRoot);
        if (original.sha256 !== selected.sha256 || original.sizeBytes !== selected.sizeBytes) throw fail('REPAIR_AUDIO_CHANGED');
        await copyFile(original.path, audioPath);
        clip.audioPath = audioPath;
        const visual = await localFile(clip.path, work), audio = await localFile(clip.audioPath, work);
        if (visual.sha256 !== originals[index].sha256 || audio.sha256 !== selected.sha256 || originalAudioHashes.has(audio.sha256))
          throw fail('REPAIR_SOURCE_CHANGED');
      }
    };
    const reviewSpeech = async input => {
      if (input.clips.some(clip => !clip.audioPath || originalAudio.has(clip.audioPath))) throw fail('REPAIR_SELECTED_AUDIO_INVALID');
      // This is the ordinary recognizer on the selected replacement track.
      // A synthesis receipt never substitutes for its real script comparison.
      const reviewed = await reviewFilmSpeech({ ...input,
        transcribe: repairTranscriber(dirname(input.clips[0].path), { now, receiptRoot: buildRoot }) });
      selectedAudio = await Promise.all(input.clips.map(async clip => {
        const audio = await localFile(clip.audioPath, dirname(clip.path));
        const visual = await localFile(clip.path, dirname(clip.path));
        const expected = snapshot.sources.find(source => source.shotId === clip.shotId);
        const selected = build.selectedAudio.find(source => source.shotId === clip.shotId);
        if (visual.sha256 !== expected?.sha256 || originalAudio.has(clip.audioPath) || audio.sha256 !== selected?.sha256)
          throw fail('REPAIR_REVIEWED_AUDIO_CHANGED');
        return { shotId: clip.shotId, sha256: audio.sha256, sizeBytes: audio.sizeBytes };
      }));
      return reviewed;
    };
    const assemble = async input => {
      const report = await assembleFilm(input);
      // Publication must use exactly the video inspected in the private
      // preview. Any encoding difference stops before the private upload.
      if (report.sha256 !== reviewedPreviewSha256) throw fail('REPAIR_REVIEWED_PREVIEW_CHANGED');
      return report;
    };
    const assembly = createWorkerAssembly({ ...dependencies, adapter: falProductionAdapter, ffmpeg, prepareClips, reviewSpeech, assemble });
    artifact = await assembly({ email: current.email, id: snapshot.preparedId, job: current.job.value, stillOwned: owns });
    if (!artifact?.speechReview?.passed || artifact.sha256 !== reviewedPreviewSha256
      || selectedAudio?.length !== snapshot.sources.length || !await owns()) throw fail('REPAIR_SPEECH_UNVERIFIED');
    await saveReceipt('verified-artifact', { provenance, selectedAudio, artifact });
    const film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now,
      verifyAssembledMedia: value => verifyPublishedFilm(value, dependencies) });
    await film.acceptAssembly({ email: current.email, id: snapshot.preparedId, manifestHash: snapshot.manifestHash, artifact, stillOwned: owns });
    const completed = await read(current.jobPath);
    if (completed?.value.status !== 'completed' || completed.value.media?.sha256 !== artifact.sha256
      || completed.value.manifestHash !== snapshot.manifestHash) throw fail('REPAIR_COMPLETION_UNCONFIRMED');
    await finishQueue(true);
    await saveReceipt('completed', { provenance, selectedAudio, artifact, completedJobRevision: completed.value.revision });
    return { state: 'completed', preparedId: snapshot.preparedId, manifestHash: snapshot.manifestHash, sha256: artifact.sha256,
      durationSeconds: artifact.durationSeconds, sourceCount: snapshot.sources.length, providerSubmissions: 0 };
  } catch (error) {
    clearInterval(timer); await renewal;
    const completed = await read(current.jobPath).catch(() => null);
    const delivered = Boolean(artifact && completed?.value.status === 'completed' && completed.value.media?.sha256 === artifact.sha256);
    await finishQueue(delivered).catch(() => {});
    await saveReceipt(delivered ? 'completed-receipt-needs-review' : 'attention', { ...(selectedAudio ? { selectedAudio } : {}),
      ...(artifact ? { artifact } : {}), reason: 'SOUNDTRACK_RECOVERY_UNCONFIRMED' }).catch(() => {});
    throw error;
  } finally { clearInterval(timer); await renewal; }
}

async function main() {
  const [action, ...args] = process.argv.slice(2), parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1] || Object.hasOwn(parsed, args[index])) throw fail('REPAIR_ARGUMENTS_INVALID');
    parsed[args[index]] = args[index + 1];
  }
  let result;
  if (action === 'prepare' && Object.keys(parsed).length === 4 && ['--order-id', '--prepared-id', '--manifest-hash', '--output-dir'].every(key => parsed[key]))
    result = await preparePaidFilmSoundtrackRepair({ orderId: parsed['--order-id'], preparedId: parsed['--prepared-id'], manifestHash: parsed['--manifest-hash'], outputDir: parsed['--output-dir'] });
  else if (action === 'build' && Object.keys(parsed).length === 4 && ['--snapshot', '--snapshot-sha256', '--voices', '--output-dir'].every(key => parsed[key]))
    result = await buildPaidFilmSoundtrackRepair({ snapshotPath: parsed['--snapshot'], snapshotSha256: parsed['--snapshot-sha256'],
      voices: JSON.parse(await readFile(resolve(parsed['--voices']), 'utf8')), outputDir: parsed['--output-dir'] });
  else if (action === 'review-built' && Object.keys(parsed).length === 5 && ['--snapshot', '--snapshot-sha256', '--constructed', '--constructed-sha256', '--output-dir'].every(key => parsed[key]))
    result = await reviewConstructedFilmSoundtrack({ snapshotPath: parsed['--snapshot'], snapshotSha256: parsed['--snapshot-sha256'],
      constructedPath: parsed['--constructed'], constructedSha256: parsed['--constructed-sha256'], outputDir: parsed['--output-dir'] });
  else if (action === 'publish-preview' && Object.keys(parsed).length === 4 && ['--snapshot', '--snapshot-sha256', '--build', '--build-sha256'].every(key => parsed[key]))
    result = await publishPaidFilmSoundtrackPreview({ snapshotPath: parsed['--snapshot'], snapshotSha256: parsed['--snapshot-sha256'],
      buildPath: parsed['--build'], buildSha256: parsed['--build-sha256'] });
  else if (action === 'apply' && Object.keys(parsed).length === 5 && ['--snapshot', '--snapshot-sha256', '--build', '--build-sha256', '--reviewed-preview-sha256'].every(key => parsed[key]))
    result = await applyPaidFilmSoundtrackRepair({ snapshotPath: parsed['--snapshot'], snapshotSha256: parsed['--snapshot-sha256'],
      buildPath: parsed['--build'], buildSha256: parsed['--build-sha256'], reviewedPreviewSha256: parsed['--reviewed-preview-sha256'] });
  else throw fail('REPAIR_ARGUMENTS_INVALID');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  const failure = finishingFailure(error), recovery = error?.repairRecovery;
  const reason = error?.code === 'SOUNDTRACK_REBUILD_REQUIRED' && /^[A-Z_]{1,80}$/.test(error?.reason || '') ? error.reason : null;
  process.stderr.write(`${JSON.stringify({ state: 'not-confirmed', code: /^REPAIR_[A-Z_]+$/.test(error?.code || '') ? error.code : 'REPAIR_FAILED',
    ...(failure ? { failure } : {}), ...(reason ? { reason } : {}),
    ...(typeof recovery?.constructedPath === 'string' && HASH.test(recovery.constructedSha256 || '') ? { recovery } : {}) })}\n`);
  process.exitCode = 1;
});
