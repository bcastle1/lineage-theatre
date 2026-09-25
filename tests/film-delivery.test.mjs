import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createFilmDeliveryService, magicLightExport, copyMagicLightExport } from "../api/_lib/film-delivery.mjs";
import { createArchiveService, parseRange, metadataPath } from "../api/_lib/archive.mjs";
import { createFilmLibraryService } from "../api/_lib/film-library.mjs";
import { createFilmDeliveryHandler } from "../api/film-delivery.mjs";
import { createArchiveHandler } from "../api/archive.mjs";
import { userPath } from "../api/_lib/auth.mjs";
const owner = { email: "erik@brocotech.ai", role: "owner", status: "active" };
const customer = { email: "customer@example.invalid", role: "customer", status: "active", approvedAt: "2026-09-01T00:00:00Z", approvedBy: owner.email };
const second = { ...customer, email: "second@example.invalid" };
const sourceUrl = "https://videocos.magiclight.ai/videos/7503837121089429506/2eab384a-599c-4799-a359-33b3f4906710.mp4";
const input = { ownerEmail: customer.email, title: "Fictional delivered film", duration: 30, sourceUrl, assignmentConfirmed: true };
function fixture(options = {}) {
  const records = new Map(), blobs = new Map(); let revision = 0, copies = 0, clock = Date.now();
  const bytes = Buffer.alloc(128); bytes.write("ftyp", 4);
  const read = async key => structuredClone(records.get(key) || null);
  const write = async (key, value, etag) => {
    if (records.get(key)?.etag !== etag) throw new Error("ETag precondition failed");
    records.set(key, { value: structuredClone(value), etag: String(++revision) });
  };
  for (const user of [owner, customer, second]) records.set(userPath(user.email), { value: structuredClone(user), etag: String(++revision) });
  const listBlobs = async ({ prefix, cursor, limit = 100 }) => {
    const paths = [...records.keys()].filter(key => key.startsWith(prefix)).sort(), offset = Number(cursor || 0);
    return { blobs: paths.slice(offset, offset + limit).map(pathname => ({ pathname })), hasMore: offset + limit < paths.length, cursor: String(offset + limit) };
  };
  const getBlob = async (pathname, options) => {
    const data = blobs.get(pathname); if (!data) return null;
    const range = parseRange(options?.headers?.Range, data.length), result = range ? data.subarray(range.start, range.end + 1) : data;
    return { stream: new Response(result).body, blob: { pathname, size: result.length, contentType: "video/mp4" },
      headers: new Headers(range ? { "content-range": range.contentRange } : {}) };
  };
  const archive = createArchiveService({ readRecord: read, writeRecord: write, listBlobs, getBlob,
    headBlob: async pathname => ({ pathname, contentType: "video/mp4", size: blobs.get(pathname)?.length, etag: "video-etag" }) });
  const service = createFilmDeliveryService({ read, write, listBlobs, deleteBlob: async key => records.delete(key), archiveService: archive,
    fetchImpl: async (_url, options) => { assert.equal(options.method, "HEAD"); assert.equal(options.redirect, "error"); return new Response(null, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } }); },
    copy: async (job, pathname) => { copies++; await options.beforeCopy?.(records); if (options.failCopy) throw new Error("secret transport error"); blobs.set(pathname, bytes); return { sizeBytes: bytes.length, sha256: "a".repeat(64) }; },
    now: () => clock });
  const library = createFilmLibraryService({ read, write, listBlobs, cursorSecret: "synthetic-only" });
  return { service, archive, library, records, blobs, bytes, getBlob, copyCount: () => copies, advance: () => { clock += 400_000; } };
}
test("only the observed MagicLight export host and canonical MP4 paths are accepted", () => {
  assert.equal(magicLightExport(sourceUrl).projectId, "7503837121089429506");
  for (const value of ["http://127.0.0.1/a.mp4", sourceUrl.replace("videocos.magiclight.ai", "videocos.magiclight.ai.evil.test"), sourceUrl + "?url=http://localhost", sourceUrl + "#x", sourceUrl.replace("https://", "https://user:pass@"), "https://magiclight.ai/project/edit/7503837121089429506/", sourceUrl.replace("https:", "http:"), sourceUrl.replace(".ai/", ".ai:444/")]) assert.throws(() => magicLightExport(value));
});
test("queued delivery reaches only the assigned customer library, with honest provenance and no fabricated consent", async () => {
  const f = fixture(), job = await f.service.enqueue(owner, input);
  assert.equal(job.status, "queued"); assert.equal(f.copyCount(), 0);
  const result = await f.service.run(); assert.equal(result.job.status, "delivered"); assert.equal(f.copyCount(), 1);
  const saved = f.records.get(metadataPath(customer.email, job.id)).value;
  assert.equal(saved.consent, undefined); assert.equal(saved.delivery.assignedBy, owner.email); assert.equal(saved.video.origin, "magiclight-delivery");
  const detail = await f.library.detail(customer, { kind: "upload", id: job.id });
  assert.equal(detail.entry.origin, "magiclight-delivery"); assert.equal(detail.entry.production.mediaReady, true);
  assert.equal(detail.entry.mediaUrl, `/api/archive?action=media&id=${job.id}`);
  await assert.rejects(f.library.detail(second, { kind: "upload", id: job.id }), { status: 404 });
  assert.equal((await f.service.enqueue(owner, input)).id, job.id);
  assert.equal((await f.service.run()).processed, 0); assert.equal(f.copyCount(), 1);
  await assert.rejects(f.archive.uploadOptions(customer.email, saved.video.pathname, JSON.stringify({ id: job.id })), { status: 403 });
  await assert.rejects(f.service.enqueue(owner, { ...input, ownerEmail: second.email }), { status: 409 });
});
test("customers and revoked administrators cannot assign films; suspended customers cannot receive them", async () => {
  const f = fixture(); await assert.rejects(f.service.enqueue(customer, input), { status: 403 });
  f.records.get(userPath(customer.email)).value.status = "suspended";
  await assert.rejects(f.service.enqueue(owner, input), { status: 403 });
  f.records.get(userPath(owner.email)).value.status = "suspended";
  await assert.rejects(f.service.list(owner), { status: 403 });
});
test("failed transfer never becomes playable; retry keeps the same job and does not resubmit generation", async () => {
  const options = { failCopy: true }, f = fixture(options), job = await f.service.enqueue(owner, input);
  const failed = await f.service.run(); assert.equal(failed.job.status, "failed"); assert.doesNotMatch(JSON.stringify(failed), /secret transport/);
  assert.equal((await f.library.detail(customer, { kind: "upload", id: job.id })).entry.production.mediaReady, false);
  options.failCopy = false; await f.service.retry(owner, job.id);
  assert.equal((await f.service.run()).job.status, "delivered"); assert.equal(f.copyCount(), 2);
});
test("account suspension during copying prevents publication", async () => {
  const f = fixture({ beforeCopy: async records => { records.get(userPath(customer.email)).value.status = "suspended"; } });
  const job = await f.service.enqueue(owner, input); assert.equal((await f.service.run()).job.status, "failed");
  assert.equal(f.records.get(metadataPath(customer.email, job.id)).value.video, undefined);
});
test("concurrent workers acquire one transfer lease", async () => {
  const f = fixture(), job = await f.service.enqueue(owner, input);
  await Promise.all([f.service.transferNow(owner, job.id), f.service.transferNow(owner, job.id)]);
  assert.equal(f.copyCount(), 1);
});
test("orphaned queue ticket is repaired by safely repeating the same assignment", async () => {
  const f = fixture(), job = await f.service.enqueue(owner, input);
  f.records.delete(`delivery/pending/${job.id}.json`); await f.service.enqueue(owner, input);
  assert.equal((await f.service.run()).job.status, "delivered");
});
test("streaming transfer verifies MP4 bytes, byte count, and private readback before success", async () => {
  const bytes = Buffer.alloc(128); bytes.write("ftyp", 4); let copied;
  const deps = {
    fetchImpl: async (_url, options) => { assert.equal(options.redirect, "error"); return new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": "128" } }); },
    putBlob: async (_path, stream, options) => { assert.equal(options.access, "private"); assert.equal(options.allowOverwrite, false); const chunks = []; for await (const part of stream) chunks.push(part); copied = Buffer.concat(chunks); },
    getBlob: async pathname => ({ blob: { pathname, contentType: "video/mp4", size: copied.length }, stream: new Response(copied).body }) };
  const result = await copyMagicLightExport({ sourceUrl, expectedSize: 128 }, "private-test.mp4", deps);
  assert.equal(result.sizeBytes, 128); assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.deepEqual(copied, bytes);
  await assert.rejects(copyMagicLightExport({ sourceUrl, expectedSize: 129 }, "private-test.mp4", deps));
  await assert.rejects(copyMagicLightExport({ sourceUrl, expectedSize: 128 }, "private-test.mp4", { ...deps,
    getBlob: async pathname => ({ blob: { pathname, contentType: "video/mp4", size: 128 }, stream: new Response(Buffer.alloc(128)).body }) }));
});
class Capture extends Writable {
  constructor() { super(); this.headers = {}; this.parts = []; this.statusCode = 200; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; } removeHeader(key) { delete this.headers[key.toLowerCase()]; }
  _write(chunk, _encoding, callback) { this.parts.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.parts); }
}
test("cron requires its secret; the administrative route requires a same-origin administrator", async () => {
  const f = fixture(), handler = createFilmDeliveryHandler({ service: f.service, sessionFor: async req => req.user ? { user: req.user } : null, limiter: async () => true, env: { CRON_SECRET: "x".repeat(40) } });
  const request = async (url, { method = "GET", user = owner, body, authorization, origin = "https://lineagetheater.com" } = {}) => {
    const res = new Capture(); await handler({ url, method, user, body, headers: { host: "lineagetheater.com", origin, authorization } }, res); return res;
  };
  assert.equal((await request("/api/film-delivery?action=run")).statusCode, 401);
  assert.equal((await request("/api/film-delivery?action=run", { authorization: `Bearer ${"x".repeat(40)}` })).statusCode, 200);
  assert.equal((await request("/api/film-delivery", { user: null, authorization: `Bearer ${"x".repeat(40)}` })).statusCode, 200);
  assert.equal((await request("/api/film-delivery", { user: customer })).statusCode, 403);
  assert.equal((await request("/api/film-delivery", { user: null })).statusCode, 401);
  assert.equal((await request("/api/film-delivery", { method: "POST", body: { action: "enqueue", ...input }, origin: "https://evil.test" })).statusCode, 403);
});
test("delivered video streams authenticated byte ranges and rejects another customer", async () => {
  const f = fixture(), job = await f.service.enqueue(owner, input); await f.service.run();
  const handler = createArchiveHandler({ archive: f.archive, getBlob: f.getBlob, getSession: async req => ({ user: req.user }), limitAction: async () => true });
  const request = async (user, ownerParam = "") => { const res = new Capture(); await handler({ method: "GET", url: `/api/archive?action=media&id=${job.id}${ownerParam}`, user,
    headers: { host: "lineagetheater.com", range: "bytes=0-31" } }, res); return res; };
  const good = await request(customer); assert.equal(good.statusCode, 206); assert.equal(good.body.length, 32);
  assert.equal(good.headers["content-range"], "bytes 0-31/128");
  assert.equal((await request(second, `&owner=${encodeURIComponent(customer.email)}`)).statusCode, 403);
  assert.equal((await request(second)).statusCode, 404);
});
