// Blob-only owner-pilot delivery worker. It never submits a provider job, calls
// Accounting, approves story content, or changes the original paid plan.
import { randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get, put, list } from "@vercel/blob";
import { digest, readRecord, writeRecord, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL, isOwner, accessStatusForUser } from "../api/_lib/access.mjs";
import { requireFinishedFilmPayment } from "../api/_lib/production-media.mjs";
import { verifiedMediaProfile } from "../api/_lib/media-profile.mjs";
import { verifyFilmMedia } from "./assemble-film.mjs";

const PREFIX = "production/generation-attempts/";
const CURSOR = "production/generation-delivery-worker.json";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const TASK = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BYTES = 250 * 1024 * 1024;
const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const codes = new Set(["DELIVERY_CHANGED", "DELIVERY_ACCESS_REQUIRED", "DELIVERY_PAYMENT_REQUIRED", "DELIVERY_SOURCE_UNAPPROVED",
  "DELIVERY_DOWNLOAD_FAILED", "DELIVERY_MEDIA_INVALID", "DELIVERY_STORAGE_FAILED", "DELIVERY_LEASE_LOST"]);
const failure = code => Object.assign(new Error(codes.has(code) ? code : "DELIVERY_STORAGE_FAILED"), { code });
const safeCode = error => codes.has(error?.code) ? error.code : "DELIVERY_STORAGE_FAILED";
const hashBytes = value => createHash("sha256").update(value).digest("hex");

export function generationDeliveryPath(email, id) {
  if (email !== OWNER_EMAIL || !UUID.test(id || "")) throw failure("DELIVERY_ACCESS_REQUIRED");
  return `production/generation-delivery/${digest(email)}/${id}.json`;
}
export function generationDeliveryBinding(attempt) {
  if (!plain(attempt) || attempt.version !== 1 || attempt.ownerEmail !== OWNER_EMAIL || !UUID.test(attempt.id || "")
    || !UUID.test(attempt.filmId || "") || !UUID.test(attempt.changeId || "") || !HASH.test(attempt.manifestHash || "")
    || !HASH.test(attempt.orderId || "") || !HASH.test(attempt.promptHash || "") || !HASH.test(attempt.keyFingerprint || "")
    || !TASK.test(attempt.taskId || "") || attempt.submissionCount !== 1 || attempt.status !== "verifying"
    || !date(attempt.submittedAt) || typeof attempt.outputUrl !== "string" || !attempt.outputUrl)
    throw failure("DELIVERY_CHANGED");
  return { id: attempt.id, ownerEmail: attempt.ownerEmail, filmId: attempt.filmId, manifestHash: attempt.manifestHash,
    orderId: attempt.orderId, taskHash: digest(attempt.taskId), sourceHash: digest(attempt.outputUrl),
    submittedAt: attempt.submittedAt, promptHash: attempt.promptHash };
}
export function generationAttemptAuthorization(binding) {
  return { environment: "production", manifestHash: binding.manifestHash, kind: "owner-generation-attempt",
    orderId: binding.orderId, attemptId: binding.id, taskHash: binding.taskHash, sourceHash: binding.sourceHash,
    authorizedAt: binding.submittedAt };
}
function sameBinding(value, binding) {
  return plain(value) && Object.entries(binding).every(([key, expected]) => value[key] === expected);
}
function validHost(host) {
  return typeof host === "string" && host.length <= 253 && host === host.toLowerCase() && !isIP(host)
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host);
}
export function generationOutputHosts(value) {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string" || value.length > 2048) throw failure("DELIVERY_SOURCE_UNAPPROVED");
  const hosts = value.split(",").map(host => host.trim());
  if (!hosts.length || hosts.length > 8 || hosts.some(host => !validHost(host)) || new Set(hosts).size !== hosts.length)
    throw failure("DELIVERY_SOURCE_UNAPPROVED");
  return hosts;
}
export function generationMediaSource(value, hosts) {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\#\x00-\x1f\x7f]/.test(value)
    || !Array.isArray(hosts) || !hosts.length || hosts.length > 8 || hosts.some(host => !validHost(host)))
    throw failure("DELIVERY_SOURCE_UNAPPROVED");
  let url;
  try { url = new URL(value); } catch { throw failure("DELIVERY_SOURCE_UNAPPROVED"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.href !== value || !hosts.includes(url.hostname))
    throw failure("DELIVERY_SOURCE_UNAPPROVED");
  return value;
}
export function validateGenerationDeliveryArtifact(artifact, binding, manifest) {
  try { verifiedMediaProfile(artifact); } catch { throw failure("DELIVERY_MEDIA_INVALID"); }
  if (!plain(artifact) || artifact.manifestHash !== binding.manifestHash || artifact.contentType !== "video/mp4"
    || !HASH.test(artifact.sha256 || "") || artifact.pathname !== `production/media/${digest(binding.ownerEmail)}/${binding.id}/${artifact.sha256}.mp4`
    || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 16 || artifact.sizeBytes > MAX_BYTES
    || !Number.isFinite(artifact.durationSeconds) || artifact.durationSeconds <= 0 || artifact.durationSeconds > 600
    || !Number.isFinite(manifest?.targetDurationSeconds) || Math.abs(artifact.durationSeconds - manifest.targetDurationSeconds) > 1
    || artifact.hasAudio !== true || artifact.playable !== true || artifact.technicalSample !== false
    || artifact.contentReviewed !== false || artifact.verification !== "full-video-and-audio-decode") throw failure("DELIVERY_MEDIA_INVALID");
  return artifact;
}
async function deadline(ms, operation) {
  const abort = new AbortController();
  let timer;
  try {
    return await Promise.race([operation(abort.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(failure("DELIVERY_STORAGE_FAILED")); }, ms);
    })]);
  } finally { clearTimeout(timer); abort.abort(); }
}
async function verifyStoredBytes(getBlob, artifact, signal) {
  let result, reader;
  const cancel = () => { try { void reader?.cancel().catch(() => {}); } catch { /* Only fixed worker codes are exposed. */ } };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    result = await getBlob(artifact.pathname, { access: "private", useCache: false, abortSignal: signal,
      headers: { "accept-encoding": "identity" } });
    if (signal.aborted || !result?.stream || result.blob?.pathname !== artifact.pathname || result.blob?.size !== artifact.sizeBytes
      || result.blob?.contentType !== "video/mp4") throw failure("DELIVERY_STORAGE_FAILED");
    reader = result.stream.getReader();
    let count = 0;
    const hash = createHash("sha256");
    for (;;) {
      if (signal.aborted) throw failure("DELIVERY_STORAGE_FAILED");
      const next = await reader.read();
      if (signal.aborted) throw failure("DELIVERY_STORAGE_FAILED");
      if (next.done) break;
      count += next.value.byteLength;
      if (count > artifact.sizeBytes) throw failure("DELIVERY_STORAGE_FAILED");
      hash.update(next.value);
    }
    if (count !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256) throw failure("DELIVERY_STORAGE_FAILED");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await result?.stream?.cancel().catch(() => {});
  }
}

export function createPaidFilmDeliveryWorker({ read = readRecord, write = writeRecord, listBlobs = list, getBlob = get, putBlob = put,
  fetchImpl = fetch, verifyMedia = verifyFilmMedia, now = Date.now, ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  allowedHosts = generationOutputHosts(process.env.LINEAGE_GENERATION_OUTPUT_HOSTS),
  tempRoot = join(tmpdir(), "lineage-paid-delivery"), downloadTimeoutMs = 120_000, storageTimeoutMs = 120_000,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  for (const ms of [downloadTimeoutMs, storageTimeoutMs]) if (!Number.isSafeInteger(ms) || ms < 1 || ms > 300_000) throw failure("DELIVERY_STORAGE_FAILED");
  const configured = Array.isArray(allowedHosts) && allowedHosts.length > 0 && allowedHosts.length <= 8 && allowedHosts.every(validHost);
  async function stored(path) { try { return await read(path); } catch { throw failure("DELIVERY_STORAGE_FAILED"); } }
  async function save(path, previous, value) {
    const next = { ...value, changeId: randomUUID(), updatedAt: new Date(now()).toISOString() };
    try { await write(path, next, previous?.etag); } catch { /* Confirm an ambiguous committed write, never overwrite without its ETag. */ }
    const result = await stored(path);
    if (typeof result?.etag !== "string" || !result.etag || result.value?.changeId !== next.changeId
      || digest(JSON.stringify(result.value)) !== digest(JSON.stringify(next))) throw failure("DELIVERY_LEASE_LOST");
    return result;
  }
  async function context(path, expected) {
    const source = await stored(path), attempt = source?.value;
    const binding = generationDeliveryBinding(attempt);
    if (path !== `${PREFIX}${digest(binding.ownerEmail)}/${binding.id}.json` || typeof source?.etag !== "string"
      || expected && !sameBinding(binding, expected)) throw failure("DELIVERY_CHANGED");
    generationMediaSource(attempt.outputUrl, allowedHosts);
    const owner = (await stored(userPath(binding.ownerEmail)))?.value;
    if (!isOwner(owner) || owner.email !== binding.ownerEmail || owner.mustChangePassword || accessStatusForUser(owner) !== "approved")
      throw failure("DELIVERY_ACCESS_REQUIRED");
    const planPath = `production/jobs/${digest(binding.ownerEmail)}/${binding.id}.json`;
    const record = await stored(planPath), job = record?.value;
    if (typeof record?.etag !== "string" || !record.etag || !job || job.id !== binding.id || job.ownerHash !== digest(binding.ownerEmail)
      || job.filmId !== binding.filmId || job.manifestHash !== binding.manifestHash || job.mode !== "customer"
      || job.status !== "prepared" || job.lease || !plain(job.manifest) || digest(JSON.stringify(job.manifest)) !== binding.manifestHash
      || job.manifest.filmId !== binding.filmId || !Array.isArray(job.shots) || !job.shots.length
      || !Array.isArray(job.manifest.shots) || job.shots.length !== job.manifest.shots.length
      || job.shots.some((shot, index) => shot.id !== job.manifest.shots[index].id || shot.status !== "prepared")) throw failure("DELIVERY_CHANGED");
    if (binding.orderId !== digest(`${binding.ownerEmail}:production:${binding.manifestHash}`)) throw failure("DELIVERY_PAYMENT_REQUIRED");
    try {
      await requireFinishedFilmPayment({ job: { ...job, authorization: generationAttemptAuthorization(binding) }, email: binding.ownerEmail,
        actor: owner, read: stored, now });
    } catch { throw failure("DELIVERY_PAYMENT_REQUIRED"); }
    return { binding, attempt, job };
  }
  async function claim(path, binding) {
    const previous = await stored(path), value = previous?.value;
    if (previous && (typeof previous.etag !== "string" || !plain(value) || value.version !== 1 || !sameBinding(value, binding)
      || !Number.isSafeInteger(value.attempts) || value.attempts < 1 || !UUID.test(value.changeId || "")
      || !["pending", "importing", "awaiting-review", "attention", "completed"].includes(value.status))) throw failure("DELIVERY_CHANGED");
    if (value && (["awaiting-review", "attention", "completed"].includes(value.status) || value.nextAttemptAt > now()
      || value.lease?.expiresAt > now())) return null;
    if (value && value.attempts >= MAX_ATTEMPTS) {
      const { lease, ...rest } = value;
      await save(path, previous, { ...rest, status: "attention", nextAttemptAt: 0, lastFailure: "DELIVERY_LEASE_LOST" });
      return null;
    }
    const token = randomUUID();
    const next = { version: 1, ...binding, status: "importing", attempts: (value?.attempts || 0) + 1,
      createdAt: value?.createdAt || new Date(now()).toISOString(), nextAttemptAt: 0, lease: { token, expiresAt: now() + LEASE_MS } };
    await save(path, previous, next);
    return { path, token, binding };
  }
  async function owns(ticket) {
    const value = (await stored(ticket.path))?.value;
    return value?.status === "importing" && sameBinding(value, ticket.binding) && value.lease?.token === ticket.token && value.lease.expiresAt > now();
  }
  async function requireOwned(ticket, sourcePath) {
    if (!await owns(ticket)) throw failure("DELIVERY_LEASE_LOST");
    const result = await context(sourcePath, ticket.binding);
    if (!await owns(ticket)) throw failure("DELIVERY_LEASE_LOST");
    return result;
  }
  async function renew(ticket) {
    const old = await stored(ticket.path);
    if (!old || !await owns(ticket)) return false;
    try { await save(ticket.path, old, { ...old.value, lease: { token: ticket.token, expiresAt: now() + LEASE_MS } }); return true; }
    catch { return false; }
  }
  async function finish(ticket, fields) {
    const old = await stored(ticket.path);
    if (!old || !await owns(ticket)) throw failure("DELIVERY_LEASE_LOST");
    const { lease, ...value } = old.value;
    return save(ticket.path, old, { ...value, ...fields });
  }
  async function download(source, filename) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), downloadTimeoutMs);
    let response;
    try {
      response = await fetchImpl(source, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: abort.signal,
        headers: { Accept: "video/mp4, application/octet-stream", "Accept-Encoding": "identity" } });
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const length = response.headers.get("content-length");
      if (abort.signal.aborted || response.status !== 200 || response.redirected || response.url && response.url !== source
        || !["video/mp4", "application/octet-stream"].includes(type) || ![null, "identity"].includes(response.headers.get("content-encoding"))
        || response.headers.get("content-range") || length !== null && (!/^\d+$/.test(length) || Number(length) < 16 || Number(length) > MAX_BYTES)
        || !response.body) throw failure("DELIVERY_DOWNLOAD_FAILED");
      let size = 0, first = Buffer.alloc(0);
      const cap = new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > MAX_BYTES || length !== null && size > Number(length)) return done(failure("DELIVERY_DOWNLOAD_FAILED"));
        if (first.length < 32) first = Buffer.concat([first, chunk.subarray(0, 32 - first.length)]);
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), cap, createWriteStream(filename, { flags: "wx" }), { signal: abort.signal });
      if (abort.signal.aborted || size < 16 || length !== null && size !== Number(length)
        || first.length < 16 || first.toString("ascii", 4, 8) !== "ftyp" || first.readUInt32BE(0) < 16 || first.readUInt32BE(0) > Math.min(size, 4096))
        throw failure("DELIVERY_DOWNLOAD_FAILED");
    } catch { throw failure("DELIVERY_DOWNLOAD_FAILED"); }
    finally { clearTimeout(timer); abort.abort(); if (!response?.body?.locked) await response?.body?.cancel().catch(() => {}); }
  }
  async function runOne(sourcePath) {
    if (!configured) throw failure("DELIVERY_SOURCE_UNAPPROVED");
    let ticket, timer, work, renewal = Promise.resolve();
    const root = resolve(tempRoot);
    try {
      const original = (await stored(sourcePath))?.value;
      if (original?.status !== "verifying") return { state: "skipped" };
      const originalBinding = generationDeliveryBinding(original);
      const existing = (await stored(generationDeliveryPath(originalBinding.ownerEmail, originalBinding.id)))?.value;
      if (sameBinding(existing, originalBinding) && ["awaiting-review", "completed"].includes(existing.status)) return { state: "skipped" };
      const input = await context(sourcePath), path = generationDeliveryPath(input.binding.ownerEmail, input.binding.id);
      ticket = await claim(path, input.binding);
      if (!ticket) return { state: "skipped" };
      timer = setIntervalImpl(() => { renewal = renewal.then(() => renew(ticket)).catch(() => false); }, 30_000);
      timer?.unref?.();
      await requireOwned(ticket, sourcePath);
      await mkdir(root, { recursive: true }); work = await mkdtemp(join(root, "lineage-paid-film-"));
      await writeFile(join(work, ".lineage-paid-film.json"), JSON.stringify({ kind: "lineage-paid-film-delivery-v1", pid: process.pid }), { flag: "wx" });
      const local = join(work, "generated-film.mp4");
      await download(input.attempt.outputUrl, local);
      await requireOwned(ticket, sourcePath);
      let report;
      try { report = await verifyMedia({ manifest: input.job.manifest, manifestHash: input.binding.manifestHash, path: local, ffmpeg }); }
      catch { throw failure("DELIVERY_MEDIA_INVALID"); }
      const bytes = await readFile(local), sha = hashBytes(bytes);
      const artifact = { ...Object.fromEntries(["manifestHash", "contentType", "sizeBytes", "durationSeconds", "width", "height", "frameRate",
        "hasAudio", "playable", "technicalSample", "contentReviewed", "verification", "sha256"].map(key => [key, report?.[key]])),
        pathname: `production/media/${digest(input.binding.ownerEmail)}/${input.binding.id}/${sha}.mp4` };
      validateGenerationDeliveryArtifact(artifact, input.binding, input.job.manifest);
      if (artifact.sha256 !== sha || artifact.sizeBytes !== bytes.length) throw failure("DELIVERY_MEDIA_INVALID");
      await requireOwned(ticket, sourcePath);
      await deadline(storageTimeoutMs, async signal => {
        try { await putBlob(artifact.pathname, bytes, { access: "private", contentType: "video/mp4", addRandomSuffix: false,
          allowOverwrite: false, cacheControlMaxAge: 60, abortSignal: signal }); } catch { /* A matching immutable private readback resolves lost upload replies. */ }
        if (signal.aborted) throw failure("DELIVERY_STORAGE_FAILED");
        await verifyStoredBytes(getBlob, artifact, signal);
      });
      await requireOwned(ticket, sourcePath);
      clearIntervalImpl(timer); timer = undefined; await renewal;
      await requireOwned(ticket, sourcePath);
      await finish(ticket, { status: "awaiting-review", nextAttemptAt: 0, artifact, verifiedAt: new Date(now()).toISOString(), lastFailure: null });
      return { state: "awaiting-review" };
    } catch (error) {
      clearIntervalImpl(timer); timer = undefined; await renewal;
      const code = safeCode(error);
      if (ticket) {
        try {
          if (!await owns(ticket)) return { state: "skipped" };
          const previous = (await stored(ticket.path))?.value;
          const retry = ["DELIVERY_DOWNLOAD_FAILED", "DELIVERY_STORAGE_FAILED"].includes(code) && previous.attempts < MAX_ATTEMPTS;
          await finish(ticket, { status: retry ? "pending" : "attention", nextAttemptAt: retry ? now() + 60_000 * previous.attempts : 0, lastFailure: code });
          return { state: retry ? "pending" : "attention" };
        } catch { return { state: "attention" }; }
      }
      return { state: "attention" };
    } finally {
      clearIntervalImpl(timer); await renewal;
      if (work && dirname(resolve(work)) === root && basename(work).startsWith("lineage-paid-film-")) await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function runBatch({ limit = 5 } = {}) {
    if (!configured) throw failure("DELIVERY_SOURCE_UNAPPROVED");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw failure("DELIVERY_STORAGE_FAILED");
    const previous = await stored(CURSOR), cursor = previous?.value?.cursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor || cursor.length > 2048)) throw failure("DELIVERY_STORAGE_FAILED");
    const page = await listBlobs({ prefix: PREFIX, limit, ...(cursor ? { cursor } : {}) });
    if (!plain(page) || !Array.isArray(page.blobs) || page.blobs.length > limit || typeof page.hasMore !== "boolean"
      || page.hasMore && (typeof page.cursor !== "string" || !page.cursor || page.cursor.length > 2048 || page.cursor === cursor)) throw failure("DELIVERY_STORAGE_FAILED");
    const counts = { "awaiting-review": 0, pending: 0, attention: 0, skipped: 0 };
    for (const blob of page.blobs) {
      if (typeof blob?.pathname !== "string" || !/^production\/generation-attempts\/[a-f0-9]{64}\/[a-f0-9-]{36}\.json$/.test(blob.pathname)) { counts.skipped++; continue; }
      counts[(await runOne(blob.pathname)).state]++;
    }
    try { await write(CURSOR, { cursor: page.hasMore ? page.cursor : null }, previous?.etag); } catch { /* A later pass can safely inspect the same immutable attempt again. */ }
    return { ...counts, hasMore: page.hasMore };
  }
  return { runOne, runBatch, readiness: () => ({ outputHostsConfigured: configured, contentReviewRequired: true, generationSubmitted: false }) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--once"].includes(args[0])) throw failure("DELIVERY_STORAGE_FAILED");
  const worker = createPaidFilmDeliveryWorker(), readiness = worker.readiness();
  if (args[0] === "--check") {
    process.stdout.write(`${JSON.stringify({ ...readiness, storageConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      nodeSupported: Number(process.versions.node.split(".")[0]) >= 22 })}\n`);
    return;
  }
  if (!readiness.outputHostsConfigured || !process.env.BLOB_READ_WRITE_TOKEN || Number(process.versions.node.split(".")[0]) < 22)
    throw failure("DELIVERY_STORAGE_FAILED");
  process.stdout.write(`${JSON.stringify(await worker.runBatch())}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Paid film delivery could not run. Check the reviewed output hosts, private storage, and media runtime. No generation was submitted or film approved.\n"); process.exitCode = 1; });
}
