// Run on a durable Node/FFmpeg host, never inside a request-limited API handler.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get, put } from "@vercel/blob";
import { digest, readRecord, writeRecord } from "../api/_lib/auth.mjs";
import { createFilmProductionService, validateProviderOutput, validateProviderAudio, unavailableMagicLightAdapter } from "../api/_lib/film-production.mjs";
import { verifiedMediaProfile } from "../api/_lib/media-profile.mjs";
import { createProductionQueue } from "../api/_lib/production-queue.mjs";
import { createPaymentsService } from "../api/_lib/payments.mjs";
import { createHostedCheckoutService } from "../api/_lib/hosted-checkout.mjs";
import { assembleFilm } from "./assemble-film.mjs";
import { falProductionAdapter } from "../api/_lib/fal-production.mjs";
import { createRemoteProductionAuthorization } from "../api/_lib/remote-production-authorization.mjs";
import { reviewFilmSpeech } from './review-film-speech.mjs';
import { finishingFailure, markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { createAutomaticSoundtrackFallback } from './automatic-film-soundtrack.mjs';

const MAX_BYTES = 250 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const workerTempRoot = process.env.LINEAGE_WORKER_TEMP_ROOT || join(tmpdir(), "lineage-production-worker");
const markerName = ".lineage-worker.json";
const finishingError = (message, reason) => markFinishingFailure(new Error(message), null, reason);
function processRunning(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }
export async function cleanStaleWorkerDirectories(rootValue = workerTempRoot, { now = Date.now(), isRunning = processRunning } = {}) {
  const root = resolve(rootValue);
  await mkdir(root, { recursive: true });
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^lineage-worker-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (dirname(path) !== root) continue;
    try {
      const markerPath = join(path, markerName);
      if ((await stat(markerPath)).size > 2048) continue;
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker.kind !== "lineage-film-worker-v1" || marker.host !== hostname() || !Number.isSafeInteger(marker.pid) || marker.pid < 1
        || !Number.isFinite(marker.createdAt) || now - marker.createdAt < 3600_000 || isRunning(marker.pid)) continue;
      await rm(path, { recursive: true, force: true }); removed++;
    } catch { /* Never delete an unrecognized or unreadable directory. */ }
  }
  return removed;
}
async function boundedBytes(stream, expected) {
  if (!stream || !Number.isSafeInteger(expected) || expected < 16 || expected > MAX_BYTES) throw finishingError("Invalid media size.", "MEDIA_SIZE_INVALID");
  const reader = stream.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > expected) throw finishingError("Media size changed.", "MEDIA_SIZE_CHANGED");
      chunks.push(next.value);
    }
    if (length !== expected) throw finishingError("Media download was incomplete.", "MEDIA_DOWNLOAD_INCOMPLETE");
    return Buffer.concat(chunks, length);
  } finally { await reader.cancel().catch(() => {}); }
}

async function downloadProductionMedia(verified, fetchImpl) {
  const response = await fetchImpl(verified.url, { redirect: "error", credentials: "omit", cache: "no-store",
    headers: { Accept: verified.contentType }, signal: AbortSignal.timeout(120_000) });
  const contentType = response.headers.get("content-type")?.split(";")[0];
  const length = response.headers.get("content-length");
  if (response.status !== 200 || contentType !== verified.contentType || (length !== null && Number(length) !== verified.sizeBytes)) {
    await response.body?.cancel(); throw finishingError("The provider clip could not be verified.", "MEDIA_RESPONSE_INVALID");
  }
  return boundedBytes(response.body, verified.sizeBytes);
}
export async function downloadProductionClip(output, allowedHosts, { fetchImpl = fetch } = {}) {
  return downloadProductionMedia(validateProviderOutput(output, allowedHosts), fetchImpl);
}
export async function downloadProductionAudio(output, allowedHosts, { fetchImpl = fetch } = {}) {
  return downloadProductionMedia(validateProviderAudio(output, allowedHosts), fetchImpl);
}

export async function verifyPublishedFilm({ email, id, manifestHash, artifact, manifest }, { getBlob = get } = {}) {
  try {
  verifiedMediaProfile(artifact);
  if (!artifact || artifact.technicalSample !== false || artifact.playable !== true || artifact.hasAudio !== true
    || artifact.manifestHash !== manifestHash || !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")
    || artifact.pathname !== `production/media/${digest(email)}/${id}/${artifact.sha256}.mp4`
    || artifact.contentType !== "video/mp4" || !Number.isFinite(artifact.durationSeconds)
    || Math.abs(artifact.durationSeconds - manifest.targetDurationSeconds) > 1) throw finishingError("The assembled artifact is invalid.", "STORED_ARTIFACT_INVALID");
  const stored = await getBlob(artifact.pathname, { access: "private", useCache: false });
  if (!stored?.stream) throw finishingError("The private film has not been stored.", "STORED_MEDIA_MISSING");
  if (stored.blob.size !== artifact.sizeBytes || stored.blob.contentType !== "video/mp4") {
    await stored.stream.cancel(); throw finishingError("The stored film changed.", "STORED_MEDIA_CHANGED");
  }
  const bytes = await boundedBytes(stored.stream, artifact.sizeBytes);
  if (sha256(bytes) !== artifact.sha256) throw finishingError("The private film checksum does not match.", "STORED_CHECKSUM_MISMATCH");
  return { ...artifact, playable: true };
  } catch (error) { throw markFinishingFailure(error, 'stored-verification'); }
}

export function createWorkerAssembly({ adapter = unavailableMagicLightAdapter, fetchImpl = fetch, putBlob = put,
  assemble = assembleFilm, reviewSpeech = reviewFilmSpeech, prepareClips, soundtrackFallback,
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", tempRoot = workerTempRoot } = {}) {
  return async ({ email, id, job, stillOwned }) => {
    let stage = 'assembly';
    try {
    if (job.status !== "awaiting-assembly" || job.shots.length !== job.manifest.shots.length
      || job.shots.some(shot => shot.status !== "completed") || adapter.available !== true) throw finishingError("The film is not ready for assembly.", "ASSEMBLY_NOT_READY");
    const root = resolve(tempRoot);
    await mkdir(root, { recursive: true });
    const work = await mkdtemp(join(root, "lineage-worker-"));
    try {
      await writeFile(join(work, markerName), JSON.stringify({ kind: "lineage-film-worker-v1", pid: process.pid, host: hostname(), createdAt: Date.now() }), { flag: "wx" });
      const clips = [];
      stage = 'download';
      for (const [index, shot] of job.shots.entries()) {
        if (!await stillOwned()) throw finishingError("The worker claim expired.", "WORKER_CLAIM_EXPIRED");
        const bytes = await downloadProductionClip(shot.output, adapter.outputHosts, { fetchImpl });
        const path = join(work, `clip-${index}.${shot.output.contentType === "video/mp4" ? "mp4" : "webm"}`);
        await writeFile(path, bytes, { flag: "wx" });
        const clip = { shotId: shot.id, path };
        if (shot.output.audio !== undefined) {
          if (!await stillOwned()) throw finishingError("The worker claim expired.", "WORKER_CLAIM_EXPIRED");
          const audio = validateProviderAudio(shot.output.audio, adapter.outputHosts);
          const extension = { "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/webm": "webm" }[audio.contentType];
          const audioBytes = await downloadProductionAudio(audio, adapter.outputHosts, { fetchImpl });
          clip.audioPath = join(work, `audio-${index}.${extension}`);
          await writeFile(clip.audioPath, audioBytes, { flag: "wx" });
        }
        clips.push(clip);
      }
      const outputPath = join(work, "film.mp4");
      stage = 'speech-review';
      // Only an explicitly configured operator repair supplies this hook. The
      // ordinary worker reviews native audio before considering local fallback.
      if (prepareClips !== undefined) {
        if (typeof prepareClips !== 'function' || !await stillOwned()) throw finishingError("The worker claim expired.", "WORKER_CLAIM_EXPIRED");
        await prepareClips({ email, id, job, clips, work, ffmpeg, stillOwned });
        if (!await stillOwned()) throw finishingError("The worker claim expired.", "WORKER_CLAIM_EXPIRED");
      }
      let speechReview = null;
      if (adapter.id === 'fal') {
        const nativeClips = clips.map(clip => ({ ...clip }));
        try {
          speechReview = await reviewSpeech({ manifest: job.manifest, clips: nativeClips, ffmpeg });
          for (const [index, clip] of nativeClips.entries()) if (clip.audioPath) clips[index].audioPath = clip.audioPath;
        }
        catch (error) {
          // The operator repair has its own reviewed soundtrack path. Normal
          // fallback is confined to a completed paid film with mismatched speech.
          if (prepareClips !== undefined || typeof soundtrackFallback !== 'function'
            || finishingFailure(error)?.reason !== 'SPEECH_SCRIPT_MISMATCH') throw error;
          // Earlier scenes may have produced reviewed native-audio files before
          // a later mismatch. Remove only those exact outputs from this run so
          // authored review can use its normal exclusive output filenames.
          for (const [index, clip] of nativeClips.entries()) {
            const generated = resolve(work, `${clip.shotId}-reviewed.wav`);
            if (clip.audioPath !== clips[index].audioPath && typeof clip.audioPath === 'string'
              && resolve(clip.audioPath) === generated && dirname(generated) === resolve(work)) await rm(generated, { force: true });
          }
          speechReview = await soundtrackFallback({ email, id, job, clips, work, ffmpeg, stillOwned });
        }
      }
      if(adapter.id==='fal'&&speechReview?.passed!==true)throw finishingError('Film narration was not verified.', 'SPEECH_REVIEW_REQUIRED');
      stage = 'assembly';
      const report = await assemble({ manifest: job.manifest, manifestHash: job.manifestHash, clips, outputPath, ffmpeg, technicalSample: false });
      verifiedMediaProfile(report);
      const bytes = await readFile(outputPath);
      if (bytes.length > MAX_BYTES || report.sizeBytes !== bytes.length || report.sha256 !== sha256(bytes)
        || report.manifestHash !== job.manifestHash || !Number.isFinite(report.durationSeconds)
        || Math.abs(report.durationSeconds - job.manifest.targetDurationSeconds) > 1
        || report.hasAudio !== true || report.playable !== true || report.technicalSample !== false) throw finishingError("Assembly verification failed.", "ASSEMBLY_REPORT_INVALID");
      if (!await stillOwned()) throw finishingError("The worker claim expired.", "WORKER_CLAIM_EXPIRED");
      const pathname = `production/media/${digest(email)}/${id}/${report.sha256}.mp4`;
      // Immutable, content-addressed publication: retrying a lost response never
      // overwrites a different film. Readback verifies both new and prior writes.
      stage = 'private-upload';
      try {
        await putBlob(pathname, bytes, { access: "private", addRandomSuffix: false, allowOverwrite: false,
          contentType: "video/mp4", cacheControlMaxAge: 60 });
      } catch { /* A complete matching private readback is the only success signal. */ }
      const artifact = { ...report, pathname, ...(speechReview?{speechReview}:{}) };
      // acceptAssembly verifies the private readback before marking completion,
      // including a lost upload response. Avoid downloading the same film twice.
      // Retain captions privately; failed caption publication cannot claim success.
      const captions = await readFile(`${outputPath}.vtt`);
      const captionPath = pathname.replace(/\.mp4$/, ".vtt");
      try { await putBlob(captionPath, captions, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "text/vtt" }); }
      catch { /* A duplicate immutable caption object is harmless; film delivery is independent. */ }
      return artifact;
    } finally {
      // Delete only this invocation's newly created directory under the chosen root.
      if (dirname(resolve(work)) === root && basename(work).startsWith("lineage-worker-")) await rm(work, { recursive: true, force: true });
    }
    } catch (error) { throw markFinishingFailure(error, stage); }
  };
}

export function createProductionWorker({ adapter = falProductionAdapter, paymentService, ...dependencies } = {}) {
  const read = dependencies.read || dependencies.readRecordImpl;
  const write = dependencies.write || dependencies.writeRecordImpl;
  // Quotes and generation must use this worker's same configured adapter. A
  // callback to the web singleton could otherwise quote a different provider.
  let film;
  const productionQuote = input => film.quoteForProductionBudget(input);
  const hosted = dependencies.hostedCheckout || createHostedCheckoutService({ ...dependencies, read, write, productionQuote });
  const authorizer = paymentService || (process.env.LINEAGE_WORKER_SECRET
    ? createRemoteProductionAuthorization({ adapter })
    : createPaymentsService({ ...dependencies, read, write, hostedCheckout: hosted, productionQuote }));
  film = createFilmProductionService({ ...dependencies, adapter,
    readRecordImpl: read,
    writeRecordImpl: write,
    authorize: ({ email, id, manifestHash, authorizationReference }) => authorizer.authorizeProduction({ email, preparedId: id, manifestHash, orderId: authorizationReference }),
    verifyAssembledMedia: value => verifyPublishedFilm(value, dependencies) });
  const queue = createProductionQueue({ ...dependencies, read, write, film, paymentService: authorizer });
  const soundtrackFallback = dependencies.soundtrackFallback ?? createAutomaticSoundtrackFallback({ ...dependencies, read, write });
  const assemble = createWorkerAssembly({ ...dependencies, adapter, soundtrackFallback });
  return { runBatch: options => queue.runBatch({ ...options, assemble }), readiness: film.readiness };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--once", "--check"].includes(arg)) || args.length !== 1)
    throw new Error("Usage: node scripts/production-worker.mjs --check | --once");
  const worker = createProductionWorker();
  const readiness = worker.readiness();
  if (args[0] === "--check") {
    process.stdout.write(`${JSON.stringify({ available: readiness.available, provider: readiness.adapter,
      storageConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN), gaps: readiness.gaps })}\n`);
    return;
  }
  if (!readiness.available || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Worker is not configured: connect the documented provider and private storage before processing jobs.");
  await cleanStaleWorkerDirectories();
  const healthPath='production/worker-health.json';
  const heartbeat=async()=>{
    const old=await readRecord(healthPath);
    await writeRecord(healthPath,{version:1,ready:true,model:falProductionAdapter.model,recipe:falProductionAdapter.modelVersion,checkedAt:new Date().toISOString()},old?.etag);
  };
  await heartbeat();
  const pulse=setInterval(()=>void heartbeat().catch(()=>{}),30000);pulse.unref();
  let cursor;
  try { do {
    const result = await worker.runBatch({ cursor, limit: 20 });
    cursor = result.cursor;
    process.stdout.write(`${JSON.stringify({ completed: result.completed, pending: result.pending, attention: result.attention, skipped: result.skipped })}\n`);
  } while (cursor); } finally {clearInterval(pulse);}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Production worker could not run. Check provider activation, private storage, and worker configuration. No automatic charge or submission retry was performed.\n"); process.exitCode = 1; });
}
