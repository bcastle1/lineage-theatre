import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "./_lib/auth.mjs";
import { paidFilmGeneration } from "./_lib/paid-film-generation.mjs";
import { automaticProduction } from "./_lib/automatic-production.mjs";

const digest = value => createHash("sha256").update(value).digest();
export function createFilmGenerationHandler({ service = paidFilmGeneration, automation = automaticProduction, env = process.env } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { message: "Method not allowed." }); }
    const secret = env.CRON_SECRET;
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /\s/.test(secret))
      return json(res, 503, { message: "Film generation checks are not configured." });
    const authorization = req.headers?.authorization;
    if (typeof authorization !== "string" || authorization.length > 1024
      || !timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`)))
      return json(res, 401, { message: "Authorization required." });
    // Polling an existing provider task and scheduling newly paid films are
    // independent. A failure in either must not prevent the other from running.
    const [generation, automatic] = await Promise.allSettled([
      Promise.resolve().then(() => service.run()), Promise.resolve().then(() => automation.run()),
    ]);
    const failed = generation.status === "rejected" || automatic.status === "rejected";
    return json(res, failed ? 503 : 200, {
      ...(generation.status === "fulfilled" ? generation.value : {}),
      ...(automatic.status === "fulfilled" ? { automatic: automatic.value } : {}),
      ...(failed ? { message: "Some film production checks are temporarily unavailable." } : {}),
    });
  };
}

export default createFilmGenerationHandler();
