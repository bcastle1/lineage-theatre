import { randomUUID } from "node:crypto";
import { get, head, list } from "@vercel/blob";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { accessStatusForUser, hasAdminAccess } from "./access.mjs";

export const MAX_FILM_BYTES = 500 * 1024 * 1024;
export const MAX_ACCOUNT_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_ACCOUNT_FILMS = 100;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TYPES = { "video/mp4": "mp4", "video/webm": "webm" };

export class ArchiveError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function archiveId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new ArchiveError("Choose a valid film reference.");
  return value;
}
export function archiveOwner(value) {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(value))
    throw new ArchiveError("Choose a valid archive owner.");
  return value.trim().toLowerCase();
}
export const metadataPath = (owner, id) => `archive/metadata/${digest(archiveOwner(owner))}/${archiveId(id)}.json`;
export const mediaPath = (owner, id, type) => {
  if (!Object.hasOwn(TYPES, type)) throw new ArchiveError("Choose an MP4 or WebM finished film.");
  return `archive/media/${digest(archiveOwner(owner))}/${archiveId(id)}.${TYPES[type]}`;
};
export function publicFilm(record) {
  return {
    id: record.id, ownerEmail: record.ownerEmail, title: record.title,
    ancestor: record.ancestor, duration: record.duration, createdAt: record.createdAt,
    updatedAt: record.updatedAt, hasVideo: Boolean(record.video),
    status: record.video ? "uploaded" : record.pending ? "upload-pending" : "draft",
  };
}
function field(value, label, max) {
  if (typeof value !== "string" || value.length > max) throw new ArchiveError(`${label} must be ${max} characters or fewer.`);
  return value.trim();
}
export function validateArchiveInput(input) {
  if (!input || input.archiveConsent !== true) throw new ArchiveError("Allow your film details and selected video to be saved privately with administrator access before saving.");
  const id = archiveId(input.id);
  const title = field(input.title, "The film title", 200);
  const ancestor = field(input.ancestor, "The ancestor name", 160);
  if (!title) throw new ArchiveError("Add a title before saving to the cloud archive.");
  const duration = input.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 4 * 3600)
    throw new ArchiveError("The film duration must be between zero and four hours.");
  let video;
  if (input.video !== undefined) {
    if (!input.video || !Object.hasOwn(TYPES, input.video.type)) throw new ArchiveError("Choose an MP4 or WebM finished film.");
    if (!Number.isSafeInteger(input.video.size) || input.video.size < 16 || input.video.size > MAX_FILM_BYTES)
      throw new ArchiveError("Each finished film must be between 16 bytes and 500 MB.");
    video = { type: input.video.type, size: input.video.size };
  }
  // Deliberately whitelist metadata. Scripts, source documents and client URLs are never stored.
  return { id, title, ancestor, duration, video };
}
export function parseRange(value, size) {
  if (!value) return null;
  if (typeof value !== "string") throw new ArchiveError("The requested video range is invalid.", 416);
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new ArchiveError("The requested video range is invalid.", 416);
  let start, end;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) throw new ArchiveError("The requested video range is invalid.", 416);
    start = Math.max(0, size - length); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end)
      throw new ArchiveError("The requested video range is unavailable.", 416);
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1, header: `bytes=${start}-${end}`, contentRange: `bytes ${start}-${end}/${size}` };
}
export function verifyVideoHeader(bytes, type) {
  return type === "video/mp4"
    ? bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp"
    : type === "video/webm" && bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}
async function leadingBytes(stream) {
  const reader = stream.getReader();
  const bytes = new Uint8Array(32); let offset = 0;
  try {
    while (offset < bytes.length) {
      const next = await reader.read();
      if (next.done) break;
      const take = Math.min(next.value.length, bytes.length - offset);
      bytes.set(next.value.subarray(0, take), offset); offset += take;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return bytes.subarray(0, offset);
}
function conflict(error) { return /precondition|already exists|etag|if.?match/i.test(`${error?.name} ${error?.message}`); }

export function createArchiveService(dependencies = {}) {
  const read = dependencies.readRecord || readRecord;
  const write = dependencies.writeRecord || writeRecord;
  const listBlobs = dependencies.listBlobs || list;
  const headBlob = dependencies.headBlob || head;
  const getBlob = dependencies.getBlob || get;
  const now = dependencies.now || (() => Date.now());
  const uuid = dependencies.uuid || randomUUID;

  async function requireApprovedOwner(owner) {
    const account = await read(userPath(owner));
    if (account?.value.email !== owner || accessStatusForUser(account.value) !== "approved")
      throw new ArchiveError("This account is not approved to complete a cloud upload.", 403);
  }

  async function mutate(path, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await read(path);
      const next = await change(previous?.value);
      try { await write(path, next, previous?.etag); return next; }
      catch (error) { if (!conflict(error) || attempt === 4) throw error; }
    }
  }
  async function reserve(owner, id, size = 0) {
    await mutate(`archive/accounts/${digest(owner)}.json`, (old) => {
      const films = { ...(old?.films || {}) };
      if (!Object.hasOwn(films, id) && Object.keys(films).length >= MAX_ACCOUNT_FILMS)
        throw new ArchiveError("Your cloud archive has reached its 100-film limit. Contact the administrator for help.", 409);
      films[id] = Math.max(films[id] || 0, size);
      if (Object.values(films).reduce((sum, bytes) => sum + bytes, 0) > MAX_ACCOUNT_BYTES)
        throw new ArchiveError("Your cloud archive has reached its 5 GB upload allowance. Contact the administrator for help.", 409);
      return { films, updatedAt: new Date(now()).toISOString() };
    });
  }
  async function readFilm(ownerValue, idValue) {
    const owner = archiveOwner(ownerValue), id = archiveId(idValue);
    const record = await read(metadataPath(owner, id));
    if (!record || record.value.ownerEmail !== owner || record.value.id !== id)
      throw new ArchiveError("This cloud film was not found.", 404);
    return record;
  }
  async function requireDeliveryAdministrator(email) {
    const current = (await read(userPath(email)))?.value;
    if (!current || current.email !== email || current.mustChangePassword || !hasAdminAccess(current))
      throw new ArchiveError("The administrator who assigned this delivery no longer has access.", 403);
  }
  async function save(ownerValue, input, delivery) {
    const owner = archiveOwner(ownerValue), data = validateArchiveInput(input);
    if (delivery) {
      await requireApprovedOwner(owner);
      await requireDeliveryAdministrator(delivery.assignedBy);
      if (delivery.provider !== "magiclight" || !/^\d{10,25}$/.test(delivery.projectId || "") || !/^[a-f0-9]{64}$/.test(delivery.sourceHash || ""))
        throw new ArchiveError("The delivery reference is invalid.");
    }
    const current = await read(metadataPath(owner, data.id));
    if (current?.value.delivery && !delivery) throw new ArchiveError("This film was delivered by your administrator. Create a new film to upload another version.", 409);
    if (current?.value.video && data.video) throw new ArchiveError("This cloud film already has a video. Save a new film to upload another version.", 409);
    if (current?.value.pending && data.video && (current.value.pending.size !== data.video.size || current.value.pending.contentType !== data.video.type))
      throw new ArchiveError("Resume this film's original upload, or create a new film for a different video.", 409);
    await reserve(owner, data.id, data.video?.size);
    const saved = await mutate(metadataPath(owner, data.id), (old) => {
      if (old && (old.ownerEmail !== owner || old.id !== data.id)) throw new ArchiveError("This cloud film could not be updated.", 403);
      if (old?.video && data.video) throw new ArchiveError("This cloud film already has a video. Save a new film to upload another version.", 409);
      if (old?.pending && data.video && (old.pending.size !== data.video.size || old.pending.contentType !== data.video.type))
        throw new ArchiveError("Resume this film's original upload, or create a new film for a different video.", 409);
      const timestamp = new Date(now()).toISOString();
      return {
        version: 1, id: data.id, ownerEmail: owner, title: data.title, ancestor: data.ancestor,
        duration: data.duration, createdAt: old?.createdAt || timestamp, updatedAt: timestamp,
        ...(delivery ? { delivery: { ...delivery, assignedAt: old?.delivery?.assignedAt || timestamp } }
          : { consent: { administratorAccess: true, savedAt: timestamp } }),
        ...(old?.video ? { video: old.video } : {}),
        ...(old?.pending ? { pending: old.pending } : data.video ? { pending: {
          nonce: uuid(), pathname: mediaPath(owner, data.id, data.video.type),
          contentType: data.video.type, size: data.video.size, createdAt: timestamp,
        } } : {}),
      };
    });
    return { film: publicFilm(saved), ...(saved.pending ? { upload: { pathname: saved.pending.pathname, clientPayload: JSON.stringify({ id: saved.id }) } } : {}) };
  }
  async function uploadOptions(ownerValue, pathname, payload) {
    let input;
    try { input = JSON.parse(payload); } catch { throw new ArchiveError("The upload request is invalid."); }
    const owner = archiveOwner(ownerValue);
    const record = (await readFilm(owner, input?.id)).value;
    if (record.delivery) throw new ArchiveError("Administrator deliveries cannot be replaced with a browser upload.", 403);
    if (!record.pending || record.video || pathname !== record.pending.pathname || pathname !== mediaPath(owner, record.id, record.pending.contentType))
      throw new ArchiveError("The video upload does not match this film.", 403);
    return {
      allowedContentTypes: [record.pending.contentType], maximumSizeInBytes: record.pending.size,
      validUntil: now() + 30 * 60_000, addRandomSuffix: false, allowOverwrite: false,
      tokenPayload: JSON.stringify({ id: record.id, ownerEmail: owner, ...record.pending }),
    };
  }
  async function finalize(ownerValue, idValue, ticket) {
    const owner = archiveOwner(ownerValue), id = archiveId(idValue);
    const original = (await readFilm(owner, id)).value;
    if (original.video) {
      if (ticket && ["pathname", "nonce", "contentType", "size"].some((key) => ticket[key] !== original.video[key]))
        throw new ArchiveError("The upload callback does not match this film.", 403);
      return publicFilm(original);
    }
    const pending = original.pending;
    if (!pending) throw new ArchiveError("Choose a finished video for this cloud film first.", 409);
    if (ticket && ["pathname", "nonce", "contentType", "size"].some((key) => ticket[key] !== pending[key]))
      throw new ArchiveError("The upload callback does not match this film.", 403);
    if (pending.pathname !== mediaPath(owner, id, pending.contentType)) throw new ArchiveError("The archived video path is invalid.", 403);
    // A signed upload ticket can outlive account approval. Its callback has no
    // browser session, so the current account must authorize a new finalization.
    await requireApprovedOwner(owner);
    if (original.delivery) await requireDeliveryAdministrator(original.delivery.assignedBy);
    let info;
    try { info = await headBlob(pending.pathname); }
    catch (error) { if (/not.?found/i.test(`${error?.name} ${error?.message}`)) throw new ArchiveError("The video upload has not arrived yet. Retry verification after the upload finishes.", 409); throw error; }
    if (info.pathname !== pending.pathname || info.size !== pending.size || info.contentType !== pending.contentType || info.size > MAX_FILM_BYTES)
      throw new ArchiveError("The uploaded video does not match its approved type and size.", 409);
    const beginning = await getBlob(pending.pathname, { access: "private", useCache: false, headers: { Range: "bytes=0-31" } });
    if (!beginning?.stream || !verifyVideoHeader(await leadingBytes(beginning.stream), pending.contentType))
      throw new ArchiveError("The uploaded file is not a recognized MP4 or WebM video.", 409);
    const saved = await mutate(metadataPath(owner, id), async (old) => {
      if (!old || old.ownerEmail !== owner || old.id !== id) throw new ArchiveError("This cloud film was not found.", 404);
      if (old.video?.pathname === pending.pathname && old.video.nonce === pending.nonce) return old;
      if (!old.pending || old.pending.nonce !== pending.nonce) throw new ArchiveError("This video upload is no longer current.", 409);
      // Media verification may take time. Recheck immediately before committing,
      // including retries after a concurrent metadata update.
      await requireApprovedOwner(owner);
      if (old.delivery) await requireDeliveryAdministrator(old.delivery.assignedBy);
      const { pending: removed, ...rest } = old;
      return { ...rest, updatedAt: new Date(now()).toISOString(), video: {
        pathname: pending.pathname, contentType: info.contentType, size: info.size,
        etag: info.etag, nonce: pending.nonce, uploadedAt: new Date(now()).toISOString(),
        origin: old.delivery ? "magiclight-delivery" : "user-upload",
      } };
    });
    return publicFilm(saved);
  }
  async function completeUpload({ blob, tokenPayload }) {
    let ticket;
    try { ticket = JSON.parse(tokenPayload); } catch { throw new ArchiveError("The upload callback is invalid.", 403); }
    if (!ticket || !blob || blob.pathname !== ticket.pathname || ticket.pathname !== mediaPath(ticket.ownerEmail, ticket.id, ticket.contentType))
      throw new ArchiveError("The upload callback path is invalid.", 403);
    return finalize(ticket.ownerEmail, ticket.id, ticket);
  }
  async function listArchive({ ownerEmail, cursor, limit = 25 } = {}) {
    const owner = ownerEmail ? archiveOwner(ownerEmail) : null;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 2000)) throw new ArchiveError("The archive page reference is invalid.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ArchiveError("Choose an archive page size between 1 and 50.");
    const prefix = `archive/metadata/${owner ? `${digest(owner)}/` : ""}`;
    const result = await listBlobs({ prefix, cursor: cursor || undefined, limit });
    const records = await Promise.all(result.blobs.map(async (blob) => {
      if (!blob.pathname.startsWith(prefix) || !/^archive\/metadata\/[a-f0-9]{64}\/[a-f0-9-]{36}\.json$/.test(blob.pathname)) return null;
      const record = await read(blob.pathname);
      if (!record || (owner && record.value.ownerEmail !== owner)) return null;
      try { if (metadataPath(record.value.ownerEmail, record.value.id) !== blob.pathname) return null; }
      catch { return null; }
      return publicFilm(record.value);
    }));
    return { films: records.filter(Boolean), ...(result.hasMore && result.cursor ? { cursor: result.cursor } : {}) };
  }
  return { save, readFilm, uploadOptions, finalize, completeUpload, listArchive };
}

export const archive = createArchiveService();
export const listArchive = (options) => archive.listArchive(options);
