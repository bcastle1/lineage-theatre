import test from "node:test";
import assert from "node:assert/strict";
import { createFilmLibraryService, libraryStatePath } from "../api/_lib/film-library.mjs";
import { createLibraryHandler } from "../api/library.mjs";
import { buildFilmManifest, fictionalOperatorProject, productionJobPath } from "../api/_lib/film-production.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { metadataPath, mediaPath } from "../api/_lib/archive.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const EMAIL = "family@example.invalid", OTHER = "other@example.invalid";
const NOW = Date.parse("2026-09-24T12:00:00Z"), TIME = new Date(NOW).toISOString();
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const clone = value => structuredClone(value);
const account = email => ({ email, role: "customer", status: "active", approvedAt: TIME, approvedBy: OWNER_EMAIL });
function fixture(options = {}) {
  let revision = 0;
  const records = new Map([[userPath(EMAIL), { value: account(EMAIL), etag: "account-1" }], [userPath(OTHER), { value: account(OTHER), etag: "account-2" }]]);
  const reads = [], writes = [], lists = [];
  const read = async path => { reads.push(path); await options.beforeRead?.(path); return clone(records.get(path) || null); };
  const write = async (path, value, etag) => {
    await options.beforeWrite?.(path, value);
    const old = records.get(path); if (old ? old.etag !== etag : Boolean(etag)) throw new Error("precondition failed");
    const record = { value: clone(value), etag: `v-${++revision}` }; records.set(path, record); writes.push(path);
    await options.afterWrite?.(path, value); return clone(record);
  };
  const listBlobs = async input => {
    lists.push(clone(input)); await options.beforeList?.(input);
    const all = [...records.keys()].filter(path => path.startsWith(input.prefix)).sort();
    const offset = input.cursor ? Number(input.cursor.replace("opaque-", "")) : 0;
    const paths = all.slice(offset, offset + input.limit), hasMore = offset + paths.length < all.length;
    return options.page ? options.page(input) : { blobs: paths.map(pathname => ({ pathname })), hasMore, ...(hasMore ? { cursor: `opaque-${offset + paths.length}` } : {}) };
  };
  const deps = { read, write, listBlobs, now: () => NOW, cursorSecret: "fictional-library-cursor-signing-secret" };
  const service = createFilmLibraryService(deps);
  function put(path, value) { records.set(path, { value: clone(value), etag: `seed-${++revision}` }); }
  function plan(index = 1, { email = EMAIL, filmId = uuid(100), title = "Saved fictional film", mode = "customer", status = "prepared" } = {}) {
    const project = fictionalOperatorProject(); project.id = filmId; project.title = title; project.duration = 120;
    const { manifest, manifestHash } = buildFilmManifest(project), id = uuid(index);
    const job = { id, ownerHash: digest(email), filmId, manifestHash, manifest, mode, status,
      shots: manifest.shots.map(shot => ({ id: shot.id, status: status === "completed" ? "completed" : "prepared", providerJobId: "PRIVATE_PROVIDER_TASK" })),
      createdAt: TIME, updatedAt: TIME };
    put(productionJobPath(email, id), job); return job;
  }
  function payment(job, { email = EMAIL, legacy = false, sandbox = false, status = "captured", ...rest } = {}) {
    const id = digest(legacy ? `${email}:${job.manifestHash}` : `${email}:production:${job.manifestHash}`);
    const order = { id, customerEmail: email, preparedId: job.id, filmId: job.filmId, manifestHash: job.manifestHash, status,
      amountCents: 330, refundedCents: 0, currency: "USD", capturedAt: TIME,
      merchantBinding: { environment: sandbox ? "sandbox" : "production", grantId: "a".repeat(64) },
      provider: "quickbooks", providerChargeId: "PRIVATE_PROCESSOR_CHARGE", ...rest };
    put(`payments/orders/${id}.json`, order); return order;
  }
  function complete(job) {
    const result = { ...job, status: "completed", authorization: { environment: "production", manifestHash: job.manifestHash },
      shots: job.shots.map(shot => ({ ...shot, status: "completed" })), media: { pathname: `production/media/${job.ownerHash}/${job.id}/${"b".repeat(64)}.mp4`,
        sha256: "b".repeat(64), contentType: "video/mp4", sizeBytes: 128, durationSeconds: 120 } };
    put(productionJobPath(EMAIL, job.id), result); return result;
  }
  function upload(index = 500, email = EMAIL, ready = true) {
    const id = uuid(index), record = { id, ownerEmail: email, title: "Uploaded fictional film", duration: 120, createdAt: TIME, updatedAt: TIME,
      ...(ready ? { video: { pathname: mediaPath(email, id, "video/mp4"), contentType: "video/mp4", size: 128, etag: "media-etag" } } : {}) };
    put(metadataPath(email, id), record); return record;
  }
  return { service, records, reads, writes, lists, put, plan, payment, complete, upload, deps,
    list: input => service.list(account(EMAIL), input), detail: (kind, id) => service.detail(account(EMAIL), { kind, id }),
    organize: (action, kind, id, expectedRevision = 0) => service.organize(account(EMAIL), { action, kind, id, expectedRevision }) };
}

test("server library recovers a paid saved plan without browser storage and excludes private source/provider/payment fields", async () => {
  const h = fixture(), job = h.plan(); const order = h.payment(job);
  const page = await h.list(); assert.equal(page.entries.length, 1);
  const entry = page.entries[0]; assert.equal(entry.id, job.id); assert.equal(entry.filmId, job.filmId);
  assert.equal(entry.payments[0].id, order.id); assert.equal(entry.payments[0].status, "captured"); assert.equal(entry.production.status, "prepared");
  assert.equal(entry.production.mediaReady, false); assert.equal(entry.mediaUrl, undefined);
  const publicData = JSON.stringify(page);
  for (const secret of ["PRIVATE_PROVIDER_TASK", "PRIVATE_PROCESSOR_CHARGE", job.manifest.screenplay.scenes[0].narration, "keyFingerprint", "merchantBinding", "sources", "screenplay"]) assert.equal(publicData.includes(secret), false);
  assert.equal(h.lists.every(call => call.prefix === `production/jobs/${digest(EMAIL)}/`), true);
  assert.equal(h.reads.some(path => path.startsWith("payments/") && !path.startsWith("payments/orders/")), false);
});

test("distinct saved versions remain distinct and payment binds only its exact prepared version", async () => {
  const h = fixture(), first = h.plan(1), second = h.plan(2), changed = h.plan(3, { title: "Another saved version" });
  h.payment(first); h.payment(changed);
  const entries = (await h.list()).entries;
  assert.equal(entries.length, 3); assert.equal(new Set(entries.map(row => row.filmId)).size, 1);
  assert.equal(entries.find(row => row.id === first.id).payments.length, 1);
  assert.equal(entries.find(row => row.id === second.id).payments.length, 0);
  assert.equal(entries.find(row => row.id === changed.id).payments.length, 1);
});

test("library is owner scoped even for administrators and cannot resolve another customer's entry", async () => {
  const h = fixture(); h.plan(1); const foreign = h.plan(2, { email: OTHER }); h.upload(600, OTHER);
  assert.equal((await h.list()).entries.length, 1);
  await assert.rejects(h.detail("plan", foreign.id), e => e.status === 404);
  await assert.rejects(h.organize("trash", "plan", foreign.id), e => e.status === 404);
  h.put(userPath(EMAIL), { ...account(EMAIL), role: "admin" });
  const adminPage = await h.service.list({ ...account(EMAIL), role: "admin" }); assert.equal(adminPage.entries.length, 1);
  assert.equal(h.reads.some(path => path.startsWith(`production/jobs/${digest(OTHER)}/`)), false);
});

test("payment identifiers and environments remain separate, exact identity mismatches are not attached", async () => {
  const h = fixture(), job = h.plan();
  h.payment(job); h.payment(job, { legacy: true, sandbox: true });
  let entry = (await h.list()).entries[0]; assert.deepEqual(entry.payments.map(order => order.sandbox), [false, true]);
  for (const patch of [{ customerEmail: OTHER }, { preparedId: uuid(99) }, { filmId: uuid(99) }, { manifestHash: "c".repeat(64) }]) {
    const order = h.payment(job, patch); entry = (await h.list()).entries[0];
    assert.equal(entry.payments.some(item => item.id === order.id), false);
  }
});

test("queue state comes from the exact saved ticket and refund/review status stays visible", async () => {
  const h = fixture(), job = h.plan(); h.payment(job, { status: "refund-pending", refundedCents: 100, refundOperation: { requestId: "private-refund" } });
  const path = `production/queue/${digest(EMAIL)}/${job.id}.json`;
  h.put(path, { email: EMAIL, id: job.id, manifestHash: job.manifestHash, state: "pending" });
  let entry = (await h.list()).entries[0]; assert.equal(entry.production.status, "queued"); assert.equal(entry.payments[0].requiresReview, true); assert.equal(entry.payments[0].refundedCents, 100);
  h.put(path, { email: OTHER, id: job.id, manifestHash: job.manifestHash, state: "pending" });
  assert.equal((await h.list()).entries[0].production.status, "prepared");
  h.put(path, { email: EMAIL, id: job.id, manifestHash: job.manifestHash, state: "attention" });
  assert.equal((await h.list()).entries[0].production.needsAttention, true);
});

test("completed playback uses existing payment gates and is independent of current provider availability", async () => {
  const h = fixture(), job = h.complete(h.plan()); h.payment(job);
  let entry = (await h.list()).entries[0]; assert.equal(entry.production.mediaReady, true);
  assert.equal(entry.mediaUrl, `/api/studio?action=productionMedia&id=${job.id}`); assert.equal(entry.downloadUrl, `${entry.mediaUrl}&download=1`);
  for (const patch of [{ refundedCents: 1 }, { refundOperation: {} }, { merchantBinding: { environment: "sandbox", grantId: "a".repeat(64) } }, { capturedAt: undefined }]) {
    h.payment(job, patch); entry = (await h.list()).entries[0]; assert.equal(entry.production.mediaReady, false); assert.equal(entry.mediaUrl, undefined);
  }
  h.payment(job); h.put(productionJobPath(EMAIL, job.id), { ...job, media: { ...job.media, pathname: "https://secret.invalid/video.mp4" } });
  assert.equal((await h.list()).entries[0].production.mediaReady, false);
});

test("archive uploads are paginated separately with existing private media links", async () => {
  const h = fixture(), job = h.plan(), upload = h.upload(), draft = h.upload(501, EMAIL, false);
  const plans = await h.list(); assert.equal(plans.entries[0].id, job.id); assert.ok(plans.cursor);
  const uploads = await h.list({ cursor: plans.cursor }); assert.equal(uploads.cursor, undefined); assert.equal(uploads.entries.length, 2);
  assert.equal(uploads.entries[0].mediaUrl, `/api/archive?action=media&id=${upload.id}`);
  assert.equal(uploads.entries.find(row => row.id === draft.id).production.mediaReady, false);
  assert.equal(h.lists.at(-1).prefix, `archive/metadata/${digest(EMAIL)}/`);
});

test("archive, trash and restore update only reversible metadata, preserving payment and queued production", async () => {
  const h = fixture(), job = h.plan(); h.payment(job);
  h.put(`production/queue/${digest(EMAIL)}/${job.id}.json`, { email: EMAIL, id: job.id, manifestHash: job.manifestHash, state: "pending" });
  const original = clone([...h.records]);
  assert.equal((await h.organize("archive", "plan", job.id)).entry.libraryState, "archived");
  assert.equal((await h.list()).entries.length, 0); assert.ok((await h.list()).cursor);
  assert.equal((await h.list({ view: "archived" })).entries[0].id, job.id);
  assert.equal((await h.organize("trash", "plan", job.id, 1)).entry.revision, 2);
  assert.equal((await h.list({ view: "trash" })).entries[0].production.status, "queued");
  assert.equal((await h.organize("restore", "plan", job.id, 2)).entry.libraryState, "active");
  for (const [path, value] of original) assert.deepEqual(h.records.get(path), value);
  assert.equal(h.writes.every(path => path === libraryStatePath(EMAIL, "plan", job.id)), true);
  await assert.rejects(h.service.organize(account(EMAIL), { action: "delete", kind: "plan", id: job.id, expectedRevision: 3 }), e => e.status === 400);
});

test("organization uses optimistic revision checks and confirms lost write replies", async () => {
  const h = fixture({ afterWrite: async () => { throw new Error("response lost"); } }), job = h.plan();
  const outcomes = await Promise.allSettled([h.organize("archive", "plan", job.id), h.organize("trash", "plan", job.id)]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1); assert.equal(h.writes.length, 1);
  await assert.rejects(h.organize("restore", "plan", job.id, 0), e => e.status === 409);
  const entry = (await h.detail("plan", job.id)).entry;
  assert.equal((await h.organize("restore", "plan", job.id, entry.revision)).entry.libraryState, "active");
});

test("manifest review returns the exact immutable version and never includes job or payment internals", async () => {
  const h = fixture(), job = h.plan(); h.payment(job);
  const detail = await h.detail("plan", job.id);
  assert.deepEqual(detail.manifest, { id: job.id, manifestHash: job.manifestHash, manifest: job.manifest });
  assert.equal(digest(JSON.stringify(detail.manifest.manifest)), detail.manifest.manifestHash);
  assert.equal(JSON.stringify(detail).includes("PRIVATE_PROVIDER_TASK"), false);
  assert.equal(JSON.stringify(detail).includes("PRIVATE_PROCESSOR_CHARGE"), false);
  detail.manifest.manifest.title = "Browser edit";
  assert.equal((await h.detail("plan", job.id)).entry.title, job.manifest.title);
});

test("bounded signed cursors cannot cross owners, views or stages and reach later paid plans after empty filtered pages", async () => {
  const h = fixture();
  for (let index = 1; index <= 13; index++) { const job = h.plan(index, { title: `Version ${index}` }); if (index <= 12) await h.organize("archive", "plan", job.id); else h.payment(job); }
  const first = await h.list(); assert.equal(first.entries.length, 0); assert.ok(first.cursor); assert.equal(h.lists.at(-1).limit, 12);
  const next = await h.list({ cursor: first.cursor }); assert.equal(next.entries.length, 1); assert.equal(next.entries[0].payments[0].status, "captured");
  const before = h.lists.length;
  await assert.rejects(h.service.list(account(OTHER), { cursor: first.cursor }), e => e.status === 400);
  await assert.rejects(h.list({ view: "archived", cursor: first.cursor }), e => e.status === 400);
  await assert.rejects(h.list({ cursor: `${first.cursor.slice(0, -2)}xx` }), e => e.status === 400);
  assert.equal(h.lists.length, before);
  const expired = createFilmLibraryService({ ...h.deps, now: () => NOW + 25 * 3600_000 });
  await assert.rejects(expired.list(account(EMAIL), { cursor: first.cursor }), e => e.status === 400);
});

test("malformed or foreign Blob listing rows cannot cause cross-owner reads and oversized pages fail closed", async () => {
  const foreignPath = productionJobPath(OTHER, uuid(2));
  const h = fixture({ page: () => ({ blobs: [{ pathname: foreignPath }, { pathname: `production/jobs/${digest(EMAIL)}/../../auth.json` }], hasMore: false }) });
  h.plan(2, { email: OTHER }); assert.equal((await h.list()).entries.length, 0); assert.equal(h.reads.includes(foreignPath), false);
  const tooMany = fixture({ page: () => ({ blobs: Array.from({ length: 13 }, () => ({ pathname: "ignored" })), hasMore: false }) });
  await assert.rejects(tooMany.list(), e => e.status === 503);
});

test("unapproved, suspended and revoked accounts cannot list, review or organize films", async () => {
  for (const patch of [{ status: "pending" }, { status: "suspended" }, { mustChangePassword: true }, { approvedAt: undefined }]) {
    const h = fixture(), job = h.plan(); h.put(userPath(EMAIL), { ...account(EMAIL), ...patch });
    for (const call of [() => h.list(), () => h.detail("plan", job.id), () => h.organize("trash", "plan", job.id)]) await assert.rejects(call, e => e.status === 403);
    assert.equal(h.writes.length, 0);
  }
  let h; h = fixture({ beforeList: async () => h.put(userPath(EMAIL), { ...account(EMAIL), status: "suspended" }) }); h.plan();
  await assert.rejects(h.list(), e => e.status === 403);
});

test("operator test plans are excluded unless the current owner record authorizes the same caller", async () => {
  const h = fixture(); const job = h.plan(1, { mode: "operator-test" });
  assert.equal((await h.list()).entries.length, 0); await assert.rejects(h.detail("plan", job.id), e => e.status === 404);
  h.put(userPath(OWNER_EMAIL), { email: OWNER_EMAIL, role: "owner" }); h.plan(2, { email: OWNER_EMAIL, mode: "operator-test" });
  const page = await h.service.list({ email: OWNER_EMAIL, role: "owner" }); assert.equal(page.entries.length, 1);
});

async function route(h, { method = "GET", url = "/api/library", user = account(EMAIL), body, origin = "https://lineagetheater.com", allow = true } = {}) {
  let status, result; const headers = {};
  const handler = createLibraryHandler({ service: h.service, sessionFor: async () => user ? { user } : null, limiter: async () => allow });
  await handler({ method, url, body, headers: { host: "lineagetheater.com", origin } }, {
    set statusCode(value) { status = value; }, setHeader(name, value) { headers[name.toLowerCase()] = value; }, end(value) { result = JSON.parse(value); },
  });
  return { status, result, headers };
}
test("library routes enforce authentication, same-origin writes, strict fields and rate limits", async () => {
  const h = fixture(), job = h.plan();
  assert.equal((await route(h, { user: null })).status, 401);
  assert.equal((await route(h, { method: "POST", origin: "https://other.invalid", body: { action: "trash", kind: "plan", id: job.id, expectedRevision: 0 } })).status, 403);
  assert.equal((await route(h, { url: `/api/library?action=detail&kind=plan&id=${job.id}&owner=${OTHER}` })).status, 400);
  assert.equal((await route(h, { url: "/api/library?view=active&view=trash" })).status, 400);
  assert.equal((await route(h, { allow: false })).status, 429);
  assert.equal((await route(h, { method: "DELETE" })).status, 405);
  assert.equal((await route(h, { method: "POST", body: { action: "trash", kind: "plan", id: job.id, expectedRevision: 0, paid: true } })).status, 400);
  const view = await route(h); assert.equal(view.status, 200); assert.match(view.headers["cache-control"], /no-store/); assert.equal(view.headers.vary, "Cookie");
  const organized = await route(h, { method: "POST", body: { action: "archive", kind: "plan", id: job.id, expectedRevision: 0 } });
  assert.equal(organized.status, 200); assert.equal(organized.result.entry.libraryState, "archived");
  assert.equal((await route(h, { url: `/api/library?action=detail&kind=plan&id=${job.id}` })).result.manifest.manifestHash, job.manifestHash);
});
