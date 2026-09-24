import { randomUUID } from "node:crypto";
import { createMagicLightClient, MagicLightClientError } from "./magiclight-client.mjs";

// This check only looks up a newly generated, nonexistent task reference. The
// saved credential stays in the server process; no generation request is made.
export async function checkMagicLightConnection({ apiKey = process.env.MAGICLIGHT_API_KEY,
  clientFactory = createMagicLightClient, now = Date.now } = {}) {
  const base = { configured: typeof apiKey === "string" && Boolean(apiKey),
    origin: "https://open.magiclight.ai", checkedAt: new Date(now()).toISOString(),
    authentication: "unconfirmed", generationSubmitted: false, productionReady: false };
  if (!base.configured) return { ...base, code: "MAGICLIGHT_KEY_REQUIRED" };
  try {
    const client = clientFactory({ apiKey, environment: "production", enableSubmission: false, requestTimeoutMs: 15_000 });
    const result = await client.checkTask({ taskId: `lineage_probe_${randomUUID()}` });
    const providerCode = Number.isSafeInteger(result?.providerCode) ? result.providerCode : undefined;
    // The published protocol defines only 10000 as success. A different code
    // could mean an unknown task or rejected authentication; do not guess.
    // Even a success/status-0 envelope for a nonexistent task may be a generic
    // fallback. Record receipt without claiming authenticated account access.
    if (providerCode === 10000) return { ...base, code: "MAGICLIGHT_STATUS_RECEIVED", providerCode };
    return { ...base, code: "MAGICLIGHT_STATUS_UNCONFIRMED", ...(providerCode === undefined ? {} : { providerCode }) };
  } catch (error) {
    if (error instanceof MagicLightClientError) {
      const httpStatus = Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : undefined;
      if (httpStatus === 401) return { ...base, authentication: "rejected", code: "MAGICLIGHT_AUTH_REJECTED", httpStatus };
      const knownCodes = ["MAGICLIGHT_KEY_REQUIRED", "MAGICLIGHT_TIMEOUT", "MAGICLIGHT_HTTP_REJECTED",
        "MAGICLIGHT_INVALID_RESPONSE", "MAGICLIGHT_RESPONSE_TOO_LARGE", "MAGICLIGHT_TRANSPORT_FAILED"];
      return { ...base, code: knownCodes.includes(error.code) ? error.code : "MAGICLIGHT_CHECK_FAILED",
        ...(httpStatus === undefined ? {} : { httpStatus }) };
    }
    return { ...base, code: "MAGICLIGHT_CHECK_FAILED" };
  }
}
