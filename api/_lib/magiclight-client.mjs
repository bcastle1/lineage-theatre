// Protocol evidence and its limits are recorded in docs/MAGICLIGHT-PROTOCOL.md.
// This isolated client is not a verified film adapter and never enables one.
export const MAGICLIGHT_ORIGINS = Object.freeze({
  test: "https://open-test.magiclight.ai",
  production: "https://open.magiclight.ai",
});
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_TEXT_BYTES = 100_000;
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const taskReference = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export class MagicLightClientError extends Error {
  constructor(code, details = {}) {
    super("The MagicLight request could not be verified.");
    this.name = "MagicLightClientError";
    this.code = code;
    this.status = 502;
    Object.assign(this, details);
  }
}
function fail(code, details) { throw new MagicLightClientError(code, details); }
function httpsUrl(value) {
  if (typeof value !== "string" || value.length > 8192) fail("MAGICLIGHT_INVALID_URL");
  let url;
  try { url = new URL(value); } catch { fail("MAGICLIGHT_INVALID_URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) fail("MAGICLIGHT_INVALID_URL");
  return value;
}

export function createMagicLightClient({ apiKey, environment = "production", enableSubmission = false,
  fetchImpl = globalThis.fetch, requestTimeoutMs = 15_000 } = {}) {
  if (!Object.hasOwn(MAGICLIGHT_ORIGINS, environment) || typeof fetchImpl !== "function"
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 90_000) fail("MAGICLIGHT_INVALID_CONFIGURATION");
  const origin = MAGICLIGHT_ORIGINS[environment];
  function key() {
    if (typeof apiKey !== "string" || !apiKey || apiKey.length > 4096 || /\s/.test(apiKey)) fail("MAGICLIGHT_KEY_REQUIRED");
    return apiKey;
  }
  function safeString(value) {
    if (typeof value === "string" && (value.includes(apiKey) || value.includes(encodeURIComponent(apiKey)))) fail("MAGICLIGHT_INVALID_RESPONSE");
    return value;
  }
  async function request(method, path, body) {
    const secret = key();
    const controller = new AbortController();
    let reader, response, timer;
    const cancel = () => {
      controller.abort();
      try { const pending = reader ? reader.cancel() : response?.body?.cancel(); pending?.catch(() => {}); } catch { /* Do not expose transport failures. */ }
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { cancel(); reject(new MagicLightClientError("MAGICLIGHT_TIMEOUT")); }, requestTimeoutMs);
    });
    async function perform() {
      // Native fetch keeps certificate/hostname verification enabled. Redirects
      // are rejected, including redirects from the fixed provider origin.
      response = await fetchImpl(`${origin}${path}`, { method, signal: controller.signal, redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json", "User-Agent": "Lineage-MagicLight/1.0",
          ...(body ? { "Content-Type": "application/json", "X-DashScope-Async": "enable" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (controller.signal.aborted) { cancel(); fail("MAGICLIGHT_TIMEOUT"); }
      if (response?.status !== 200) fail("MAGICLIGHT_HTTP_REJECTED", {
        ...(Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? { httpStatus: response.status } : {}),
      });
      const mediaType = response.headers?.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const declared = response.headers?.get("content-length");
      const encoding = response.headers?.get("content-encoding")?.trim().toLowerCase();
      if (mediaType !== "application/json" || (declared !== null && declared !== undefined
        && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))) fail("MAGICLIGHT_INVALID_RESPONSE");
      if (typeof response.body?.getReader !== "function") fail("MAGICLIGHT_INVALID_RESPONSE");
      reader = response.body.getReader();
      let length = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) fail("MAGICLIGHT_TIMEOUT");
        if (done) break;
        if (!(value instanceof Uint8Array) || (length += value.byteLength) > MAX_RESPONSE_BYTES) fail("MAGICLIGHT_RESPONSE_TOO_LARGE");
        chunks.push(value);
      }
      // Native fetch decompresses bodies but preserves the wire Content-Length.
      // The streaming cap above always applies to decoded bytes; equality only
      // applies when the declared body has no content encoding.
      if ((!encoding || encoding === "identity") && declared !== null && declared !== undefined
        && Number(declared) !== length) fail("MAGICLIGHT_INVALID_RESPONSE");
      let result;
      try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { fail("MAGICLIGHT_INVALID_RESPONSE"); }
      if (!plain(result) || !Number.isSafeInteger(result.biz_code)) fail("MAGICLIGHT_INVALID_RESPONSE");
      // Unknown provider codes stay numeric evidence. No guessed authentication,
      // entitlement, billing or job-status interpretation is attached to them.
      if (result.biz_code !== 10000) return { providerCode: result.biz_code };
      if (!plain(result.data)) fail("MAGICLIGHT_INVALID_RESPONSE");
      return { providerCode: result.biz_code, data: result.data };
    }
    try { return await Promise.race([perform(), deadline]); }
    catch (error) {
      const safe = error instanceof MagicLightClientError ? error : new MagicLightClientError("MAGICLIGHT_TRANSPORT_FAILED");
      // A transport failure after POST may conceal an accepted job. Never retry
      // automatically; the published protocol has no request-lookup contract.
      if (method === "POST") safe.submissionUncertain = true;
      throw safe;
    } finally { clearTimeout(timer); cancel(); }
  }
  async function checkTask({ taskId } = {}) {
    if (!taskReference(taskId)) fail("MAGICLIGHT_INVALID_TASK");
    const result = await request("GET", `/api/misc/openclaw_check_task?task_id=${encodeURIComponent(taskId)}`);
    if (result.providerCode !== 10000) return result;
    const data = result.data;
    if (!Number.isSafeInteger(data.task_status) || (data.task_id !== undefined
      && (!taskReference(data.task_id) || data.task_id !== taskId))) fail("MAGICLIGHT_INVALID_RESPONSE");
    const videoUrl = data.video_url === undefined || data.video_url === "" ? undefined : httpsUrl(safeString(data.video_url));
    if (data.task_status === 2 && !videoUrl) fail("MAGICLIGHT_INVALID_RESPONSE");
    return { providerCode: result.providerCode, taskStatus: data.task_status,
      ...(data.task_id !== undefined ? { taskId: safeString(data.task_id) } : {}), ...(videoUrl ? { videoUrl } : {}) };
  }
  async function submitTask({ text, imageUrl } = {}) {
    if (enableSubmission !== true) fail("MAGICLIGHT_SUBMISSION_DISABLED");
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES) fail("MAGICLIGHT_INVALID_TEXT");
    const body = { text, ...(imageUrl === undefined ? {} : { image_url: httpsUrl(imageUrl) }) };
    const result = await request("POST", "/api/misc/openclaw_add_task", body);
    if (result.providerCode !== 10000) fail("MAGICLIGHT_PROVIDER_REJECTED", { providerCode: result.providerCode, submissionUncertain: true });
    if (!taskReference(result.data.task_id)) fail("MAGICLIGHT_INVALID_RESPONSE", { submissionUncertain: true });
    try { return { providerCode: result.providerCode, taskId: safeString(result.data.task_id) }; }
    catch { fail("MAGICLIGHT_INVALID_RESPONSE", { submissionUncertain: true }); }
  }
  // No upload or media-download URL is fetched by this client. Those require
  // independently verified hosts, byte limits and consent in the film adapter.
  return Object.freeze({ available: false, environment, origin, checkTask, submitTask });
}
