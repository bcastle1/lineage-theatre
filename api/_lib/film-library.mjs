import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { list as listBlobRecords } from "@vercel/blob";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { accessStatusForUser, isOwner } from "./access.mjs";
import { productionJobPath } from "./film-production.mjs";
import { metadataPath, mediaPath, MAX_FILM_BYTES } from "./archive.mjs";
import { requireFinishedFilmPayment, validateStoredProductionMedia } from "./production-media.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = ["plan", "upload"];
const VIEWS = ["active", "archived", "trash"];
const JOB_STATES = ["prepared", "queued", "submitting", "processing", "uncertain", "failed", "completed", "awaiting-assembly"];
const PAYMENT_STATES = ["awaiting-payment", "submitting", "uncertain", "captured", "declined", "refund-pending", "refunded", "partially-refunded"];
const PAGE_SIZE = 12;
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export class FilmLibraryError extends Error {
  constructor(message, status = 400, code = "INVALID_LIBRARY_REQUEST") { super(message); this.name = "FilmLibraryError"; this.status = status; this.code = code; }
}
const invalid = () => new FilmLibraryError("Choose a valid film library action.");
const missing = () => new FilmLibraryError("This saved film was not found in your library.", 404, "LIBRARY_NOT_FOUND");
const conflict = () => new FilmLibraryError("This library entry changed. Refresh before organizing it again.", 409, "LIBRARY_CONFLICT");
const denied = () => new FilmLibraryError("Sign in with an approved account to use your film library.", 403, "LIBRARY_ACCESS_REQUIRED");
const unavailable = () => new FilmLibraryError("Your film library could not be loaded. Your saved films and payments are unchanged.", 503, "LIBRARY_UNAVAILABLE");
function identity(kind, id) { if (!KINDS.includes(kind) || typeof id !== "string" || !UUID.test(id)) throw invalid(); }
function actorEmail(actor) {
  if (!actor || actor.mustChangePassword || accessStatusForUser(actor) !== "approved" || typeof actor.email !== "string"
    || actor.email.length > 254 || actor.email !== actor.email.toLowerCase().trim() || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(actor.email)) throw denied();
  return actor.email;
}
export const libraryStatePath = (email, kind, id) => {
  identity(kind, id);
  return `library/entries/${digest(email)}/${kind}/${id}.json`;
};

// Saved plan versions and uploaded films retain distinct identities. Organizing
// an entry never rewrites a plan, payment, queue ticket or media object.
export function createFilmLibraryService({ read = readRecord, write = writeRecord, listBlobs = listBlobRecords,
  now = Date.now, cursorSecret = () => process.env.LINEAGE_SESSION_SECRET } = {}) {
  async function approved(actor) {
    const email = actorEmail(actor), current = (await read(userPath(email)))?.value;
    if (!current || current.email !== email || current.mustChangePassword || accessStatusForUser(current) !== "approved") throw denied();
    return current;
  }
  function cursorKey() {
    const key = typeof cursorSecret === "function" ? cursorSecret() : cursorSecret;
    if (typeof key !== "string" || !key) throw unavailable();
    return key;
  }
  function encodeCursor(email, view, phase, cursor) {
    const value = Buffer.from(JSON.stringify({ version: 1, owner: digest(email), view, phase, cursor: cursor ?? null, expires: now() + 24 * 3600_000 })).toString("base64url");
    return `${value}.${createHmac("sha256", cursorKey()).update(value).digest("base64url")}`;
  }
  function decodeCursor(value, email, view) {
    if (value === undefined) return { phase: "plan", cursor: undefined };
    if (typeof value !== "string" || value.length > 6000) throw invalid();
    try {
      const [payload, signature, extra] = value.split(".");
      const expected = createHmac("sha256", cursorKey()).update(payload).digest("base64url");
      if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (data.version !== 1 || data.owner !== digest(email) || data.view !== view || !KINDS.includes(data.phase)
        || !Number.isFinite(data.expires) || data.expires <= now() || data.expires > now() + 24 * 3600_000
        || !(data.cursor === null || typeof data.cursor === "string" && data.cursor.length > 0 && data.cursor.length <= 2048)) throw invalid();
      return { phase: data.phase, cursor: data.cursor || undefined };
    } catch (error) { if (error instanceof FilmLibraryError && error.status === 503) throw error; throw invalid(); }
  }
  function sourcePath(email, kind, id) { return kind === "plan" ? productionJobPath(email, id) : metadataPath(email, id); }
  function validResource(value, actor, kind, id) {
    if (!plain(value) || value.id !== id || typeof value.title !== "string" && kind === "upload") throw missing();
    if (kind === "plan") {
      if (value.ownerHash !== digest(actor.email) || !["customer", "operator-test"].includes(value.mode)
        || value.mode === "operator-test" && !isOwner(actor) || !UUID.test(value.filmId || "") || !HASH.test(value.manifestHash || "")
        || !plain(value.manifest) || value.manifest.filmId !== value.filmId || digest(JSON.stringify(value.manifest)) !== value.manifestHash
        || typeof value.manifest.title !== "string" || value.manifest.title.length > 200 || !integer(value.manifest.targetDurationSeconds, 15, 600)
        || !Array.isArray(value.manifest.screenplay?.scenes) || !integer(value.manifest.screenplay.scenes.length, 1, 30)
        || !Array.isArray(value.shots) || !integer(value.shots.length, 1, 1000) || !JOB_STATES.includes(value.status)) throw missing();
    } else if (value.ownerEmail !== actor.email || value.title.length > 200 || !Number.isFinite(value.duration) || value.duration < 0 || value.duration > 14400) throw missing();
    if (!date(value.createdAt) || !date(value.updatedAt)) throw missing();
    return value;
  }
  async function resource(actor, kind, id) {
    identity(kind, id);
    return validResource((await read(sourcePath(actor.email, kind, id)))?.value, actor, kind, id);
  }
  async function state(email, kind, id) {
    const previous = await read(libraryStatePath(email, kind, id));
    if (!previous) return { previous: null, libraryState: "active", revision: 0 };
    const value = previous.value;
    if (!plain(value) || value.version !== 1 || value.ownerHash !== digest(email) || value.kind !== kind || value.id !== id
      || !VIEWS.includes(value.state) || !integer(value.revision, 1, Number.MAX_SAFE_INTEGER) || !date(value.updatedAt)) throw conflict();
    return { previous, libraryState: value.state, revision: value.revision };
  }
  async function paymentSummaries(email, job) {
    const ids = [digest(`${email}:production:${job.manifestHash}`), digest(`${email}:${job.manifestHash}`)];
    const records = await Promise.all(ids.map(id => read(`payments/orders/${id}.json`)));
    return records.flatMap((record, index) => {
      const value = record?.value;
      if (!value || value.id !== ids[index] || value.customerEmail !== email || value.preparedId !== job.id || value.filmId !== job.filmId
        || value.manifestHash !== job.manifestHash || !PAYMENT_STATES.includes(value.status) || value.currency !== "USD"
        || !integer(value.amountCents, 1, 100_000_000) || !integer(value.refundedCents ?? 0, 0, value.amountCents)
        || !["production", "sandbox"].includes(value.merchantBinding?.environment)) return [];
      const captured = date(value.capturedAt);
      return [{ id: value.id, status: value.status, amountCents: value.amountCents, currency: "USD", refundedCents: value.refundedCents ?? 0,
        sandbox: value.merchantBinding.environment === "sandbox",
        requiresReview: ["submitting", "uncertain", "refund-pending"].includes(value.status) || Boolean(value.refundOperation || value.checkOperation)
          || value.status === "captured" && !captured,
        receiptAvailable: captured }];
    });
  }
  async function entry(actor, kind, id, supplied) {
    const value = supplied || await resource(actor, kind, id);
    const metadata = await state(actor.email, kind, id);
    let production, payments = [], mediaReady = false;
    if (kind === "plan") {
      const queue = (await read(`production/queue/${digest(actor.email)}/${id}.json`))?.value;
      const ticket = queue?.email === actor.email && queue.id === id && queue.manifestHash === value.manifestHash ? queue : null;
      payments = await paymentSummaries(actor.email, value);
      if (value.status === "completed") {
        try {
          validateStoredProductionMedia(value, actor.email);
          await requireFinishedFilmPayment({ job: value, email: actor.email, actor, read, now });
          mediaReady = true;
        } catch { /* Playback remains unavailable until the existing delivery checks pass. */ }
      }
      production = { status: value.status === "prepared" && ticket?.state === "pending" ? "queued" : value.status === "awaiting-assembly" ? "processing" : value.status,
        completedShots: value.shots.filter(shot => shot.status === "completed").length, shotCount: value.shots.length, mediaReady,
        needsAttention: ticket?.state === "attention" || value.status === "uncertain" || value.status === "failed" || value.status === "completed" && !mediaReady };
    } else {
      const video = value.video;
      if (video && ["video/mp4", "video/webm"].includes(video.contentType) && integer(video.size, 16, MAX_FILM_BYTES)
        && video.pathname === mediaPath(actor.email, id, video.contentType)) mediaReady = true;
      production = { status: mediaReady ? "uploaded" : "prepared", completedShots: 0, shotCount: 0, mediaReady, needsAttention: Boolean(video && !mediaReady) };
    }
    const mediaUrl = kind === "plan" ? `/api/studio?action=productionMedia&id=${id}` : `/api/archive?action=media&id=${id}`;
    return { kind, id, filmId: kind === "plan" ? value.filmId : id, title: kind === "plan" ? value.manifest.title : value.title,
      durationSeconds: kind === "plan" ? value.manifest.targetDurationSeconds : value.duration,
      createdAt: value.createdAt, updatedAt: value.updatedAt, libraryState: metadata.libraryState, revision: metadata.revision, production, payments,
      ...(kind === "plan" ? { manifestHash: value.manifestHash } : {}),
      ...(mediaReady ? { mediaUrl, downloadUrl: `${mediaUrl}&download=1` } : {}) };
  }
  async function list(actor, { view = "active", cursor } = {}) {
    const current = await approved(actor), email = current.email;
    if (!VIEWS.includes(view)) throw invalid();
    const position = decodeCursor(cursor, email, view);
    const prefix = position.phase === "plan" ? `production/jobs/${digest(email)}/` : `archive/metadata/${digest(email)}/`;
    const page = await listBlobs({ prefix, limit: PAGE_SIZE, ...(position.cursor ? { cursor: position.cursor } : {}) });
    if (!plain(page) || !Array.isArray(page.blobs) || page.blobs.length > PAGE_SIZE || typeof page.hasMore !== "boolean"
      || page.hasMore && (typeof page.cursor !== "string" || !page.cursor || page.cursor.length > 2048 || page.cursor === position.cursor)) throw unavailable();
    const entries = await Promise.all(page.blobs.map(async blob => {
      const id = typeof blob.pathname === "string" && blob.pathname.startsWith(prefix) ? blob.pathname.slice(prefix.length).replace(/\.json$/, "") : "";
      if (!UUID.test(id) || blob.pathname !== sourcePath(email, position.phase, id)) return null;
      let value;
      try { value = await resource(current, position.phase, id); }
      catch (error) { if (error instanceof FilmLibraryError && error.status === 404) return null; throw error; }
      const result = await entry(current, position.phase, id, value);
      return result.libraryState === view ? result : null;
    }));
    await approved(actor);
    const next = page.hasMore ? encodeCursor(email, view, position.phase, page.cursor)
      : position.phase === "plan" ? encodeCursor(email, view, "upload", null) : undefined;
    return { entries: entries.filter(Boolean), ...(next ? { cursor: next } : {}) };
  }
  async function detail(actor, { kind, id }) {
    const current = await approved(actor), value = await resource(current, kind, id);
    const result = await entry(current, kind, id, value);
    await approved(actor);
    return { entry: result, ...(kind === "plan" ? { manifest: { id, manifestHash: value.manifestHash, manifest: structuredClone(value.manifest) } } : {}) };
  }
  async function organize(actor, input) {
    if (!plain(input) || Object.keys(input).some(key => !["action", "kind", "id", "expectedRevision"].includes(key))
      || !["archive", "trash", "restore"].includes(input.action) || !integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)) throw invalid();
    const current = await approved(actor), { kind, id } = input;
    await resource(current, kind, id);
    const old = await state(current.email, kind, id);
    if (old.revision !== input.expectedRevision) throw conflict();
    const nextState = { archive: "archived", trash: "trash", restore: "active" }[input.action];
    if (old.libraryState !== nextState) {
      const next = { version: 1, ownerHash: digest(current.email), kind, id, state: nextState, revision: old.revision + 1,
        updatedAt: new Date(now()).toISOString(), changeId: randomUUID() };
      await approved(actor);
      try { await write(libraryStatePath(current.email, kind, id), next, old.previous?.etag); }
      catch { /* Confirm a lost metadata-write reply without overwriting a competing action. */ }
      const confirmed = await read(libraryStatePath(current.email, kind, id));
      if (confirmed?.value?.changeId !== next.changeId || digest(JSON.stringify(confirmed.value)) !== digest(JSON.stringify(next))) throw conflict();
    }
    return { entry: (await detail(actor, { kind, id })).entry };
  }
  return Object.freeze({ list, detail, organize });
}

export const filmLibrary = createFilmLibraryService();
