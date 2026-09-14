import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PASSWORD_MAX_AGE_MS = 120 * 24 * 3600_000;
export const PASSWORD_CHANGE_INTERVAL_MS = 3600_000;
export const LOGIN_LOCK_MS = 24 * 3600_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_MS = 12 * 3600_000;
export const SETUP_SESSION_MS = 15 * 60_000;
export const MFA_SETUP_MS = 10 * 60_000;
export const MFA_CHALLENGE_MS = 5 * 60_000;
export const EMAIL_VERIFICATION_MS = 30 * 60_000;

export class AccountSecurityError extends Error {
  constructor(message, status = 400, code = "ACCOUNT_SECURITY") {
    super(message); this.status = status; this.code = code;
  }
}

// A local common-password screen, not a claim of exhaustive multilingual dictionary coverage.
const commonPasswords = new Set([
  "password", "passwords", "passwordpassword", "passphrase", "letmein", "welcome", "welcomehome",
  "qwerty", "qwertyuiop", "qwertyuiopasdfghjkl", "asdfghjkl", "zxcvbnm", "iloveyou", "admin",
  "administrator", "changeme", "default", "secret", "sunshine", "princess", "football", "baseball",
  "basketball", "superman", "trustnoone", "dragon", "monkey", "abc", "abcdef", "abcdefgh",
  "abcdefghijkl", "abcdefghijklmnopqrstuvwxyz", "lineagetheatre", "lineagetheater", "brocotech",
  "correcthorsebatterystaple", "contraseña", "contrasena", "motdepasse", "passwort", "bienvenue",
]);
const canonical = value => value.normalize("NFKC").toLowerCase()
  .replace(/[034157@$!]/g, char => ({0:"o",3:"e",4:"a",1:"i",5:"s",7:"t","@":"a","$":"s","!":"i"})[char])
  .replace(/[^\p{L}\p{N}]/gu, "");

export function validatePassword(password, user = {}) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128 || !password.trim())
    throw new AccountSecurityError("Choose a password with 12–128 characters.");
  if (!/\p{L}/u.test(password)) throw new AccountSecurityError("Include at least one letter in your password.");
  const plain = canonical(password);
  const stripped = plain.replace(/\p{N}/gu, "");
  const withoutSuffix = canonical(password.replace(/[\p{N}\p{P}\p{S}]+$/gu, ""));
  if (commonPasswords.has(plain) || commonPasswords.has(stripped) || commonPasswords.has(withoutSuffix)
      || new Set(plain).size < 5 || /^(.{1,4})\1+$/u.test(plain)
      || /^(?:password|letmein|welcome|changeme|qwerty|admin)[\p{N}]+$/u.test(password.toLowerCase().replace(/[^\p{L}\p{N}]/gu,"")))
    throw new AccountSecurityError("Choose a less common password or a longer, unrelated passphrase.");
  const local = String(user.email || "").split("@")[0];
  const identifiers = [local, ...local.split(/[.+_-]+/), ...String(user.name || "").split(/\s+/)]
    .flatMap(value => [value, value.replace(/\d+$/u, "")])
    .map(canonical).filter(value => value.length >= 3);
  if (identifiers.some(value => plain.includes(value)))
    throw new AccountSecurityError("Choose a password that does not contain your name or email username.");
  return password;
}

export function passwordSetupRequired(user, now = Date.now()) {
  const expires = Date.parse(user.passwordExpiresAt || "");
  return user.mustChangePassword === true || (Number.isFinite(expires) && expires <= now);
}

export function passwordUpdate(user, password, { hashPassword, verifyPassword, now = Date.now() }) {
  validatePassword(password, user);
  const changedAt = Date.parse(user.passwordChangedAt || "");
  if (!user.mustChangePassword && Number.isFinite(changedAt) && now - changedAt < PASSWORD_CHANGE_INTERVAL_MS)
    throw new AccountSecurityError("Wait one hour after your last password change before changing it again.", 429);
  const history = [user.passwordHash, ...(Array.isArray(user.passwordHistory) ? user.passwordHistory : [])].filter(value => typeof value === "string").slice(0, 6);
  if (history.some(hash => verifyPassword(password, hash)))
    throw new AccountSecurityError("Choose a password you have not used for your last five password changes.");
  return {
    ...user, passwordHash: hashPassword(password), passwordHistory: history.slice(0, 5),
    mustChangePassword: false, passwordChangedAt: new Date(now).toISOString(),
    passwordExpiresAt: new Date(now + PASSWORD_MAX_AGE_MS).toISOString(), updatedAt: new Date(now).toISOString(),
  };
}

export function mfaEncryptionAvailable(env = process.env) {
  try { encryptionKey(env); return true; } catch { return false; }
}
function encryptionKey(env) {
  const value = env.LINEAGE_MFA_ENCRYPTION_KEY || "";
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new AccountSecurityError("Authenticator setup is not configured yet.", 503, "MFA_UNAVAILABLE");
  return key;
}
export function encryptMfaSecret(secret, email, env = process.env) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  cipher.setAAD(Buffer.from(`lineage-mfa:${email}`));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function decryptMfaSecret(encrypted, email, env = process.env) {
  if (encrypted?.version !== 1) throw new AccountSecurityError("Authenticator verification is unavailable. Use a recovery code or contact support.", 503);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), Buffer.from(encrypted.iv, "base64"));
  decipher.setAAD(Buffer.from(`lineage-mfa:${email}`));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8");
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes) {
  let bits = 0, value = 0, output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Bytes(secret) {
  if (typeof secret !== "string" || !/^[A-Z2-7]{16,128}$/.test(secret)) throw new Error("Invalid authenticator configuration");
  let bits = 0, value = 0; const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
export const newMfaSecret = () => base32(randomBytes(20));
export function totpCode(secret, counter, digits = 6) {
  const value = Buffer.alloc(8); value.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Bytes(secret)).update(value).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, "0");
}
export function verifyTotp(secret, code, now = Date.now(), lastCounter = -1) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter < 0 || counter <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, counter)), Buffer.from(code))) return counter;
  }
  return null;
}
export const recoveryHash = code => createHash("sha256").update(String(code).replace(/-/g, "").toUpperCase()).digest("hex");
export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => randomBytes(10).toString("hex").toUpperCase().match(/.{1,5}/g).join("-"));
  return { codes, hashes: codes.map(recoveryHash) };
}
export function mfaProof(user, { code, recoveryCode }, { now = Date.now(), env = process.env } = {}) {
  if (!user.mfa?.enabled) throw new AccountSecurityError("Authenticator verification is not enabled.");
  if (typeof recoveryCode === "string" && /^[A-Fa-f0-9-]{20,23}$/.test(recoveryCode)) {
    const hash = recoveryHash(recoveryCode), hashes = user.mfa.recoveryHashes || [];
    const index = hashes.findIndex(value => typeof value === "string" && value.length === hash.length && timingSafeEqual(Buffer.from(value), Buffer.from(hash)));
    if (index >= 0) return { ...user.mfa, recoveryHashes: hashes.filter((_, i) => i !== index) };
  } else if (code !== undefined) {
    const counter = verifyTotp(decryptMfaSecret(user.mfa.secret, user.email, env), code, now, user.mfa.lastCounter ?? -1);
    if (counter !== null) return { ...user.mfa, lastCounter: counter };
  }
  throw new AccountSecurityError("The verification code is incorrect or already used.", 401, "MFA_CODE_INVALID");
}
