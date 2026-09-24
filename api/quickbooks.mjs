import { getSession, json, readBody, sameOrigin, limitAction } from "./_lib/auth.mjs";
import { hasAdminAccess, isOwner } from "./_lib/access.mjs";
import { quickbooks, QuickBooksError, QUICKBOOKS_ORIGIN, readQuickBooksStateCookie, callbackLocation } from "./_lib/quickbooks.mjs";
import { quickbooksPaymentTest } from "./_lib/quickbooks-payment-test.mjs";

export function createQuickBooksHandler(overrides = {}) {
  const { service = quickbooks, paymentTest = quickbooksPaymentTest, sessionFor = getSession, limiter = limitAction } = overrides;
  return async function handler(req, res) {
    let isCallback = false;
    try {
      const url = new URL(req.url, QUICKBOOKS_ORIGIN);
      isCallback = url.searchParams.get("action") === "callback";
      if (isCallback) {
        if (req.method !== "GET") return json(res, 405, { message: "Method not allowed." });
        if (req.headers.host !== new URL(QUICKBOOKS_ORIGIN).host) throw new QuickBooksError("Open Lineage Theater at its canonical address.", 403);
        // Existing app cookies are SameSite=Strict; only this dedicated, hashed,
        // single-use Lax cookie is used for the top-level Intuit return.
        const result = await service.callback(url.searchParams, readQuickBooksStateCookie(req));
        res.statusCode = 302; res.setHeader("Cache-Control", "no-cache, no-store"); res.setHeader("Pragma", "no-cache"); res.setHeader("Referrer-Policy", "no-referrer");
        // Let the short-lived nonce cookie expire. A late response from another
        // tab must not erase a newer attempt's cookie; durable state is single-use.
        res.setHeader("Location", callbackLocation(result.result)); return res.end();
      }
      const session = await sessionFor(req);
      if (!session) return json(res, 401, { message: "Sign in to manage QuickBooks." });
      if (!hasAdminAccess(session.user)) return json(res, 403, { message: "Administrator access is required." });
      if (req.method === "GET" && (url.searchParams.get("action") || "status") === "status")
        return json(res, 200, await service.status());
      if (req.method === "GET" && url.searchParams.get("action") === "paymentTest") {
        if (!isOwner(session.user)) return json(res, 403, { message: "Only the owner can review payment testing." });
        return json(res, 200, await paymentTest.status(session.user));
      }
      if (req.method !== "POST") return json(res, 405, { message: "Method not allowed." });
      if (!isOwner(session.user)) return json(res, 403, { message: "Only the owner can manage the QuickBooks connection." });
      if (!sameOrigin(req) || req.headers.origin !== QUICKBOOKS_ORIGIN || req.headers.host !== new URL(QUICKBOOKS_ORIGIN).host)
        return json(res, 403, { message: "Begin this action at https://lineagetheater.com inside Administration." });
      const body = await readBody(req, 2048);
      if (!body || typeof body !== "object" || Array.isArray(body) || !["start", "disconnect", "verifyCompany", "refresh", "testPayment"].includes(body.action))
        return json(res, 400, { message: "Unknown QuickBooks connection action." });
      if (body.action === "refresh" && (Object.keys(body).some(key => !["action", "expectedRevision"].includes(key))
        || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0))
        return json(res, 400, { message: "Refresh requires the current connection revision only." });
      if (body.action === "testPayment" && (Object.keys(body).some(key => !["action", "operation"].includes(key))
        || !["charge", "refund", "check"].includes(body.operation)))
        return json(res, 400, { message: "Select a supported payment test action only." });
      if (!(await limiter(`quickbooks-${body.action}:${session.user.email}`, 10, 3600_000)))
        return json(res, 429, { message: "Please wait before making more QuickBooks connection changes." });
      if (body.action === "start") {
        const { stateCookie, ...result } = await service.start(session.user, body);
        res.setHeader("Set-Cookie", stateCookie); return json(res, 200, result);
      }
      if (body.action === "verifyCompany") return json(res, 200, await service.verifyCompany(session.user, body));
      if (body.action === "refresh") return json(res, 200, await service.refresh(session.user, { expectedRevision: body.expectedRevision }));
      if (body.action === "testPayment") return json(res, 200, await paymentTest.run(session.user, { operation: body.operation }));
      const disconnected = await service.disconnect(session.user, body);
      return json(res, 200, disconnected);
    } catch (error) {
      if (isCallback && req.method === "GET") {
        res.statusCode = 302; res.setHeader("Cache-Control", "no-cache, no-store"); res.setHeader("Pragma", "no-cache"); res.setHeader("Referrer-Policy", "no-referrer");
        // An old popup must not clear the cookie belonging to a newer attempt.
        // Failed callbacks cannot use their consumed state again; the cookie expires shortly.
        res.setHeader("Location", callbackLocation("error")); return res.end();
      }
      return json(res, error instanceof QuickBooksError ? error.status : 503, {
        code: error instanceof QuickBooksError ? error.code : "QUICKBOOKS_UNAVAILABLE",
        message: error instanceof QuickBooksError ? error.message : "The QuickBooks connection could not be updated. Refresh its status before trying again.",
        paymentReady: false, refundReady: false,
      });
    }
  };
}
export default createQuickBooksHandler();
