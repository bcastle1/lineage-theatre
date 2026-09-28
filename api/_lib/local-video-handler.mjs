import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "@vercel/blob";
import { json, readBody, sameOrigin, getSession, limitAction } from "./auth.mjs";
import { parseRange } from "./archive.mjs";
import { localVideo, LocalVideoError } from "./local-video.mjs";

function workerAuthorized(req, key) {
  const given = req.headers.authorization;
  return typeof key === "string" && key.length >= 40 && typeof given === "string"
    && Buffer.byteLength(given) === Buffer.byteLength(`Bearer ${key}`)
    && timingSafeEqual(Buffer.from(given), Buffer.from(`Bearer ${key}`));
}
export function createLocalVideoHandler({ service = localVideo, sessionFor = getSession, limiter = limitAction, getBlob = get,
  workerKey = () => process.env.LINEAGE_LOCAL_VIDEO_WORKER_KEY } = {}) {
  async function stream(req, res, media, download) {
    const range = parseRange(req.headers.range, media.sizeBytes);
    const result = await getBlob(media.pathname, { access: "private", useCache: false,
      headers: { "accept-encoding": "identity", ...(range ? { Range: range.header } : {}) } });
    if (!result?.stream || result.blob.pathname !== media.pathname || result.blob.contentType !== media.contentType
      || result.blob.size !== (range?.length ?? media.sizeBytes) || result.headers.get("content-range") !== (range?.contentRange ?? null)) {
      await result?.stream?.cancel(); throw new LocalVideoError("The video could not be loaded. Please retry.", 503);
    }
    res.statusCode = range ? 206 : 200;
    res.setHeader("Content-Type", media.contentType);
    res.setHeader("Content-Length", String(range?.length ?? media.sizeBytes));
    res.setHeader("Accept-Ranges", "bytes");
    if (range) res.setHeader("Content-Range", range.contentRange);
    if (download) res.setHeader("Content-Disposition", 'attachment; filename="family-archive-film.mp4"');
    if (req.method === "HEAD") { await result.stream.cancel(); return res.end(); }
    return pipeline(Readable.fromWeb(result.stream), res);
  }
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie, Authorization");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(req.url, `https://${req.headers.host}`), action = url.searchParams.get("action");
      if (url.searchParams.get("worker") === "1") {
        if (!workerAuthorized(req, workerKey())) return json(res, 401, { message: "Worker authentication required." });
        if (req.method === "GET" && action === "source")
          return await stream(req, res, await service.source(url.searchParams.get("id"), req.headers["x-render-claim"], url.searchParams.get("photo")), false);
        if (req.method !== "POST") return json(res, 405, { message: "Method not allowed." });
        const body = await readBody(req, 4096);
        const result = body.action === "poll" ? await service.poll()
          : body.action === "progress" ? await service.progress(body.id, body.claim, body.progress)
          : body.action === "upload" ? await service.upload(body.id, body.claim, body.report)
          : body.action === "complete" ? await service.complete(body.id, body.claim, body.report)
          : body.action === "failed" ? await service.failed(body.id, body.claim)
          : null;
        if (!result) throw new LocalVideoError("Unknown worker action.");
        return json(res, 200, result);
      }
      const session = await sessionFor(req);
      if (!session || session.user.mustChangePassword) return json(res, 401, { message: "Sign in to create or watch your film." });
      if (req.method === "POST") {
        if (!sameOrigin(req)) return json(res, 403, { message: "Start the render inside Lineage Theatre." });
        if (!(await limiter(`local-video:${session.user.email}`, 12, 86400_000))) return json(res, 429, { message: "Your daily free-render limit is reached. Existing films remain available." });
        return json(res, 202, await service.start(session.user, await readBody(req, 100_000)));
      }
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { message: "Method not allowed." });
      if (action === "capabilities" && req.method === "GET") return json(res, 200, await service.capabilities());
      if (action === "history" && req.method === "GET") return json(res, 200, await service.history(session.user));
      if (action === "status" && req.method === "GET") return json(res, 200, await service.status(session.user, url.searchParams.get("id")));
      if (action === "video") return await stream(req, res, await service.video(session.user, url.searchParams.get("id")), url.searchParams.get("download") === "1");
      throw new LocalVideoError("Choose a local film action.");
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      for (const header of ["Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"]) res.removeHeader?.(header);
      return json(res, error instanceof LocalVideoError ? error.status : error?.status === 416 ? 416 : 503,
        { message: error instanceof LocalVideoError ? error.message : "Local film rendering is temporarily unavailable. Your draft is saved." });
    }
  };
}
export const localVideoHandler = createLocalVideoHandler();
