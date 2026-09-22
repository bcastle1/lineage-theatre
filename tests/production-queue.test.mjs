import test from "node:test";
import assert from "node:assert/strict";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { createFilmProductionService, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import { createProductionQueue, productionQueuePath } from "../api/_lib/production-queue.mjs";

const email = "customer@example.invalid", orderId = "a".repeat(64);
const actor = { email, role: "customer", status: "active", approvedBy: "owner@example.invalid", approvedAt: "2026-09-20T00:00:00Z" };
function fixture({ unavailable = false, submitFails = false } = {}) {
  let time = Date.parse("2026-09-20T12:00:00Z"), revision = 0;
  const records = new Map(), calls = { submit: 0, reconcile: 0, assembly: 0 };
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw new Error("precondition failed");
    const result = { value: structuredClone(value), etag: `r${++revision}` }; records.set(path, result); return result;
  };
  // The customer branch uses an in-memory production-environment mock. No real
  // provider, merchant approval, payment or production evidence is represented.
  const grant = async ({ manifestHash }) => ({ allowed: true, manifestHash, environment: "production", budgetCents: 300, expiresAt: new Date(time + 60_000).toISOString(), fictionalOnly: false });
  const adapter = { id: "magiclight", available: true, environment: "production", outputHosts: ["media.example.invalid"],
    evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true },
    validateManifest: async () => ({ ready: true, maximumCostCents: 300 }), quote() {},
    submitShot: async ({ shot }) => { calls.submit++; if (submitFails) throw new Error("signed-url-must-not-leak"); return { status: "queued", providerJobId: shot.id }; },
    reconcileShot: async () => { calls.reconcile++; return { status: "uncertain" }; },
    pollShot: async ({ shot }) => ({ status: "completed", providerJobId: shot.id, output: { url: "https://media.example.invalid/clip.mp4", contentType: "video/mp4", sizeBytes: 100, durationSeconds: 5 } }) };
  const film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now: () => time,
    ...(unavailable ? {} : { adapter }), authorize: grant, verifyAssembledMedia: async ({ artifact }) => artifact });
  const listBlobs = async ({ cursor, limit }) => {
    const all = [...records.keys()].filter(path => path.startsWith("production/queue/")), start = Number(cursor || 0);
    return { blobs: all.slice(start, start + limit).map(pathname => ({ pathname })), hasMore: start + limit < all.length, cursor: String(start + limit) };
  };
  const dependencies = { read, write, listBlobs, now: () => time, film, paymentService: { authorizeProduction: grant } };
  const queue = createProductionQueue(dependencies);
  const assemble = async ({ id, job }) => { calls.assembly++; return { playable: true, manifestHash: job.manifestHash,
    pathname: `production/media/${digest(email)}/${id}/${"b".repeat(64)}.mp4`, sha256: "b".repeat(64), contentType: "video/mp4", sizeBytes: 100, durationSeconds: 15, width: 1920, height: 1080, frameRate: 24 }; };
  return { queue, film, records, calls, read, write, dependencies, assemble, advanceTime: () => { time += 400_000; },
    async prepare() { await write(userPath(email), actor); return film.prepare({ email, project: fictionalOperatorProject(), preparationConsent: true, idempotencyKey: "queue-test-preparation-001" }); } };
}

test("queue requires configured rendering and a saved captured-order authorization", async () => {
  const f = fixture({ unavailable: true }), job = await f.prepare();
  await assert.rejects(f.queue.enqueue({ actor, id: job.id, orderId }), /not available/);
  assert.equal([...f.records.keys()].some(path => path.startsWith("production/queue/")), false);
  const g = fixture(), ready = await g.prepare();
  const queue = createProductionQueue({ ...g.dependencies, paymentService: { authorizeProduction: async () => ({ allowed: false }) } });
  await assert.rejects(queue.enqueue({ actor, id: ready.id, orderId }), /not available/);
  assert.equal(g.calls.submit, 0);
});

test("concurrent starts enqueue one ticket, preserve plan binding and do not call the provider", async () => {
  const f = fixture(), job = await f.prepare();
  const results = await Promise.all([1, 2, 3].map(() => f.queue.enqueue({ actor, id: job.id, orderId })));
  assert.ok(results.every(result => result.status === "queued")); assert.equal(f.calls.submit, 0);
  assert.equal([...f.records.keys()].filter(path => path.startsWith("production/queue/")).length, 1);
  await assert.rejects(f.queue.enqueue({ actor, id: job.id, orderId: "b".repeat(64) }), /different production request/);
});

test("durable queue survives service restart and concurrent workers submit each shot once", async () => {
  const f = fixture(), job = await f.prepare();
  await f.queue.enqueue({ actor, id: job.id, orderId });
  const restarted = createProductionQueue(f.dependencies), path = productionQueuePath(email, job.id);
  for (let step = 0; step < 7; step++) {
    await Promise.all([f.queue.runTicket(path, { assemble: f.assemble }), restarted.runTicket(path, { assemble: f.assemble })]);
    f.advanceTime();
  }
  assert.equal(f.calls.submit, 3); assert.equal(f.calls.assembly, 1);
  assert.equal((await restarted.status({ email, id: job.id })).status, "completed");
  assert.equal((await f.read(path)).value.state, "completed");
  assert.deepEqual(await restarted.runBatch({ assemble: f.assemble }), { completed: 0, pending: 0, attention: 0, skipped: 1, cursor: undefined });
});

test("ambiguous submission is reconciled after restart, never automatically resubmitted", async () => {
  const f = fixture({ submitFails: true }), job = await f.prepare();
  await f.queue.enqueue({ actor, id: job.id, orderId });
  const path = productionQueuePath(email, job.id);
  await f.queue.runTicket(path); f.advanceTime();
  await createProductionQueue(f.dependencies).runTicket(path);
  assert.equal(f.calls.submit, 1); assert.equal(f.calls.reconcile, 1);
  assert.doesNotMatch(JSON.stringify((await f.read(path)).value), /signed-url/);
});

test("suspension after enqueue prevents provider calls and exposes attention without private data", async () => {
  const f = fixture(), job = await f.prepare(); await f.queue.enqueue({ actor, id: job.id, orderId });
  const stored = await f.read(userPath(email)); await f.write(userPath(email), { ...actor, status: "suspended" }, stored.etag);
  assert.deepEqual(await f.queue.runTicket(productionQueuePath(email, job.id)), { state: "attention" });
  assert.equal(f.calls.submit, 0);
  const state = await f.queue.status({ email, id: job.id }); assert.equal(state.needsAttention, true);
  assert.doesNotMatch(JSON.stringify(state), /customer@example|orderId|lease|providerJobId/);
});

test("expired assembly claim cannot mark a film complete", async () => {
  const f = fixture(), job = await f.prepare(); await f.queue.enqueue({ actor, id: job.id, orderId });
  const path = productionQueuePath(email, job.id);
  for (let step = 0; step < 6; step++) { await f.queue.runTicket(path); f.advanceTime(); }
  await f.queue.runTicket(path, { assemble: async input => { for (let i = 0; i < 5; i++) f.advanceTime(); return f.assemble(input); } });
  assert.equal((await f.film.getPrepared({ email, id: job.id })).status, "awaiting-assembly");
});

test("claim is checked again after slow final media verification", async () => {
  const f = fixture(), job = await f.prepare(); await f.queue.enqueue({ actor, id: job.id, orderId });
  const path = productionQueuePath(email, job.id);
  for (let step = 0; step < 6; step++) { await f.queue.runTicket(path); f.advanceTime(); }
  const verifier = createFilmProductionService({ readRecordImpl: f.read, writeRecordImpl: f.write,
    verifyAssembledMedia: async ({ artifact }) => { for (let i = 0; i < 5; i++) f.advanceTime(); return artifact; } });
  const queue = createProductionQueue({ ...f.dependencies, film: verifier });
  await queue.runTicket(path, { assemble: f.assemble });
  assert.equal((await f.film.getPrepared({ email, id: job.id })).status, "awaiting-assembly");
});

test("owned claims renew during long assembly without permitting a second worker", async () => {
  const f = fixture(), job = await f.prepare(); await f.queue.enqueue({ actor, id: job.id, orderId });
  const path = productionQueuePath(email, job.id);
  for (let step = 0; step < 6; step++) { await f.queue.runTicket(path); f.advanceTime(); }
  let heartbeat, cleared = 0;
  const queue = createProductionQueue({ ...f.dependencies, setIntervalImpl: callback => { heartbeat = callback; return 1; }, clearIntervalImpl: () => { cleared++; } });
  await queue.runTicket(path, { assemble: async input => {
    for (let i = 0; i < 10; i++) { f.advanceTime(); await heartbeat(); assert.deepEqual(await f.queue.runTicket(path), { state: "skipped" }); }
    return f.assemble(input);
  } });
  assert.equal((await f.film.getPrepared({ email, id: job.id })).status, "completed"); assert.ok(cleared > 0);
});
