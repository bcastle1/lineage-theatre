import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "./_lib/auth.mjs";
import { paymentReconciliation } from "./_lib/payment-reconciliation.mjs";

const digest = value => createHash("sha256").update(value).digest();
export function createPaymentReconcileHandler({ service = paymentReconciliation, env = process.env } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { message: "Method not allowed." }); }
    const secret = env.CRON_SECRET;
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /\s/.test(secret))
      return json(res, 503, { message: "Payment reconciliation is not configured." });
    const authorization = req.headers?.authorization;
    if (typeof authorization !== "string" || authorization.length > 1024
      || !timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`)))
      return json(res, 401, { message: "Authorization required." });
    try { return json(res, 200, await service.run()); }
    catch { return json(res, 503, { message: "Payment reconciliation is temporarily unavailable." }); }
  };
}

export default createPaymentReconcileHandler();
