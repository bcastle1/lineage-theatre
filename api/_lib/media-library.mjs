import { randomUUID } from "node:crypto";
import { head, list, del } from "@vercel/blob";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { hasAdminAccess, accessStatusForUser } from "./access.mjs";
import { audit } from "./admin.mjs";

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 10 * 1024 * 1024 * 1024;
export const SOURCE_TYPES = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  ged: "text/plain",
  csv: "text/csv",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
});
export class MediaError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const idFor = (value) => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  )
    throw new MediaError("Choose a valid media reference.");
  return value;
};
const ownerFor = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(value)
  )
    throw new MediaError("Choose a valid media owner.");
  return value.trim().toLowerCase();
};
export const sourceRecordPath = (owner, id) =>
  `sources/metadata/${digest(ownerFor(owner))}/${idFor(id)}.json`;
export const sourceBlobPath = (owner, id, ext) => {
  if (!Object.hasOwn(SOURCE_TYPES, ext))
    throw new MediaError("This source file type is not supported.");
  return `sources/files/${digest(ownerFor(owner))}/${idFor(id)}.${ext}`;
};
function filename(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 240 ||
    /[\x00-\x1f\x7f/\\]/.test(value)
  )
    throw new MediaError(
      "Use a file name of 1–240 characters without slashes or control characters.",
    );
  return value.trim();
}
const conflict = (error) =>
  /precondition|already exists|etag|if.?match/i.test(
    `${error?.name} ${error?.message}`,
  );
const active = (record) =>
  record && !["purged", "deleting"].includes(record.status);
function publicSource(record) {
  return {
    id: record.id,
    ownerEmail: record.ownerEmail,
    name: record.name,
    originalName: record.originalName,
    contentType: record.contentType,
    size: record.size,
    status: record.status,
    customerState: record.customerState,
    adminArchivedAt: record.adminArchivedAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    project: record.project || null,
    ...(record.status === "ready"
      ? {
          mediaUrl: `/api/media?action=file&owner=${encodeURIComponent(record.ownerEmail)}&id=${record.id}`,
        }
      : {}),
  };
}

export function createMediaLibrary(deps = {}) {
  const read = deps.read || readRecord,
    write = deps.write || writeRecord;
  const listBlobs = deps.list || list,
    headBlob = deps.head || head,
    deleteBlob = deps.del || del;
  const recordAudit = deps.audit || audit,
    now = deps.now || Date.now,
    uuid = deps.uuid || randomUUID;
  const timestamp = () => new Date(now()).toISOString();
  async function mutate(path, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = await read(path),
        value = await change(old?.value);
      try {
        await write(path, value, old?.etag);
        return value;
      } catch (error) {
        if (!conflict(error) || attempt === 4) throw error;
      }
    }
  }
  function authorize(actor, owner, admin = false) {
    if (
      !actor ||
      actor.mustChangePassword ||
      actor.status === "suspended" ||
      actor.accessStatus === "pending"
    )
      throw new MediaError("Sign in with an approved account.", 401);
    if ((admin || actor.email !== owner) && !hasAdminAccess(actor))
      throw new MediaError(
        "Administrator access is required for another customer's media.",
        403,
      );
  }
  async function record(owner, id) {
    const result = await read(sourceRecordPath(owner, id));
    if (!result || result.value.ownerEmail !== owner || result.value.id !== id)
      throw new MediaError("This media file was not found.", 404);
    return result.value;
  }
  async function quota(owner, id, bytes) {
    await mutate(`sources/accounts/${digest(owner)}.json`, (old) => {
      const files = { ...old?.files };
      if (bytes === null) delete files[id];
      else files[id] = bytes;
      if (
        Object.keys(files).length > 2000 ||
        Object.values(files).reduce((sum, size) => sum + size, 0) >
          MAX_LIBRARY_BYTES
      )
        throw new MediaError(
          "Your media library has reached its 2,000-file or 10 GB allowance. Contact the administrator for help.",
          409,
        );
      return { files, updatedAt: timestamp() };
    });
  }
  async function reserve(actor, input) {
    const owner = ownerFor(actor?.email);
    authorize(actor, owner);
    const id = idFor(input.id),
      name = filename(input.name),
      ext = name.split(".").pop().toLowerCase();
    const pathname = sourceBlobPath(owner, id, ext);
    if (
      !Number.isSafeInteger(input.size) ||
      input.size < 1 ||
      input.size > MAX_SOURCE_BYTES
    )
      throw new MediaError("Choose a non-empty source file up to 100 MB.");
    if (input.retentionAccepted !== true)
      throw new MediaError(
        "Acknowledge that administrators retain access when you archive or remove media.",
      );
    if (
      input.project &&
      (typeof input.project.title !== "string" ||
        input.project.title.length > 240)
    )
      throw new MediaError("Use a film title of 240 characters or fewer.");
    const project = input.project
      ? {
          id: idFor(input.project.id),
          title: input.project.title.trim() || "Untitled family film",
        }
      : null;
    const previous = await read(sourceRecordPath(owner, id));
    const check = (old) => {
      if (
        old &&
        (!active(old) ||
          old.size !== input.size ||
          old.originalName !== name ||
          old.pathname !== pathname)
      )
        throw new MediaError(
          "This media reference already belongs to a different or permanently deleted file. Choose a new upload.",
          409,
        );
    };
    check(previous?.value);
    await quota(owner, id, input.size);
    const saved = await mutate(sourceRecordPath(owner, id), (old) => {
      check(old);
      return (
        old || {
          version: 1,
          id,
          ownerEmail: owner,
          name,
          originalName: name,
          ext,
          pathname,
          size: input.size,
          contentType: SOURCE_TYPES[ext],
          project,
          status: "pending",
          customerState: "active",
          revision: 1,
          nonce: uuid(),
          createdAt: timestamp(),
          updatedAt: timestamp(),
          retentionAcceptedAt: timestamp(),
          history: [],
        }
      );
    });
    return {
      item: publicSource(saved),
      resumed: Boolean(previous),
      ...(saved.status === "pending"
        ? {
            upload: {
              pathname,
              clientPayload: JSON.stringify({ id }),
              contentType: saved.contentType,
            },
          }
        : {}),
    };
  }
  async function uploadOptions(actor, pathname, payload) {
    const owner = ownerFor(actor?.email);
    authorize(actor, owner);
    let input;
    try {
      input = JSON.parse(payload);
    } catch {
      throw new MediaError("Invalid media upload request.");
    }
    const id = idFor(input?.id),
      validUntil = now() + 10 * 60_000;
    const saved = await mutate(sourceRecordPath(owner, id), (old) => {
      if (
        !active(old) ||
        old.status !== "pending" ||
        old.pathname !== pathname ||
        pathname !== sourceBlobPath(owner, id, old.ext) ||
        old.adminArchivedAt
      )
        throw new MediaError("This upload is no longer available.", 409);
      return {
        ...old,
        tokenValidUntil: Math.max(old.tokenValidUntil || 0, validUntil),
      };
    });
    return {
      allowedContentTypes: [saved.contentType],
      maximumSizeInBytes: saved.size,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: false,
      tokenPayload: JSON.stringify({ owner, id, pathname, nonce: saved.nonce }),
    };
  }
  async function finalize(ownerValue, idValue, ticket) {
    const owner = ownerFor(ownerValue),
      id = idFor(idValue),
      old = await record(owner, id);
    if (!active(old))
      throw new MediaError(
        "This media file has been permanently removed.",
        410,
      );
    if (
      ticket &&
      (ticket.nonce !== old.nonce || ticket.pathname !== old.pathname)
    )
      throw new MediaError(
        "This upload callback does not match the source.",
        403,
      );
    if (old.status === "ready") return publicSource(old);
    const account = (await read(userPath(owner)))?.value;
    if (
      !account ||
      account.email !== owner ||
      accessStatusForUser(account) !== "approved"
    )
      throw new MediaError(
        "This account is not approved to finish uploads.",
        403,
      );
    let info;
    try {
      info = await headBlob(sourceBlobPath(owner, id, old.ext));
    } catch (error) {
      if (/not.?found/i.test(`${error?.name} ${error?.message}`))
        throw new MediaError(
          "The upload has not arrived yet. Retry verification after it finishes.",
          409,
        );
      throw error;
    }
    if (
      info.pathname !== old.pathname ||
      info.size !== old.size ||
      info.contentType !== old.contentType
    )
      throw new MediaError(
        "The uploaded source does not match its approved size and format.",
        409,
      );
    const saved = await mutate(sourceRecordPath(owner, id), async (current) => {
      if (!active(current) || current.nonce !== old.nonce)
        throw new MediaError("This upload is no longer available.", 410);
      if (current.status === "ready") return current;
      if (
        accessStatusForUser((await read(userPath(owner)))?.value) !== "approved"
      )
        throw new MediaError(
          "This account is not approved to finish uploads.",
          403,
        );
      return {
        ...current,
        status: "ready",
        etag: info.etag,
        updatedAt: timestamp(),
        revision: current.revision + 1,
      };
    });
    return publicSource(saved);
  }
  async function completeUpload({ blob, tokenPayload }) {
    let ticket;
    try {
      ticket = JSON.parse(tokenPayload);
    } catch {
      throw new MediaError("Invalid upload callback.", 403);
    }
    if (!ticket || !blob || blob.pathname !== ticket.pathname)
      throw new MediaError("Invalid upload callback path.", 403);
    return finalize(ticket.owner, ticket.id, ticket);
  }
  async function listMedia(
    actor,
    { admin = false, view = "active", cursor } = {},
  ) {
    const owner = ownerFor(actor?.email);
    authorize(actor, owner, admin);
    if (
      !(
        admin ? ["all", "active", "archived"] : ["active", "archived", "trash"]
      ).includes(view)
    )
      throw new MediaError("Choose a valid media library view.");
    if (cursor && (typeof cursor !== "string" || cursor.length > 2000))
      throw new MediaError("Invalid media page reference.");
    const prefix = `sources/metadata/${admin ? "" : `${digest(owner)}/`}`;
    const page = await listBlobs({
      prefix,
      limit: 50,
      cursor: cursor || undefined,
    });
    const items = await Promise.all(
      page.blobs.map(async (blob) => {
        if (
          !blob.pathname.startsWith(prefix) ||
          !/^sources\/metadata\/[a-f0-9]{64}\/[a-f0-9-]{36}\.json$/.test(
            blob.pathname,
          )
        )
          return null;
        const value = (await read(blob.pathname))?.value;
        if (
          !value ||
          (!admin && value.ownerEmail !== owner) ||
          sourceRecordPath(value.ownerEmail, value.id) !== blob.pathname ||
          value.status === "purged"
        )
          return null;
        if (
          admin
            ? view !== "all" &&
              Boolean(value.adminArchivedAt) !== (view === "archived")
            : !active(value) || value.customerState !== view
        )
          return null;
        return publicSource(value);
      }),
    );
    return {
      items: items.filter(Boolean),
      ...(page.hasMore && page.cursor ? { cursor: page.cursor } : {}),
    };
  }
  async function organize(actor, input) {
    const owner = ownerFor(input.owner || actor?.email),
      id = idFor(input.id);
    const adminAction = ["admin-archive", "admin-restore", "purge"].includes(
      input.action,
    );
    authorize(actor, owner, adminAction);
    if (!adminAction && actor.email !== owner)
      throw new MediaError(
        "Use administrator archive controls for another customer's media.",
        403,
      );
    if (
      ![
        "archive",
        "trash",
        "restore",
        "rename",
        "admin-archive",
        "admin-restore",
        "purge",
      ].includes(input.action)
    )
      throw new MediaError("Choose a valid media action.");
    const saved = await mutate(sourceRecordPath(owner, id), (old) => {
      if (!old || old.status === "purged")
        throw new MediaError("This media file was not found.", 404);
      if (old.status === "deleting" && input.action !== "purge")
        throw new MediaError(
          "Permanent deletion is in progress. An administrator can retry it from the archive.",
          409,
        );
      if (
        !Number.isSafeInteger(input.revision) ||
        input.revision !== old.revision
      )
        throw new MediaError(
          "This media file changed. Refresh before trying again.",
          409,
        );
      let patch;
      if (input.action === "purge") {
        if (!old.adminArchivedAt || input.confirmation !== "DELETE")
          throw new MediaError(
            "Archive the media first, then type DELETE to permanently remove it.",
            409,
          );
        // An already-issued upload token must expire before removal; otherwise a late upload could recreate the binary.
        if ((old.tokenValidUntil || 0) + 60_000 > now())
          throw new MediaError(
            "An upload authorization is still active. Wait up to 11 minutes after the latest upload attempt, then retry permanent deletion.",
            409,
          );
        patch = { status: "deleting" };
      } else if (input.action === "rename") {
        const name = filename(input.name);
        if (name.split(".").pop().toLowerCase() !== old.ext)
          throw new MediaError(
            "Keep the original file extension when renaming media.",
          );
        patch = { name };
      } else if (adminAction)
        patch = {
          adminArchivedAt:
            input.action === "admin-archive" ? timestamp() : null,
        };
      else
        patch = {
          customerState: {
            archive: "archived",
            trash: "trash",
            restore: "active",
          }[input.action],
        };
      return {
        ...old,
        ...patch,
        updatedAt: timestamp(),
        revision: old.revision + 1,
        history: [
          ...(old.history || []),
          { action: input.action, actor: actor.email, at: timestamp() },
        ].slice(-50),
      };
    });
    if (input.action === "purge") {
      // A failed delete retains its retryable record; callbacks and reads are blocked before deleting bytes.
      await deleteBlob(sourceBlobPath(owner, id, saved.ext));
      await quota(owner, id, null);
      await mutate(sourceRecordPath(owner, id), (old) => ({
        version: 1,
        id,
        ownerEmail: owner,
        status: "purged",
        revision: old.revision + 1,
        deletedAt: timestamp(),
        deletedBy: actor.email,
      }));
      await recordAudit(actor.email, "media.purge", id, { owner });
      return { removed: true };
    }
    return { item: publicSource(saved) };
  }
  async function file(actor, ownerValue, idValue) {
    const owner = ownerFor(ownerValue || actor?.email),
      id = idFor(idValue);
    authorize(actor, owner);
    const value = await record(owner, id);
    if (!active(value) || value.status !== "ready")
      throw new MediaError("This source file is not available.", 404);
    if (value.pathname !== sourceBlobPath(owner, id, value.ext))
      throw new MediaError("This source file cannot be opened.", 409);
    return value;
  }
  return {
    reserve,
    uploadOptions,
    finalize,
    completeUpload,
    listMedia,
    organize,
    file,
  };
}
export const mediaLibrary = createMediaLibrary();
