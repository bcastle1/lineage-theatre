import { randomUUID } from "node:crypto";
import { digest, readRecord, writeRecord } from "./auth.mjs";
import { hasAdminAccess } from "./access.mjs";
import { DEFAULT_SOURCE_AGREEMENT } from "./source-agreement-default.mjs";

export const SOURCE_AGREEMENT_PATH = "settings/source-agreement.json";
const versionPattern = /^source-agreement-v(0|[1-9]\d{0,15})-([a-f0-9]{64})(?:-([a-f0-9]{32}))?$/;
const contentFields = ["title", "body", "consentLabel"];
const publicFields = [...contentFields, "version", "contentHash", "revision", "updatedAt"];
export class SourceAgreementError extends Error {
  constructor(message, status = 400, code = "AGREEMENT_INVALID") { super(message); this.status = status; this.code = code; }
}
const unavailable = () => new SourceAgreementError("The source agreement is temporarily unavailable. Please try again.", 503, "AGREEMENT_UNAVAILABLE");
const changed = () => new SourceAgreementError("The source agreement changed. Read the current version and accept it before creating your account.", 409, "AGREEMENT_CHANGED");
const conflict = () => new SourceAgreementError("The source agreement was updated. Reload it before saving your changes.", 409, "AGREEMENT_CONFLICT");
const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, value[field]]));
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
function content(value) {
  const limits = { title: 160, body: 10_000, consentLabel: 500 }, result = {};
  for (const field of contentFields) {
    if (typeof value?.[field] !== "string") throw new SourceAgreementError("Enter the agreement title, statement, and acceptance label.");
    const text = value[field].normalize("NFC").replace(/\r\n?/g, "\n").trim();
    if (!text || text.length > limits[field] || /[<>\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(text)
      || (field !== "body" && /[\n\t]/.test(text)))
      throw new SourceAgreementError(`Use plain text for ${field === "consentLabel" ? "the acceptance label" : `the agreement ${field}`}, up to ${limits[field].toLocaleString("en-US")} characters.`);
    result[field] = text;
  }
  return result;
}
const contentHash = value => digest(JSON.stringify(content(value)));
function validated(value) {
  try {
    const text = content(value), match = typeof value.version === "string" && versionPattern.exec(value.version);
    if (!match || !Number.isSafeInteger(value.revision) || value.revision < 0 || Number(match[1]) !== value.revision
      || value.contentHash !== contentHash(text) || match[2] !== value.contentHash
      || (value.revision === 0 ? value.updatedAt !== null : !instant(value.updatedAt))
      || contentFields.some(field => text[field] !== value[field])) throw unavailable();
    return pick(value, publicFields);
  } catch { throw unavailable(); }
}
export function builtInSourceAgreement() {
  const text = content(DEFAULT_SOURCE_AGREEMENT), hash = contentHash(text);
  return { ...text, version: `source-agreement-v0-${hash}`, contentHash: hash, revision: 0, updatedAt: null };
}
export function sourceAgreementVersionPath(version) {
  if (typeof version !== "string" || !versionPattern.test(version))
    throw new SourceAgreementError("Choose a valid source agreement version.");
  return `agreements/source/versions/${version}.json`;
}

export function createSourceAgreementService({ readRecord: read = readRecord, writeRecord: write = writeRecord, now = Date.now } = {}) {
  const stamp = () => new Date(now()).toISOString();
  async function safely(operation) {
    try { return await operation(); }
    catch (error) { if (error instanceof SourceAgreementError) throw error; throw unavailable(); }
  }
  async function history(version) {
    const path = sourceAgreementVersionPath(version), record = await read(path);
    if (record) {
      const result = validated(record.value.agreement);
      if (result.version !== version) throw unavailable();
      return result;
    }
    const builtin = builtInSourceAgreement();
    if (version === builtin.version) return builtin;
    throw new SourceAgreementError("This source agreement version was not found.", 404, "AGREEMENT_NOT_FOUND");
  }
  async function currentRecord() {
    const record = await read(SOURCE_AGREEMENT_PATH);
    if (!record) return { agreement: builtInSourceAgreement(), record: null };
    const pointer = record.value;
    if (!pointer || !Number.isSafeInteger(pointer.revision) || pointer.revision < 1 || typeof record.etag !== "string") throw unavailable();
    let agreement;
    try { agreement = await history(pointer.version); } catch { throw unavailable(); }
    if (["version", "contentHash", "revision", "updatedAt"].some(field => pointer[field] !== agreement[field])) throw unavailable();
    return { agreement, record };
  }
  async function archive(agreement, { updatedBy = null, previousVersion = null } = {}) {
    const path = sourceAgreementVersionPath(agreement.version), prior = await read(path);
    if (prior) {
      if (JSON.stringify(validated(prior.value.agreement)) !== JSON.stringify(agreement)) throw unavailable();
      return;
    }
    const value = { agreement: structuredClone(agreement), updatedBy, previousVersion, archivedAt: stamp() };
    try { await write(path, value); }
    catch {
      // Concurrent first acceptances and lost create responses may converge on
      // this same immutable default version; never overwrite its contents.
      const stored = await read(path);
      if (!stored || JSON.stringify(validated(stored.value.agreement)) !== JSON.stringify(agreement)) throw unavailable();
    }
    const stored = await read(path);
    if (!stored || JSON.stringify(validated(stored.value.agreement)) !== JSON.stringify(agreement)) throw unavailable();
  }
  async function update(actor, input) {
    return safely(async () => {
      // Match the administrator handler, including persisted legacy roles
      // without a status field. The shared helper rejects suspended accounts.
      if (!actor || actor.mustChangePassword || !hasAdminAccess(actor)
        || typeof actor.email !== "string" || actor.email !== actor.email.trim().toLowerCase())
        throw new SourceAgreementError("Administrator access is required.", 403, "AGREEMENT_FORBIDDEN");
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(field => !["revision", ...contentFields].includes(field)))
        throw new SourceAgreementError("The agreement update contains unsupported information.");
      const text = content(input), current = await currentRecord();
      if (!Number.isSafeInteger(input.revision) || input.revision !== current.agreement.revision) throw conflict();
      if (current.agreement.revision >= Number.MAX_SAFE_INTEGER) throw unavailable();
      // Retain the built-in statement before replacing it; future deployments
      // cannot erase the version that existing users actually accepted.
      await archive(current.agreement);
      const hash = contentHash(text), revision = current.agreement.revision + 1;
      const agreement = { ...text, version: `source-agreement-v${revision}-${hash}-${randomUUID().replaceAll("-", "")}`,
        contentHash: hash, revision, updatedAt: stamp() };
      await archive(agreement, { updatedBy: actor.email, previousVersion: current.agreement.version });
      const pointer = pick(agreement, ["version", "contentHash", "revision", "updatedAt"]);
      try { await write(SOURCE_AGREEMENT_PATH, pointer, current.record?.etag); }
      catch {
        const latest = await read(SOURCE_AGREEMENT_PATH);
        if (latest?.value.version !== agreement.version) {
          if (latest?.etag !== current.record?.etag) throw conflict();
          throw unavailable();
        }
      }
      const saved = await currentRecord();
      if (saved.agreement.version !== agreement.version) throw conflict();
      return saved.agreement;
    });
  }
  async function accept(account, input) {
    return safely(async () => {
      if (input?.sourceAgreementAccepted !== true)
        throw new SourceAgreementError("Read and accept the source ownership and sharing agreement before creating your account.", 400, "AGREEMENT_REQUIRED");
      const current = (await currentRecord()).agreement;
      if (input.sourceAgreementVersion !== current.version || input.sourceAgreementHash !== current.contentHash) throw changed();
      if (typeof account?.email !== "string" || account.email !== account.email.trim().toLowerCase()
        || !/^\S+@\S+\.\S+$/.test(account.email) || typeof account.name !== "string" || !account.name
        || account.name !== account.name.normalize("NFC").trim().replace(/\s+/g, " ") || account.name.length > 100) throw unavailable();
      await archive(current);
      if ((await currentRecord()).agreement.version !== current.version) throw changed();
      return { agreement: structuredClone(current), acceptedAt: stamp(), signedName: account.name,
        accountEmail: account.email, signatureMethod: "account-name-checkbox" };
    });
  }
  function accepted(user) {
    const value = user?.sourceAgreementAcceptance;
    if (value === undefined) return null;
    if (!value || value.accountEmail !== user.email || typeof value.signedName !== "string" || !value.signedName
      || value.signedName.length > 100 || !instant(value.acceptedAt) || value.signatureMethod !== "account-name-checkbox") throw unavailable();
    return { agreement: validated(value.agreement), acceptedAt: value.acceptedAt, signedName: value.signedName,
      accountEmail: value.accountEmail, signatureMethod: value.signatureMethod };
  }
  return { current: () => safely(async () => (await currentRecord()).agreement), version: version => safely(() => history(version)), update, accept, accepted };
}
