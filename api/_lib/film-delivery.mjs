import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get, put, list, del } from "@vercel/blob";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { hasAdminAccess, accessStatusForUser } from "./access.mjs";
import { archive, MAX_FILM_BYTES, verifyVideoHeader } from "./archive.mjs";

const PREFIX = "delivery/jobs/", PENDING = "delivery/pending/";
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LIMIT_MS = 240_000, LEASE_MS = 6 * 60_000;
const path = id => { if (!ID.test(id || "")) throw new DeliveryError("Choose a valid delivery."); return `${PREFIX}${id}.json`; };
const safe = job => ({ id: job.id, ownerEmail: job.ownerEmail, title: job.title, projectId: job.projectId,
  status: job.status, attempts: job.attempts, createdAt: job.createdAt, updatedAt: job.updatedAt,
  ...(job.error ? { error: job.error } : {}), ...(job.deliveredAt ? { deliveredAt: job.deliveredAt, sizeBytes: job.sizeBytes } : {}) });
export class DeliveryError extends Error {
  constructor(message, status = 400, code = "DELIVERY_INVALID") { super(message); this.status = status; this.code = code; }
}
export function magicLightExport(value) {
  try {
    if (typeof value !== "string" || value.length > 1024) throw new Error();
    const url = new URL(value);
    const match = /^\/videos\/(\d{10,25})\/([a-f0-9-]{36})\.mp4$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "videocos.magiclight.ai" || url.port || url.username || url.password
      || url.search || url.hash || !match || !ID.test(match[2]) || url.href !== value) throw new Error();
    return { url: url.href, projectId: match[1] };
  } catch { throw new DeliveryError("Use the finished MP4 link from MagicLight's video player (videocos.magiclight.ai). Project editor links cannot be transferred."); }
}

// Copies only a reviewed MagicLight CDN export. No browser cookies, API keys,
// generation requests, customer charges, or arbitrary remote URLs are involved.
export async function copyMagicLightExport(job, pathname, { fetchImpl = fetch, putBlob = put, getBlob = get } = {}) {
  const source = magicLightExport(job.sourceUrl).url;
  const filename = join(tmpdir(), `lineage-delivery-${randomUUID()}.mp4`);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LIMIT_MS);
  let response;
  try {
    response = await fetchImpl(source, { redirect: "error", headers: { "Accept-Encoding": "identity" }, signal: abort.signal });
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "video/mp4"
      || !Number.isSafeInteger(size) || size < 16 || size > MAX_FILM_BYTES || size !== job.expectedSize)
      throw new DeliveryError("The export is unavailable or its type or size changed. Check the finished video link.", 502, "DELIVERY_SOURCE_CHANGED");
    let total = 0, first = Buffer.alloc(0), hash = createHash("sha256");
    const check = new Transform({ transform(chunk, _encoding, done) {
      total += chunk.length;
      if (total > size) return done(new Error("Video exceeds expected size"));
      if (first.length < 32) first = Buffer.concat([first, chunk.subarray(0, 32 - first.length)]);
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), check, createWriteStream(filename, { flags: "wx" }), { signal: abort.signal });
    if (total !== size || !verifyVideoHeader(first, "video/mp4")) throw new DeliveryError("The export is not a complete MP4 video.", 502);
    const sha256 = hash.digest("hex");
    const uploadStream = createReadStream(filename);
    try {
      await putBlob(pathname, uploadStream, { access: "private", contentType: "video/mp4", multipart: true,
        addRandomSuffix: false, allowOverwrite: false, abortSignal: abort.signal });
    } catch (error) {
      if (!/already.exists/i.test(`${error?.name} ${error?.message}`)) throw error;
      // A previous attempt may have finished copying before its reply was lost.
    } finally { uploadStream.destroy(); }
    const copy = await getBlob(pathname, { access: "private", useCache: false, abortSignal: abort.signal,
      headers: { "accept-encoding": "identity" } });
    if (!copy?.stream || copy.blob.pathname !== pathname || copy.blob.size !== size || copy.blob.contentType !== "video/mp4") {
      await copy?.stream?.cancel(); throw new Error("Private copy mismatch");
    }
    const verified = createHash("sha256"); let count = 0;
    for await (const chunk of Readable.fromWeb(copy.stream)) {
      count += chunk.length;
      if (count > size || abort.signal.aborted) throw new Error("Private copy exceeds bounds");
      verified.update(chunk);
    }
    if (count !== size || verified.digest("hex") !== sha256) throw new Error("Private copy digest mismatch");
    return { sizeBytes: size, sha256 };
  } finally {
    clearTimeout(timer); abort.abort();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await unlink(filename).catch(() => {});
  }
}

export function createFilmDeliveryService({ read = readRecord, write = writeRecord, listBlobs = list, deleteBlob = del,
  archiveService = archive, copy = copyMagicLightExport, fetchImpl = fetch, now = Date.now } = {}) {
  async function approved(email, admin = false) {
    const user = (await read(userPath(email)))?.value;
    if (!user || user.email !== email || user.mustChangePassword || accessStatusForUser(user) !== "approved" || admin && !hasAdminAccess(user))
      throw new DeliveryError(admin ? "Administrator access is required." : "Choose an approved customer account.", 403, "DELIVERY_ACCESS_REQUIRED");
    return user;
  }
  async function administrator(actor) {
    if (!actor || actor.mustChangePassword || !hasAdminAccess(actor)) throw new DeliveryError("Administrator access is required.", 403);
    return approved(actor.email, true);
  }
  async function enqueue(actor, input) {
    await administrator(actor);
    if (!input || Object.keys(input).some(key => !["ownerEmail", "title", "duration", "sourceUrl", "assignmentConfirmed"].includes(key))
      || input.assignmentConfirmed !== true || typeof input.ownerEmail !== "string" || input.ownerEmail.length > 254
      || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(input.ownerEmail)
      || typeof input.title !== "string" || !input.title.trim() || input.title.length > 200
      || !Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 14400) throw new DeliveryError("Confirm the customer, film title, runtime, and finished video link.");
    const ownerEmail = input.ownerEmail.trim().toLowerCase(); await approved(ownerEmail);
    const source = magicLightExport(input.sourceUrl), sourceHash = digest(source.url);
    // One global identity per immutable export prevents duplicate copies and an
    // accidental second delivery of the same private film to another account.
    const id = `${sourceHash.slice(0,8)}-${sourceHash.slice(8,12)}-${sourceHash.slice(12,16)}-${sourceHash.slice(16,20)}-${sourceHash.slice(20,32)}`;
    const existing = await read(path(id));
    if (existing) {
      if (existing.value.ownerEmail !== ownerEmail) throw new DeliveryError("This export is already assigned to another account. Review its delivery record.", 409);
      if (["queued", "processing"].includes(existing.value.status)) await ensureTicket(id);
      return safe(existing.value);
    }
    const check = await fetchImpl(source.url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(15_000) });
    const size = Number(check.headers.get("content-length"));
    if (!check.ok || check.headers.get("content-type")?.split(";")[0].trim() !== "video/mp4"
      || !Number.isSafeInteger(size) || size < 16 || size > MAX_FILM_BYTES)
      throw new DeliveryError("MagicLight must expose a completed MP4 export of 500 MB or less before delivery can be queued.", 409);
    const timestamp = new Date(now()).toISOString();
    const job = { version: 1, id, ownerEmail, title: input.title.trim(), duration: input.duration, sourceUrl: source.url,
      sourceHash, projectId: source.projectId, expectedSize: size, assignedBy: actor.email,
      status: "queued", attempts: 0, createdAt: timestamp, updatedAt: timestamp };
    try { await write(path(id), job); } catch {
      const saved = (await read(path(id)))?.value;
      if (!saved || saved.ownerEmail !== ownerEmail || saved.sourceHash !== sourceHash) throw new DeliveryError("The delivery assignment changed. Refresh before continuing.", 409);
    }
    await ensureTicket(id);
    return safe((await read(path(id))).value);
  }
  async function ensureTicket(id) {
    const key = `${PENDING}${id}.json`;
    try { await write(key, { id }); } catch { if (!(await read(key))) throw new Error("Delivery queue unavailable"); }
  }
  async function listJobs(actor, cursor) {
    await administrator(actor);
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 2048)) throw new DeliveryError("Invalid delivery page.");
    const page = await listBlobs({ prefix: PREFIX, limit: 30, ...(cursor ? { cursor } : {}) });
    const jobs = [];
    for (const item of page.blobs) {
      const id = item.pathname.slice(PREFIX.length).replace(/\.json$/, "");
      if (!ID.test(id) || item.pathname !== path(id)) continue;
      const job = (await read(item.pathname))?.value;
      if (job?.id === id) jobs.push(safe(job));
    }
    return { jobs, ...(page.hasMore ? { cursor: page.cursor } : {}) };
  }
  async function transfer(id) {
    const record = await read(path(id));
    if (!record) throw new DeliveryError("Delivery not found.", 404);
    const job = record.value;
    if (job.status === "delivered") { await deleteBlob(`${PENDING}${id}.json`).catch(() => {}); return safe(job); }
    if (job.status === "processing" && job.leaseUntil > now()) return safe(job);
    if (job.status === "failed") return safe(job);
    const operation = randomUUID(), timestamp = new Date(now()).toISOString();
    const running = { ...job, status: "processing", operation, leaseUntil: now() + LEASE_MS, attempts: job.attempts + 1, updatedAt: timestamp };
    try { await write(path(id), running, record.etag); } catch { return safe((await read(path(id))).value); }
    let result, error;
    try {
      await approved(job.assignedBy, true); await approved(job.ownerEmail);
      const current = await archiveService.readFilm(job.ownerEmail, id).catch(cause => { if (cause.status !== 404) throw cause; return null; });
      if (current?.value.video) {
        if (current.value.delivery?.sourceHash !== job.sourceHash || current.value.video.size !== job.expectedSize) throw new DeliveryError("The existing library film does not match this export.", 409);
        result = { sizeBytes: current.value.video.size };
      } else {
        const saved = await archiveService.save(job.ownerEmail, { id, title: job.title, ancestor: "", duration: job.duration,
          archiveConsent: true, video: { type: "video/mp4", size: job.expectedSize } },
          { provider: "magiclight", projectId: job.projectId, sourceHash: job.sourceHash, assignedBy: job.assignedBy });
        result = await copy(job, saved.upload.pathname);
        await approved(job.assignedBy, true); await approved(job.ownerEmail);
        await archiveService.finalize(job.ownerEmail, id);
      }
    } catch (cause) {
      error = cause instanceof DeliveryError ? cause.message : "The transfer could not be verified. Check the export and retry delivery; no new generation is submitted.";
    }
    const latest = await read(path(id));
    if (latest?.value.operation !== operation) throw new DeliveryError("Another worker owns this delivery. Refresh its status.", 409);
    const { leaseUntil, operation: removed, ...rest } = running;
    const terminal = { ...rest, status: error ? "failed" : "delivered", updatedAt: new Date(now()).toISOString(),
      ...(error ? { error } : { ...result, deliveredAt: new Date(now()).toISOString() }) };
    await write(path(id), terminal, latest.etag);
    await deleteBlob(`${PENDING}${id}.json`).catch(() => {});
    console.info(JSON.stringify({ event: "film-delivery", id, status: terminal.status, attempts: terminal.attempts }));
    return safe(terminal);
  }
  async function run() {
    const page = await listBlobs({ prefix: PENDING, limit: 10 });
    for (const item of page.blobs) {
      const id = item.pathname.slice(PENDING.length).replace(/\.json$/, "");
      if (!ID.test(id) || item.pathname !== `${PENDING}${id}.json`) continue;
      const job = (await read(path(id)))?.value;
      if (!job) { await deleteBlob(item.pathname); continue; }
      if (["failed", "delivered"].includes(job.status)) { await deleteBlob(item.pathname); continue; }
      if (job.status === "processing" && job.leaseUntil > now()) continue;
      return { processed: 1, job: await transfer(id) };
    }
    return { processed: 0 };
  }
  async function retry(actor, id) {
    await administrator(actor); const old = await read(path(id));
    if (!old) throw new DeliveryError("Delivery not found.", 404);
    await approved(old.value.ownerEmail);
    if (old.value.status === "failed") {
      const { error, ...rest } = old.value;
      await write(path(id), { ...rest, assignedBy: actor.email, status: "queued", updatedAt: new Date(now()).toISOString() }, old.etag);
    }
    await ensureTicket(id); return safe((await read(path(id))).value);
  }
  async function transferNow(actor, id) { await administrator(actor); return transfer(id); }
  return { enqueue, list: listJobs, retry, transferNow, run };
}
export const filmDelivery = createFilmDeliveryService();
