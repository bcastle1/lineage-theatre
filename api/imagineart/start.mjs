import {
  IMAGINEART_API_BASE,
  IMAGINEART_MODEL,
  allowSameOrigin,
  fetchWithTimeout,
  isHumanRequest,
  readJsonBody,
  readUpstreamJson,
  sendJson,
  upstreamMessage,
} from "./_shared.mjs";

const recentJobs = new Map();

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "method_not_allowed", message: "Use POST to begin an ImagineArt render." });
  }

  if (!allowSameOrigin(request)) {
    return sendJson(response, 403, { error: "origin_not_allowed", message: "This production request must begin inside Lineage Theatre." });
  }

  try {
    if (!(await isHumanRequest(request))) {
      return sendJson(response, 403, { error: "automated_request_blocked", message: "Production could not be verified as a human request. Reload the page and try again." });
    }
  } catch {
    return sendJson(response, 503, { error: "verification_unavailable", message: "Production verification is temporarily unavailable. Please try again." });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return sendJson(response, 400, { error: "invalid_request", message: "The production request could not be read." });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const idempotencyKey = typeof request.headers?.["idempotency-key"] === "string"
    ? request.headers["idempotency-key"].slice(0, 180)
    : "";

  if (!projectId || !/^[a-zA-Z0-9_-]{8,80}$/.test(projectId)) {
    return sendJson(response, 400, { error: "invalid_project", message: "The film project could not be identified." });
  }
  if (prompt.length < 80 || prompt.length > 4_000) {
    return sendJson(response, 400, { error: "invalid_prompt", message: "The production prompt must contain 80 to 4,000 characters." });
  }

  const isLocalMock = process.env.IMAGINEART_MOCK_MODE === "true" && process.env.VERCEL_ENV !== "production";
  if (isLocalMock) {
    return sendJson(response, 202, {
      jobId: `mock-${projectId}`,
      status: "queued",
      model: IMAGINEART_MODEL,
      submittedAt: new Date().toISOString(),
    });
  }

  const token = process.env.IMAGINEART_API_TOKEN;
  if (!token) {
    return sendJson(response, 503, { error: "imagineart_not_configured", message: "ImagineArt production is not connected yet." });
  }

  if (idempotencyKey && recentJobs.has(idempotencyKey)) {
    return sendJson(response, 200, recentJobs.get(idempotencyKey));
  }

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("style", IMAGINEART_MODEL);
  form.append("aspect_ratio", "16:9");

  try {
    const upstream = await fetchWithTimeout(`${IMAGINEART_API_BASE}/video/text-to-video`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const payload = await readUpstreamJson(upstream);

    if (!upstream.ok) {
      const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status === 429 ? 429 : 502;
      return sendJson(response, status, {
        error: upstream.status === 429 ? "imagineart_limit_reached" : "imagineart_request_failed",
        message: upstreamMessage(payload, upstream.status === 429 ? "ImagineArt has reached its current usage limit." : "ImagineArt did not accept this production request."),
      });
    }

    const jobId = String(payload.id ?? payload.video?.id ?? payload.video?.uuid ?? "").trim();
    if (!jobId) {
      return sendJson(response, 502, { error: "missing_job_id", message: "ImagineArt accepted the request but did not return a production ID." });
    }

    const result = {
      jobId,
      status: "queued",
      model: IMAGINEART_MODEL,
      submittedAt: new Date().toISOString(),
    };
    if (idempotencyKey) recentJobs.set(idempotencyKey, result);
    return sendJson(response, 202, result);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return sendJson(response, timedOut ? 504 : 502, {
      error: timedOut ? "imagineart_timeout" : "imagineart_unavailable",
      message: timedOut ? "ImagineArt took too long to accept the production request. Please try again." : "ImagineArt is temporarily unavailable. Please try again.",
    });
  }
}
