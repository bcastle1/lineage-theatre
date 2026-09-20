import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "@vercel/blob";
import { digest } from "./auth.mjs";
import { parseRange, MAX_FILM_BYTES } from "./archive.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;

export class ProductionMediaError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const unavailable = () => new ProductionMediaError("The finished film is currently unavailable. Please retry.", 503);
const notFound = () => new ProductionMediaError("This finished film was not found.", 404);
const invalidMedia = () => new ProductionMediaError("The finished film needs playback verification.", 409);
function mediaOwner(email) {
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email)) throw notFound();
  return email.toLowerCase();
}

// Only a completed server job can name a media object. A prefix match alone
// would permit sibling files, traversal, or a client-supplied provider URL.
export function validateStoredProductionMedia(job, email) {
  const ownerHash = digest(mediaOwner(email));
  if (!job || !UUID.test(job.id || "") || job.ownerHash !== ownerHash) throw notFound();
  if (job.status !== "completed") throw new ProductionMediaError("This film is not ready to watch yet.", 409);
  const media = job.media;
  if (!media || !HASH.test(media.sha256 || "") || media.contentType !== "video/mp4"
    || media.pathname !== `production/media/${ownerHash}/${job.id}/${media.sha256}.mp4`
    || !Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 16 || media.sizeBytes > MAX_FILM_BYTES
    || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0 || media.durationSeconds > 600) throw invalidMedia();
  return Object.fromEntries(["pathname", "sha256", "contentType", "sizeBytes", "durationSeconds"].map(key => [key, media[key]]));
}

function exactLength(expected) {
  let received = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > expected) return callback(unavailable());
      callback(null, chunk);
    },
    flush(callback) { callback(received === expected ? undefined : unavailable()); },
  });
}

function sendError(req, res, error) {
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  for (const name of ["Content-Length", "Content-Range", "Content-Disposition", "ETag", "Accept-Ranges"]) res.removeHeader?.(name);
  const known = error instanceof ProductionMediaError ? error
    : error?.code === "PRODUCTION_NOT_FOUND" ? notFound() : unavailable();
  res.statusCode = known.status;
  res.setHeader("Content-Type", "application/json");
  res.end(req.method === "HEAD" ? undefined : JSON.stringify({ message: known.message }));
}

// The caller must obtain email from its authenticated session. No URL or path
// from the request is passed to Blob; getPrepared scopes the job to that user.
export async function streamProductionMedia({ req, res, email, id, filmProduction, getBlob = get, download = false }) {
  let upstream;
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Allow", "GET, HEAD");
      throw new ProductionMediaError("Method not allowed.", 405);
    }
    const owner = mediaOwner(email);
    if (typeof id !== "string" || !UUID.test(id)) throw new ProductionMediaError("Choose a valid production reference.", 400);
    const job = await filmProduction.getPrepared({ email: owner, id });
    if (job?.id !== id) throw notFound();
    const media = validateStoredProductionMedia(job, owner);
    const etag = `"sha256-${media.sha256}"`;
    let range;
    try {
      range = parseRange(req.headers?.["if-range"] && req.headers["if-range"] !== etag ? null : req.headers?.range, media.sizeBytes);
    } catch (error) {
      if (error.status !== 416) throw error;
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${media.sizeBytes}`);
      res.setHeader("Accept-Ranges", "bytes");
      return res.end();
    }
    const expectedLength = range?.length ?? media.sizeBytes;
    upstream = await getBlob(media.pathname, {
      access: "private", useCache: false,
      headers: { "accept-encoding": "identity", ...(range ? { Range: range.header } : {}) },
    });
    if (!upstream?.stream) throw notFound();
    // Blob's SDK normalizes even 206 responses to statusCode 200. Verify the
    // actual range and metadata instead of relying on that normalized status.
    if (upstream.statusCode !== 200 || upstream.blob?.pathname !== media.pathname
      || upstream.blob?.contentType !== media.contentType || upstream.blob?.size !== expectedLength
      || upstream.headers?.get("content-type") !== media.contentType
      || upstream.headers?.get("content-length") !== String(expectedLength)
      || upstream.headers?.get("content-range") !== (range?.contentRange ?? null)
      || ![null, "identity"].includes(upstream.headers?.get("content-encoding"))) {
      throw new ProductionMediaError("The finished film could not be loaded safely. Please retry.", 502);
    }
    res.statusCode = range ? 206 : 200;
    res.setHeader("Content-Type", media.contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(expectedLength));
    res.setHeader("Content-Disposition", `${download === true ? "attachment" : "inline"}; filename="${id}.mp4"`);
    res.setHeader("ETag", etag);
    if (range) res.setHeader("Content-Range", range.contentRange);
    if (req.method === "HEAD") {
      await upstream.stream.cancel();
      upstream = undefined;
      return res.end();
    }
    const source = Readable.fromWeb(upstream.stream);
    upstream = undefined;
    await pipeline(source, exactLength(expectedLength), res);
  } catch (error) {
    if (upstream?.stream) await upstream.stream.cancel().catch(() => {});
    return sendError(req, res, error);
  }
}
