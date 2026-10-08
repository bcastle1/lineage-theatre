import test from "node:test";
import assert from "node:assert/strict";
import { createAutomaticProduction, automaticProductionPath } from "../api/_lib/automatic-production.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";

const NOW = Date.parse("2026-10-08T12:00:00Z"), id = "a".repeat(64);
const email = "customer@example.invalid", preparedId = "10000000-1111-4222-8333-444444444444";
const filmId = "20000000-1111-4222-8333-444444444444";
function fixture() {
  const records = new Map(), calls = [], queueIds = new Set(); let serial = 0, fail = false;
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: String(++serial) });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (records.get(path)?.etag !== etag) throw Error("precondition");
    seed(path, value); return read(path);
  };
  const actor = { email, role: "customer", status: "active", approvedAt: new Date(NOW).toISOString(), approvedBy: "owner@example.invalid" };
  const manifest = { filmId, title: "SAMPLE ONLY" }, manifestHash = digest(JSON.stringify(manifest));
  const order = { id, version: 1, provider: "quickbooks", checkoutMethod: "quickbooks-hosted-invoice", status: "captured", sandbox: false,
    merchantBinding: { environment: "production" }, confirmationSource: "quickbooks-accounting", productionConsent: true,
    productionConsentAt: new Date(NOW).toISOString(), capturedAt: new Date(NOW).toISOString(), refundedCents: 0,
    customerEmail: email, preparedId, manifestHash, filmId };
  seed(userPath(email), actor); seed(`payments/orders/${id}.json`, order);
  seed(`production/jobs/${digest(email)}/${preparedId}.json`, { id: preparedId, filmId, ownerHash: digest(email), manifest, manifestHash });
  const dependencies = { read, write, now: () => NOW,
    listBlobs: async ({ prefix }) => ({ blobs: [...records.keys()].filter(p => p.startsWith(prefix)).slice(0, 1).map(pathname => ({ pathname })), hasMore: false }),
    queue: { enqueue: async input => { if (fail) throw Error("provider unavailable"); calls.push(input); queueIds.add(`${input.actor.email}:${input.id}`); } } };
  return { service: createAutomaticProduction(dependencies), peer: () => createAutomaticProduction(dependencies), seed, read, records, calls, queueIds, order, actor,
    failQueue: value => { fail = value; } };
}

test("confirmed consenting customer payment is durable and queues without a browser", async () => {
  const f = fixture(); assert.deepEqual(await f.service.schedule({ id }), { state: "pending" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.peer().run(), { queued: 1, pending: 0, skipped: 0 });
  assert.deepEqual(f.calls[0], { actor: f.actor, id: preparedId, orderId: id });
  assert.equal((await f.read(automaticProductionPath(id))).value.state, "queued");
  await f.service.schedule({ id }); await f.service.run(); assert.equal(f.calls.length, 1);
});

test("unpaid, sandbox, refunded and legacy orders never become automatic starts", async () => {
  for (const change of [{ status: "awaiting-payment" }, { status: "uncertain" }, { sandbox: true }, { merchantBinding: { environment: "sandbox" } },
    { confirmationSource: "browser-return" }, { productionConsent: false }, { productionConsentAt: undefined }, { refundedCents: 1 },
    { refunds: [{ amountCents: 1 }] }, { refundOperation: {} }, { capturedAt: "invalid" }, { preparedId: "bad" }]) {
    const f = fixture(); f.seed(`payments/orders/${id}.json`, { ...f.order, ...change });
    assert.deepEqual(await f.service.schedule({ id }), { state: "skipped" }); assert.equal(f.calls.length, 0);
    assert.equal(await f.read(automaticProductionPath(id)), null);
  }
});

test("account and paid-manifest changes block queued work before any dispatch", async () => {
  for (const change of [{ status: "suspended" }, { mustChangePassword: true }, { approvedAt: undefined }]) {
    const f = fixture(); await f.service.schedule({ id }); f.seed(userPath(email), { ...f.actor, ...change });
    await f.service.run(); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await f.service.schedule({ id });
  const path = `production/jobs/${digest(email)}/${preparedId}.json`, job = (await f.read(path)).value;
  f.seed(path, { ...job, manifest: { ...job.manifest, title: "Changed after payment" } });
  await f.service.run(); assert.equal(f.calls.length, 0);
});

test("provider failure preserves pending intent and recovers on a later server run", async () => {
  const f = fixture(); await f.service.schedule({ id }); f.failQueue(true);
  assert.deepEqual(await f.service.run(), { queued: 0, pending: 1, skipped: 0 });
  assert.equal((await f.read(automaticProductionPath(id))).value.state, "pending");
  f.failQueue(false); assert.equal((await f.peer().run()).queued, 1); assert.equal(f.queueIds.size, 1);
});

test("racing scheduling and workers keep the existing queue's single film identity", async () => {
  const f = fixture(); await Promise.all([f.service.schedule({ id }), f.peer().schedule({ id })]);
  await Promise.all([f.service.run(), f.peer().run()]);
  assert.equal(f.queueIds.size, 1); assert.equal((await f.read(automaticProductionPath(id))).value.state, "queued");
});
