import test from "node:test";
import assert from "node:assert/strict";
import { createSourceAgreementService, builtInSourceAgreement, sourceAgreementVersionPath, SOURCE_AGREEMENT_PATH } from "../api/_lib/source-agreement.mjs";
import { createAuthHandler } from "../api/auth.mjs";
import { createAdminHandler } from "../api/admin.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { digest } from "../api/_lib/auth.mjs";

const at = Date.parse("2026-09-22T18:00:00.000Z");
const admin = { email: "admin@example.invalid", role: "admin", status: "active" };
const account = { email: "ada@example.invalid", name: "Fictional Ada Example" };
const text = { title: "Source rights", body: "I am authorized to provide these materials.\nThe stated permissions apply.", consentLabel: "I accept this statement." };
const consent = agreement => ({ sourceAgreementAccepted: true, sourceAgreementVersion: agreement.version, sourceAgreementHash: agreement.contentHash });
const code = (status, value) => error => error.status === status && error.code === value;
function harness(hooks = {}) {
  const records = new Map(), writes = [];
  let serial = 0;
  const read = async path => {
    await hooks.beforeRead?.(path);
    return records.has(path) ? structuredClone(records.get(path)) : null;
  };
  const write = async (path, value, etag) => {
    await hooks.beforeWrite?.(path, value, etag);
    const old = records.get(path);
    if (old ? etag !== old.etag : etag !== undefined) throw new Error("Conditional write failed");
    records.set(path, { value: structuredClone(value), etag: `etag-${++serial}` });
    writes.push({ path, value: structuredClone(value), etag });
    await hooks.afterWrite?.(path, value, etag);
  };
  return { records, writes, read, write, service: createSourceAgreementService({ readRecord: read, writeRecord: write, now: () => at }) };
}

test("default reads are public and nondestructive; first acceptance archives the exact server statement", async () => {
  const h = harness(), current = await h.service.current();
  assert.deepEqual(current, builtInSourceAgreement());
  assert.deepEqual(await h.service.version(current.version), current);
  assert.equal(h.writes.length, 0);
  const accepted = await h.service.accept(account, { ...consent(current), title: "Forged", acceptedAt: "2000-01-01" });
  assert.deepEqual(accepted, { agreement: current, acceptedAt: new Date(at).toISOString(), signedName: account.name,
    accountEmail: account.email, signatureMethod: "account-name-checkbox" });
  assert.equal(h.writes.length, 1);
  const archive = h.records.get(sourceAgreementVersionPath(current.version)).value;
  assert.deepEqual(archive.agreement, current);
  assert.equal(archive.updatedBy, null);
  assert.equal(h.writes[0].etag, undefined);
  assert.deepEqual(h.service.accepted({ ...account, sourceAgreementAcceptance: accepted }), accepted);
  assert.equal(h.service.accepted(account), null);
  accepted.agreement.body = "Changed outside the service";
  assert.deepEqual(await h.service.version(current.version), current);
});

test("admin updates archive the old version and preserve previously signed snapshots", async () => {
  const h = harness(), original = await h.service.current();
  const acceptance = await h.service.accept(account, consent(original));
  const saved = await h.service.update(admin, { revision: 0, ...text });
  assert.equal(saved.revision, 1);
  assert.equal(saved.updatedAt, new Date(at).toISOString());
  assert.match(saved.version, /^source-agreement-v1-[a-f0-9]{64}-[a-f0-9]{32}$/);
  assert.deepEqual(await h.service.current(), saved);
  assert.deepEqual(await h.service.version(original.version), original);
  assert.deepEqual(await h.service.version(saved.version), saved);
  assert.deepEqual(h.service.accepted({ ...account, sourceAgreementAcceptance: acceptance }).agreement, original);
  const archive = h.records.get(sourceAgreementVersionPath(saved.version)).value;
  assert.equal(archive.updatedBy, admin.email);
  assert.equal(archive.previousVersion, original.version);
  assert.equal(archive.archivedAt, new Date(at).toISOString());
  assert.equal(saved.updatedBy, undefined);
  await assert.rejects(h.service.accept(account, consent(original)), code(409, "AGREEMENT_CHANGED"));
  await assert.rejects(h.service.update(admin, { revision: 0, ...text }), code(409, "AGREEMENT_CONFLICT"));
  assert.deepEqual(await h.service.current(), saved);
});

test("legacy owner and administrator records may save agreements through shared role authorization", async () => {
  for (const actor of [{ email: OWNER_EMAIL, role: "owner" }, { email: admin.email, role: "admin" }]) {
    const h = harness(), events = [];
    const handler = createAdminHandler({ getSession: async () => ({ user: actor }), sourceAgreement: h.service,
      limitAction: async () => true, audit: async (...args) => events.push(args) });
    const run = async method => {
      let status, body;
      await handler({ method, url: "/api/admin?action=agreement", headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com" },
        ...(method === "POST" ? { body: { action: "updateAgreement", revision: 0, ...text } } : {}) }, {
        set statusCode(value) { status = value; }, setHeader() {}, end(value) { body = JSON.parse(value); },
      });
      return { status, body };
    };
    assert.equal((await run("GET")).status, 200);
    const saved = await run("POST");
    assert.equal(saved.status, 200);
    assert.equal(saved.body.agreement.revision, 1);
    assert.deepEqual((await run("GET")).body.agreement, saved.body.agreement);
    assert.equal(h.records.get(sourceAgreementVersionPath(saved.body.agreement.version)).value.updatedBy, actor.email);
    assert.equal(events[0][0], actor.email);
    assert.equal(events[0][1], "source.agreement.updated");
    assert.equal(Object.hasOwn(actor, "status"), false);
  }
});

test("agreement saves still reject suspended roles, password setup, customers and owner email alone", async () => {
  const h = harness();
  for (const actor of [
    { email: OWNER_EMAIL }, { email: OWNER_EMAIL, status: "active" },
    { email: OWNER_EMAIL, role: "customer", status: "active" }, { email: account.email, role: "owner", status: "active" },
    { email: OWNER_EMAIL, role: "owner", status: "suspended" }, { ...admin, status: "suspended" },
    { email: OWNER_EMAIL, role: "owner", mustChangePassword: true }, { ...admin, mustChangePassword: true },
    { ...account, role: "customer", status: "pending" },
  ]) await assert.rejects(h.service.update(actor, { revision: 0, ...text }), code(403, "AGREEMENT_FORBIDDEN"));
  assert.equal(h.writes.length, 0);
});

test("historical built-in statements remain retrievable independently of the current bundled default", async () => {
  const h = harness(), oldText = { ...text, body: "A previous bundled statement." };
  const contentHash = digest(JSON.stringify(oldText));
  const old = { ...oldText, contentHash, version: `source-agreement-v0-${contentHash}`, revision: 0, updatedAt: null };
  await h.write(sourceAgreementVersionPath(old.version), { agreement: old });
  assert.notEqual(old.version, builtInSourceAgreement().version);
  assert.deepEqual(await h.service.version(old.version), old);
});

test("only explicit current consent can produce a signature and stale requests do not write", async () => {
  const h = harness(), current = await h.service.current();
  for (const value of [undefined, false, "true", 1, null])
    await assert.rejects(h.service.accept(account, { ...consent(current), sourceAgreementAccepted: value }), code(400, "AGREEMENT_REQUIRED"));
  for (const value of [{ sourceAgreementVersion: "old" }, { sourceAgreementHash: "a".repeat(64) }, { sourceAgreementHash: undefined }])
    await assert.rejects(h.service.accept(account, { ...consent(current), ...value }), code(409, "AGREEMENT_CHANGED"));
  assert.equal(h.writes.length, 0);
});

test("a statement changed during acceptance must be shown again before registration", async () => {
  let changed = false;
  const h = harness({ afterWrite: async path => {
    if (!changed && path === sourceAgreementVersionPath(builtInSourceAgreement().version)) {
      changed = true;
      await h.service.update(admin, { revision: 0, ...text });
    }
  } });
  await assert.rejects(h.service.accept(account, consent(builtInSourceAgreement())), code(409, "AGREEMENT_CHANGED"));
  assert.equal((await h.service.current()).revision, 1);
});

test("simultaneous administrator saves select one current version without overwriting history", async () => {
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const h = harness({ beforeWrite: async path => {
    if (path === SOURCE_AGREEMENT_PATH) { if (++arrivals === 2) release(); await barrier; }
  } });
  const results = await Promise.allSettled([
    h.service.update(admin, { revision: 0, ...text }),
    h.service.update({ ...admin, email: "second@example.invalid" }, { revision: 0, ...text }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const loser = results.find(result => result.status === "rejected");
  assert.equal(loser.reason.code, "AGREEMENT_CONFLICT");
  const winner = results.find(result => result.status === "fulfilled").value;
  assert.deepEqual(await h.service.current(), winner);
  assert.deepEqual(await h.service.version(winner.version), winner);
  const versions = h.writes.filter(write => write.path.startsWith("agreements/"));
  assert.equal(versions.length, 3);
  assert.equal(new Set(versions.map(write => write.path)).size, 3);
  assert.ok(versions.every(write => write.etag === undefined));
});

test("archival or settings outages fail closed and never publish an unarchived statement", async () => {
  const readFailure = harness({ beforeRead: async () => { throw new Error("Private storage details"); } });
  await assert.rejects(readFailure.service.current(), code(503, "AGREEMENT_UNAVAILABLE"));
  await assert.rejects(readFailure.service.accept(account, consent(builtInSourceAgreement())), code(503, "AGREEMENT_UNAVAILABLE"));
  const archiveFailure = harness({ beforeWrite: async path => { if (path.startsWith("agreements/")) throw new Error("Unavailable"); } });
  await assert.rejects(archiveFailure.service.accept(account, consent(builtInSourceAgreement())), code(503, "AGREEMENT_UNAVAILABLE"));
  await assert.rejects(archiveFailure.service.update(admin, { revision: 0, ...text }), code(503, "AGREEMENT_UNAVAILABLE"));
  assert.equal(archiveFailure.writes.length, 0);
  const pointerFailure = harness({ beforeWrite: async path => { if (path === SOURCE_AGREEMENT_PATH) throw new Error("Unavailable"); } });
  await assert.rejects(pointerFailure.service.update(admin, { revision: 0, ...text }), code(503, "AGREEMENT_UNAVAILABLE"));
  assert.equal(pointerFailure.records.has(SOURCE_AGREEMENT_PATH), false);
  assert.deepEqual(await pointerFailure.service.current(), builtInSourceAgreement());
});

test("lost successful write responses are recovered only through matching durable readback", async () => {
  const h = harness({ afterWrite: async () => { throw new Error("Response lost after durable write"); } });
  const acceptance = await h.service.accept(account, consent(builtInSourceAgreement()));
  assert.deepEqual(acceptance.agreement, builtInSourceAgreement());
  const saved = await h.service.update(admin, { revision: 0, ...text });
  assert.deepEqual(await h.service.current(), saved);
  assert.equal(saved.revision, 1);
});

test("corrupt pointers, modified historical text and mismatched account signatures are rejected", async () => {
  const h = harness(), saved = await h.service.update(admin, { revision: 0, ...text });
  const pointer = h.records.get(SOURCE_AGREEMENT_PATH);
  pointer.value.contentHash = "a".repeat(64);
  await assert.rejects(h.service.current(), code(503, "AGREEMENT_UNAVAILABLE"));
  pointer.value.contentHash = saved.contentHash;
  h.records.get(sourceAgreementVersionPath(saved.version)).value.agreement.body = "Modified without a new version";
  await assert.rejects(h.service.current(), code(503, "AGREEMENT_UNAVAILABLE"));
  await assert.rejects(h.service.version(saved.version), code(503, "AGREEMENT_UNAVAILABLE"));
  const clean = harness(), accepted = await clean.service.accept(account, consent(builtInSourceAgreement()));
  assert.throws(() => clean.service.accepted({ email: "other@example.invalid", sourceAgreementAcceptance: accepted }), code(503, "AGREEMENT_UNAVAILABLE"));
});

test("admin content is bounded plain text with normalization and no client-assigned metadata", async () => {
  const h = harness();
  for (const patch of [{ title: "" }, { title: "a".repeat(161) }, { body: "a".repeat(10001) }, { consentLabel: "a".repeat(501) },
    { body: "<script>text</script>" }, { body: "hidden\u202etext" }, { body: "bad\u0000text" }, { title: "two\nlines" },
    { consentLabel: "two\tparts" }, { body: 123 }, { updatedAt: new Date(at).toISOString() }, { contentHash: "a".repeat(64) }])
    await assert.rejects(h.service.update(admin, { revision: 0, ...text, ...patch }), code(400, "AGREEMENT_INVALID"));
  for (const actor of [null, { ...admin, role: "customer" }, { ...admin, status: "suspended" }, { ...admin, mustChangePassword: true }])
    await assert.rejects(h.service.update(actor, { revision: 0, ...text }), code(403, "AGREEMENT_FORBIDDEN"));
  assert.equal(h.writes.length, 0);
  const saved = await h.service.update(admin, { revision: 0, title: "  Cafe\u0301 sources  ", body: "  First\r\nSecond\rThird\tpart  ", consentLabel: "  I accept.  " });
  assert.equal(saved.title, "Café sources");
  assert.equal(saved.body, "First\nSecond\nThird\tpart");
  assert.equal(saved.consentLabel, "I accept.");
});

test("version lookup rejects traversal and unknown valid versions without revealing storage details", async () => {
  const h = harness();
  for (const value of ["../auth/users", "", null, "source-agreement-v0-nohash"])
    await assert.rejects(h.service.version(value), code(400, "AGREEMENT_INVALID"));
  await assert.rejects(h.service.version(`source-agreement-v1-${"a".repeat(64)}`), code(404, "AGREEMENT_NOT_FOUND"));
  assert.equal(h.writes.length, 0);
});

test("public agreement lookup needs no session while the accepted copy requires that account's session", async () => {
  const h = harness(), acceptance = await h.service.accept(account, consent(builtInSourceAgreement()));
  let session = null, sessionCalls = 0;
  const handler = createAuthHandler({ sourceAgreement: h.service, getSession: async () => { sessionCalls++; return session; } });
  const run = async url => {
    let status, body;
    await handler({ method: "GET", url, headers: { host: "lineagetheater.com" } }, {
      set statusCode(value) { status = value; }, setHeader() {}, end(value) { body = JSON.parse(value); },
    });
    return { status, body };
  };
  assert.deepEqual((await run("/api/auth?action=agreement")).body, { agreement: builtInSourceAgreement() });
  assert.equal(sessionCalls, 0);
  assert.equal((await run("/api/auth?action=acceptedAgreement")).status, 401);
  session = { user: account };
  assert.deepEqual((await run("/api/auth?action=acceptedAgreement")).body, { acceptance: null });
  session = { user: { ...account, sourceAgreementAcceptance: acceptance } };
  assert.deepEqual((await run("/api/auth?action=acceptedAgreement")).body, { acceptance });
  session.user.mustChangePassword = true;
  assert.equal((await run("/api/auth?action=acceptedAgreement")).status, 401);
});
