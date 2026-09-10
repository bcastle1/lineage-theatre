import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  hashPassword,
  verifyPassword,
  sameOrigin,
  readBody,
  sessionCookie,
  getSession,
} from "../api/_lib/auth.mjs";

test("password hashes use distinct salts and reject wrong or malformed credentials", () => {
  const password = "Synthetic test password";
  const first = hashPassword(password),
    second = hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(verifyPassword(password, first), true);
  assert.equal(verifyPassword("incorrect", first), false);
  assert.equal(verifyPassword(password, "invalid"), false);
});
test("mutations require the exact host including port", () => {
  assert.equal(
    sameOrigin({
      headers: {
        origin: "https://lineagetheater.com",
        host: "lineagetheater.com",
      },
    }),
    true,
  );
  for (const origin of [
    "https://evil.example",
    "https://lineagetheater.com.evil.example",
    "https://lineagetheater.com:444",
    undefined,
  ])
    assert.equal(
      sameOrigin({ headers: { origin, host: "lineagetheater.com" } }),
      false,
    );
});
test("oversized parsed and streamed bodies are rejected", async () => {
  await assert.rejects(
    readBody({ body: { text: "x".repeat(101) } }, 100),
    /too large/,
  );
  await assert.rejects(
    readBody(
      {
        async *[Symbol.asyncIterator]() {
          yield "x".repeat(101);
        },
      },
      100,
    ),
    /too large/,
  );
});
test("sessions expire, resist tampering and constrain temporary access", async () => {
  process.env.LINEAGE_SESSION_SECRET =
    "isolated-test-signing-key-never-used-in-production";
  const user = {
    email: "test@example.invalid",
    passwordHash: hashPassword("Synthetic password"),
    mustChangePassword: true,
  };
  const cookie = sessionCookie(user);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(cookie, /Max-Age=900/);
  assert.match(
    sessionCookie({ ...user, mustChangePassword: false }),
    /Max-Age=43200/,
  );
  const token = cookie.split(";")[0];
  assert.equal(
    await getSession({ headers: { cookie: token.slice(0, -1) + "!" } }),
    null,
  );
  const payload = Buffer.from(
    JSON.stringify({ sub: user.email, exp: Date.now() - 1 }),
  ).toString("base64url");
  const sig = createHmac("sha256", process.env.LINEAGE_SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  assert.equal(
    await getSession({
      headers: { cookie: `lineage_session=${payload}.${sig}` },
    }),
    null,
  );
  delete process.env.LINEAGE_SESSION_SECRET;
});
