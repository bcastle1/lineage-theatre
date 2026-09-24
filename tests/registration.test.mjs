import { captchaStub } from "./fixtures/captcha.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createAuthHandler, validateRegistration } from "../api/auth.mjs";
import { getSession, hashPassword, publicUser, sessionCookie, userPath, verifyPassword, writeRecord } from "../api/_lib/auth.mjs";
import { builtInSourceAgreement } from "../api/_lib/source-agreement.mjs";

const previousSecret = process.env.LINEAGE_SESSION_SECRET;
process.env.LINEAGE_SESSION_SECRET = "isolated-registration-test-secret-never-used-in-production";
after(() => {
  if (previousSecret === undefined) delete process.env.LINEAGE_SESSION_SECRET;
  else process.env.LINEAGE_SESSION_SECRET = previousSecret;
});
const registration = () => ({ action: "register", name: "Fictional Ada Example", email: "ada@example.invalid", password: "Synthetic registration passphrase", termsAccepted: true,
  sourceAgreementAccepted: true, sourceAgreementVersion: builtInSourceAgreement().version, sourceAgreementHash: builtInSourceAgreement().contentHash });
const request = (body, headers = {}) => ({ method: "POST", url: "/api/auth", body, headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com", "x-forwarded-for": "198.51.100.7", ...headers } });
async function run(handler, req) {
  const result = { statusCode: 0, headers: {}, body: null };
  await handler(req, {
    set statusCode(value) { result.statusCode = value; },
    setHeader(name, value) { result.headers[name] = value; },
    end(value) { result.body = JSON.parse(value); },
  });
  return result;
}
function harness(overrides = {}) {
  const records = new Map();
  const writes = [], limits = [];
  const read = async path => records.has(path) ? { value: records.get(path), etag: "existing-etag" } : null;
  const write = async (path, user, etag) => {
    writes.push({ path, user, etag });
    if (records.has(path) && !etag) throw new Error("Atomic create conflict");
    records.set(path, user);
  };
  const handler = createAuthHandler({ captcha: captchaStub,
    readRecord: read,
    writeRecord: write,
    getSession: (req, allowSetup) => getSession(req, allowSetup, { readRecordImpl: read, writeRecordImpl: write }),
    limitAction: async (...args) => { limits.push(args); return true; },
    ...overrides,
  });
  return { handler, records, writes, limits, read, write };
}

test("public signup creates a pending unverified customer with a restricted authenticated session", async () => {
  const h = harness();
  const body = { ...registration(), email: "  ADA@Example.Invalid  ", name: "  Fictional   Ada Example  " };
  const result = await run(h.handler, request(body));
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.user.email, "ada@example.invalid");
  assert.equal(result.body.user.name, "Fictional Ada Example");
  assert.equal(result.body.user.role, "customer");
  assert.equal(result.body.user.accessStatus, "pending");
  assert.equal(result.body.user.emailVerified, false);
  assert.equal(result.body.user.mustChangePassword, false);
  const stored = h.records.get(userPath("ada@example.invalid"));
  assert.equal(stored.role, "customer");
  assert.equal(stored.status, "pending");
  assert.equal(stored.emailVerified, false);
  assert.equal(Object.hasOwn(stored, "password"), false);
  assert.equal(verifyPassword(body.password, stored.passwordHash), true);
  assert.equal(stored.termsAcceptedAt, stored.privacyAcknowledgedAt);
  assert.ok(Number.isFinite(Date.parse(stored.termsAcceptedAt)));
  assert.deepEqual(stored.sourceAgreementAcceptance.agreement, builtInSourceAgreement());
  assert.equal(stored.sourceAgreementAcceptance.signedName, "Fictional Ada Example");
  assert.equal(stored.sourceAgreementAcceptance.accountEmail, "ada@example.invalid");
  assert.equal(stored.sourceAgreementAcceptance.signatureMethod, "account-name-checkbox");
  assert.equal(stored.termsVersion, "source-agreement-registration-2026-09-22");
  assert.equal(result.body.user.sourceAgreementAcceptance, undefined);
  assert.equal(h.writes[0].etag, undefined);
  const cookie = result.headers["Set-Cookie"];
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(await getSession({ headers: { cookie: cookie.split(";")[0] } }, false,
    { readRecordImpl: h.read, writeRecordImpl: h.write }), null);
  const current = await run(h.handler, { method: "GET", headers: { cookie: cookie.split(";")[0] } });
  assert.equal(current.body.user.email, "ada@example.invalid");
  assert.equal(current.body.user.role, "customer");
  assert.equal(current.body.registrationApprovalRequired, true);
  assert.equal(h.limits[0][0], "captcha-auth:198.51.100.7");
  assert.equal(h.limits[1][0], "register-ip:198.51.100.7");
  assert.equal(h.limits[2][0], "register-email:ada@example.invalid");
});

test("registration rejects all supplied privilege or verification fields", async () => {
  const h = harness();
  for (const [key, value] of Object.entries({ role: "owner", roles: ["admin"], status: "active", accessStatus: "approved",
    approvedAt: new Date().toISOString(), approvedBy: "erik@brocotech.ai", approvalSource: "administrator",
    approvalPolicyRevision: 1, approvalRequired: false, adminGrantedBy: "erik@brocotech.ai", adminRevokedAt: null,
    emailVerified: true, permissions: ["all"], mustChangePassword: false,
    sourceAgreementAcceptance: {}, sourceAgreementAcceptedAt: "2000-01-01T00:00:00.000Z", sourceAgreementSignedName: "Forged name" })) {
    const result = await run(h.handler, request({ ...registration(), [key]: value }));
    assert.equal(result.statusCode, 400, key);
    assert.match(result.body.message, /assigned by the server/);
    assert.equal(result.headers["Set-Cookie"], undefined);
  }
  assert.equal(h.writes.length, 0);
});

test("existing and reserved owner accounts cannot be registered or overwritten", async () => {
  const h = harness();
  const owner = { email: "erik@brocotech.ai", name: "Existing owner", role: "owner", passwordHash: "existing-owner-password-hash", createdAt: "2026-09-10T00:00:00.000Z" };
  h.records.set(userPath(owner.email), owner);
  const result = await run(h.handler, request({ ...registration(), email: " ERIK@BROCOTECH.AI " }));
  assert.equal(result.statusCode, 409);
  assert.equal(h.records.get(userPath(owner.email)), owner);
  assert.equal(h.writes.length, 0);
  assert.equal(result.headers["Set-Cookie"], undefined);
  h.records.clear();
  assert.equal((await run(h.handler, request({ ...registration(), email: owner.email }))).statusCode, 409);
  assert.equal(h.writes.length, 0);
  assert.equal(publicUser({ email: owner.email, name: owner.name }).role, "customer");
});

test("duplicate normalized email keeps the original account and password", async () => {
  const h = harness();
  assert.equal((await run(h.handler, request(registration()))).statusCode, 201);
  const original = h.records.get(userPath(registration().email));
  const duplicate = await run(h.handler, request({ ...registration(), email: "ADA@EXAMPLE.INVALID", password: "Different synthetic passphrase" }));
  assert.equal(duplicate.statusCode, 409);
  assert.equal(h.records.get(userPath(registration().email)), original);
  assert.equal(h.writes.filter(write => write.path.startsWith("auth/users/")).length, 1);
  assert.equal(duplicate.headers["Set-Cookie"], undefined);
});

test("concurrent signup requests atomically create one user and never overwrite the winner", async () => {
  const records = new Map(), writes = [];
  let earlyReads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createAuthHandler({ captcha: captchaStub,
    limitAction: async () => true,
    readRecord: async path => {
      if (earlyReads < 2) { earlyReads++; if (earlyReads === 2) release(); await gate; return null; }
      return records.has(path) ? { value: records.get(path), etag: "winner" } : null;
    },
    writeRecord: async (path, value, etag) => {
      writes.push({ path, etag });
      if (records.has(path)) throw new Error("Atomic create conflict");
      records.set(path, value);
    },
  });
  const inputs = [registration(), { ...registration(), name: "Another fictional name", password: "Copper orchard lanterns remain" }];
  const results = await Promise.all(inputs.map(body => run(handler, request(body))));
  assert.deepEqual(results.map(r=>r.statusCode).sort(), [201, 409]);
  assert.deepEqual(writes.filter(write => write.path.startsWith("auth/users/")).map(write => write.etag), [undefined, undefined]);
  assert.equal([...records.keys()].filter(path => path.startsWith("auth/users/")).length, 1);
  const winner = results.findIndex(r=>r.statusCode === 201);
  assert.equal(verifyPassword(inputs[winner].password, records.get(userPath(registration().email)).passwordHash), true);
  assert.equal(results[1 - winner].headers["Set-Cookie"], undefined);
});

test("registration requires current source acceptance and never uses browser statement text or timestamps", async () => {
  for (const fields of [{ sourceAgreementAccepted: false }, { sourceAgreementAccepted: "true" }, { sourceAgreementAccepted: undefined },
    { sourceAgreementVersion: "old-version" }, { sourceAgreementHash: "a".repeat(64) }]) {
    const h = harness(), result = await run(h.handler, request({ ...registration(), ...fields }));
    assert.equal(result.statusCode, fields.sourceAgreementAccepted !== undefined || Object.hasOwn(fields, "sourceAgreementAccepted") ? 400 : 409);
    assert.equal(h.records.has(userPath(registration().email)), false); assert.equal(result.headers["Set-Cookie"], undefined);
  }
  const h = harness(), result = await run(h.handler, request({ ...registration(), agreementText: "Forged text", acceptedAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal(result.statusCode, 201);
  const saved = h.records.get(userPath(registration().email)).sourceAgreementAcceptance;
  assert.deepEqual(saved.agreement, builtInSourceAgreement()); assert.notEqual(saved.acceptedAt, "2000-01-01T00:00:00.000Z");
});

test("agreement storage outages fail registration closed without stranding existing sessions", async () => {
  const h = harness({ sourceAgreement: { accept: async () => { throw new Error("Private agreement storage failure"); } } });
  const result = await run(h.handler, request(registration()));
  assert.equal(result.statusCode, 503); assert.equal(h.records.has(userPath(registration().email)), false);
  assert.equal(result.headers["Set-Cookie"], undefined); assert.doesNotMatch(JSON.stringify(result.body), /Private agreement/);
});

test("private Blob create explicitly disables overwrite and supplies no update condition", async () => {
  let options;
  await writeRecord("auth/users/synthetic.json", { role: "customer" }, undefined, {
    putImpl: async (path, body, supplied) => { options = supplied; },
  });
  assert.equal(options.access, "private");
  assert.equal(options.allowOverwrite, false);
  assert.equal(options.addRandomSuffix, false);
  assert.equal(Object.hasOwn(options, "ifMatch"), false);
});

test("registration validation rejects malformed fields and missing explicit consent", async () => {
  const h = harness();
  const invalid = [
    { email: "no-at-sign" }, { email: "a@localhost" }, { email: "a..b@example.com" },
    { email: "a@-example.com" }, { email: "a".repeat(65) + "@example.com" }, { email: {} },
    { name: " " }, { name: "x".repeat(101) }, { name: "Name\nInjected" }, { name: [] },
    { password: "too short" }, { password: "x".repeat(129) }, { password: " ".repeat(12) }, { password: {} },
    { termsAccepted: false }, { termsAccepted: "true" }, { termsAccepted: undefined },
  ];
  for (const fields of invalid) assert.equal((await run(h.handler, request({ ...registration(), ...fields }))).statusCode, 400);
  assert.equal(h.writes.length, 0);
  assert.equal(validateRegistration({ ...registration(), email: "ada+family@example.invalid", name: "Zoë Example" }).name, "Zoë Example");
  assert.throws(() => validateRegistration(null), /Enter your name/);
});

test("cross-origin signup and exhausted IP or email limits never create a user", async () => {
  const origin = harness();
  assert.equal((await run(origin.handler, request(registration(), { origin: "https://other.example" }))).statusCode, 403);
  assert.equal(origin.limits.length, 0);
  assert.equal(origin.writes.length, 0);
  for (const prefix of ["register-ip:", "register-email:"]) {
    const h = harness({ limitAction: async key => !key.startsWith(prefix) });
    const result = await run(h.handler, request(registration()));
    assert.equal(result.statusCode, 429);
    assert.equal(h.writes.length, 0);
    assert.equal(result.headers["Set-Cookie"], undefined);
  }
});

test("missing session configuration and failed storage writes do not issue a signup cookie", async () => {
  const h = harness({ sessionCookie: () => { throw new Error("Missing signing setup"); } });
  assert.equal((await run(h.handler, request(registration()))).statusCode, 503);
  assert.equal(h.writes.length, 0);
  const failed = harness({ writeRecord: async () => { throw new Error("Private provider error"); } });
  const result = await run(failed.handler, request(registration()));
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers["Set-Cookie"], undefined);
  assert.equal(JSON.stringify(result.body).includes("Private provider error"), false);
});

test("suspended users cannot log in or reuse an already issued normal or setup session", async () => {
  const h = harness();
  const user = { email: registration().email, name: "Fictional Ada", passwordHash: hashPassword(registration().password), mustChangePassword: false, role: "admin", status: "active" };
  h.records.set(userPath(user.email), user);
  const cookie = sessionCookie(user).split(";")[0];
  assert.equal((await getSession({ headers: { cookie } }, false, { readRecordImpl: h.read, writeRecordImpl: h.write })).user.email, user.email);
  user.status = "suspended";
  assert.equal(await getSession({ headers: { cookie } }, false, { readRecordImpl: h.read, writeRecordImpl: h.write }), null);
  assert.equal(await getSession({ headers: { cookie } }, true, { readRecordImpl: h.read, writeRecordImpl: h.write }), null);
  const login = await run(h.handler, request({ action: "login", email: user.email, password: registration().password }));
  assert.equal(login.statusCode, 401);
  assert.equal(login.headers["Set-Cookie"], undefined);
});

test("legacy login keeps forced-password setup and trusted server roles", async () => {
  const h = harness();
  const user = { email: registration().email, name: "Fictional Ada", passwordHash: hashPassword(registration().password), mustChangePassword: true };
  h.records.set(userPath(user.email), user);
  const login = await run(h.handler, request({ action: "login", email: user.email, password: registration().password, role: "owner" }));
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.user.mustChangePassword, true);
  assert.equal(login.body.user.role, "customer");
  const cookie = login.headers["Set-Cookie"].split(";")[0];
  assert.equal(await getSession({ headers: { cookie } }, false, { readRecordImpl: h.read, writeRecordImpl: h.write }), null);
  const changed = await run(h.handler, request({ action: "password", password: "New synthetic personal passphrase" }, { cookie }));
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body.user.mustChangePassword, false);
  assert.equal(changed.body.user.role, "customer");
  assert.equal(h.writes.find(write => write.path === userPath(user.email)).etag, "existing-etag");
});
