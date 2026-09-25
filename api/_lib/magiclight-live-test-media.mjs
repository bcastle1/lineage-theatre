import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get, put } from "@vercel/blob";
import { digest, readRecord, writeRecord } from "./auth.mjs";
import { parseRange } from "./archive.mjs";
import { magiclightLiveTest, MagicLightLiveTestError } from "./magiclight-live-test.mjs";

export const MAGICLIGHT_TEST_MEDIA_PATH = "integrations/magiclight/operator-test-v1-media.json";
export const MAX_TEST_MEDIA_BYTES = 100 * 1024 * 1024;
// Add an exact CDN host only after observing it in the saved provider result.
export const MAGICLIGHT_TEST_OUTPUT_HOSTS = Object.freeze([]);
const HASH = /^[a-f0-9]{64}$/;
const failure = (code = "MAGICLIGHT_TEST_MEDIA_UNAVAILABLE", status = 503) =>
  new MagicLightLiveTestError(code, status, "The saved test clip could not be delivered. Refresh its status and retry the import; no new generation will be submitted.");
const identity = test => ({ testId: test.id, ownerHash: digest(test.ownerEmail), fixtureHash: test.fixtureHash,
  taskHash: digest(test.taskId), sourceHash: digest(test.videoUrl) });
const mediaPath = (test, sha) => `integrations/magiclight/media/${digest(test.ownerEmail)}/${test.id}/${sha}.mp4`;

export function testMediaSource(value, hosts = MAGICLIGHT_TEST_OUTPUT_HOSTS) {
  let url;
  try { url = new URL(value); } catch { throw failure("MAGICLIGHT_TEST_MEDIA_HOST_UNAPPROVED", 409); }
  if (typeof value !== "string" || value.length > 8192 || url.protocol !== "https:" || url.username || url.password
    || url.hash || url.port || !hosts.includes(url.hostname)) throw failure("MAGICLIGHT_TEST_MEDIA_HOST_UNAPPROVED", 409);
  return url.href;
}
async function boundedBytes(stream, { expected, signal, limit = MAX_TEST_MEDIA_BYTES } = {}) {
  if (!stream) throw failure();
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 16 || expected > limit)) {
    await stream.cancel().catch(() => {}); throw failure();
  }
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw failure("MAGICLIGHT_TEST_MEDIA_TIMEOUT", 504);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw failure("MAGICLIGHT_TEST_MEDIA_TIMEOUT", 504);
      if (done) break;
      size += value.byteLength;
      if (size > limit || (expected !== undefined && size > expected)) throw failure("MAGICLIGHT_TEST_MEDIA_TOO_LARGE", 502);
      chunks.push(Buffer.from(value));
    }
    if (size < 16 || (expected !== undefined && size !== expected)) throw failure();
    return Buffer.concat(chunks, size);
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function checkMp4(bytes) {
  const size = bytes.readUInt32BE(0);
  if (bytes.toString("ascii", 4, 8) !== "ftyp" || size < 16 || size > bytes.length || size > 4096)
    throw failure("MAGICLIGHT_TEST_MEDIA_INVALID", 502);
}
function validMetadata(value, test) {
  const binding = identity(test);
  if (!value || value.version !== 1 || Object.entries(binding).some(([key, val]) => value[key] !== val)
    || !HASH.test(value.sha256 || "") || value.pathname !== mediaPath(test, value.sha256)
    || value.contentType !== "video/mp4" || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 16 || value.sizeBytes > MAX_TEST_MEDIA_BYTES
    || (value.downloadSourceHash !== undefined && !HASH.test(value.downloadSourceHash))
    || typeof value.importedAt !== "string" || !Number.isFinite(Date.parse(value.importedAt))) throw failure("MAGICLIGHT_TEST_MEDIA_INVALID", 409);
  return value;
}
function blobMatches(result, media, range) {
  const length = range?.length ?? media.sizeBytes;
  return result?.stream && result.statusCode === 200 && result.blob?.pathname === media.pathname
    && result.blob?.contentType === "video/mp4" && result.blob?.size === length
    && result.headers?.get("content-type") === "video/mp4" && result.headers?.get("content-length") === String(length)
    && result.headers?.get("content-range") === (range?.contentRange ?? null)
    && [null, "identity"].includes(result.headers?.get("content-encoding"));
}

export function createMagicLightTestMediaService({ liveTest = magiclightLiveTest, read = readRecord, write = writeRecord,
  getBlob = get, putBlob = put, fetchImpl = fetch, now = Date.now, timeoutMs = 45_000,
  approvedHosts = MAGICLIGHT_TEST_OUTPUT_HOSTS } = {}) {
  async function stored(test) {
    let result;
    try { result = await read(MAGICLIGHT_TEST_MEDIA_PATH); } catch { throw failure(); }
    return result ? validMetadata(result.value, test) : null;
  }
  async function binding(actor, expected) {
    const current = await liveTest.completedForMedia(actor);
    if (expected && JSON.stringify(identity(current)) !== JSON.stringify(identity(expected))) throw failure("MAGICLIGHT_TEST_MEDIA_CHANGED", 409);
    return current;
  }
  async function state(actor, current) {
    const result = current ?? await liveTest.status(actor);
    if (result.test?.status !== "completed") return { ...result, media: { ready: false } };
    const test = await binding(actor), media = await stored(test);
    await binding(actor, test);
    return { ...result, media: media ? { ready: true, sizeBytes: media.sizeBytes, sha256: media.sha256 } : { ready: false } };
  }
  async function importClip(actor) {
    const test = await binding(actor);
    if (await stored(test)) return state(actor);
    let source = testMediaSource(test.videoUrl, approvedHosts);
    await binding(actor, test);
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
    let bytes;
    try {
      const download = () => fetchImpl(source, { method: "GET", redirect: "error", credentials: "omit",
        headers: { Accept: "video/mp4, application/octet-stream", "Accept-Encoding": "identity" }, signal: abort.signal });
      let response = await download();
      // A denied or expired link can be recovered once through the same saved
      // task. Never retry generation, follow redirects, or retain a signed URL
      // in public metadata. The original completion binding stays immutable.
      if ([401, 403, 404, 410].includes(response.status) && !response.redirected && (!response.url || response.url === source)) {
        await response.body?.cancel().catch(() => {});
        if (abort.signal.aborted) throw failure("MAGICLIGHT_TEST_MEDIA_TIMEOUT", 504);
        await binding(actor, test);
        const renewed = await liveTest.refreshMediaSource(actor);
        if (abort.signal.aborted) throw failure("MAGICLIGHT_TEST_MEDIA_TIMEOUT", 504);
        await binding(actor, test);
        source = testMediaSource(renewed, approvedHosts);
        response = await download();
      }
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const length = response.headers.get("content-length");
      if (response.status !== 200 || response.redirected || (response.url && response.url !== source)
        || !["video/mp4", "application/octet-stream"].includes(type)
        || ![null, "identity"].includes(response.headers.get("content-encoding"))
        || response.headers.get("content-range") || (length !== null && !/^[0-9]+$/.test(length))) {
        await response.body?.cancel().catch(() => {}); throw failure("MAGICLIGHT_TEST_MEDIA_INVALID", 502);
      }
      bytes = await boundedBytes(response.body, { expected: length === null ? undefined : Number(length), signal: abort.signal });
      checkMp4(bytes);
    } catch (error) {
      if (error instanceof MagicLightLiveTestError) throw error;
      throw failure(abort.signal.aborted ? "MAGICLIGHT_TEST_MEDIA_TIMEOUT" : "MAGICLIGHT_TEST_MEDIA_UNAVAILABLE");
    } finally { clearTimeout(timer); }
    await binding(actor, test);
    const sha256 = digest(bytes), media = { version: 1, ...identity(test), pathname: mediaPath(test, sha256),
      sha256, downloadSourceHash: digest(source), sizeBytes: bytes.length, contentType: "video/mp4", importedAt: new Date(now()).toISOString() };
    // Create-only content and metadata permit retrying delivery, never generation.
    const storageAbort = new AbortController(), storageTimer = setTimeout(() => storageAbort.abort(), timeoutMs);
    let copy;
    try {
      try { await putBlob(media.pathname, bytes, { access: "private", contentType: "video/mp4", addRandomSuffix: false,
        allowOverwrite: false, cacheControlMaxAge: 60, abortSignal: storageAbort.signal }); } catch { /* Verify an existing identical immutable copy below. */ }
      if (storageAbort.signal.aborted) throw failure();
      copy = await getBlob(media.pathname, { access: "private", useCache: false, headers: { "accept-encoding": "identity" }, abortSignal: storageAbort.signal });
      if (!blobMatches(copy, media)) throw failure();
      const verify = await boundedBytes(copy.stream, { expected: bytes.length, signal: storageAbort.signal });
      copy = undefined;
      if (digest(verify) !== sha256) throw failure();
    } catch { throw failure(); }
    finally { clearTimeout(storageTimer); await copy?.stream?.cancel().catch(() => {}); }
    await binding(actor, test);
    try { await write(MAGICLIGHT_TEST_MEDIA_PATH, media); } catch { /* Readback resolves a race or lost committed reply. */ }
    const saved = await stored(test);
    if (!saved || saved.sha256 !== sha256 || saved.sizeBytes !== bytes.length) throw failure();
    return state(actor);
  }
  async function stream({ actor, req, res, download = false }) {
    let upstream;
    res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Vary", "Cookie");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (!["GET", "HEAD"].includes(req.method)) throw failure("MAGICLIGHT_TEST_MEDIA_METHOD", 405);
      const test = await binding(actor), media = await stored(test);
      if (!media) throw failure("MAGICLIGHT_TEST_MEDIA_NOT_IMPORTED", 404);
      const etag = `"sha256-${media.sha256}"`;
      let range;
      try { range = parseRange(req.headers?.["if-range"] && req.headers["if-range"] !== etag ? null : req.headers?.range, media.sizeBytes); }
      catch (error) {
        if (error.status !== 416) throw error;
        res.statusCode = 416; res.setHeader("Content-Range", `bytes */${media.sizeBytes}`); res.setHeader("Accept-Ranges", "bytes"); return res.end();
      }
      upstream = await getBlob(media.pathname, { access: "private", useCache: false,
        headers: { "accept-encoding": "identity", ...(range ? { Range: range.header } : {}) } });
      if (!blobMatches(upstream, media, range)) throw failure();
      await binding(actor, test);
      const length = range?.length ?? media.sizeBytes;
      res.statusCode = range ? 206 : 200;
      res.setHeader("Content-Type", "video/mp4"); res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(length)); res.setHeader("ETag", etag);
      res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="lineage-fictional-test.mp4"`);
      if (range) res.setHeader("Content-Range", range.contentRange);
      if (req.method === "HEAD") { await upstream.stream.cancel(); upstream = undefined; return res.end(); }
      let received = 0;
      const exactLength = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length; callback(received > length ? failure() : null, chunk);
      }, flush(callback) { callback(received === length ? undefined : failure()); } });
      const source = Readable.fromWeb(upstream.stream); upstream = undefined;
      await pipeline(source, exactLength, res);
    } catch (error) {
      await upstream?.stream?.cancel().catch(() => {});
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      for (const header of ["Content-Length", "Content-Range", "Content-Disposition", "ETag", "Accept-Ranges"]) res.removeHeader?.(header);
      const safe = error instanceof MagicLightLiveTestError ? error : failure();
      res.statusCode = safe.status; res.setHeader("Content-Type", "application/json");
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ code: safe.code, message: safe.message }));
    }
  }
  return Object.freeze({ state, importClip, stream });
}
