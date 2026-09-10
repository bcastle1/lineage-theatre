import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
  createHash,
} from "node:crypto";
import { get, put } from "@vercel/blob";

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
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
export async function readRecord(path) {
  const result = await get(path, { access: "private", useCache: false });
  if (!result || !result.stream) return null;
  return {
    value: await new Response(result.stream).json(),
    etag: result.blob.etag,
  };
}
export async function writeRecord(path, value, etag) {
  return put(path, JSON.stringify(value), {
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
export function sessionCookie(user) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.email,
      version: digest(user.passwordHash),
      exp: Date.now() + (user.mustChangePassword ? 15 * 60_000 : 12 * 3600_000),
      nonce: randomBytes(12).toString("hex"),
    }),
  ).toString("base64url");
  return `lineage_session=${payload}.${signature(payload)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${user.mustChangePassword ? 900 : 43200}`;
}
export async function getSession(req, allowSetup = false) {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("lineage_session="))
    ?.slice(16);
  if (!token) return null;
  try {
    const [payload, sig] = token.split(".");
    const expected = signature(payload);
    if (
      !sig ||
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.exp < Date.now()) return null;
    const record = await readRecord(userPath(decoded.sub));
    if (!record || digest(record.value.passwordHash) !== decoded.version)
      return null;
    if (record.value.mustChangePassword && !allowSetup) return null;
    return { user: record.value, etag: record.etag };
  } catch {
    return null;
  }
}
export const publicUser = (user) => ({
  email: user.email,
  name: user.name,
  mustChangePassword: user.mustChangePassword,
});
