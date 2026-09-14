import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
  createHash,
} from "node:crypto";
import { get, put } from "@vercel/blob";
import { roleForUser, accessStatusForUser } from "./access.mjs";
import { passwordSetupRequired, SESSION_IDLE_MS, SESSION_MAX_MS, SETUP_SESSION_MS } from "./auth-security.mjs";

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.end(JSON.stringify(body));
}
export async function readBody(req, limit = 3_500_000) {
  const raw =
    req.body ??
    (await (async () => {
      let s = "";
      for await (const c of req) {
        s += c;
        if (s.length > limit) throw new Error("Request is too large.");
      }
      return s;
    })());
  if (typeof raw === "object" && !Buffer.isBuffer(raw)) {
    if (JSON.stringify(raw).length > limit)
      throw new Error("Request is too large.");
    return raw;
  }
  if (String(raw).length > limit) throw new Error("Request is too large.");
  return JSON.parse(String(raw) || "{}");
}
export function sameOrigin(req) {
  try {
    return (
      Boolean(req.headers.origin) &&
      new URL(req.headers.origin).host === req.headers.host
    );
  } catch {
    return false;
  }
}
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const userPath = (email) => `auth/users/${digest(email)}.json`;
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, hash) {
  try {
    const [salt, expected] = hash.split(":");
    const actual = scryptSync(password, salt, 64);
    return timingSafeEqual(actual, Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
export async function readRecord(path, { getImpl = get } = {}) {
  const result = await getImpl(path, {
    access: "private",
    useCache: false,
    // Compression weakens the ETag; conditional writes need the stored entity's validator.
    headers: { "accept-encoding": "identity" },
  });
  if (!result || !result.stream) return null;
  return {
    value: await new Response(result.stream).json(),
    etag: result.blob.etag,
  };
}
export async function writeRecord(path, value, etag, { putImpl = put } = {}) {
  return putImpl(path, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: Boolean(etag),
    ...(etag ? { ifMatch: etag } : {}),
    cacheControlMaxAge: 60,
  });
}
export async function limitAction(key, max, windowMs) {
  const path = `limits/${digest(key)}-${Math.floor(Date.now() / windowMs)}.json`;
  for (let i = 0; i < 4; i++) {
    const record = await readRecord(path);
    const count = record?.value.count ?? 0;
    if (count >= max) return false;
    try {
      await writeRecord(path, { count: count + 1 }, record?.etag);
      return true;
    } catch (e) {
      if (i === 3) throw e;
    }
  }
  return false;
}
function signature(value) {
  if (!process.env.LINEAGE_SESSION_SECRET)
    throw new Error("Sign-in is not configured.");
  return createHmac("sha256", process.env.LINEAGE_SESSION_SECRET)
    .update(value)
    .digest("base64url");
}
export const clearSessionCookie = "lineage_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
export function sessionCookie(user, { now = Date.now() } = {}) {
  const duration = passwordSetupRequired(user, now) ? SETUP_SESSION_MS : SESSION_MAX_MS;
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.email,
      version: digest(user.passwordHash),
      iat: now,
      exp: now + duration,
      securityVersion: user.securityVersion || 0,
      setup: passwordSetupRequired(user, now),
      nonce: randomBytes(12).toString("hex"),
    }),
  ).toString("base64url");
  return `lineage_session=${payload}.${signature(payload)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${duration / 1000}`;
}
function sessionClaims(req, now) {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("lineage_session="))
    ?.slice(16);
  if (!token) return null;
  try {
    const [payload, sig, extra] = token.split(".");
    const expected = signature(payload);
    if (
      extra || !sig ||
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof decoded.sub !== "string" || decoded.sub.length > 254 || !Number.isFinite(decoded.exp)
      || decoded.exp <= now || !/^[a-f0-9]{24}$/.test(decoded.nonce || "")) return null;
    // Previously issued cookies have no iat and expire within the original 12-hour bound.
    const issuedAt = decoded.iat ?? decoded.exp - SESSION_MAX_MS;
    if (!Number.isFinite(issuedAt) || issuedAt > now || decoded.exp - issuedAt > SESSION_MAX_MS) return null;
    return { ...decoded, iat: issuedAt };
  } catch { return null; }
}
const sessionPath = nonce => `auth/sessions/${digest(nonce)}.json`;
export async function revokeSession(req, { readRecordImpl = readRecord, writeRecordImpl = writeRecord, now = Date.now() } = {}) {
  const claims = sessionClaims(req, now);
  if (!claims) return;
  const path = sessionPath(claims.nonce);
  for (let attempt = 0; attempt < 4; attempt++) {
    const record = await readRecordImpl(path);
    if (record?.value.revoked) return;
    try {
      await writeRecordImpl(path, { ...record?.value, email: claims.sub, revoked: true,
        expiresAt: claims.exp, revokedAt: now }, record?.etag);
      return;
    } catch (error) { if (attempt === 3) throw error; }
  }
}
export async function getSession(req, allowSetup = false, { readRecordImpl = readRecord, writeRecordImpl = writeRecord, now = Date.now } = {}) {
  const clock = typeof now === "function" ? now : () => now;
  let checkedAt = clock();
  if (!Number.isFinite(checkedAt)) return null;
  const decoded = sessionClaims(req, checkedAt);
  if (!decoded) return null;
  try {
    const record = await readRecordImpl(userPath(decoded.sub));
    if (!record || digest(record.value.passwordHash) !== decoded.version
      || (record.value.securityVersion || 0) !== (decoded.securityVersion || 0))
      return null;
    if (record.value.status === "suspended") return null;
    // Restricted auth sessions let pending applicants manage their own account,
    // but an old cookie must never grant studio access without current approval.
    if (!allowSetup && accessStatusForUser(record.value) !== "approved") return null;
    const path = sessionPath(decoded.nonce);
    let active = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await readRecordImpl(path);
      // A parallel request may record activity after this request began. Compare
      // that record with the current clock, including after a conditional retry.
      checkedAt = clock();
      if (!Number.isFinite(checkedAt) || checkedAt < decoded.iat || decoded.exp <= checkedAt) return null;
      if (stored?.value.revoked || (stored && (stored.value.email !== decoded.sub || stored.value.version !== decoded.version
          || stored.value.expiresAt !== decoded.exp))) return null;
      // Expiry cannot turn an existing normal session into password-reset authority.
      if (passwordSetupRequired(record.value, checkedAt) && !record.value.mustChangePassword && decoded.setup !== true) return null;
      if (passwordSetupRequired(record.value, checkedAt) && !allowSetup) return null;
      const lastSeenAt = stored?.value.lastSeenAt ?? decoded.iat;
      if (!Number.isFinite(lastSeenAt) || lastSeenAt > checkedAt || checkedAt - lastSeenAt >= SESSION_IDLE_MS) return null;
      if (stored && checkedAt - lastSeenAt < 60_000) { active = true; break; }
      try {
        await writeRecordImpl(path, { email: decoded.sub, version: decoded.version, expiresAt: decoded.exp,
          createdAt: decoded.iat, lastSeenAt: checkedAt, revoked: false }, stored?.etag);
        active = true; break;
      } catch (error) { if (attempt === 3) throw error; }
    }
    if (!active) return null;
    return { user: { ...record.value, mustChangePassword: passwordSetupRequired(record.value, checkedAt) },
      etag: record.etag, sessionId: digest(decoded.nonce) };
  } catch {
    return null;
  }
}
export const publicUser = (user) => ({
  email: user.email,
  name: user.name,
  mustChangePassword: passwordSetupRequired(user),
  role: roleForUser(user),
  accessStatus: accessStatusForUser(user),
  emailVerified: user.emailVerified === true,
  mfaEnabled: user.mfa?.enabled === true,
});
