import test from "node:test";
import assert from "node:assert/strict";
import { digest, getSession, sessionCookie, userPath } from "../api/_lib/auth.mjs";
import { SESSION_IDLE_MS, SESSION_MAX_MS } from "../api/_lib/auth-security.mjs";

process.env.LINEAGE_SESSION_SECRET = "isolated-session-concurrency-test-key-never-used-in-production";
const at = Date.parse("2026-09-14T12:00:00.000Z");
const user = { email: "session@example.invalid", name: "Fictional Session", passwordHash: "fictional-password-hash",
  role: "customer", status: "active", mustChangePassword: false, approvedAt: "2026-09-14T00:00:00.000Z", approvedBy: "erik@brocotech.ai" };
const clone = value => structuredClone(value);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let time = at, version = 0;
  const cookie = sessionCookie(user, { now: at }).split(";")[0];
  const claims = JSON.parse(Buffer.from(cookie.slice(16).split(".")[0], "base64url").toString());
  const path = `auth/sessions/${digest(claims.nonce)}.json`;
  const records = new Map([
    [userPath(user.email), { value: clone(user), etag: "user-version" }],
    [path, { value: { email: user.email, version: digest(user.passwordHash), expiresAt: at + SESSION_MAX_MS,
      createdAt: at, lastSeenAt: at, revoked: false }, etag: "session-version" }],
  ]);
  const read = async key => clone(records.get(key) || null);
  const write = async (key, value, etag) => {
    if (records.get(key)?.etag !== etag) throw new Error("Precondition failed");
    records.set(key, { value: clone(value), etag: `revision-${++version}` });
  };
  return { records, path, read, write, request: { headers: { cookie } }, now: () => time,
    setTime: value => { time = value; }, dependencies: { readRecordImpl: read, writeRecordImpl: write } };
}

test("an earlier parallel request accepts activity recorded while its session read was waiting", async t => {
  const f = fixture(), entered = deferred(), release = deferred();
  t.mock.method(Date, "now", f.now);
  f.setTime(at + 120_000);
  const earlier = getSession(f.request, false, { ...f.dependencies, readRecordImpl: async path => {
    if (path === f.path) { entered.resolve(); await release.promise; }
    return f.read(path);
  } });
  await entered.promise;
  f.setTime(at + 120_001);
  const later = await getSession(f.request, false, f.dependencies);
  release.resolve();
  assert.equal(later?.user.email, user.email);
  assert.equal((await earlier)?.user.email, user.email);
  assert.equal(f.records.get(f.path).value.lastSeenAt, at + 120_001);
});

test("a conditional-write loser rereads activity using the current injected clock", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.setTime(at + 120_000);
  let attempts = 0;
  const earlier = getSession(f.request, false, { ...f.dependencies, now: f.now, writeRecordImpl: async (...args) => {
    attempts++;
    entered.resolve(); await release.promise;
    return f.write(...args);
  } });
  await entered.promise;
  f.setTime(at + 120_001);
  const later = await getSession(f.request, false, { ...f.dependencies, now: f.now });
  release.resolve();
  assert.equal(later?.user.email, user.email);
  assert.equal((await earlier)?.user.email, user.email);
  assert.equal(attempts, 1);
  assert.equal(f.records.get(f.path).value.lastSeenAt, at + 120_001);
});

test("a session timestamp one millisecond beyond the current clock still fails closed", async () => {
  const f = fixture(); f.setTime(at + 120_000);
  f.records.get(f.path).value.lastSeenAt = f.now() + 1;
  for (const now of [f.now, f.now()]) {
    assert.equal(await getSession(f.request, false, { ...f.dependencies, now }), null);
  }
  assert.equal(f.records.get(f.path).value.lastSeenAt, at + 120_001);
});

test("idle and absolute expiry reached during storage reads are rejected at their exact boundaries", async () => {
  for (const maximum of [SESSION_IDLE_MS, SESSION_MAX_MS]) {
    const f = fixture();
    f.setTime(at + maximum - 1);
    if (maximum === SESSION_MAX_MS) f.records.get(f.path).value.lastSeenAt = f.now();
    const result = await getSession(f.request, false, { ...f.dependencies, now: f.now, readRecordImpl: async path => {
      if (path === f.path) f.setTime(at + maximum);
      return f.read(path);
    } });
    assert.equal(result, null, `${maximum}ms expiry`);
  }
});

test("numeric now remains supported and non-finite clocks cannot authenticate", async () => {
  const f = fixture();
  assert.equal((await getSession(f.request, false, { ...f.dependencies, now: at + 1 }))?.user.email, user.email);
  for (const now of [NaN, Infinity, () => NaN, () => Infinity]) {
    assert.equal(await getSession(f.request, false, { ...f.dependencies, now }), null);
  }
});

test("revocation, changed cookies, suspended accounts and removed approval remain denied", async () => {
  for (const change of [
    f => { f.records.get(f.path).value.revoked = true; },
    f => { f.records.get(userPath(user.email)).value.passwordHash = "changed-password-hash"; },
    f => { f.records.get(userPath(user.email)).value.securityVersion = 1; },
    f => { f.records.get(userPath(user.email)).value.status = "suspended"; },
    f => { delete f.records.get(userPath(user.email)).value.approvedAt; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(await getSession(f.request, false, { ...f.dependencies, now: f.now }), null);
  }
});

test("password expiry during an activity read cannot upgrade an old cookie to setup authority", async () => {
  for (const allowSetup of [false, true]) {
    const f = fixture();
    f.records.get(userPath(user.email)).value.passwordExpiresAt = new Date(at + 1).toISOString();
    const result = await getSession(f.request, allowSetup, { ...f.dependencies, now: f.now, readRecordImpl: async path => {
      if (path === f.path) f.setTime(at + 1);
      return f.read(path);
    } });
    assert.equal(result, null);
  }
});
