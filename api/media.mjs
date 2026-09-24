import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import {
  getSession,
  sameOrigin,
  json,
  readBody,
  limitAction,
} from "./_lib/auth.mjs";
import { parseRange } from "./_lib/archive.mjs";
import { mediaLibrary, MediaError } from "./_lib/media-library.mjs";

export function createMediaHandler({
  service = mediaLibrary,
  sessionFor = getSession,
  limiter = limitAction,
  uploadHandler = handleUpload,
  getBlob = get,
} = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (!["GET", "HEAD", "POST"].includes(req.method))
        return json(res, 405, { message: "Method not allowed." });
      const body = req.method === "POST" ? await readBody(req, 16_384) : null;
      if (body?.type === "blob.upload-completed") {
        return json(
          res,
          200,
          await uploadHandler({
            request: req,
            body,
            onBeforeGenerateToken: async () => {
              throw new MediaError("Invalid callback.", 403);
            },
            onUploadCompleted: (event) => service.completeUpload(event),
          }),
        );
      }
      const session = await sessionFor(req);
      if (!session || session.user.mustChangePassword)
        return json(res, 401, {
          message: "Sign in to access your media library.",
        });
      const actor = session.user;
      if (req.method === "POST") {
        if (!sameOrigin(req))
          return json(res, 403, {
            message: "Begin this action inside Lineage Theatre.",
          });
        if (!(await limiter(`media-write:${actor.email}`, 300, 3600_000)))
          throw new MediaError(
            "Please wait before making more media changes.",
            429,
          );
        if (body?.type === "blob.generate-client-token")
          return json(
            res,
            200,
            await uploadHandler({
              request: req,
              body,
              onBeforeGenerateToken: (pathname, payload) =>
                service.uploadOptions(actor, pathname, payload),
              onUploadCompleted: (event) => service.completeUpload(event),
            }),
          );
        if (body?.action === "reserve")
          return json(res, 200, await service.reserve(actor, body));
        if (body?.action === "finalize")
          return json(res, 200, {
            item: await service.finalize(actor.email, body.id),
          });
        return json(res, 200, await service.organize(actor, body || {}));
      }
      const url = new URL(req.url, `https://${req.headers.host}`),
        action = url.searchParams.get("action") || "list";
      if (action === "list" && req.method === "GET")
        return json(
          res,
          200,
          await service.listMedia(actor, {
            admin: url.searchParams.get("scope") === "admin",
            view: url.searchParams.get("view") || "active",
            cursor: url.searchParams.get("cursor") || undefined,
          }),
        );
      if (action !== "file")
        throw new MediaError("Choose a valid media library action.");
      const item = await service.file(
        actor,
        url.searchParams.get("owner"),
        url.searchParams.get("id"),
      );
      let range;
      try {
        range = parseRange(
          req.headers["if-range"] && req.headers["if-range"] !== item.etag
            ? null
            : req.headers.range,
          item.size,
        );
      } catch (error) {
        if (error.status !== 416) throw error;
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${item.size}`);
        return res.end();
      }
      const result = await getBlob(item.pathname, {
        access: "private",
        useCache: false,
        headers: {
          "accept-encoding": "identity",
          ...(range ? { Range: range.header } : {}),
        },
      });
      if (!result?.stream)
        throw new MediaError(
          "This source file is temporarily unavailable.",
          404,
        );
      if (
        result.blob.pathname !== item.pathname ||
        result.blob.contentType !== item.contentType ||
        result.blob.size !== (range?.length ?? item.size) ||
        result.headers.get("content-range") !== (range?.contentRange ?? null)
      ) {
        await result.stream.cancel();
        throw new MediaError(
          "The source file could not be loaded safely. Please retry.",
          502,
        );
      }
      const inline =
        /^(image\/|audio\/|video\/)/.test(item.contentType) ||
        item.contentType === "application/pdf";
      res.setHeader("Content-Type", item.contentType);
      res.setHeader(
        "Content-Disposition",
        `${inline && url.searchParams.get("download") !== "1" ? "inline" : "attachment"}; filename="source.${item.ext}"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
      );
      res.setHeader(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(range?.length ?? item.size));
      if (range) res.setHeader("Content-Range", range.contentRange);
      if (item.etag) res.setHeader("ETag", item.etag);
      res.statusCode = range ? 206 : 200;
      if (req.method === "HEAD") {
        await result.stream.cancel();
        return res.end();
      }
      await pipeline(Readable.fromWeb(result.stream), res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const name of [
        "Content-Length",
        "Content-Range",
        "Content-Disposition",
        "Content-Security-Policy",
        "ETag",
      ])
        res.removeHeader?.(name);
      const signature = /callback signature/i.test(error?.message || "");
      return json(
        res,
        error instanceof MediaError ? error.status : signature ? 403 : 503,
        {
          message:
            error instanceof MediaError
              ? error.message
              : signature
                ? "The upload callback could not be verified."
                : "The media library could not complete this request. Refresh to check its current state before retrying.",
        },
      );
    }
  };
}
export default createMediaHandler();
