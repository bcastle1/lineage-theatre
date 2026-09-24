import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { isOwner } from "./access.mjs";
import { createMagicLightClient } from "./magiclight-client.mjs";

export const MAGICLIGHT_LIVE_TEST_PATH = "integrations/magiclight/operator-test-v1.json";
const fixture = {
  id: "lineage-shipyard-live-test-v1", title: "Fictional shipyard test",
  prompt: "Create a short fictional historical scene based on this illustrated shipyard. At golden hour, a shipwright and an apprentice inspect a wooden sailing ship while workers move in the background. Gentle cinematic camera movement, natural atmosphere, hopeful mood. This is a fictional technical test, not a real family history.",
  imageUrl: "https://lineagetheater.com/assets/ancestor-shipyard-still.png",
};
export const MAGICLIGHT_LIVE_TEST_FIXTURE = Object.freeze({ ...fixture, hash: digest(JSON.stringify(fixture)), costVerified: false, durationVerified: false });
const ORIGIN = "https://open.magiclight.ai";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TASK = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = ["submitting", "submitted", "uncertain", "completed", "failed"];
const SAFE_CODES = ["MAGICLIGHT_TIMEOUT", "MAGICLIGHT_HTTP_REJECTED", "MAGICLIGHT_INVALID_RESPONSE", "MAGICLIGHT_RESPONSE_TOO_LARGE",
  "MAGICLIGHT_TRANSPORT_FAILED", "MAGICLIGHT_PROVIDER_REJECTED", "MAGICLIGHT_STATUS_UNCONFIRMED", "MAGICLIGHT_CHECK_FAILED"];
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const stamp = now => new Date(now()).toISOString();
const validKey = value => typeof value === "string" && Boolean(value) && value.length <= 4096 && !/\s/.test(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;

export class MagicLightLiveTestError extends Error {
  constructor(code, status, message) { super(message); this.name = "MagicLightLiveTestError"; this.code = code; this.status = status; }
}
const conflict = () => new MagicLightLiveTestError("MAGICLIGHT_TEST_CONFLICT", 409, "The saved test changed. Refresh its status; no additional generation request will be sent.");
const storageError = () => new MagicLightLiveTestError("MAGICLIGHT_TEST_STORAGE_UNAVAILABLE", 503, "The test record could not be confirmed. Refresh its status before continuing; do not submit another test.");
const ownerError = () => new MagicLightLiveTestError("MAGICLIGHT_TEST_OWNER_REQUIRED", 403, "Only the active owner can use the live generation test.");
const keyError = () => new MagicLightLiveTestError("MAGICLIGHT_TEST_KEY_REQUIRED", 409, "The saved production key is unavailable. No generation request was sent.");
const bindingError = () => new MagicLightLiveTestError("MAGICLIGHT_TEST_BINDING_CHANGED", 409, "The saved test belongs to a different connection or fixture. Its record is preserved; no additional generation request will be sent.");
const badResponse = () => new MagicLightLiveTestError("MAGICLIGHT_INVALID_RESPONSE", 502, "The provider result could not be verified.");

function outputUrl(value, apiKey) {
  if (typeof value !== "string" || value.length > 8192 || (apiKey && (value.includes(apiKey) || value.includes(encodeURIComponent(apiKey))))) throw badResponse();
  let url;
  try { url = new URL(value); } catch { throw badResponse(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname)) throw badResponse();
  // This validates storage/display only, not permission to fetch the destination.
  // A later media importer must independently approve the exact output host.
  return url;
}

export function createMagicLightLiveTestService({ read = readRecord, write = writeRecord, now = Date.now,
  env = process.env, clientFactory = createMagicLightClient } = {}) {
  async function stored(path) { try { return await read(path); } catch { throw storageError(); } }
  async function owner(actor) {
    if (!isOwner(actor) || actor.mustChangePassword) throw ownerError();
    const current = (await stored(userPath(actor.email)))?.value;
    if (!isOwner(current) || current.email !== actor.email || current.mustChangePassword) throw ownerError();
  }
  function configuration() {
    const apiKey = env.MAGICLIGHT_API_KEY;
    return validKey(apiKey) ? { apiKey, fingerprint: digest(apiKey) } : null;
  }
  function record(value, actor) {
    if (!plain(value) || value.version !== 1 || !UUID.test(value.id || "") || !UUID.test(value.changeId || "")
      || value.ownerEmail !== actor.email || value.fixtureHash !== MAGICLIGHT_LIVE_TEST_FIXTURE.hash || value.origin !== ORIGIN
      || !HASH.test(value.keyFingerprint || "") || value.submissionCount !== 1 || !STATES.includes(value.status)
      || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
      || (value.checkedAt !== undefined && !timestamp(value.checkedAt))
      || (value.providerCode !== undefined && !Number.isSafeInteger(value.providerCode))
      || (value.httpStatus !== undefined && !httpStatus(value.httpStatus))
      || (value.taskStatus !== undefined && !Number.isSafeInteger(value.taskStatus))
      || (value.code !== undefined && !SAFE_CODES.includes(value.code))
      || (value.taskId !== undefined && (typeof value.taskId !== "string" || !TASK.test(value.taskId)))
      || (["submitted", "completed", "failed"].includes(value.status) && !value.taskId)
      || (["submitting", "uncertain"].includes(value.status) && value.taskId !== undefined)
      || (value.status === "completed" && (value.taskStatus !== 2 || value.providerCode !== 10000 || !value.videoUrl))
      || (value.status === "failed" && (value.taskStatus !== 3 || value.providerCode !== 10000))
      || (value.videoUrl !== undefined && value.status !== "completed")) throw bindingError();
    if (value.videoUrl) outputUrl(value.videoUrl);
    return value;
  }
  async function saved(actor) {
    const previous = await stored(MAGICLIGHT_LIVE_TEST_PATH);
    if (previous) {
      if (typeof previous.etag !== "string" || !previous.etag) throw bindingError();
      record(previous.value, actor);
    }
    return previous;
  }
  async function save(previous, value, attempts = 1) {
    const next = { ...value, changeId: randomUUID(), updatedAt: stamp(now) };
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await write(MAGICLIGHT_LIVE_TEST_PATH, next, previous?.etag); }
      catch { /* A readback distinguishes a lost reply from an uncommitted write. */ }
      let confirmed;
      try { confirmed = await stored(MAGICLIGHT_LIVE_TEST_PATH); }
      catch (error) { if (attempt + 1 < attempts) continue; throw error; }
      if (confirmed?.etag && confirmed.value?.changeId === next.changeId
        && digest(JSON.stringify(confirmed.value)) === digest(JSON.stringify(next))) return confirmed;
      // Only a still-exact original record permits a storage retry. The same
      // ETag/changeId protects against replacing any concurrent newer result.
      if (attempt + 1 >= attempts || !previous || confirmed?.etag !== previous.etag
        || digest(JSON.stringify(confirmed?.value ?? null)) !== digest(JSON.stringify(previous.value))) throw conflict();
    }
    throw conflict();
  }
  function bound(value, config) {
    if (!config) throw keyError();
    if (value && value.keyFingerprint !== config.fingerprint) throw bindingError();
    return config;
  }
  async function active(actor, previous, config) {
    await owner(actor);
    const latest = await saved(actor);
    if (latest?.etag !== previous?.etag || latest?.value?.changeId !== previous?.value?.changeId) throw conflict();
    await owner(actor);
    if (bound(previous?.value, configuration()).fingerprint !== config.fingerprint) throw bindingError();
  }
  function view(value, message) {
    const config = configuration();
    return { configured: Boolean(config), productionReady: false, customerFulfillment: false,
      fixture: MAGICLIGHT_LIVE_TEST_FIXTURE,
      test: value ? { id: value.id, status: value.status, submissionCount: 1, createdAt: value.createdAt, updatedAt: value.updatedAt,
        ...Object.fromEntries(["checkedAt", "providerCode", "httpStatus", "taskStatus", "code"].filter(key => value[key] !== undefined).map(key => [key, value[key]])),
        ...(value.videoUrl ? { outputOrigin: outputUrl(value.videoUrl).origin } : {}) } : null,
      message: message || (!value ? "One live fictional test can use provider credits. Its exact cost and duration are not verified."
        : value.status === "submitting" || value.status === "uncertain" ? "The submission needs review. No second generation request will be sent."
        : value.status === "completed" ? "The provider reports the test video is complete. Secure video delivery still needs verification; customer film production remains unavailable."
        : value.status === "failed" ? "The provider reports this test failed. No second generation request will be sent."
        : "The test task is saved. Check its status to continue without creating another task.") };
  }
  async function status(actor) {
    await owner(actor);
    const previous = await saved(actor);
    await owner(actor);
    return view(previous?.value);
  }
  async function submit(actor, input) {
    await owner(actor);
    if (!plain(input) || input.consent !== true || Object.keys(input).some(key => key !== "consent"))
      throw new MagicLightLiveTestError("MAGICLIGHT_TEST_CONSENT_REQUIRED", 400, "Confirm the single live fictional test before submitting it.");
    let previous = await saved(actor);
    if (previous) { await owner(actor); return view(previous.value); }
    const config = bound(null, configuration());
    const client = clientFactory({ apiKey: config.apiKey, environment: "production", enableSubmission: true, requestTimeoutMs: 15_000 });
    await owner(actor);
    if (configuration()?.fingerprint !== config.fingerprint) throw bindingError();
    // A permanent create-only claim bounds spending across tabs, processes,
    // restarts and key changes. It is never expired or reset into another POST.
    previous = await save(null, { version: 1, id: randomUUID(), ownerEmail: actor.email,
      fixtureHash: MAGICLIGHT_LIVE_TEST_FIXTURE.hash, keyFingerprint: config.fingerprint, origin: ORIGIN,
      submissionCount: 1, status: "submitting", createdAt: stamp(now) });
    await active(actor, previous, config);
    let outcome;
    try {
      outcome = await client.submitTask({ text: fixture.prompt, imageUrl: fixture.imageUrl });
      if (outcome?.providerCode !== 10000 || typeof outcome.taskId !== "string" || !TASK.test(outcome.taskId)
        || outcome.taskId.includes(config.apiKey) || outcome.taskId.includes(encodeURIComponent(config.apiKey))) throw badResponse();
    } catch (error) {
      const code = SAFE_CODES.includes(error?.code) ? error.code : "MAGICLIGHT_TRANSPORT_FAILED";
      previous = await save(previous, { ...previous.value, status: "uncertain", code,
        ...(Number.isSafeInteger(error?.providerCode) ? { providerCode: error.providerCode } : {}),
        ...(httpStatus(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) });
      await owner(actor);
      return view(previous.value);
    }
    // Persist an accepted task even if owner access changed during the request.
    // Revocation stops disclosure/polling, never destroys the recovery identity.
    // Storage-only retries preserve this known task ID through a transient Blob
    // failure. They never repeat the provider POST or change the saved claim.
    previous = await save(previous, { ...previous.value, status: "submitted", taskId: outcome.taskId, providerCode: 10000 }, 3);
    await owner(actor);
    return view(previous.value);
  }
  async function check(actor) {
    await owner(actor);
    let previous = await saved(actor);
    if (!previous?.value.taskId || ["completed", "failed"].includes(previous.value.status)) { await owner(actor); return view(previous?.value); }
    const config = bound(previous.value, configuration());
    const client = clientFactory({ apiKey: config.apiKey, environment: "production", enableSubmission: false, requestTimeoutMs: 15_000 });
    await active(actor, previous, config);
    let update;
    try {
      const result = await client.checkTask({ taskId: previous.value.taskId });
      if (!plain(result) || !Number.isSafeInteger(result.providerCode)) throw badResponse();
      update = { providerCode: result.providerCode, checkedAt: stamp(now) };
      if (result.providerCode !== 10000) update.code = "MAGICLIGHT_STATUS_UNCONFIRMED";
      else {
        if (!Number.isSafeInteger(result.taskStatus) || (result.taskId !== undefined && result.taskId !== previous.value.taskId)) throw badResponse();
        update.taskStatus = result.taskStatus;
        if (result.taskStatus === 2) update = { ...update, status: "completed", videoUrl: outputUrl(result.videoUrl, config.apiKey).href };
        else if (result.taskStatus === 3) update.status = "failed";
        else update.code = "MAGICLIGHT_STATUS_UNCONFIRMED";
      }
    } catch (error) {
      update = { checkedAt: stamp(now), code: SAFE_CODES.includes(error?.code) ? error.code : "MAGICLIGHT_CHECK_FAILED",
        ...(httpStatus(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) };
    }
    await active(actor, previous, config);
    const { code, httpStatus: previousHttpStatus, ...old } = previous.value;
    previous = await save(previous, { ...old, ...update });
    await owner(actor);
    return view(previous.value);
  }
  // Server-only delivery binding. Never serialize this private record through
  // an API response; its signed provider URL is solely for the media importer.
  async function completedForMedia(actor) {
    await owner(actor);
    const previous = await saved(actor);
    if (previous?.value.status !== "completed") throw new MagicLightLiveTestError("MAGICLIGHT_TEST_NOT_COMPLETE", 409, "The saved test clip is not complete yet.");
    await owner(actor);
    return { ...previous.value };
  }
  return Object.freeze({ status, submit, check, completedForMedia });
}

export const magiclightLiveTest = createMagicLightLiveTestService();
