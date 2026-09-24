import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentReconcileHandler } from "../api/payment-reconcile.mjs";
import { createPaymentReconciliationService, createReconciliationTransport, RECONCILIATION_STATE_PATH } from "../api/_lib/payment-reconciliation.mjs";
import { userPath } from "../api/_lib/auth.mjs";

const NOW = Date.parse("2026-09-24T02:00:00Z"), SECRET = "synthetic-cron-secret-never-used-live";
const CUSTOMER = { email: "customer@example.invalid", role: "customer", status: "active", approvedAt: "2026-09-01T00:00:00Z", approvedBy: "erik@brocotech.ai" };
const idFor = number => number.toString(16).padStart(64, "0");
const order = (number, changes = {}) => ({ id: idFor(number), version: 1, provider: "quickbooks", checkoutMethod: "quickbooks-hosted-invoice",
  merchantBinding: { environment: "production", realmId: "1234", grantId: "a".repeat(64) }, status: "awaiting-payment", invoiceId: String(number), customerEmail: CUSTOMER.email, ...changes });
function fixture(orders = [order(1)], options = {}) {
  let serial = 0, time = NOW;
  const records = new Map(), checks = [], deliveries = [], pages = [];
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `etag-${++serial}` });
  seed(userPath(CUSTOMER.email), CUSTOMER);
  for (const value of orders) seed(`payments/orders/${value.id}.json`, value);
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    await options.beforeWrite?.(path, value);
    const previous = records.get(path);
    if (previous ? previous.etag !== etag : Boolean(etag)) throw Error("CAS conflict");
    seed(path, value);return read(path);
  };
  const page = async (prefix, input) => {
    pages.push({ prefix, ...input });
    const values = [...records.entries()].filter(([path]) => path.startsWith(prefix)).map(([, record]) => record.value).sort((a, b) => a.id.localeCompare(b.id));
    const offset = Number(input.cursor || 0), next = offset + input.limit;
    return { records: structuredClone(values.slice(offset, next)), ...(next < values.length ? { cursor: String(next) } : {}) };
  };
  const dependencies = { read, write, page, now: () => time,
    makeHosted: bounds => ({ check: async (actor, input) => {
      checks.push({ actor: structuredClone(actor), ...input, deadline: bounds.deadline });
      if (options.check) return options.check({ actor, input, records, seed, advance: ms => time += ms, bounds });
      const path = `payments/orders/${input.orderId}.json`, saved = (await read(path)).value;
      seed(path, { ...saved, status: "captured" });return { id: input.orderId, status: "captured" };
    } }),
    receipts: { deliver: async value => { deliveries.push(value);return { status: "accepted" }; } },
  };
  return { service: createPaymentReconciliationService(dependencies), peer: () => createPaymentReconciliationService(dependencies), records, checks, deliveries, pages, read, seed,
    advance: ms => time += ms };
}
async function invoke(handler, options = {}) {
  const { method = "GET" } = options, authorization = Object.hasOwn(options, "authorization") ? options.authorization : `Bearer ${SECRET}`;
  let code, body;const headers = {};
  await handler({ method, url: "/api/payment-reconcile", headers: { authorization } },
    { set statusCode(value) { code = value; }, setHeader(name, value) { headers[name] = value; }, end(value) { body = JSON.parse(value); } });
  return { code, body, headers };
}

test("cron requires an exact bearer secret and GET without any session or provider work", async () => {
  let calls = 0;const handler = createPaymentReconcileHandler({ env: { CRON_SECRET: SECRET }, service: { run: async () => { calls++;return { status: "completed" }; } } });
  for (const authorization of [undefined, "", SECRET, "Bearer incorrect", `bearer ${SECRET}`, `Bearer ${SECRET} `, [SECRET]])
    assert.equal((await invoke(handler, { authorization })).code, 401);
  for (const method of ["POST", "PUT", "HEAD", "DELETE"]) assert.equal((await invoke(handler, { method })).code, 405);
  assert.equal(calls, 0);assert.equal((await invoke(handler)).code, 200);assert.equal(calls, 1);
  for (const secret of [undefined, "", "short", " ".repeat(40)]) {
    const disabled = createPaymentReconcileHandler({ env: { CRON_SECRET: secret }, service: { run: async () => { calls++; } } });
    assert.equal((await invoke(disabled)).code, 503);
  }
  assert.equal(calls, 1);
  const failed = createPaymentReconcileHandler({ env: { CRON_SECRET: SECRET }, service: { run: async () => { throw Error(`private-provider-data ${SECRET}`); } } });
  const failure = await invoke(failed);assert.equal(failure.code, 503);assert.doesNotMatch(JSON.stringify(failure), /private-provider-data|synthetic-cron/);
});

test("background checks use the persisted owning user and deliver only persisted captured orders", async () => {
  const h = fixture([order(1), order(2, { status: "captured" }), order(3, { status: "uncertain" })]);
  const result = await h.service.run();
  assert.equal(result.examined, 3);assert.equal(result.checked, 2);assert.equal(result.receiptsAccepted, 3);
  assert.deepEqual(h.checks.map(value => value.orderId), [idFor(1), idFor(3)]);
  assert.ok(h.checks.every(value => value.actor.email === CUSTOMER.email && value.actor.role === "customer"));
  assert.deepEqual(h.deliveries, [1, 2, 3].map(number => ({ id: idFor(number) })));
  assert.equal(h.records.get(RECONCILIATION_STATE_PATH).value.lease, null);
  assert.doesNotMatch(JSON.stringify(result), /customer|invoiceId|realmId|cursor|grantId/);
  const unpersisted = fixture([order(1)], { check: async () => ({ id: idFor(1), status: "captured" }) });
  assert.equal((await unpersisted.service.run()).checked, 1);assert.equal(unpersisted.deliveries.length, 0);
});

test("legacy, sandbox, unknown invoices and unapproved users never enter background provider work", async () => {
  for (const change of [{ checkoutMethod: "legacy-direct-card" }, { merchantBinding: { environment: "sandbox" } }, { invoiceId: null }, { provider: "other" }, { version: 9 }]) {
    const h = fixture([order(1, change)]);assert.equal((await h.service.run()).skipped, 1);assert.equal(h.checks.length + h.deliveries.length, 0);
  }
  for (const user of [null, { ...CUSTOMER, status: "suspended" }, { ...CUSTOMER, status: "pending" }, { ...CUSTOMER, approvedAt: undefined }, { ...CUSTOMER, mustChangePassword: true }]) {
    const h = fixture();if (user) h.seed(userPath(CUSTOMER.email), user);else h.records.delete(userPath(CUSTOMER.email));
    assert.equal((await h.service.run()).skipped, 1);assert.equal(h.checks.length + h.deliveries.length, 0);
  }
});

test("saved cursor and remaining IDs advance across bounded runs without starving later invoices", async () => {
  const h = fixture(Array.from({ length: 25 }, (_, index) => order(index + 1)), { check: async ({ input }) => {
    if (input.orderId === idFor(1)) throw Error("synthetic provider failure");return { status: "awaiting-payment" };
  } });
  for (let run = 0; run < 9; run++) {
    const result = await h.service.run();assert.ok(result.examined <= 3);
  }
  assert.deepEqual(h.checks.map(value => value.orderId), Array.from({ length: 25 }, (_, index) => idFor(index + 1)));
  assert.deepEqual(h.pages.map(value => value.cursor), [undefined, "20"]);
  assert.ok(h.pages.every(value => value.limit === 20 && value.prefix === "payments/orders/"));
  assert.deepEqual(h.records.get(RECONCILIATION_STATE_PATH).value.pendingIds, []);
  await h.service.run();assert.equal(h.checks[25].orderId, idFor(1));
});

test("runtime reserve stops new work and leaves the next invoice saved for a later run", async () => {
  const h = fixture([order(1), order(2), order(3)], { check: async ({ advance }) => { advance(65_000);return { status: "awaiting-payment" }; } });
  const first = await h.service.run();assert.equal(first.examined, 1);assert.equal(first.hasMore, true);
  assert.deepEqual(h.records.get(RECONCILIATION_STATE_PATH).value.pendingIds, [idFor(2), idFor(3)]);
  await h.service.run();assert.equal(h.checks[1].orderId, idFor(2));
});

test("a CAS lease prevents overlapping runs and expired work cannot send or release a replacement lease", async () => {
  let started, release;const beginning = new Promise(resolve => started = resolve), blocked = new Promise(resolve => release = resolve);
  const h = fixture([order(1)], { check: async () => { started();await blocked;return { status: "awaiting-payment" }; } });
  const first = h.service.run();await beginning;
  assert.equal((await h.peer().run()).status, "locked");assert.equal(h.checks.length, 1);release();await first;
  const stale = fixture([order(1)], { check: async ({ seed, records, input }) => {
    const path = `payments/orders/${input.orderId}.json`;seed(path, { ...records.get(path).value, status: "captured" });
    seed(RECONCILIATION_STATE_PATH, { version: 1, cursor: null, pendingIds: [], lease: { token: "replacement", expiresAt: NOW + 500_000 } });
  } });
  assert.equal((await stale.service.run()).failed, 1);assert.equal(stale.deliveries.length, 0);
  assert.equal(stale.records.get(RECONCILIATION_STATE_PATH).value.lease.token, "replacement");
  const expired = fixture();expired.seed(RECONCILIATION_STATE_PATH, { version: 1, cursor: null, pendingIds: [], lease: { token: "expired", expiresAt: NOW - 1 } });
  assert.equal((await expired.service.run()).checked, 1);
});

test("lost claims and revoked customer approval cannot cause receipt delivery", async () => {
  const failed = fixture([order(1)], { beforeWrite: async path => { if (path === RECONCILIATION_STATE_PATH) throw Error("storage failure"); } });
  assert.equal((await failed.service.run()).status, "locked");assert.equal(failed.checks.length + failed.deliveries.length, 0);
  const revoked = fixture([order(1)], { check: async ({ records, seed, input }) => {
    const path = `payments/orders/${input.orderId}.json`;seed(path, { ...records.get(path).value, status: "captured" });
    seed(userPath(CUSTOMER.email), { ...CUSTOMER, status: "suspended" });
  } });
  assert.equal((await revoked.service.run()).skipped, 1);assert.equal(revoked.deliveries.length, 0);
});

test("bounded accounting transport permits only six invoice/payment reads under a live lease and deadline", async () => {
  let calls = 0, time = NOW, owned = true;
  const transport = createReconciliationTransport({ deadline: NOW + 25_000, now: () => time, stillOwned: async () => owned,
    transport: { binding: async () => ({ environment: "production" }), request: async () => { calls++;return new Response("{}"); } } });
  for (const operation of [{ method: "POST", path: "/invoice" }, { method: "GET", path: "/query" }, { method: "POST", path: "/invoice/1/send" }, { method: "GET", path: "/invoice/../preferences" }])
    await assert.rejects(() => transport.request({}, operation));
  for (let index = 0; index < 6; index++) await transport.request({}, { method: "GET", path: index ? "/payment/2" : "/invoice/1" });
  await assert.rejects(() => transport.request({}, { method: "GET", path: "/payment/3" }));assert.equal(calls, 6);
  owned = false;await assert.rejects(() => transport.binding({ allowRefresh: true }));
  owned = true;time += 25_001;await assert.rejects(() => transport.binding({ allowRefresh: true }));
});
