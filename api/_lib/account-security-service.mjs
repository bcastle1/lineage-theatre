import { randomBytes } from "node:crypto";
import { digest, userPath } from "./auth.mjs";
import {
  AccountSecurityError, LOGIN_LOCK_MS, MFA_SETUP_MS, MFA_CHALLENGE_MS, EMAIL_VERIFICATION_MS,
  mfaEncryptionAvailable, newMfaSecret, encryptMfaSecret, decryptMfaSecret, verifyTotp,
  newRecoveryCodes, mfaProof,
} from "./auth-security.mjs";

const token = () => randomBytes(32).toString("hex");
const tokenPattern = /^[a-f0-9]{64}$/;
const lockedError = () => new AccountSecurityError("This account is temporarily locked after repeated sign-in failures. Try again in 24 hours.", 429, "ACCOUNT_LOCKED");
const challengeError = () => new AccountSecurityError("This sign-in verification expired. Sign in again.", 401, "MFA_CHALLENGE_EXPIRED");
const cookieName = "lineage_mfa_challenge";
export const clearMfaCookie = `${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
const challengeCookie = value => `${cookieName}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MFA_CHALLENGE_MS / 1000}`;
const readChallenge = req => req.headers.cookie?.split(";").map(value=>value.trim())
  .find(value=>value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);

export function createAccountSecurityService({ readRecord: read, writeRecord: write, verifyPassword,
  verificationMail, now = () => Date.now(), env = process.env }) {
  const failurePath = email => `auth/login-failures/${digest(email)}.json`;
  const enrollmentPath = email => `auth/mfa-enrollments/${digest(email)}.json`;

  async function checkLogin(email) {
    const failures = await read(failurePath(email));
    if (failures?.value.lockedUntil > now()) throw lockedError();
  }
  async function loginOutcome(email, success) {
    const path = failurePath(email);
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await read(path), current = previous?.value;
      if (current?.lockedUntil > now()) throw lockedError();
      if (success && !previous) return;
      const count = success ? 0 : (current?.lockedUntil ? 0 : current?.count || 0) + 1;
      const next = { count, lockedUntil: count >= 10 ? now() + LOGIN_LOCK_MS : null, updatedAt: now() };
      try {
        await write(path, next, previous?.etag);
        if (next.lockedUntil) throw lockedError();
        return;
      } catch (error) {
        if (error instanceof AccountSecurityError || attempt === 3) throw error;
      }
    }
  }
  async function requirePassword(user, currentPassword) {
    await checkLogin(user.email);
    if (typeof currentPassword !== "string" || currentPassword.length > 128 || !verifyPassword(currentPassword, user.passwordHash)) {
      await loginOutcome(user.email, false);
      throw new AccountSecurityError("Your current password is incorrect.", 401);
    }
  }
  function security(user) {
    return { emailVerified: user.emailVerified === true, emailVerificationAvailable: verificationMail.available(),
      mfaAvailable: mfaEncryptionAvailable(env), mfaEnabled: user.mfa?.enabled === true,
      passwordExpiresAt: Number.isFinite(Date.parse(user.passwordExpiresAt || "")) ? user.passwordExpiresAt : null };
  }
  async function beginMfa(session, body) {
    await requirePassword(session.user, body.currentPassword);
    if (session.user.mfa?.enabled) throw new AccountSecurityError("Authenticator verification is already enabled.", 409);
    const secret = newMfaSecret();
    const encrypted = encryptMfaSecret(secret, session.user.email, env);
    const path = enrollmentPath(session.user.email), previous = await read(path), expiresAt = now() + MFA_SETUP_MS;
    await write(path, { email: session.user.email, sessionId: session.sessionId,
      passwordVersion: digest(session.user.passwordHash), securityVersion: session.user.securityVersion || 0,
      secret: encrypted, expiresAt, consumed: false }, previous?.etag);
    return { secret, expiresAt: new Date(expiresAt).toISOString(),
      otpauthUri: `otpauth://totp/${encodeURIComponent(`Lineage Theatre:${session.user.email}`)}?secret=${secret}&issuer=Lineage%20Theatre&algorithm=SHA1&digits=6&period=30` };
  }
  async function confirmMfa(session, body) {
    await checkLogin(session.user.email);
    const path = enrollmentPath(session.user.email), pending = await read(path), value = pending?.value;
    if (session.user.mfa?.enabled || !value || value.consumed || value.expiresAt <= now()
      || value.sessionId !== session.sessionId || value.passwordVersion !== digest(session.user.passwordHash)
      || value.securityVersion !== (session.user.securityVersion || 0))
      throw new AccountSecurityError("Authenticator setup expired or changed. Start setup again.", 409);
    const counter = verifyTotp(decryptMfaSecret(value.secret, session.user.email, env), body.code, now());
    if (counter === null) { await loginOutcome(session.user.email, false); throw new AccountSecurityError("The verification code is incorrect or expired.", 401); }
    // Consume before changing the account; competing setup confirmations cannot both win.
    await write(path, { ...value, consumed: true, secret: null }, pending.etag);
    const recovery = newRecoveryCodes(), stamp = new Date(now()).toISOString();
    const user = { ...session.user, mfa: { enabled: true, secret: value.secret, lastCounter: counter,
      recoveryHashes: recovery.hashes, enabledAt: stamp }, securityVersion: (session.user.securityVersion || 0) + 1, updatedAt: stamp };
    await write(userPath(user.email), user, session.etag);
    await loginOutcome(user.email, true);
    return { user, recoveryCodes: recovery.codes, message: "Authenticator verification is enabled. Save these recovery codes now; they are shown only once." };
  }
  async function manageMfa(session, body) {
    await requirePassword(session.user, body.currentPassword);
    let mfa;
    try { mfa = mfaProof(session.user, body, { now: now(), env }); }
    catch (error) { if (error.code === "MFA_CODE_INVALID") await loginOutcome(session.user.email, false); throw error; }
    const recovery = body.action === "mfaRecoveryCodes" ? newRecoveryCodes() : null;
    const user = { ...session.user, mfa: recovery ? { ...mfa, recoveryHashes: recovery.hashes } : { enabled: false },
      securityVersion: (session.user.securityVersion || 0) + 1, updatedAt: new Date(now()).toISOString() };
    await write(userPath(user.email), user, session.etag);
    await loginOutcome(user.email, true);
    return { user, ...(recovery ? { recoveryCodes: recovery.codes } : {}),
      message: recovery ? "New recovery codes are ready. Save them now; previous codes no longer work." : "Authenticator verification is disabled." };
  }
  async function beginChallenge(user) {
    const value = token(), path = `auth/mfa-challenges/${digest(value)}.json`;
    await write(path, { email: user.email, passwordVersion: digest(user.passwordHash),
      securityVersion: user.securityVersion || 0, expiresAt: now() + MFA_CHALLENGE_MS, consumed: false });
    return challengeCookie(value);
  }
  async function cancelChallenge(req) {
    const value = readChallenge(req);
    if (!tokenPattern.test(value || "")) return;
    const path = `auth/mfa-challenges/${digest(value)}.json`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await read(path);
      if (!stored || stored.value.consumed) return;
      try { await write(path, { ...stored.value, consumed: true }, stored.etag); return; }
      catch (error) { if (attempt === 3) throw error; }
    }
  }
  async function completeChallenge(req, body) {
    const value = readChallenge(req);
    if (!tokenPattern.test(value || "")) throw challengeError();
    const path = `auth/mfa-challenges/${digest(value)}.json`, pending = await read(path), challenge = pending?.value;
    if (!challenge || challenge.consumed || challenge.expiresAt <= now()) throw challengeError();
    const record = await read(userPath(challenge.email)), user = record?.value;
    if (!user || user.status === "suspended" || !user.mfa?.enabled
      || digest(user.passwordHash) !== challenge.passwordVersion || (user.securityVersion || 0) !== challenge.securityVersion) throw challengeError();
    await checkLogin(user.email);
    let mfa;
    try { mfa = mfaProof(user, body, { now: now(), env }); }
    catch (error) { if (error.code === "MFA_CODE_INVALID") await loginOutcome(user.email, false); throw error; }
    await write(path, { ...challenge, consumed: true }, pending.etag);
    const updated = { ...user, mfa, lastLoginAt: new Date(now()).toISOString() };
    await write(userPath(user.email), updated, record.etag);
    await loginOutcome(user.email, true);
    return updated;
  }
  async function requestVerification(session) {
    if (session.user.emailVerified) return { message: "Your email address is already verified.", emailVerified: true };
    if (!verificationMail.available()) throw new AccountSecurityError("Email verification is not available yet. Your account remains unverified.", 503, "EMAIL_VERIFICATION_UNAVAILABLE");
    const value = token(), path = `auth/email-verifications/${digest(session.user.email)}.json`, previous = await read(path);
    const record = { email: session.user.email, tokenHash: digest(value), passwordVersion: digest(session.user.passwordHash),
      expiresAt: now() + EMAIL_VERIFICATION_MS, consumed: false, accepted: false };
    await write(path, record, previous?.etag);
    const result = await verificationMail.send({ to: session.user.email, token: value });
    if (result?.accepted !== true) throw new AccountSecurityError("The verification email could not be requested. Please try again later.", 503);
    const current = await read(path);
    if (!current || current.value.tokenHash !== record.tokenHash || current.value.consumed)
      throw new AccountSecurityError("A newer verification request replaced this one. Use the most recent email.", 409);
    await write(path, { ...current.value, accepted: true }, current.etag);
    return { message: "Verification email requested. Check your inbox; delivery can take a few minutes.", emailVerified: false };
  }
  async function confirmVerification(session, body) {
    if (!tokenPattern.test(body.token || "")) throw new AccountSecurityError("This email verification link is invalid or expired.");
    const path = `auth/email-verifications/${digest(session.user.email)}.json`, stored = await read(path), value = stored?.value;
    if (!value || !value.accepted || value.consumed || value.expiresAt <= now() || value.email !== session.user.email
      || value.passwordVersion !== digest(session.user.passwordHash) || digest(body.token) !== value.tokenHash)
      throw new AccountSecurityError("This email verification link is invalid or expired.");
    await write(path, { ...value, consumed: true, tokenHash: null, consumedAt: now() }, stored.etag);
    const user = { ...session.user, emailVerified: true, emailVerifiedAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
    await write(userPath(user.email), user, session.etag);
    return { user, message: "Your email address is verified." };
  }
  return { checkLogin, loginOutcome, requirePassword, security, beginMfa, confirmMfa, manageMfa,
    beginChallenge, cancelChallenge, completeChallenge, requestVerification, confirmVerification };
}
