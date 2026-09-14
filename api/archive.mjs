import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { getSession, sameOrigin, json, readBody, limitAction } from "./_lib/auth.mjs";
import { hasAdminAccess } from "./_lib/access.mjs";
import { archive, archiveOwner, archiveId, mediaPath, parseRange, ArchiveError } from "./_lib/archive.mjs";

export function createArchiveHandler(dependencies = {}) {
  const service = dependencies.archive || archive;
  const sessionFor = dependencies.getSession || getSession;
  const adminAccess = dependencies.hasAdminAccess || hasAdminAccess;
  const uploadHandler = dependencies.handleUpload || handleUpload;
  const limiter = dependencies.limitAction || limitAction;
  const getBlob = dependencies.getBlob || get;
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, `https://${req.headers.host}`);
      if (req.method === "POST") {
        const body = await readBody(req, 16_384);
        if (body.type === "blob.upload-completed") {
          // Vercel's helper verifies x-vercel-signature before invoking our callback.
          const result = await uploadHandler({ request: req, body,
            onBeforeGenerateToken: async () => { throw new ArchiveError("Invalid callback.", 403); },
            onUploadCompleted: (event) => service.completeUpload(event),
          });
          return json(res, 200, result);
        }
        const session = await sessionFor(req);
        if (!session) return json(res, 401, { message: "Sign in to save your private cloud films." });
        if (!sameOrigin(req)) return json(res, 403, { message: "Begin this action inside Lineage Theatre." });
        const owner = archiveOwner(session.user.email);
        if (body.type === "blob.generate-client-token") {
          if (!(await limiter(`archive-upload:${owner}`, 10, 3600_000))) throw new ArchiveError("Your hourly cloud-upload limit is reached. Try again later.", 429);
          const result = await uploadHandler({ request: req, body,
            onBeforeGenerateToken: (pathname, clientPayload) => service.uploadOptions(owner, pathname, clientPayload),
            onUploadCompleted: (event) => service.completeUpload(event),
          });
          return json(res, 200, result);
        }
        if (!(await limiter(`archive-save:${owner}`, 100, 3600_000))) throw new ArchiveError("Your hourly archive limit is reached. Try again later.", 429);
        if (body.action === "save") return json(res, 200, await service.save(owner, body));
        if (body.action === "finalize") return json(res, 200, { film: await service.finalize(owner, body.id) });
        return json(res, 400, { message: "Unknown cloud archive action." });
      }
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { message: "Method not allowed." });
      const session = await sessionFor(req);
      if (!session) return json(res, 401, { message: "Sign in to view your private cloud films." });
      const owner = archiveOwner(session.user.email);
      const action = url.searchParams.get("action") || "list";
      if (action === "list" && req.method === "GET")
        return json(res, 200, await service.listArchive({ ownerEmail: owner, cursor: url.searchParams.get("cursor") || undefined }));
      if (action === "admin" && req.method === "GET") {
        if (!adminAccess(session.user)) return json(res, 403, { message: "Administrator access is required." });
        return json(res, 200, await service.listArchive({ cursor: url.searchParams.get("cursor") || undefined }));
      }
      if (action !== "media") return json(res, 400, { message: "Unknown cloud archive action." });
      const filmOwner = archiveOwner(url.searchParams.get("owner") || owner);
      if (filmOwner !== owner && !adminAccess(session.user)) return json(res, 403, { message: "This film is private to its owner and administrators." });
      const id = archiveId(url.searchParams.get("id"));
      const film = (await service.readFilm(filmOwner, id)).value;
      const video = film.video;
      if (!video) return json(res, 404, { message: "This cloud film has no uploaded video yet." });
      if (video.pathname !== mediaPath(filmOwner, id, video.contentType)) throw new ArchiveError("The archived video could not be opened.", 409);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Cookie");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", video.contentType);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Disposition", `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${id}.${video.contentType === "video/mp4" ? "mp4" : "webm"}"`);
      let range;
      try { range = parseRange(req.headers["if-range"] && req.headers["if-range"] !== video.etag ? null : req.headers.range, video.size); }
      catch (error) {
        if (error.status === 416) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${video.size}`); return res.end(); }
        throw error;
      }
      res.statusCode = range ? 206 : 200;
      res.setHeader("Content-Length", String(range?.length ?? video.size));
      if (range) res.setHeader("Content-Range", range.contentRange);
      if (video.etag) res.setHeader("ETag", video.etag);
      if (req.method === "HEAD") return res.end();
      const result = await getBlob(video.pathname, { access: "private", headers: range ? { Range: range.header } : undefined });
      if (!result?.stream) throw new ArchiveError("The archived video is currently unavailable.", 404);
      // The SDK reports statusCode 200 for range responses; verify Content-Range itself.
      if ((range && result.headers.get("content-range") !== range.contentRange) || result.blob.size !== (range?.length ?? video.size)) {
        await result.stream.cancel();
        throw new ArchiveError("The archived video range could not be loaded. Please retry.", 502);
      }
      await pipeline(Readable.fromWeb(result.stream), res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.removeHeader?.("Content-Length"); res.removeHeader?.("Content-Range");
      res.removeHeader?.("Content-Disposition"); res.removeHeader?.("ETag");
      const callbackError = /callback signature/i.test(error?.message || "");
      return json(res, error instanceof ArchiveError ? error.status : callbackError ? 403 : 503, {
        message: error instanceof ArchiveError ? error.message : callbackError ? "The upload callback could not be verified." : "The cloud archive could not complete this action. Your local project is unchanged.",
      });
    }
  };
}
export default createArchiveHandler();
