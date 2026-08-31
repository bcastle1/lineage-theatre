import {
  IMAGINEART_API_BASE,
  fetchWithTimeout,
  normalizeImagineStatus,
  readUpstreamJson,
  sendJson,
  upstreamMessage,
} from "./_shared.mjs";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: "method_not_allowed", message: "Use GET to check an ImagineArt render." });
  }

  const requestUrl = new URL(request.url ?? "/api/imagineart/status", `https://${request.headers?.host ?? "lineagetheater.com"}`);
  const jobId = String(requestUrl.searchParams.get("id") ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(jobId)) {
    return sendJson(response, 400, { error: "invalid_job_id", message: "The ImagineArt production ID is not valid." });
  }

  const isLocalMock = process.env.IMAGINEART_MOCK_MODE === "true" && process.env.VERCEL_ENV !== "production";
  if (isLocalMock && jobId.startsWith("mock-")) {
    return sendJson(response, 200, {
      jobId,
      status: "completed",
      videoUrl: "/assets/the-journey-of-thomas-wilson.mp4",
      thumbnailUrl: "/assets/the-journey-of-thomas-wilson-poster.jpg",
      message: null,
    });
  }

  const token = process.env.IMAGINEART_API_TOKEN;
  if (!token) {
    return sendJson(response, 503, { error: "imagineart_not_configured", message: "ImagineArt production is not connected yet." });
  }

  const headers = { Authorization: `Bearer ${token}` };
  const statusUrls = [
    `${IMAGINEART_API_BASE}/assets/${encodeURIComponent(jobId)}/status`,
    `${IMAGINEART_API_BASE}/video/${encodeURIComponent(jobId)}/status`,
  ];

  try {
    let upstream = await fetchWithTimeout(statusUrls[0], { method: "GET", headers }, 20_000);
    if (upstream.status === 404) upstream = await fetchWithTimeout(statusUrls[1], { method: "GET", headers }, 20_000);
    const payload = await readUpstreamJson(upstream);
    if (!upstream.ok) {
      return sendJson(response, upstream.status === 429 ? 429 : 502, {
        error: upstream.status === 429 ? "imagineart_limit_reached" : "imagineart_status_failed",
        message: upstreamMessage(payload, "ImagineArt could not return the current production status."),
      });
    }
    return sendJson(response, 200, normalizeImagineStatus(payload, jobId));
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return sendJson(response, timedOut ? 504 : 502, {
      error: timedOut ? "imagineart_timeout" : "imagineart_unavailable",
      message: timedOut ? "ImagineArt took too long to report production status." : "ImagineArt production status is temporarily unavailable.",
    });
  }
}
