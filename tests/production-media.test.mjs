import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { digest } from "../api/_lib/auth.mjs";
import { createFilmProductionService } from "../api/_lib/film-production.mjs";
import { parseRange, MAX_FILM_BYTES } from "../api/_lib/archive.mjs";
import { ProductionMediaError, streamProductionMedia, validateStoredProductionMedia } from "../api/_lib/production-media.mjs";

const owner = "family@example.invalid", other = "other@example.invalid";
const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const bytes = Buffer.from(Array.from({ length: 128 }, (_, index) => index));
const sha256 = digest(bytes);
const pathname = `production/media/${digest(owner)}/${id}/${sha256}.mp4`;
const completeJob = () => ({ id, ownerHash: digest(owner), status: "completed", media: {
  pathname, sha256, contentType: "video/mp4", sizeBytes: bytes.length, durationSeconds: 15,
} });

class ResponseCapture extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = 200; this.headersSent = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  _write(chunk, encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); done(); }
  get body() { return Buffer.concat(this.chunks); }
  get data() { return JSON.parse(this.body.toString()); }
}

function fixture({ job = completeJob(), changeResult, streamChunks } = {}) {
  const blobReads = [], recordReads = [], cancellations = [];
  const filmProduction = createFilmProductionService({ readRecordImpl: async path => {
    recordReads.push(path);
    return path === `production/jobs/${digest(owner)}/${id}.json` && job ? { value: structuredClone(job), etag: "job-etag" } : null;
  } });
  const getBlob = async (path, options) => {
    blobReads.push({ path, options });
    const range = parseRange(options.headers.Range, bytes.length);
    const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    const stream = new ReadableStream({
      start(controller) { for (const chunk of streamChunks || [body]) controller.enqueue(chunk); controller.close(); },
      cancel() { cancellations.push(path); },
    });
    const result = { statusCode: 200, stream,
      blob: { pathname: path, size: body.length, contentType: "video/mp4" },
      headers: new Headers({ "content-type": "video/mp4", "content-length": String(body.length), ...(range ? { "content-range": range.contentRange } : {}) }),
    };
    return changeResult ? changeResult(result) : result;
  };
  return { filmProduction, getBlob, blobReads, recordReads, cancellations };
}
async function request(fix, { method = "GET", email = owner, productionId = id, headers = {}, download = false, ...dependencies } = {}) {
  const res = new ResponseCapture();
  const req = { method, url: `/api/studio?action=productionMedia&id=${id}&url=https://untrusted.invalid/file`, headers };
  await streamProductionMedia({ req, res, email, id: productionId, filmProduction: fix.filmProduction, getBlob: fix.getBlob, download, ...dependencies });
  return res;
}

test("stored production media permits only the owner's completed hash-addressed MP4", () => {
  assert.deepEqual(validateStoredProductionMedia(completeJob(), owner.toUpperCase()), completeJob().media);
  for (const change of [
    { pathname: `production/media/${digest(other)}/${id}/${sha256}.mp4` },
    { pathname: `production/media/${digest(owner)}/${secondId}/${sha256}.mp4` },
    { pathname: `production/media/${digest(owner)}/${id}/${"a".repeat(64)}.mp4` },
    { pathname: `${pathname}/../../auth/users` },
    { pathname: pathname.replace(".mp4", ".webm"), contentType: "video/webm" },
    { pathname: `https://example.invalid/${pathname}` },
    { pathname: pathname.replace("/media/", "/media%2f") },
    { contentType: "text/html" }, { sha256: "A".repeat(64) },
    { sizeBytes: 15 }, { sizeBytes: MAX_FILM_BYTES + 1 }, { sizeBytes: 1.1 },
    { durationSeconds: 0 }, { durationSeconds: Infinity }, { durationSeconds: 601 },
  ]) {
    const job = completeJob(); Object.assign(job.media, change);
    assert.throws(() => validateStoredProductionMedia(job, owner), ProductionMediaError);
  }
  for (const change of [{ ownerHash: digest(other) }, { status: "processing" }, { media: undefined }, { id: "../other" }]) {
    assert.throws(() => validateStoredProductionMedia({ ...completeJob(), ...change }, owner), ProductionMediaError);
  }
});

test("GET authorizes the persisted job then streams private media without exposing its storage URL", async () => {
  const fix = fixture(), res = await request(fix, { email: owner.toUpperCase() });
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, bytes);
  assert.deepEqual(fix.recordReads, [`production/jobs/${digest(owner)}/${id}.json`]);
  assert.deepEqual(fix.blobReads, [{ path: pathname, options: { access: "private", useCache: false, headers: { "accept-encoding": "identity" } } }]);
  assert.equal(res.headers["cache-control"], "private, no-store"); assert.equal(res.headers.vary, "Cookie");
  assert.equal(res.headers["x-content-type-options"], "nosniff"); assert.equal(res.headers["content-type"], "video/mp4");
  assert.equal(res.headers["accept-ranges"], "bytes"); assert.equal(res.headers["content-length"], "128");
  assert.equal(res.headers.etag, `"sha256-${sha256}"`);
  assert.equal(res.headers["content-disposition"], `inline; filename="${id}.mp4"`);
  assert.equal(JSON.stringify(res.headers).includes("production/media"), false);
});

test("download uses only a fixed safe filename derived from the production id", async () => {
  const res = await request(fixture(), { download: true });
  assert.equal(res.headers["content-disposition"], `attachment; filename="${id}.mp4"`);
});

test("cross-account, missing, unfinished and corrupted jobs never fetch a Blob", async () => {
  const scenarios = [
    { options: { email: other }, status: 404 }, { options: { productionId: secondId }, status: 404 },
    { options: { productionId: `https://example.invalid/${id}` }, status: 400 },
    { options: { email: "../family@example.invalid" }, status: 404 },
    { job: null, status: 404 }, { job: { ...completeJob(), status: "awaiting-assembly" }, status: 409 },
    { job: { ...completeJob(), ownerHash: digest(other) }, status: 404 },
    { job: { ...completeJob(), id: secondId }, status: 404 },
    { job: { ...completeJob(), media: { ...completeJob().media, pathname: "auth/users/private.json" } }, status: 409 },
  ];
  for (const scenario of scenarios) {
    const fix = fixture(Object.hasOwn(scenario, "job") ? { job: scenario.job } : {});
    const res = await request(fix, scenario.options);
    assert.equal(res.statusCode, scenario.status); assert.equal(fix.blobReads.length, 0);
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.equal(res.body.toString().includes("production/media"), false);
  }
});

test("valid byte ranges are normalized and return only the requested bytes", async () => {
  for (const [range, start, end] of [["bytes=0-3", 0, 3], ["bytes=120-", 120, 127], ["bytes=-4", 124, 127], ["bytes=120-999", 120, 127]]) {
    const fix = fixture(), res = await request(fix, { headers: { range } });
    assert.equal(res.statusCode, 206); assert.deepEqual(res.body, bytes.subarray(start, end + 1));
    assert.equal(res.headers["content-range"], `bytes ${start}-${end}/128`);
    assert.equal(res.headers["content-length"], String(end - start + 1));
    assert.equal(fix.blobReads[0].options.headers.Range, `bytes=${start}-${end}`);
  }
});

test("malformed, multiple and unsatisfiable ranges return 416 without reading media", async () => {
  for (const range of ["bytes=128-", "bytes=-0", "bytes=4-2", "bytes=0-1,4-5", "bytes=-", "items=0-3", ["bytes=0-1"]]) {
    const fix = fixture(), res = await request(fix, { headers: { range } });
    assert.equal(res.statusCode, 416); assert.equal(res.headers["content-range"], "bytes */128");
    assert.equal(res.body.length, 0); assert.equal(fix.blobReads.length, 0);
  }
});

test("If-Range returns a range only for the exact strong media validator", async () => {
  const strong = `"sha256-${sha256}"`;
  for (const [validator, expected] of [[strong, 206], [`W/${strong}`, 200], ['"older-film"', 200], ["Wed, 01 Jan 2025 00:00:00 GMT", 200]]) {
    const fix = fixture(), res = await request(fix, { headers: { range: "bytes=0-3", "if-range": validator } });
    assert.equal(res.statusCode, expected);
    assert.deepEqual(res.body, expected === 206 ? bytes.subarray(0, 4) : bytes);
  }
});

test("HEAD checks private storage metadata and cancels the upstream body", async () => {
  for (const headers of [{}, { range: "bytes=4-7" }]) {
    const fix = fixture(), res = await request(fix, { method: "HEAD", headers });
    assert.equal(res.statusCode, headers.range ? 206 : 200); assert.equal(res.body.length, 0);
    assert.equal(res.headers["content-length"], headers.range ? "4" : "128");
    assert.deepEqual(fix.cancellations, [pathname]); assert.equal(fix.blobReads.length, 1);
  }
  const res = await request(fixture({ job: null }), { method: "HEAD" });
  assert.equal(res.statusCode, 404); assert.equal(res.body.length, 0);
});

test("mismatched Blob metadata is rejected and the unread upstream stream is canceled", async () => {
  for (const changeResult of [
    result => ({ ...result, statusCode: 206 }),
    result => ({ ...result, blob: { ...result.blob, pathname: "auth/users/other.json" } }),
    result => ({ ...result, blob: { ...result.blob, contentType: "text/html" } }),
    result => ({ ...result, blob: { ...result.blob, size: 127 } }),
    result => { result.headers.set("content-type", "text/html"); return result; },
    result => { result.headers.delete("content-length"); return result; },
    result => { result.headers.set("content-length", "127"); return result; },
    result => { result.headers.set("content-range", "bytes 0-127/128"); return result; },
    result => { result.headers.set("content-encoding", "gzip"); return result; },
  ]) {
    const fix = fixture({ changeResult }), res = await request(fix);
    assert.equal(res.statusCode, 502); assert.match(res.data.message, /could not be loaded safely/);
    assert.deepEqual(fix.cancellations, [pathname]); assert.equal(res.headers["content-length"], undefined);
    assert.equal(res.headers["content-disposition"], undefined); assert.equal(res.headers.etag, undefined);
    assert.equal(res.headers["content-type"], "application/json");
  }
});

test("an ignored or wrong upstream Range cannot masquerade as a successful partial response", async () => {
  for (const changeResult of [
    result => { result.headers.delete("content-range"); return result; },
    result => { result.headers.set("content-range", "bytes 1-4/128"); return result; },
    result => { result.headers.set("content-range", "bytes 0-3/999"); return result; },
    result => ({ ...result, blob: { ...result.blob, size: 128 } }),
  ]) {
    const fix = fixture({ changeResult }), res = await request(fix, { headers: { range: "bytes=0-3" } });
    assert.equal(res.statusCode, 502); assert.deepEqual(fix.cancellations, [pathname]);
    assert.equal(res.headers["content-range"], undefined);
  }
});

test("missing blobs and unexpected provider failures return sanitized errors", async () => {
  const missing = await request(fixture(), { getBlob: async () => null });
  assert.equal(missing.statusCode, 404);
  for (const dependencies of [
    { getBlob: async () => { throw new Error("Secret upstream token and private storage URL"); } },
    { filmProduction: { getPrepared: async () => { throw new Error("Private job record and user sources"); } } },
  ]) {
    const res = await request(fixture(), dependencies);
    assert.equal(res.statusCode, 503); assert.equal(res.data.message, "The finished film is currently unavailable. Please retry.");
  }
});

test("actual stream lengths are enforced after headers so partial or oversized transfers terminate", async () => {
  for (const streamChunks of [[bytes.subarray(0, 127)], [bytes.subarray(0, 64), Buffer.alloc(65)]]) {
    const fix = fixture({ streamChunks }), res = await request(fix);
    assert.equal(res.destroyed, true); assert.ok(res.body.length < 128);
    assert.equal(res.body.includes(Buffer.from("currently unavailable")), false);
  }
});

test("unsupported methods fail before reading any job or media", async () => {
  const fix = fixture(), res = await request(fix, { method: "POST" });
  assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, "GET, HEAD");
  assert.equal(fix.recordReads.length, 0); assert.equal(fix.blobReads.length, 0);
});
