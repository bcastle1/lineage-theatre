import {
  json,
  readBody,
  sameOrigin,
  getSession,
  sessionCookie,
  publicUser,
  readRecord,
  writeRecord,
  userPath,
  verifyPassword,
  hashPassword,
  limitAction,
  clearSessionCookie,
  revokeSession,
} from "./_lib/auth.mjs";
import { OWNER_EMAIL } from "./_lib/access.mjs";
import { AccountSecurityError, validatePassword, passwordUpdate, PASSWORD_MAX_AGE_MS } from "./_lib/auth-security.mjs";
import { createAccountSecurityService, clearMfaCookie } from "./_lib/account-security-service.mjs";
import { verificationMail } from "./_lib/verification-mail.mjs";
import { readRegistrationPolicy } from "./_lib/registration-policy.mjs";
import { captcha, CaptchaError } from "./_lib/captcha.mjs";

const unavailableRegistration = "This email cannot be registered. If you already have an account, sign in or contact the administrator.";
const dependencies = { json, readBody, sameOrigin, getSession, sessionCookie, publicUser, readRecord, writeRecord, userPath, verifyPassword, hashPassword, limitAction };

export function validateRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Enter your name, email, and password to create an account.");
  if (["role", "roles", "status", "accessStatus", "approvedAt", "approvedBy", "approvalSource", "approvalPolicyRevision", "approvalRequired", "adminGrantedBy", "adminRevokedAt", "emailVerified", "mustChangePassword", "permissions", "mfa", "securityVersion", "passwordHistory", "passwordExpiresAt"].some(key=>Object.hasOwn(body,key))) throw new Error("Account access and verification are assigned by the server.");
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const parts = email.split("@");
  const local = parts[0] || "";
  const labels = (parts[1] || "").split(".");
  if (email.length > 254 || parts.length !== 2 || !local || local.length > 64
      || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
      || local.startsWith(".") || local.endsWith(".") || local.includes("..")
      || labels.length < 2 || labels.some(label=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
    throw new Error("Enter a valid email address.");
  if (typeof body.name !== "string" || /[\u0000-\u001f\u007f]/.test(body.name)) throw new Error("Enter your name using 1–100 characters.");
  const name = body.name.normalize("NFC").trim().replace(/\s+/g," ");
  if (!name || name.length > 100) throw new Error("Enter your name using 1–100 characters.");
  validatePassword(body.password, { email, name });
  if (body.termsAccepted !== true) throw new Error("Accept the terms of use and acknowledge the privacy information before creating an account.");
  return { email, name, password: body.password };
}

export function createAuthHandler(overrides = {}) {
  const humanCheck = overrides.captcha || captcha;
  const { json, readBody, sameOrigin, getSession, sessionCookie, publicUser, readRecord, writeRecord, userPath, verifyPassword, hashPassword, limitAction } = { ...dependencies, ...overrides };
  const clock = overrides.now || (() => Date.now());
  const registrationPolicy = overrides.readRegistrationPolicy || (() => readRegistrationPolicy(readRecord));
  const security = createAccountSecurityService({ readRecord, writeRecord, verifyPassword,
    verificationMail: overrides.verificationMail || verificationMail, now: clock, env: overrides.env || process.env });
  const revoke = overrides.revokeSession || (req => revokeSession(req, { readRecordImpl: readRecord, writeRecordImpl: writeRecord, now: clock() }));
  const setSession = (res, user) => res.setHeader("Set-Cookie", sessionCookie(user, { now: clock() }));
  return async function handler(req, res) {
  try {
    if (req.method === "GET") {
      if (new URL(req.url || "/api/auth", "https://lineagetheater.com").searchParams.get("action") === "captcha")
        return json(res, 200, humanCheck.configuration());
      const session = await getSession(req, true);
      if (new URL(req.url || "/api/auth", `https://${req.headers.host || "lineagetheater.com"}`).searchParams.get("action") === "security") {
        if (!session || session.user.mustChangePassword) return json(res, 401, { message: "Sign in and complete password setup to manage account security." });
        return json(res, 200, security.security(session.user));
      }
      // A settings outage must not strand signed-in owners. Registration itself
      // still requires a successful policy read before any account is created.
      let registrationApprovalRequired = true;
      try { registrationApprovalRequired = (await registrationPolicy()).approvalRequired; }
      catch {}
      return json(res, 200, {
        user: session ? publicUser(session.user) : null,
        registrationApprovalRequired,
      });
    }
    if (req.method !== "POST")
      return json(res, 405, { message: "Method not allowed." });
    if (!sameOrigin(req))
      return json(res, 403, { message: "Open Lineage Theatre to manage your account." });
    let body;
    try { body = await readBody(req, 16000); }
    catch { return json(res, 400, { message: "The account request is invalid or too large." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { message: "The account request is invalid." });
    if (["login", "register", "mfaChallenge"].includes(body.action)) {
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
      if (!(await limitAction(`captcha-auth:${ip}`, 30, 15 * 60_000)))
        return json(res, 429, { message: "Too many security checks. Please wait 15 minutes and try again." });
      await humanCheck.verify(body.captchaToken, body.action === "mfaChallenge" ? "mfa" : body.action);
    }
    if (body.action === "register") {
      let registration;
      try { registration = validateRegistration(body); }
      catch (error) { return json(res, 400, { message: error.message }); }
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
      if (!(await limitAction(`register-ip:${ip}`, 10, 3600_000))
          || !(await limitAction(`register-email:${registration.email}`, 5, 3600_000)))
        return json(res, 429, { message: "Too many account-creation attempts. Please wait an hour before trying again." });
      const path = userPath(registration.email);
      if (registration.email === OWNER_EMAIL || await readRecord(path))
        return json(res, 409, { message: unavailableRegistration });
      // This server setting applies only at creation; it never changes the
      // approval of existing users when administrators toggle registration.
      const policy = await registrationPolicy();
      const now = new Date(clock()).toISOString();
      const user = {
        email: registration.email,
        name: registration.name,
        passwordHash: hashPassword(registration.password),
        passwordHistory: [],
        passwordChangedAt: now,
        passwordExpiresAt: new Date(clock() + PASSWORD_MAX_AGE_MS).toISOString(),
        mustChangePassword: false,
        role: "customer",
        status: policy.approvalRequired ? "pending" : "active",
        ...(!policy.approvalRequired ? { approvedAt: now, approvedBy: policy.updatedBy,
          approvalSource: "registration-policy", approvalPolicyRevision: policy.revision } : {}),
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
        termsAcceptedAt: now,
        privacyAcknowledgedAt: now,
        termsVersion: "public-registration-v1",
      };
      // Prepare the cookie before writing so missing session setup cannot strand a new account.
      const cookie = sessionCookie(user, { now: clock() });
      try {
        // No etag: private Blob atomically creates this exact path with overwrite disabled.
        await writeRecord(path, user);
      } catch (error) {
        // A concurrent signup may have won after our initial read. Never overwrite it.
        if (await readRecord(path)) return json(res, 409, { message: unavailableRegistration });
        throw error;
      }
      res.setHeader("Set-Cookie", cookie);
      return json(res, 201, { user: publicUser(user), message: policy.approvalRequired
        ? "Your account is created and awaiting administrator approval. You can manage account security while you wait."
        : "Your account is created and you are signed in." });
    }
    if (body.action === "logout") {
      await revoke(req);
      await security.cancelChallenge(req);
      res.setHeader(
        "Set-Cookie",
        [clearSessionCookie, clearMfaCookie],
      );
      return json(res, 200, { user: null });
    }
    if (body.action === "password") {
      const session = await getSession(req, true);
      if (!session)
        return json(res, 401, {
          message: "Your sign-in expired. Sign in again.",
        });
      if (!(await limitAction(`password-change:${session.user.email}`, 10, 3600_000)))
        return json(res, 429, { message: "Too many password-change attempts. Try again later." });
      await security.checkLogin(session.user.email);
      if (!session.user.mustChangePassword) await security.requirePassword(session.user, body.currentPassword);
      const user = passwordUpdate(session.user, body.password, { hashPassword, verifyPassword, now: clock() });
      const cookie = sessionCookie(user, { now: clock() });
      await writeRecord(userPath(user.email), user, session.etag);
      res.setHeader("Set-Cookie", cookie);
      return json(res, 200, {
        user: publicUser(user),
        message: "Your new password is saved.",
      });
    }
    if (["mfaBegin", "mfaConfirm", "mfaDisable", "mfaRecoveryCodes", "emailVerificationRequest", "emailVerificationConfirm"].includes(body.action)) {
      const session = await getSession(req, true);
      if (!session || session.user.mustChangePassword) return json(res, 401, { message: "Sign in and complete password setup to manage account security." });
      const emailRequest = body.action === "emailVerificationRequest";
      if (!(await limitAction(`security:${session.user.email}:${body.action}`, emailRequest ? 3 : 10, emailRequest ? 3600_000 : 15 * 60_000)))
        return json(res, 429, { message: "Too many verification attempts. Wait before trying again." });
      let result;
      if (body.action === "mfaBegin") result = await security.beginMfa(session, body);
      if (body.action === "mfaConfirm") result = await security.confirmMfa(session, body);
      if (["mfaDisable", "mfaRecoveryCodes"].includes(body.action)) result = await security.manageMfa(session, body);
      if (body.action === "emailVerificationRequest") result = await security.requestVerification(session);
      if (body.action === "emailVerificationConfirm") result = await security.confirmVerification(session, body);
      if (result.user) { setSession(res, result.user); result = { ...result, user: publicUser(result.user) }; }
      return json(res, 200, result);
    }
    if (body.action === "mfaChallenge") {
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
      if (!(await limitAction(`mfa-challenge:${ip}`, 20, 15 * 60_000)))
        return json(res, 429, { message: "Too many verification attempts. Wait 15 minutes before trying again." });
      const user = await security.completeChallenge(req, body);
      res.setHeader("Set-Cookie", [sessionCookie(user, { now: clock() }), clearMfaCookie]);
      return json(res, 200, { user: publicUser(user) });
    }
    if (body.action !== "login")
      return json(res, 400, { message: "Unknown sign-in action." });
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    const password = String(body.password ?? "");
    if (email.length > 254 || password.length > 128)
      return json(res, 400, { message: "Check your email and password." });
    await security.checkLogin(email);
    const ip = String(
      req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown",
    ).split(",")[0];
    if (
      !(await limitAction(`login:${ip}`, 20, 15 * 60_000)) ||
      !(await limitAction(`account:${email}`, 10, 15 * 60_000))
    )
      return json(res, 429, {
        message: "Too many sign-in attempts. Please wait 15 minutes.",
      });
    const record = await readRecord(userPath(email));
    const valid = verifyPassword(
      password,
      record?.value.passwordHash ??
        "00000000000000000000000000000000:" + "0".repeat(128),
    );
    if (!record || !valid || record.value.status === "suspended") {
      await security.loginOutcome(email, false);
      return json(res, 401, { message: "The email or password is incorrect." });
    }
    if (record.value.mfa?.enabled) {
      res.setHeader("Set-Cookie", [await security.beginChallenge(record.value), clearSessionCookie]);
      return json(res, 200, { mfaRequired: true, message: "Enter a code from your authenticator or use a recovery code." });
    }
    await security.loginOutcome(email, true);
    setSession(res, record.value);
    return json(res, 200, { user: publicUser(record.value) });
  } catch (error) {
    if (error instanceof CaptchaError) return json(res, error.status, { code: error.code, message: error.message });
    if (error instanceof AccountSecurityError) return json(res, error.status, { code: error.code, message: error.message });
    return json(res, 503, {
      message: "Sign-in is temporarily unavailable. Please try again.",
    });
  }
  };
}

export default createAuthHandler();
