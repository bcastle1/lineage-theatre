import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { preclaimFixture, sha } from './fixtures/visual-preclaim-resume.mjs';

const secret = 'a'.repeat(64);
async function routeFixture() {
  const h = await preclaimFixture(), calls = [], limits = [], hooks = {}, readPaths = []; let reads = 0;
  const permission = { allowed: true, environment: 'production', manifestHash: h.resumeInput.manifestHash,
    budgetCents: 3000, quoteReference: digest('fictional quote'), expiresAt: new Date(h.now() + 60000).toISOString() };
  const handler = createProductionWorkerHandler({ env: { LINEAGE_WORKER_SECRET: secret }, now: h.now,
    read: async path => { reads++; readPaths.push(path); return h.read(path); }, list: h.listBlobs,
    limiter: async (...args) => { limits.push(args); return hooks.limit !== false; },
    paymentService: { authorizeProduction: async input => { calls.push(input); await hooks.authorize?.(); return structuredClone(permission); } },
    visualReviewFactory: () => assert.fail('Plan authorization cannot infer'),
    startFrameReviewFactory: () => assert.fail('Plan authorization cannot generate'),
    delivery: { deliver: () => assert.fail('Plan authorization cannot deliver') } });
  const body = { action: 'authorize-visual-review-preclaim-resume', workerProtocol: 2, resumePlan: h.resumeInput };
  const invoke = async (change = {}) => {
    const result = { statusCode: 200, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body, ...change }, result);
    return result;
  };
  return { h, calls, limits, permission, body, invoke, hooks, readPaths, reads: () => reads };
}

test('preclaim authorization binds the entire stopped attempt without writes, leases, inference or new video requests', async () => {
  const f = await routeFixture(), before = structuredClone([...f.h.records]);
  const result = await f.invoke();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ...f.permission, recoveryRequestHash: sha(f.h.resumeInput) });
  assert.deepEqual(f.calls, [{ email: f.h.email, preparedId: f.h.job.id, manifestHash: f.h.job.manifestHash, orderId: f.h.order.id }]);
  assert.deepEqual(f.limits, [['production-worker:visual-review-preclaim-resume', 10, 60000]]);
  assert.deepEqual([...f.h.records], before); assert.deepEqual(f.h.writes, []);
  assert.equal(f.h.value(f.h.queuePath).state, 'attention');
  assert.ok(f.h.lists.some(value => value.prefix === f.h.bindingPrefix));
});

test('invalid callers, expanded or malformed requests and rate limits stop before private reads or payment calls', async () => {
  for (const change of [
    f => ({ headers: { authorization: 'Bearer wrong' } }),
    f => ({ body: { ...f.body, workerProtocol: 1 } }),
    f => ({ body: { ...f.body, apply: true } }),
    f => ({ body: { ...f.body, resumePlan: null } }),
    f => ({ body: { ...f.body, resumePlan: { ...f.h.resumeInput, orderId: f.h.order.id } } }),
    f => ({ body: { ...f.body, resumePlan: { ...f.h.resumeInput, email: '../bad' } } }),
    f => ({ body: { ...f.body, resumePlan: { ...f.h.resumeInput, id: '../bad' } } }),
    f => ({ body: { ...f.body, resumePlan: { ...f.h.resumeInput, queueHash: 'not a digest' } } }),
  ]) {
    const f = await routeFixture(), result = await f.invoke(change(f));
    assert.ok([400, 401].includes(result.statusCode)); assert.equal(f.reads(), 0); assert.equal(f.calls.length, 0);
  }
  const f = await routeFixture(); f.hooks.limit = false;
  assert.equal((await f.invoke()).statusCode, 429); assert.equal(f.reads(), 0); assert.equal(f.calls.length, 0);
});

test('stale bindings, changed owner or payment, an active lease and any recovered claim deny permission', async () => {
  for (const change of [
    f => { f.body.resumePlan = { ...f.h.resumeInput, recoveryGrantHash: digest('foreign grant') }; },
    f => { f.body.resumePlan = { ...f.h.resumeInput, jobHash: digest('foreign job') }; },
    f => { f.body.resumePlan = { ...f.h.resumeInput, queueHash: digest('foreign queue') }; },
    f => f.h.mutate(userPath(f.h.email), value => { value.role = 'customer'; }),
    f => f.h.mutate(userPath(f.h.email), value => { value.status = 'suspended'; }),
    f => f.h.mutate(f.h.orderPath, value => { value.refundedCents = 1; }),
    f => f.h.mutate(f.h.queuePath, value => { value.lease = { token: 'other worker', expiresAt: f.h.now() + 1000 }; }),
    f => f.h.mutate(f.h.jobPath, value => { value.shots[3].output.sha256 = digest('different clip'); }),
    f => f.h.seed(`${f.h.bindingPrefix}pre-assembly-overlays-v2/${digest('shot-001')}.json`, { state: 'claimed' }),
    f => f.h.seed(`production/visual-reviews/${f.h.job.ownerHash}/${f.h.job.id}/${digest('other review')}.json`, { state: 'submitting' }),
  ]) {
    const f = await routeFixture(); change(f);
    assert.ok([409, 503].includes((await f.invoke()).statusCode)); assert.equal(f.calls.length, 0); assert.deepEqual(f.h.writes, []);
  }
});

test('permission expiry or state changes during live authorization fail closed before returning a grant', async () => {
  for (const change of [
    f => { f.permission.allowed = false; },
    f => { f.permission.environment = 'sandbox'; },
    f => { f.permission.manifestHash = digest('different manifest'); },
    f => { f.permission.expiresAt = 'invalid date'; },
    f => { f.h.advance(60001); },
    f => f.h.mutate(f.h.orderPath, value => { value.refundedCents = 1; }),
    f => f.h.mutate(userPath(f.h.email), value => { value.status = 'suspended'; }),
    f => f.h.mutate(f.h.jobPath, value => { value.updatedAt = new Date(f.h.now() + 1).toISOString(); }),
    f => f.h.mutate(f.h.queuePath, value => { value.orderId = digest('different order'); }),
    f => f.h.seed(`${f.h.bindingPrefix}pre-assembly-overlays-v2/${digest('shot-001')}.json`, { state: 'claimed' }),
  ]) {
    const f = await routeFixture(); f.hooks.authorize = () => change(f);
    assert.ok([409, 503].includes((await f.invoke()).statusCode)); assert.equal(f.calls.length, 1); assert.deepEqual(f.h.writes, []);
  }
});

test('a completed resume cannot obtain another permission even after the queue later stops again', async () => {
  const f = await routeFixture(); await f.h.resume(); f.h.writes.length = 0;
  const before = structuredClone([...f.h.records]);
  assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.calls.length, 0);
  assert.deepEqual([...f.h.records], before); assert.deepEqual(f.h.writes, []);
  f.h.mutate(f.h.queuePath, value => { value.state = 'attention'; value.lastResult = 'REVIEW_REQUIRED'; });
  assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.calls.length, 0); assert.deepEqual(f.h.writes, []);
});

test('the exact partial job update can renew permission before queue release, while unrelated modifications fail closed', async () => {
  const f = await routeFixture();
  f.h.hooks.beforeWrite = path => { if (path === f.h.queuePath) throw Error('Synthetic unavailable queue write'); };
  await assert.rejects(f.h.resume());
  assert.ok(f.h.value(f.h.resumePath)); assert.ok(f.h.value(f.h.jobPath).visualReviewPreclaimResumeHash);
  assert.notEqual(sha(f.h.value(f.h.jobPath)), f.h.resumeInput.jobHash);
  assert.equal(sha(f.h.value(f.h.queuePath)), f.h.resumeInput.queueHash);
  const before = structuredClone([...f.h.records]), writes = structuredClone(f.h.writes);
  assert.equal((await f.invoke()).statusCode, 200); assert.equal(f.calls.length, 1);
  assert.deepEqual([...f.h.records], before); assert.deepEqual(f.h.writes, writes);
  f.h.mutate(f.h.jobPath, value => { value.updatedAt = new Date(f.h.now() + 1).toISOString(); });
  assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.calls.length, 1); assert.deepEqual(f.h.writes, writes);
});

test('after live permission every unique validated record and exact claim-list page is freshly checked once', async () => {
  const f = await routeFixture(); let initialReads, initialLists;
  f.hooks.authorize = () => { initialReads = [...f.readPaths]; initialLists = structuredClone(f.h.lists); };
  const before = structuredClone([...f.h.records]), result = await f.invoke();
  assert.equal(result.statusCode, 200); assert.equal(result.body.expiresAt, f.permission.expiresAt);
  assert.ok(initialReads.length > new Set(initialReads).size, 'the original full validation includes repeated graph reads');
  assert.deepEqual([...f.readPaths.slice(initialReads.length)].sort(), [...new Set(initialReads)].sort());
  assert.equal(initialLists.length, 3);
  assert.deepEqual(f.h.lists.slice(initialLists.length), initialLists);
  assert.ok(initialReads.includes(f.h.jobPath)); assert.ok(initialReads.includes(f.h.queuePath));
  assert.ok(initialReads.includes(f.h.resumePath)); assert.ok(initialReads.includes(f.h.orderPath));
  assert.deepEqual([...f.h.records], before); assert.deepEqual(f.h.writes, []);
});

test('an identical value with a new ETag or a newly listed unrecognized claim invalidates the snapshot', async () => {
  for (const change of [
    f => f.h.seed(f.h.orderPath, f.h.value(f.h.orderPath)),
    f => f.h.seed(`${f.h.bindingPrefix}unknown-policy/${digest('new claim')}.json`, { claimed: true }),
  ]) {
    const f = await routeFixture(); f.hooks.authorize = () => change(f);
    assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.calls.length, 1); assert.deepEqual(f.h.writes, []);
  }
});

test('authorization that expires during fresh evidence rechecks cannot leave the route', async () => {
  const f = await routeFixture(); let advanced = false;
  f.h.hooks.beforeRead = () => {
    if (f.calls.length === 1 && !advanced) { advanced = true; f.h.advance(60001); }
  };
  assert.equal((await f.invoke()).statusCode, 409); assert.equal(advanced, true);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.h.writes, []);
});
