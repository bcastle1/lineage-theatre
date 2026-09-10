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

export default async function handler(req, res) {
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
      return json(res, 403, { message: "Open Lineage Theatre to sign in." });
    const body = await readBody(req, 6000);
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
    if (!record || !valid)
      return json(res, 401, { message: "The email or password is incorrect." });
    res.setHeader("Set-Cookie", sessionCookie(record.value));
    return json(res, 200, { user: publicUser(record.value) });
  } catch {
    return json(res, 503, {
      message: "Sign-in is temporarily unavailable. Please try again.",
    });
  }
}
