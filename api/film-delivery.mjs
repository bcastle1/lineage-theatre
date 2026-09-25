import { createHash, timingSafeEqual } from "node:crypto";
import { getSession, json, readBody, sameOrigin, limitAction } from "./_lib/auth.mjs";
import { DeliveryError, filmDelivery } from "./_lib/film-delivery.mjs";

export function createFilmDeliveryHandler({ service = filmDelivery, sessionFor = getSession, limiter = limitAction, env = process.env } = {}) {
  return async (req, res) => {
    res.setHeader("Vary", "Cookie");
    try {
      const url = new URL(req.url, `https://${req.headers.host}`);
      if (url.searchParams.get("action") === "run" || req.headers.authorization !== undefined) {
        if (req.method !== "GET" || url.searchParams.size && (url.searchParams.size !== 1 || url.searchParams.get("action") !== "run")) return json(res, 405, { message: "Method not allowed." });
        const secret = env.CRON_SECRET, header = req.headers.authorization;
        if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /\s/.test(secret)) return json(res, 503, { message: "Automatic delivery is not configured." });
        const hash = value => createHash("sha256").update(value).digest();
        if (typeof header !== "string" || header.length > 1024 || !timingSafeEqual(hash(header), hash(`Bearer ${secret}`))) return json(res, 401, { message: "Authorization required." });
        return json(res, 200, await service.run());
      }
      if (!["GET", "POST"].includes(req.method)) return json(res, 405, { message: "Method not allowed." });
      const session = await sessionFor(req);
      if (!session || session.user.mustChangePassword) return json(res, 401, { message: "Sign in to manage film deliveries." });
      if (req.method === "POST" && !sameOrigin(req)) return json(res, 403, { message: "Begin this action inside Lineage Theatre." });
      if (!(await limiter(`film-delivery:${session.user.email}`, 60, 60_000))) return json(res, 429, { message: "Please wait before trying again." });
      if (req.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) throw new DeliveryError("Invalid delivery view.");
        return json(res, 200, { ...await service.list(session.user, url.searchParams.get("cursor") || undefined), automatic: typeof env.CRON_SECRET === "string" && env.CRON_SECRET.length >= 32 });
      }
      if (url.searchParams.size) throw new DeliveryError("Invalid delivery action.");
      const body = await readBody(req, 4096);
      if (body.action === "enqueue") { const { action, ...input } = body; return json(res, 200, { job: await service.enqueue(session.user, input) }); }
      if (["retry", "transfer"].includes(body.action) && Object.keys(body).every(key => ["action", "id"].includes(key)))
        return json(res, 200, { job: await service[body.action === "retry" ? "retry" : "transferNow"](session.user, body.id) });
      throw new DeliveryError("Choose a valid delivery action.");
    } catch (error) {
      return json(res, error instanceof DeliveryError ? error.status : 503, { code: error instanceof DeliveryError ? error.code : "DELIVERY_UNAVAILABLE",
        message: error instanceof DeliveryError ? error.message : "Film delivery is temporarily unavailable. Saved films and assignments are unchanged." });
    }
  };
}
export default createFilmDeliveryHandler();
