import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createHmac } from "node:crypto";
import { createArchiveService, metadataPath, mediaPath, validateArchiveInput, parseRange, MAX_FILM_BYTES, MAX_ACCOUNT_BYTES } from "../api/_lib/archive.mjs";
import { createArchiveHandler } from "../api/archive.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const owner = "family@example.invalid", other = "other@example.invalid";
const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const input = (overrides = {}) => ({ archiveConsent: true, id, title: "A fictional family film", ancestor: "Fictional ancestor", duration: 120, ...overrides });
const approvedAccount = (email = owner) => ({ email, role: "customer", status: "active",
  approvedAt: "2026-09-14T00:00:00.000Z", approvedBy: OWNER_EMAIL });
function fixture({ beforeGetBlob } = {}) {
  const records = new Map(), videos = new Map(), reads = [], writes = [];
  records.set(userPath(owner), { value: approvedAccount(), etag: "account" });
  let revision = 0;
  const readRecord = async (path) => structuredClone(records.get(path) || null);
  const writeRecord = async (path, value, etag) => {
    if (records.get(path)?.etag !== etag) throw new Error("ETag precondition failed");
    records.set(path, { value: structuredClone(value), etag: String(++revision) }); writes.push(path);
  };
  const listBlobs = async ({ prefix, cursor, limit }) => {
    const paths = [...records.keys()].filter((path) => path.startsWith(prefix)).sort();
    const offset = Number(cursor || 0), end = offset + limit;
    return { blobs: paths.slice(offset, end).map((pathname) => ({ pathname })), hasMore: paths.length > end, cursor: String(end) };
  };
  const headBlob = async (path) => {
    reads.push(path);
    const file = videos.get(path); if (!file) throw new Error("BlobNotFoundError");
    return { pathname: path, size: file.bytes.length, contentType: file.type, etag: "video-etag", url: `https://store.private.blob.vercel-storage.com/${path}` };
  };
  const getBlob = async (path, options) => {
    await beforeGetBlob?.(records);
    reads.push(path);
    const file = videos.get(path); if (!file) return null;
    const range = parseRange(options?.headers?.Range, file.bytes.length);
    const bytes = range ? file.bytes.subarray(range.start, range.end + 1) : file.bytes;
    return { stream: new Response(bytes).body, headers: new Headers(range ? { "content-range": range.contentRange } : {}), blob: { size: bytes.length, pathname: path } };
  };
  const service = createArchiveService({ readRecord, writeRecord, listBlobs, headBlob, getBlob, now: () => 1_800_000_000_000, uuid: () => secondId });
  const addVideo = (path, type = "video/mp4", valid = true) => {
    const bytes = Buffer.alloc(128); if (valid) { if (type === "video/mp4") bytes.write("ftyp", 4); else bytes.set([0x1a, 0x45, 0xdf, 0xa3]); }
    videos.set(path, { type, bytes }); return bytes;
  };
  return { service, records, videos, reads, writes, getBlob, addVideo };
}
class ResponseCapture extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = 200; this.headersSent = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  _write(chunk, encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); done(); }
  get body() { return Buffer.concat(this.chunks); }
  get data() { return JSON.parse(this.body.toString()); }
}
async function request(fix, { method = "GET", url = "/api/archive?action=list", user = { email: owner, role: "customer" }, body, origin = "https://lineagetheater.com", headers = {}, dependencies = {} } = {}) {
  const response = new ResponseCapture();
  const handler = createArchiveHandler({ archive: fix.service, getBlob: fix.getBlob, getSession: async () => user ? { user } : null, limitAction: async () => true, ...dependencies });
  await handler({ method, url, body, headers: { host: "lineagetheater.com", origin, ...headers } }, response);
  return response;
}
async function uploaded(fix) {
  const saved = await fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } }));
  const bytes = fix.addVideo(saved.upload.pathname);
  await fix.service.finalize(owner, id);
  return { path: saved.upload.pathname, bytes };
}
async function signedCallback(fix, event) {
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  const token = "vercel_blob_rw_synthetic_archive_test_token";
  process.env.BLOB_READ_WRITE_TOKEN = token;
  try {
    const body = { type: "blob.upload-completed", payload: event };
    const signature = createHmac("sha256", token).update(JSON.stringify(body)).digest("hex");
    return await request(fix, { method: "POST", user: null, body,
      headers: { "x-vercel-signature": signature } });
  } finally {
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
}

test("archive save requires explicit consent and stores only scoped film metadata", async () => {
  const fix = fixture();
  await assert.rejects(fix.service.save(owner, input({ archiveConsent: false })), /Allow your film details/);
  assert.equal(fix.writes.length, 0);
  await fix.service.save(owner, input({ ownerEmail: other, script: "private original text", sources: [{ text: "private source" }], videoUrl: "https://evil.invalid/video" }));
  const saved = fix.records.get(metadataPath(owner, id)).value;
  assert.equal(saved.ownerEmail, owner); assert.equal(saved.consent.administratorAccess, true);
  assert.equal(saved.script, undefined); assert.equal(saved.sources, undefined); assert.equal(saved.videoUrl, undefined);
  assert.deepEqual((await fix.service.listArchive({ ownerEmail: other })).films, []);
  assert.equal((await fix.service.listArchive({ ownerEmail: owner })).films[0].status, "draft");
});
test("archive upload rejects unsafe paths, unsupported types and oversized files", () => {
  for (const change of [{ id: "../../auth/users" }, { video: { type: "text/html", size: 128 } }, { video: { type: "video/mp4", size: MAX_FILM_BYTES + 1 } }, { video: { type: "video/mp4", size: -1 } }, { duration: Infinity }])
    assert.throws(() => validateArchiveInput(input(change)));
  assert.throws(() => metadataPath(owner, `${id}/../../other`));
  assert.throws(() => mediaPath(owner, id, "text/html"));
});
test("upload token binds the signed-in owner, exact pathname, content type, size and stored ticket", async () => {
  const fix = fixture();
  const result = await fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } }));
  const options = await fix.service.uploadOptions(owner, result.upload.pathname, result.upload.clientPayload);
  assert.equal(options.maximumSizeInBytes, 128); assert.equal(options.allowOverwrite, false); assert.equal(options.addRandomSuffix, false);
  assert.deepEqual(options.allowedContentTypes, ["video/mp4"]);
  assert.equal(JSON.parse(options.tokenPayload).ownerEmail, owner);
  await assert.rejects(fix.service.uploadOptions(other, result.upload.pathname, result.upload.clientPayload), /not found/);
  await assert.rejects(fix.service.uploadOptions(owner, mediaPath(other, id, "video/mp4"), result.upload.clientPayload), /does not match/);
});
test("account reservation limits are enforced before issuing another upload", async () => {
  const fix = fixture();
  fix.records.set(`archive/accounts/${digest(owner)}.json`, { etag: "cap", value: { films: { [secondId]: MAX_ACCOUNT_BYTES } } });
  await assert.rejects(fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } })), /5 GB/);
  assert.equal(fix.records.has(metadataPath(owner, id)), false);
  fix.records.set(`archive/accounts/${digest(owner)}.json`, { etag: "cap", value: { films: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`slot${i}`, 0])) } });
  await assert.rejects(fix.service.save(owner, input()), /100-film/);
});
test("concurrent upload reservations cannot overrun the account allowance", async () => {
  const fix = fixture();
  fix.records.set(`archive/accounts/${digest(owner)}.json`, { etag: "cap", value: { films: { existing: MAX_ACCOUNT_BYTES - 128 } } });
  const results = await Promise.allSettled([id, secondId].map((filmId) => fix.service.save(owner, input({ id: filmId, video: { type: "video/mp4", size: 128 } }))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(Object.values(fix.records.get(`archive/accounts/${digest(owner)}.json`).value.films).reduce((sum, value) => sum + value, 0), MAX_ACCOUNT_BYTES);
});
test("callback and immediate verification use only a server-owned path and are idempotent", async () => {
  const fix = fixture();
  const saved = await fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } }));
  const options = await fix.service.uploadOptions(owner, saved.upload.pathname, saved.upload.clientPayload);
  fix.addVideo(saved.upload.pathname);
  const ticket = JSON.parse(options.tokenPayload);
  await assert.rejects(fix.service.completeUpload({ blob: { pathname: mediaPath(other, id, "video/mp4") }, tokenPayload: options.tokenPayload }), /callback path/);
  await assert.rejects(fix.service.completeUpload({ blob: { pathname: saved.upload.pathname }, tokenPayload: JSON.stringify({ ...ticket, nonce: id }) }), /does not match/);
  const event = { blob: { pathname: saved.upload.pathname, url: "https://evil.invalid/arbitrary" }, tokenPayload: options.tokenPayload };
  const film = await fix.service.completeUpload(event);
  assert.equal(film.hasVideo, true); assert.equal(film.status, "uploaded");
  assert.deepEqual(await fix.service.completeUpload(event), film);
  assert.deepEqual(await fix.service.finalize(owner, id), film);
  assert.ok(fix.reads.every((path) => path === saved.upload.pathname));
  assert.equal(JSON.stringify(film).includes("blob.vercel-storage"), false);
});
test("uploaded video type, exact size and container header are verified before playback is enabled", async () => {
  for (const bad of ["type", "size", "header"]) {
    const fix = fixture();
    const saved = await fix.service.save(owner, input({ video: { type: "video/mp4", size: bad === "size" ? 127 : 128 } }));
    fix.addVideo(saved.upload.pathname, bad === "type" ? "video/webm" : "video/mp4", bad !== "header");
    await assert.rejects(fix.service.finalize(owner, id), /does not match|not a recognized/);
    assert.equal((await fix.service.listArchive({ ownerEmail: owner })).films[0].hasVideo, false);
  }
});
test("private archive routes enforce authentication, admin roles, same origin and owner isolation", async () => {
  const fix = fixture(); await uploaded(fix);
  assert.equal((await request(fix, { user: null })).statusCode, 401);
  assert.equal((await request(fix, { url: "/api/archive?action=admin" })).statusCode, 403);
  assert.equal((await request(fix, { url: `/api/archive?action=media&id=${id}&owner=${owner}`, user: { email: other, role: "customer" } })).statusCode, 403);
  assert.equal((await request(fix, { method: "POST", body: { action: "save", ...input() }, origin: "https://evil.invalid" })).statusCode, 403);
  const listResponse = await request(fix, { url: `/api/archive?action=list&owner=${owner}`, user: { email: other, role: "customer" } });
  assert.deepEqual(listResponse.data.films, []);
  assert.equal((await request(fix, { url: "/api/archive?action=admin", user: { email: other, role: "admin" } })).data.films.length, 1);
});
test("private video playback streams valid byte ranges and supports authenticated downloads", async () => {
  const fix = fixture(); const video = await uploaded(fix);
  const url = `/api/archive?action=media&id=${id}`;
  const partial = await request(fix, { url, headers: { range: "bytes=10-24" } });
  assert.equal(partial.statusCode, 206); assert.equal(partial.headers["content-range"], "bytes 10-24/128");
  assert.equal(partial.headers["content-length"], "15"); assert.deepEqual(partial.body, video.bytes.subarray(10, 25));
  assert.equal(partial.headers["cache-control"], "private, no-store");
  const downloaded = await request(fix, { url: `${url}&download=1&owner=${owner}`, user: { email: other, role: "admin" } });
  assert.equal(downloaded.statusCode, 200); assert.match(downloaded.headers["content-disposition"], /^attachment;/); assert.deepEqual(downloaded.body, video.bytes);
  const calls = fix.reads.length;
  const invalid = await request(fix, { url, headers: { range: "bytes=1000-" } });
  assert.equal(invalid.statusCode, 416); assert.equal(invalid.headers["content-range"], "bytes */128");
  assert.equal(fix.reads.length, calls);
  const heading = await request(fix, { method: "HEAD", url });
  assert.equal(heading.headers["content-length"], "128"); assert.equal(heading.body.length, 0); assert.equal(fix.reads.length, calls);
});
test("range parsing supports suffixes and rejects ambiguous or unsafe ranges", () => {
  assert.equal(parseRange("bytes=-10", 128).contentRange, "bytes 118-127/128");
  assert.equal(parseRange("bytes=5-999", 128).contentRange, "bytes 5-127/128");
  for (const range of ["bytes=0-1,5-6", "bytes=-", "bytes=-0", "bytes=2-1", "bytes=999999999999999999999-"])
    assert.throws(() => parseRange(range, 128));
});
test("forged upload callbacks are rejected by the Blob SDK without touching archive metadata", async () => {
  const fix = fixture();
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_synthetic_archive_test_token";
  try {
    for (const headers of [{}, { "x-vercel-signature": "0".repeat(64) }]) {
      const response = await request(fix, { method: "POST", user: null, origin: undefined, headers, body: { type: "blob.upload-completed", payload: { blob: { pathname: mediaPath(owner, id, "video/mp4") }, tokenPayload: "{}" } } });
      assert.equal(response.statusCode, 403); assert.match(response.data.message, /could not be verified/); assert.equal(fix.writes.length, 0);
    }
  } finally { if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = previous; }
});
test("a verified Blob callback can complete without a browser session while altered tickets fail", async () => {
  const fix = fixture();
  const saved = await fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } }));
  const options = await fix.service.uploadOptions(owner, saved.upload.pathname, saved.upload.clientPayload);
  fix.addVideo(saved.upload.pathname);
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  const token = "vercel_blob_rw_synthetic_archive_test_token";
  process.env.BLOB_READ_WRITE_TOKEN = token;
  try {
    const body = { type: "blob.upload-completed", payload: { blob: { pathname: saved.upload.pathname }, tokenPayload: options.tokenPayload } };
    const signature = createHmac("sha256", token).update(JSON.stringify(body)).digest("hex");
    const response = await request(fix, { method: "POST", user: null, body, headers: { "x-vercel-signature": signature } });
    assert.equal(response.statusCode, 200); assert.equal((await fix.service.listArchive({ ownerEmail: owner })).films[0].hasVideo, true);
    const ticket = JSON.parse(options.tokenPayload);
    await assert.rejects(fix.service.completeUpload({ blob: { pathname: saved.upload.pathname }, tokenPayload: JSON.stringify({ ...ticket, size: 12 }) }), /does not match/);
  } finally { if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = previous; }
});

test("previously signed upload tickets cannot finalize for missing, pending, suspended or unapproved accounts", async () => {
  for (const account of [null, { ...approvedAccount(), status: "pending" },
    { ...approvedAccount(), status: "suspended" }, { email: owner, role: "customer", status: "active" },
    { ...approvedAccount(), approvedBy: "" }, { ...approvedAccount(), role: "admin", status: "suspended" },
    { ...approvedAccount(), email: other }]) {
    const fix = fixture();
    const saved = await fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } }));
    const options = await fix.service.uploadOptions(owner, saved.upload.pathname, saved.upload.clientPayload);
    fix.addVideo(saved.upload.pathname);
    if (account) fix.records.set(userPath(owner), { value: account, etag: "changed" });
    else fix.records.delete(userPath(owner));
    const writes = fix.writes.length;
    const response = await signedCallback(fix, { blob: { pathname: saved.upload.pathname }, tokenPayload: options.tokenPayload });
    assert.equal(response.statusCode, 403); assert.match(response.data.message, /not approved/);
    assert.equal(fix.writes.length, writes); assert.equal(fix.reads.length, 0);
    assert.equal(fix.records.get(metadataPath(owner, id)).value.video, undefined);
    await assert.rejects(fix.service.finalize(owner, id), /not approved/);
  }
});

test("signed callbacks finalize for approved customers and active existing administrators and owner", async () => {
  for (const account of [approvedAccount(), { email: owner, role: "admin", status: "active" },
    { email: OWNER_EMAIL, role: "owner", status: "active" }]) {
    const fix = fixture(), email = account.email;
    fix.records.set(userPath(email), { value: account, etag: "current" });
    const saved = await fix.service.save(email, input({ video: { type: "video/mp4", size: 128 } }));
    const options = await fix.service.uploadOptions(email, saved.upload.pathname, saved.upload.clientPayload);
    fix.addVideo(saved.upload.pathname);
    const response = await signedCallback(fix, { blob: { pathname: saved.upload.pathname }, tokenPayload: options.tokenPayload });
    assert.equal(response.statusCode, 200);
    assert.ok(fix.records.get(metadataPath(email, id)).value.video);
  }
});

test("approval revoked during media verification blocks the final metadata commit", async () => {
  const fix = fixture({ beforeGetBlob: records => {
    records.set(userPath(owner), { value: { ...approvedAccount(), status: "suspended" }, etag: "revoked" });
  } });
  const saved = await fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } }));
  const options = await fix.service.uploadOptions(owner, saved.upload.pathname, saved.upload.clientPayload);
  fix.addVideo(saved.upload.pathname);
  const writes = fix.writes.length;
  const response = await signedCallback(fix, { blob: { pathname: saved.upload.pathname }, tokenPayload: options.tokenPayload });
  assert.equal(response.statusCode, 403); assert.equal(fix.writes.length, writes);
  assert.equal(fix.records.get(metadataPath(owner, id)).value.video, undefined);
});

test("already finalized signed callbacks remain idempotent after approval is revoked without new writes", async () => {
  const fix = fixture();
  const saved = await fix.service.save(owner, input({ video: { type: "video/mp4", size: 128 } }));
  const options = await fix.service.uploadOptions(owner, saved.upload.pathname, saved.upload.clientPayload);
  fix.addVideo(saved.upload.pathname);
  const event = { blob: { pathname: saved.upload.pathname }, tokenPayload: options.tokenPayload };
  assert.equal((await signedCallback(fix, event)).statusCode, 200);
  const prior = structuredClone(fix.records.get(metadataPath(owner, id))), writes = fix.writes.length;
  fix.records.set(userPath(owner), { value: { ...approvedAccount(), status: "suspended" }, etag: "revoked" });
  assert.equal((await signedCallback(fix, event)).statusCode, 200);
  assert.equal(fix.writes.length, writes); assert.deepEqual(fix.records.get(metadataPath(owner, id)), prior);
  const ticket = { ...JSON.parse(options.tokenPayload), nonce: id };
  const altered = await signedCallback(fix, { ...event, tokenPayload: JSON.stringify(ticket) });
  assert.equal(altered.statusCode, 403); assert.equal(fix.writes.length, writes);
});
test("tampered private media paths and ignored upstream ranges never expose another file", async () => {
  const fix = fixture(); await uploaded(fix);
  const url = `/api/archive?action=media&id=${id}`;
  const ignored = await request(fix, { url, headers: { range: "bytes=0-3" }, dependencies: { getBlob: (path) => fix.getBlob(path, {}) } });
  assert.equal(ignored.statusCode, 502); assert.equal(ignored.headers["content-length"], undefined);
  fix.records.get(metadataPath(owner, id)).value.video.pathname = `auth/users/${digest(other)}.json`;
  const reads = fix.reads.length;
  const response = await request(fix, { url });
  assert.equal(response.statusCode, 409); assert.equal(fix.reads.length, reads);
});
test("upload rate limiting prevents token issuance", async () => {
  const fix = fixture(); let called = false;
  const response = await request(fix, { method: "POST", body: { type: "blob.generate-client-token", payload: {} }, dependencies: { limitAction: async () => false, handleUpload: async () => { called = true; } } });
  assert.equal(response.statusCode, 429); assert.equal(called, false);
});
test("archive pagination stays scoped even if an unexpected Blob path is returned", async () => {
  const fix = fixture();
  await fix.service.save(owner, input()); await fix.service.save(owner, input({ id: secondId })); await fix.service.save(other, input());
  const first = await fix.service.listArchive({ ownerEmail: owner, limit: 1 });
  const second = await fix.service.listArchive({ ownerEmail: owner, limit: 1, cursor: first.cursor });
  assert.equal(first.films.length, 1); assert.equal(second.films.length, 1); assert.notEqual(first.films[0].id, second.films[0].id);
  assert.equal(second.cursor, undefined);
  const maliciousListing = createArchiveService({ readRecord: async (path) => fix.records.get(path), listBlobs: async () => ({ blobs: [{ pathname: metadataPath(other, id) }], hasMore: false }) });
  assert.deepEqual((await maliciousListing.listArchive({ ownerEmail: owner })).films, []);
});
