import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createAuthHandler } from "../api/auth.mjs";
import { createAdminHandler } from "../api/admin.mjs";
import { createStudioHandler } from "../api/studio.mjs";
import { createArchiveHandler } from "../api/archive.mjs";
import { getSession, hashPassword, sessionCookie, userPath } from "../api/_lib/auth.mjs";
import { accessStatusForUser, OWNER_EMAIL } from "../api/_lib/access.mjs";
import { newInvitation } from "../api/_lib/admin.mjs";
import { REGISTRATION_POLICY_PATH, readRegistrationPolicy } from "../api/_lib/registration-policy.mjs";

const previousSecret = process.env.LINEAGE_SESSION_SECRET;
process.env.LINEAGE_SESSION_SECRET = "isolated-registration-approval-test-signing-key";
after(() => {
  if (previousSecret === undefined) delete process.env.LINEAGE_SESSION_SECRET;
  else process.env.LINEAGE_SESSION_SECRET = previousSecret;
});
const password = "Copper lantern rivers wander";
const passwordHash = hashPassword(password);
const owner = { email: OWNER_EMAIL, role: "owner", status: "active", passwordHash };
const admin = { email: "administrator@example.invalid", role: "admin", status: "active", passwordHash };
const pending = { email: "employee@brocotech.ai", name: "Fictional Employee", role: "customer", status: "pending", passwordHash };
const approved = { ...pending, status: "active", approvedAt: "2026-09-01T00:00:00.000Z", approvedBy: owner.email };
const signup = email => ({ action: "register", email, name: "Fictional Applicant", password, termsAccepted: true });

function harness(overrides = {}) {
  const records = new Map(), events = [], operations = [];
  let revision = 0;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    const current = records.get(path);
    if (current ? current.etag !== etag : Boolean(etag)) throw new Error("Conditional write conflict");
    records.set(path, { value: structuredClone(value), etag: `revision-${++revision}` });
  };
  const session = (req, allowSetup) => getSession(req, allowSetup, { readRecordImpl: read, writeRecordImpl: write });
  const shared = { readRecord: read, writeRecord: write, getSession: session, limitAction: async () => true,
    audit: async (...event) => events.push(event), ...overrides };
  const filmProduction = {
    prepare: async input => { operations.push(["prepare", input.email]); return { id: "fictional-plan" }; },
    status: async input => { operations.push(["productionStatus", input.email]); return { status: "prepared" }; },
    manifest: async input => { operations.push(["manifest", input.email]); return { id: input.id }; },
  };
  const payments = Object.fromEntries(["quote", "checkout", "order", "receipt"].map(action => [action, async actor => {
    operations.push([action, actor.email]); return { status: "synthetic-service-reached" };
  }]));
  const handlers = {
    auth: createAuthHandler({ ...shared, env: { LINEAGE_MFA_ENCRYPTION_KEY: "ab".repeat(32) }, verificationMail: { available: () => false } }),
    admin: createAdminHandler({ ...shared, recordPage: async prefix => ({ records: [...records.entries()]
      .filter(([path]) => path.startsWith(prefix)).map(([, record]) => structuredClone(record.value)) }),
      connections: async () => ({}), readPricingSettings: async () => ({ markupBasisPoints: 0, revision: 0 }) }),
    studio: createStudioHandler({ ...shared, payments, filmProduction, connections: async () => ({}), readPricingSettings: async () => ({}) }),
    archive: createArchiveHandler({ ...shared, archive: { listArchive: async () => { operations.push(["archive"]); return { films: [] }; } } }),
  };
  const cookie = user => sessionCookie(user).split(";")[0];
  async function seed(user) { await write(userPath(user.email), user, (await read(userPath(user.email)))?.etag); return cookie(user); }
  async function run(route, cookie, action, input, headers = {}) {
    let status, body, responseHeaders = {};
    await handlers[route]({ method: input ? "POST" : "GET", url: `/api/${route}?action=${action || ""}&id=fictional-reference`,
      headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com", cookie, ...headers },
      ...(input ? { body: { ...input, ...(action ? { action } : {}) } } : {}) },
    { set statusCode(value) { status = value; }, setHeader(key, value) { responseHeaders[key] = value; }, end(value) { body = JSON.parse(value); } });
    return { status, body, headers: responseHeaders };
  }
  return { records, events, operations, read, write, cookie, seed, run };
}

test("old active customers and claimed employee/admin identities need persisted approval on every studio request", async () => {
  const h = harness();
  const legacy = { ...pending, status: "active" };
  await h.seed(legacy);
  const cookie = h.cookie({ ...legacy, role: "admin", accessStatus: "approved" });
  const state = await h.run("auth", cookie);
  assert.equal(state.body.user.accessStatus, "pending");
  assert.equal(state.body.user.role, "customer");
  for (const action of ["capabilities", "productionStatus", "manifest", "order", "receipt"])
    assert.equal((await h.run("studio", cookie, action)).status, 401, action);
  for (const action of ["prepare", "quote", "checkout", "generate", "themes", "plan"])
    assert.equal((await h.run("studio", cookie, action, { preparationConsent: true, storyConsent: true })).status, 401, action);
  assert.equal((await h.run("archive", cookie, "list")).status, 401);
  assert.equal((await h.run("admin", cookie, "users")).status, 401);
  assert.deepEqual(h.operations, []);
  const security = await h.run("auth", cookie, "security");
  assert.equal(security.status, 200);
  const setup = await h.run("auth", cookie, "mfaBegin", { currentPassword: password });
  assert.equal(setup.status, 200);
  assert.equal(accessStatusForUser((await h.read(userPath(pending.email))).value), "pending");
});

test("a server approval unlocks the existing cookie for the same customer payment and film actions as admins", async () => {
  const h = harness(), pendingCookie = await h.seed(pending), ownerCookie = await h.seed(owner), adminCookie = await h.seed(admin);
  const approvedResult = await h.run("admin", adminCookie, "approve", { email: pending.email, approvedBy: "attacker@example.invalid" });
  assert.equal(approvedResult.status, 200);
  assert.equal(approvedResult.body.user.accessStatus, "approved");
  const saved = (await h.read(userPath(pending.email))).value;
  assert.equal(saved.approvedBy, admin.email);
  assert.ok(Number.isFinite(Date.parse(saved.approvedAt)));
  assert.equal(saved.role, "customer");
  assert.equal(saved.passwordHash, passwordHash);
  assert.equal(h.events[0][1], "account.approve");
  for (const [actor, cookie] of [[pending, pendingCookie], [owner, ownerCookie], [admin, adminCookie]]) {
    assert.equal((await h.run("studio", cookie, "prepare", { preparationConsent: true })).status, 201);
    for (const action of ["quote", "checkout"]) assert.equal((await h.run("studio", cookie, action, {})).status, 200);
    const rendering = await h.run("studio", cookie, "generate", {});
    assert.equal(rendering.status, 503);
    assert.equal(rendering.body.code, "PRODUCTION_UNAVAILABLE");
    assert.deepEqual(h.operations.filter(([, email]) => email === actor.email).map(([action]) => action), ["prepare", "quote", "checkout"]);
  }
  assert.equal((await h.run("admin", pendingCookie, "users")).status, 403);
  assert.equal((await h.run("admin", ownerCookie, "approve", { email: pending.email })).status, 200);
  assert.equal(h.events.filter(([, action]) => action === "account.approve").length, 1);
});

test("suspension always denies access and reactivation cannot approve a pending or malformed legacy account", async () => {
  const h = harness(), ownerCookie = await h.seed(owner);
  for (const initial of [pending, { ...pending, status: "active" }, { ...approved, approvedAt: "invalid" }, { ...approved, approvedBy: "invalid" }, approved]) {
    const cookie = await h.seed(initial);
    assert.equal((await h.run("admin", ownerCookie, "suspend", { email: pending.email })).body.user.accessStatus, "suspended");
    assert.equal((await h.run("auth", cookie)).body.user, null);
    assert.equal((await h.run("admin", ownerCookie, "approve", { email: pending.email })).status, 400);
    const restored = await h.run("admin", ownerCookie, "activate", { email: pending.email });
    const expected = initial === approved ? "approved" : "pending";
    assert.equal(restored.body.user.accessStatus, expected);
    assert.equal((await h.run("studio", cookie, "quote", {})).status, expected === "approved" ? 200 : 401);
  }
});

test("pending invitation acceptance is narrow, grants recorded approval, and preserves forced-password setup", async () => {
  const h = harness(), cookie = await h.seed(pending), invite = newInvitation(pending.email, owner.email);
  await h.write(invite.path, invite.record);
  assert.equal((await h.run("admin", cookie, "overview")).status, 401);
  assert.equal((await h.run("admin", cookie, "acceptInvite", { token: invite.token }, { origin: "https://attacker.invalid" })).status, 403);
  const setupCookie = await h.seed({ ...pending, mustChangePassword: true });
  assert.equal((await h.run("admin", setupCookie, "acceptInvite", { token: invite.token })).status, 401);
  assert.equal((await h.read(invite.path)).value.usedBy, null);
  await h.seed(pending);
  const claimed = await h.run("admin", cookie, "acceptInvite", { token: invite.token });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.user.accessStatus, "approved");
  assert.equal(claimed.body.user.role, "admin");
  const saved = (await h.read(userPath(pending.email))).value;
  assert.equal(saved.approvedBy, owner.email);
  assert.equal(saved.approvalSource, "administrator-invitation");
  assert.equal((await h.run("studio", cookie, "quote", {})).status, 200);
});

test("removing administrator rights preserves approved studio access while suspension remains in force", async () => {
  const h = harness(), ownerCookie = await h.seed(owner);
  for (const initial of [admin, { ...admin, status: undefined }, { ...admin, status: "suspended" }]) {
    const cookie = await h.seed(initial);
    const result = await h.run("admin", ownerCookie, "revokeAdmin", { email: admin.email });
    assert.equal(result.status, 200);
    assert.equal(result.body.user.role, "customer");
    assert.equal(result.body.user.accessStatus, initial.status === "suspended" ? "suspended" : "approved");
    assert.equal((await h.read(userPath(admin.email))).value.approvedBy, owner.email);
    if (initial.status === "suspended") {
      assert.equal((await h.run("studio", cookie, "quote", {})).status, 401);
      assert.equal((await h.run("admin", ownerCookie, "activate", { email: admin.email })).body.user.accessStatus, "approved");
    }
    assert.equal((await h.run("studio", cookie, "quote", {})).status, 200);
    assert.equal((await h.run("admin", cookie, "users")).status, 403);
  }
});

test("registration policy defaults closed and an audited toggle affects only future signups", async () => {
  const h = harness(), ownerCookie = await h.seed(owner), adminCookie = await h.seed(admin), pendingCookie = await h.seed(pending);
  assert.deepEqual((await h.run("admin", ownerCookie, "registrationPolicy")).body,
    { approvalRequired: true, revision: 0, updatedAt: null, updatedBy: null });
  assert.equal((await h.run("auth")).body.registrationApprovalRequired, true);
  assert.equal((await h.run("admin", adminCookie, "updateRegistrationPolicy", { approvalRequired: "false", expectedRevision: 0 })).status, 400);
  assert.equal((await h.run("admin", pendingCookie, "updateRegistrationPolicy", { approvalRequired: false, expectedRevision: 0 })).status, 401);
  const opened = await h.run("admin", adminCookie, "updateRegistrationPolicy", { approvalRequired: false, expectedRevision: 0 });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.approvalRequired, false);
  assert.equal(opened.body.revision, 1);
  assert.equal(opened.body.updatedBy, admin.email);
  assert.equal(h.events[0][1], "registration.policy.updated");
  assert.equal((await h.run("auth")).body.registrationApprovalRequired, false);
  const result = await h.run("auth", undefined, "register", signup("new@example.invalid"));
  assert.equal(result.status, 201);
  assert.equal(result.body.user.accessStatus, "approved");
  const newUser = (await h.read(userPath("new@example.invalid"))).value;
  assert.equal(newUser.approvedBy, admin.email);
  assert.equal(newUser.approvalSource, "registration-policy");
  assert.equal(newUser.approvalPolicyRevision, 1);
  assert.equal((await h.run("studio", pendingCookie, "quote", {})).status, 401);
  const closed = await h.run("admin", ownerCookie, "updateRegistrationPolicy", { approvalRequired: true, expectedRevision: 1 });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.revision, 2);
  assert.equal((await h.run("studio", h.cookie(newUser), "quote", {})).status, 200);
  assert.equal((await h.run("admin", h.cookie(newUser), "updateRegistrationPolicy", { approvalRequired: false, expectedRevision: 2 })).status, 403);
  assert.equal((await h.run("auth", undefined, "register", signup("next@example.invalid"))).body.user.accessStatus, "pending");
  assert.equal((await h.run("admin", ownerCookie, "updateRegistrationPolicy", { approvalRequired: false, expectedRevision: 1 })).status, 409);
  assert.equal((await h.read(REGISTRATION_POLICY_PATH)).value.approvalRequired, true);
});

test("settings outages preserve session bootstrap but cannot create an account or imply approval", async () => {
  const h = harness({ readRegistrationPolicy: async () => { throw new Error("Synthetic policy outage"); } });
  const cookie = await h.seed(owner);
  const bootstrap = await h.run("auth", cookie);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.user.accessStatus, "approved");
  assert.equal(bootstrap.body.registrationApprovalRequired, true);
  assert.equal((await h.run("auth", undefined, "register", signup("new@example.invalid"))).status, 503);
  assert.equal(await h.read(userPath("new@example.invalid")), null);
  assert.equal((await h.run("admin", cookie, "registrationPolicy")).status, 503);
  for (const value of [{ approvalRequired: false }, { approvalRequired: false, revision: 1, updatedAt: "invalid", updatedBy: owner.email },
    { approvalRequired: false, revision: 1, updatedAt: new Date().toISOString(), updatedBy: "invalid" }])
    await assert.rejects(readRegistrationPolicy(async () => ({ value })), /saved registration policy/);
});

test("conditional approval write failure leaves an applicant pending and emits no approval audit", async () => {
  let h;
  h = harness({ writeRecord: async (path, value, etag) => {
    if (path === userPath(pending.email) && value.status === "active") throw new Error("Conditional write conflict");
    return h.write(path, value, etag);
  } });
  const cookie = await h.seed(owner), pendingCookie = await h.seed(pending);
  assert.equal((await h.run("admin", cookie, "approve", { email: pending.email })).status, 503);
  assert.equal((await h.run("studio", pendingCookie, "checkout", {})).status, 401);
  assert.equal((await h.read(userPath(pending.email))).value.status, "pending");
  assert.deepEqual(h.events, []);
});

test("concurrent policy saves conditionally persist one administrator decision", async () => {
  const h = harness(), ownerCookie = await h.seed(owner), adminCookie = await h.seed(admin);
  const results = await Promise.all([ownerCookie, adminCookie].map(cookie =>
    h.run("admin", cookie, "updateRegistrationPolicy", { approvalRequired: false, expectedRevision: 0 })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.ok([409, 503].includes(results.find(result => result.status !== 200).status));
  assert.equal((await h.read(REGISTRATION_POLICY_PATH)).value.revision, 1);
  assert.equal(h.events.filter(([, action]) => action === "registration.policy.updated").length, 1);
});
