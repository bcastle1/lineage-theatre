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
} from "./_lib/auth.mjs";
import { OWNER_EMAIL } from "./_lib/access.mjs";

const unavailableRegistration = "This email cannot be registered. If you already have an account, sign in or contact the administrator.";
const dependencies = { json, readBody, sameOrigin, getSession, sessionCookie, publicUser, readRecord, writeRecord, userPath, verifyPassword, hashPassword, limitAction };

export function validateRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Enter your name, email, and password to create an account.");
  if (["role", "roles", "status", "emailVerified", "mustChangePassword", "permissions"].some(key=>Object.hasOwn(body,key))) throw new Error("Account access and verification are assigned by the server.");
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
  if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128 || !body.password.trim()) throw new Error("Choose a password with 12–128 characters.");
  if (body.termsAccepted !== true) throw new Error("Accept the terms of use and acknowledge the privacy information before creating an account.");
  return { email, name, password: body.password };
}

export function createAuthHandler(overrides = {}) {
  const { json, readBody, sameOrigin, getSession, sessionCookie, publicUser, readRecord, writeRecord, userPath, verifyPassword, hashPassword, limitAction } = { ...dependencies, ...overrides };
  return async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const session = await getSession(req, true);
      return json(res, 200, {
        user: session ? publicUser(session.user) : null,
      });
    }
    if (req.method !== "POST")
      return json(res, 405, { message: "Method not allowed." });
    if (!sameOrigin(req))
      return json(res, 403, { message: "Open Lineage Theatre to manage your account." });
    let body;
    try { body = await readBody(req, 6000); }
    catch { return json(res, 400, { message: "The account request is invalid or too large." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { message: "The account request is invalid." });
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
      const now = new Date().toISOString();
      const user = {
        email: registration.email,
        name: registration.name,
        passwordHash: hashPassword(registration.password),
        mustChangePassword: false,
        role: "customer",
        status: "active",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
        termsAcceptedAt: now,
        privacyAcknowledgedAt: now,
        termsVersion: "public-registration-v1",
      };
      // Prepare the cookie before writing so missing session setup cannot strand a new account.
      const cookie = sessionCookie(user);
      try {
        // No etag: private Blob atomically creates this exact path with overwrite disabled.
        await writeRecord(path, user);
      } catch (error) {
        // A concurrent signup may have won after our initial read. Never overwrite it.
        if (await readRecord(path)) return json(res, 409, { message: unavailableRegistration });
        throw error;
      }
      res.setHeader("Set-Cookie", cookie);
      return json(res, 201, { user: publicUser(user), message: "Your account is created and you are signed in." });
    }
    if (body.action === "logout") {
      res.setHeader(
        "Set-Cookie",
        "lineage_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
      );
      return json(res, 200, { user: null });
    }
    if (body.action === "password") {
      const session = await getSession(req, true);
      if (!session)
        return json(res, 401, {
          message: "Your sign-in expired. Sign in again.",
        });
      const password = String(body.password ?? "");
      if (
        password.length < 12 ||
        password.length > 128 ||
        verifyPassword(password, session.user.passwordHash)
      )
        return json(res, 400, {
          message: "Choose a different password with 12–128 characters.",
        });
      if (
        !session.user.mustChangePassword &&
        !verifyPassword(
          String(body.currentPassword ?? ""),
          session.user.passwordHash,
        )
      )
        return json(res, 400, {
          message: "Your current password is incorrect.",
        });
      const user = {
        ...session.user,
        passwordHash: hashPassword(password),
        mustChangePassword: false,
        updatedAt: new Date().toISOString(),
      };
      await writeRecord(userPath(user.email), user, session.etag);
      res.setHeader("Set-Cookie", sessionCookie(user));
      return json(res, 200, {
        user: publicUser(user),
        message: "Your new password is saved.",
      });
    }
    if (body.action !== "login")
      return json(res, 400, { message: "Unknown sign-in action." });
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    const password = String(body.password ?? "");
    if (email.length > 254 || password.length > 128)
      return json(res, 400, { message: "Check your email and password." });
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
    if (!record || !valid || record.value.status === "suspended")
      return json(res, 401, { message: "The email or password is incorrect." });
    res.setHeader("Set-Cookie", sessionCookie(record.value));
    return json(res, 200, { user: publicUser(record.value) });
  } catch {
    return json(res, 503, {
      message: "Sign-in is temporarily unavailable. Please try again.",
    });
  }
  };
}

export default createAuthHandler();
