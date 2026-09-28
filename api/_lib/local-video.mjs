import { randomUUID } from "node:crypto";
import { del, get, list } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { accessStatusForUser } from "./access.mjs";
import { mediaLibrary } from "./media-library.mjs";
import { ltxFilmInput, filmSources, imageTypes, audioTypes, checkedTimeline } from "./ltx-film.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 100 * 1024 * 1024;
const conflict = error => /precondition|already exists|etag|if.?match/i.test(`${error?.name} ${error?.message}`);
export class LocalVideoError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new LocalVideoError(message, status); };
function text(value, max, name, required = false) {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || required && !value.trim())
    fail(`Check ${name} before rendering the free film.`);
  return value.trim();
}
export function localFilmInput(input) {
  if (!input || !UUID.test(input.filmId || "") || !UUID.test(input.requestId || "") || input.consent !== true)
    fail("Confirm local rendering and choose a saved film.");
  if (!Number.isInteger(input.duration) || input.duration < 15 || input.duration > 600 || !Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 30)
    fail("Use 1–30 scenes and a target length of 15 seconds to 10 minutes.");
  const scenes = input.scenes.map(scene => ({
    title: text(scene?.title, 200, "each scene title", true),
    narration: text(scene?.narration || "", 2000, "scene narration"),
    dialogue: text(scene?.dialogue || "", 1000, "scene dialogue"),
    visual: text(scene?.visual || "", 1200, "scene visuals"),
    ...(scene?.photoId ? { photoId: UUID.test(scene.photoId) ? scene.photoId : fail("Choose a saved photo from this account.") } : {}),
  }));
  if (scenes.reduce((total, scene) => total + scene.narration.length + scene.dialogue.length, 0) > 12_000)
    fail("Shorten the narration to 12,000 characters for a free archive film.");
  return { filmId: input.filmId, title: text(input.title, 200, "the film title", true), duration: input.duration, scenes };
}
export function aiSceneInput(input) {
  if (input?.mode === "film") return ltxFilmInput(input, fail);
  if (!input || !UUID.test(input.filmId || "") || !UUID.test(input.requestId || "") || input.consent !== true)
    fail("Confirm AI rendering and choose a saved film.");
  if (![2, 5].includes(input.duration) || !Array.isArray(input.scenes) || input.scenes.length !== 1)
    fail("Choose one scene and a two- or five-second clip.");
  const scene = input.scenes[0];
  if (scene?.photoId) fail("This AI scene renderer uses a text description. Reference photos are not supported.");
  return { filmId: input.filmId, title: text(input.title, 200, "the clip title", true), duration: input.duration,
    scenes: [{ title: text(scene?.title, 200, "the scene title", true), visual: text(scene?.visual, 1800, "the scene description", true), narration: "", dialogue: "" }] };
}
export const AI_VIDEO_PROFILE = Object.freeze({ namespace: "ai-video", query: "ltx", engine: "ltx-2.5-nvfp4", width: 1024, height: 576,
  label: "AI scene video", format: "1024 × 576 MP4", narration: "Generated sound", input: aiSceneInput,
  online: "AI video renderer is online. Create a short scene with generated motion and sound.",
  enabled: () => Boolean(process.env.LINEAGE_AI_VIDEO_WORKER_KEY), maxDuration: 6 });
const ARCHIVE_PROFILE = Object.freeze({ namespace: "local-video", query: "1", engine: "ffmpeg-espeak", width: 1280, height: 720,
  label: "Free archive film", format: "1280 × 720 MP4", narration: "Computer narration", input: localFilmInput,
  online: "Local renderer is online. Photos, titles, captions, and narration are included.",
  enabled: () => Boolean(process.env.LINEAGE_LOCAL_VIDEO_WORKER_KEY), maxDuration: 900 });
function publicJob(job, profile) {
  return { id: job.id, filmId: job.filmId, title: job.title, status: job.status, progress: job.progress, createdAt: job.createdAt,
    ...(job.mode === "film" ? { mode: "film", plan: { characters: job.characters, scenes: job.scenes, voice: job.voice, speed: job.speed, era: job.era, style: job.style },
      review: job.review || null, timeline: job.media?.timeline || [], mediaSha256: job.media?.sha256 } : {}),
    ...(job.status === "failed" ? { message: "Local rendering could not finish. Your script and photos are saved. You can start a new render." } : {}),
    ...(job.media ? { durationSeconds: job.media.durationSeconds, sizeBytes: job.media.sizeBytes,
      mediaUrl: `/api/studio?local=${profile.query}&action=video&id=${job.id}` } : {}) };
}

export function createLocalVideoService({ read = readRecord, write = writeRecord, listBlobs = list, getBlob = get,
  remove = del,
  token = generateClientTokenFromReadWriteToken, sources = mediaLibrary, now = Date.now, uuid = randomUUID,
  profile = ARCHIVE_PROFILE, enabled = profile.enabled } = {}) {
  const PREFIX = `${profile.namespace}/jobs/`, PENDING = `${profile.namespace}/pending/`, HEARTBEAT = `${profile.namespace}/worker.json`;
  const pathFor = id => HASH.test(id || "") ? `${PREFIX}${id}.json` : fail("Choose a valid local film.");
  const publicResult = job => publicJob(job, profile);
  async function mutate(path, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = await read(path), value = await change(old?.value);
      if (!value) return null;
      try { await write(path, value, old?.etag); return value; }
      catch (error) { if (!conflict(error)) throw error; }
    }
    fail("The local render queue is busy. Try again.", 409);
  }
  async function active(email) {
    const actor = (await read(userPath(email)))?.value;
    if (!actor || actor.email !== email || actor.mustChangePassword || accessStatusForUser(actor) !== "approved")
      fail("This account cannot render a film.", 403);
    return actor;
  }
  async function capabilities() {
    const value = enabled() ? (await read(HEARTBEAT))?.value : null;
    const online = Boolean(value && now() - value.at < 120_000 && value.at <= now());
    return { available: online, label: profile.label, priceCents: 0, format: profile.format, narration: profile.narration,
      message: online ? profile.online : "The local renderer is offline. Your saved films remain available; check again later." };
  }
  async function own(actor, id) {
    const job = (await read(pathFor(id)))?.value;
    if (!job || job.email !== actor.email) fail("This local film was not found.", 404);
    return job;
  }
  async function start(actor, input) {
    const plan = profile.input(input), id = digest(`${actor.email}:${input.requestId}`), path = pathFor(id), inputHash = digest(JSON.stringify(plan));
    const existing = (await read(path))?.value;
    if (existing) {
      if (existing.email !== actor.email || existing.inputHash !== inputHash) fail("This request already belongs to a different saved draft. Start a new render.", 409);
      await index(actor, id);
      if (["queued", "rendering"].includes(existing.status)) await mutate(`${PENDING}${id}.json`, () => ({ id }));
      return publicResult(existing);
    }
    if (!(await capabilities()).available) fail("The local renderer is offline. Check again before starting a film.", 503);
    for (const [id, kind] of filmSources(plan)) await checkedSource(actor, id, kind);
    const job = { version: 1, id, ...plan, email: actor.email, inputHash, status: "queued", progress: 0, attempts: 0, createdAt: new Date(now()).toISOString() };
    await mutate(path, old => {
      if (old && (old.email !== actor.email || old.inputHash !== inputHash)) fail("This render request changed.", 409);
      return old || job;
    });
    await index(actor, id);
    await mutate(`${PENDING}${id}.json`, () => ({ id }));
    return publicResult(await own(actor, id));
  }
  async function index(actor, id) {
    await mutate(`${profile.namespace}/accounts/${digest(actor.email)}.json`, old => ({ ids: [id, ...(old?.ids || []).filter(value => value !== id)].slice(0, 50) }));
  }
  async function history(actor) {
    const ids = (await read(`${profile.namespace}/accounts/${digest(actor.email)}.json`))?.value?.ids || [];
    const jobs = await Promise.all(ids.slice(0, 50).filter(id => HASH.test(id)).map(id => read(pathFor(id))));
    return { jobs: jobs.map(record => record?.value).filter(job => job?.email === actor.email).map(publicResult) };
  }
  async function lease(id, claim) {
    const job = (await read(pathFor(id)))?.value;
    if (!job || !UUID.test(claim || "") || job.status !== "rendering" || job.lease?.token !== claim || job.lease.expiresAt <= now())
      fail("The render claim expired.", 409);
    await active(job.email);
    return job;
  }
  async function heartbeat() { await mutate(HEARTBEAT, () => ({ at: now(), engine: profile.engine })); }
  async function poll() {
    await heartbeat();
    let cursor;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await listBlobs({ prefix: PENDING, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const blob of page.blobs) {
        const id = blob.pathname.slice(PENDING.length, -5);
        if (!HASH.test(id) || blob.pathname !== `${PENDING}${id}.json`) continue;
        const stored = (await read(pathFor(id)))?.value;
        if (!stored || ["completed", "failed", "review", "changes_requested"].includes(stored.status)) { await remove(blob.pathname); continue; }
        let claimed = false;
        const claim = uuid();
        const job = await mutate(pathFor(id), async old => {
          claimed = false;
          if (!old || old.id !== id || !["queued", "rendering"].includes(old.status) || old.lease?.expiresAt > now()) return null;
          try { await active(old.email); } catch { return { ...old, status: "failed", lease: null }; }
          if (old.attempts >= 3) return { ...old, status: "failed", lease: null };
          claimed = true;
          return { ...old, status: "rendering", progress: 1, attempts: old.attempts + 1, lease: { token: claim, expiresAt: now() + 300_000 } };
        });
        if (claimed && job?.lease?.token === claim) return { job: { id: job.id, title: job.title, duration: job.duration, scenes: job.scenes,
          ...(job.mode === "film" ? { mode: "film", characters: job.characters, era: job.era, style: job.style, voice: job.voice, speed: job.speed } : {}) }, claim };
      }
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    return { job: null };
  }
  async function progress(id, claim, percent) {
    await lease(id, claim);
    await mutate(pathFor(id), old => {
      if (old?.lease?.token !== claim || old.status !== "rendering" || old.lease.expiresAt <= now()) fail("The render claim expired.", 409);
      return { ...old, progress: Math.max(old.progress, Math.min(95, Number.isInteger(percent) ? percent : 1)), lease: { token: claim, expiresAt: now() + 300_000 } };
    });
    await heartbeat();
    return { ok: true };
  }
  async function checkedSource(actor, id, kind) {
    const item = await sources.file(actor, actor.email, id);
    if (!(kind === "audio" ? audioTypes : imageTypes).includes(item.contentType) || item.size > 20 * 1024 * 1024 || item.customerState === "trash")
      fail("Use available JPG, PNG, WebP, MP3, WAV, M4A, or OGG sources under 20 MB.", 409);
    return item;
  }
  async function source(id, claim, photoId) {
    const job = await lease(id, claim);
    const kind = filmSources(job).find(([sourceId]) => sourceId === photoId)?.[1];
    if (!kind) fail("This source is not part of the render.", 403);
    const photo = await checkedSource(await active(job.email), photoId, kind);
    return { pathname: photo.pathname, contentType: photo.contentType, sizeBytes: photo.size };
  }
  function validateReport(report, job) {
    const film = job.mode === "film";
    if (!report || !HASH.test(report.sha256 || "") || !Number.isSafeInteger(report.sizeBytes) || report.sizeBytes < 100 || report.sizeBytes > (film ? 500 * 1024 * 1024 : MAX_BYTES)
      || !Number.isFinite(report.durationSeconds) || report.durationSeconds < 1 || report.durationSeconds > (film ? 601 : profile.maxDuration)
      || report.width !== profile.width || report.height !== profile.height || report.hasAudio !== true || report.engine !== profile.engine) fail("The rendered film could not be verified.", 409);
    return { sha256: report.sha256, sizeBytes: report.sizeBytes, durationSeconds: report.durationSeconds, width: profile.width, height: profile.height, hasAudio: true, contentType: "video/mp4",
      ...(film ? { timeline: checkedTimeline(report, job, fail) } : {}) };
  }
  async function upload(id, claim, report) {
    const job = await lease(id, claim), media = validateReport(report, job);
    const pathname = `${profile.namespace}/media/${digest(job.email)}/${id}/${media.sha256}.mp4`;
    return { pathname, token: await token({ pathname, maximumSizeInBytes: media.sizeBytes, allowedContentTypes: ["video/mp4"],
      validUntil: now() + 300_000, addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 }) };
  }
  async function complete(id, claim, report) {
    const job = await lease(id, claim), media = validateReport(report, job);
    media.pathname = `${profile.namespace}/media/${digest(job.email)}/${id}/${media.sha256}.mp4`;
    const stored = await getBlob(media.pathname, { access: "private", useCache: false, headers: { "accept-encoding": "identity" } });
    if (!stored?.stream || stored.blob.pathname !== media.pathname || stored.blob.contentType !== "video/mp4" || stored.blob.size !== media.sizeBytes) {
      await stored?.stream?.cancel(); fail("The uploaded film could not be verified.", 409);
    }
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of stored.stream) { size += chunk.length; if (size > media.sizeBytes) fail("The uploaded film changed.", 409); hash.update(chunk); }
    if (size !== media.sizeBytes || hash.digest("hex") !== media.sha256) fail("The uploaded film checksum changed.", 409);
    await lease(id, claim);
    return publicResult(await mutate(pathFor(id), old => {
      if (old?.lease?.token !== claim || old.status !== "rendering" || old.lease.expiresAt <= now()) fail("The render claim expired.", 409);
      return { ...old, status: old.mode === "film" ? "review" : "completed", progress: 100, lease: null, media, completedAt: new Date(now()).toISOString() };
    }));
  }
  async function failed(id, claim) {
    await lease(id, claim);
    await mutate(pathFor(id), old => {
      if (old?.lease?.token !== claim || old.status !== "rendering") fail("The render claim expired.", 409);
      return { ...old, status: "failed", lease: null };
    });
    return { ok: true };
  }
  async function video(actor, id) {
    const job = await own(actor, id), media = job.media;
    if (!["completed", "review", "changes_requested"].includes(job.status) || !media || !HASH.test(media.sha256 || "") || media.pathname !== `${profile.namespace}/media/${digest(actor.email)}/${id}/${media.sha256}.mp4`)
      fail("Your film is not ready to watch yet.", 409);
    return media;
  }
  async function review(actor, input) {
    await active(actor.email);
    const job = await own(actor, input.id);
    if (job.mode !== "film" || !["review", "changes_requested", "completed"].includes(job.status) || !HASH.test(input.sha256 || "") || input.sha256 !== job.media?.sha256)
      fail("Refresh the film before reviewing this version.", 409);
    if (!["approve", "changes"].includes(input.decision)) fail("Choose an approval or request changes.");
    const notes = text(input.notes || "", 2000, "your review notes", input.decision === "changes");
    if (input.decision === "approve" && !["characters", "narration", "timing"].every(key => input.checks?.[key] === true)) fail("Review character continuity, narration, and timing before approval.");
    return publicResult(await mutate(pathFor(job.id), old => {
      if (old?.media?.sha256 !== input.sha256 || old.status !== job.status) fail("The film review changed. Refresh it.", 409);
      return { ...old, status: input.decision === "approve" ? "completed" : "changes_requested",
        review: { decision: input.decision, notes, at: new Date(now()).toISOString(), sha256: input.sha256,
          checks: Object.fromEntries(["characters", "narration", "timing"].map(key => [key, input.checks?.[key] === true])) } };
    }));
  }
  return { capabilities, start, history, status: async (actor, id) => publicResult(await own(actor, id)), poll, progress, source, upload, complete, failed, video, review };
}
export const localVideo = createLocalVideoService();
export const aiVideo = createLocalVideoService({ profile: AI_VIDEO_PROFILE });
