import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { fixture, correctionFor } from './fixtures/visual-review-recovery.mjs';

const secret = 'a'.repeat(64);
const hash = value => digest(JSON.stringify(value));
function routeFixture() {
  const h = fixture(), calls = [], limits = [], hooks = {}; let reads = 0;
  h.input.textCorrections = [correctionFor(h)];
  const permission = { allowed: true, environment: 'production', manifestHash: h.input.manifestHash,
    budgetCents: 3000, quoteReference: digest('fictional quote'), expiresAt: new Date(h.now() + 60000).toISOString() };
  const handler = createProductionWorkerHandler({ env: { LINEAGE_WORKER_SECRET: secret }, now: h.now,
    read: async path => { reads++; return h.read(path); },
    limiter: async (...args) => { limits.push(args); return hooks.limit !== false; },
    paymentService: { authorizeProduction: async input => { calls.push(input); await hooks.authorize?.(); return structuredClone(permission); } },
    visualReviewFactory: () => assert.fail('Recovery authorization must not infer'),
    startFrameReviewFactory: () => assert.fail('Recovery authorization must not render'),
    delivery: { deliver: () => assert.fail('Recovery authorization must not deliver') } });
  const body = { action: 'authorize-visual-review-recovery', workerProtocol: 2, recoveryPlan: h.input };
  const invoke = async (change = {}) => {
    const result = { statusCode: 200, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body, ...change }, result);
    return result;
  };
  return { h, calls, limits, permission, body, invoke, hooks, reads: () => reads };
}

test('attention-only recovery authorization binds the complete unchanged plan and does not write, lease, render or infer', async () => {
  const f = routeFixture(), before = structuredClone([...f.h.records]);
  const result = await f.invoke();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ...f.permission, recoveryRequestHash: hash(f.body.recoveryPlan) });
  assert.deepEqual(f.calls, [{ email: f.h.email, preparedId: f.h.input.id, manifestHash: f.h.input.manifestHash, orderId: f.h.order.id }]);
  assert.deepEqual(f.limits, [['production-worker:visual-review-recovery', 10, 60000]]);
  assert.deepEqual([...f.h.records], before); assert.deepEqual(f.h.writes, []);
  const repeats = await Promise.all([f.invoke(), f.invoke()]);
  assert.ok(repeats.every(value => value.statusCode === 200 && value.body.recoveryRequestHash === result.body.recoveryRequestHash));
  assert.deepEqual([...f.h.records], before);
});

test('worker identity, exact bounded body and recovery limiter reject before private state or payment authorization', async () => {
  for (const change of [
    f => ({ headers: { authorization: 'Bearer wrong' } }),
    f => ({ body: { ...f.body, workerProtocol: 1 } }),
    f => ({ body: { ...f.body, apply: true } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.h.input, orderId: f.h.order.id } } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.h.input, email: '../bad' } } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.h.input, id: '../bad' } } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.h.input, shots: [f.h.input.shots[0], f.h.input.shots[0]] } } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.h.input, shots: [{ ...f.h.input.shots[0], extra: 'no' }] } } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.h.input, shots: Array(201).fill(f.h.input.shots[0]) } } }),
  ]) {
    const f = routeFixture(), result = await f.invoke(change(f));
    assert.ok([400, 401].includes(result.statusCode)); assert.equal(f.reads(), 0); assert.equal(f.calls.length, 0);
  }
  const f = routeFixture(); f.hooks.limit = false;
  assert.equal((await f.invoke()).statusCode, 429); assert.equal(f.reads(), 0); assert.equal(f.calls.length, 0);
});

test('only the owner with intact payment and exact rejected completed clips can obtain recovery permission', async () => {
  const changes = [
    h => h.mutate(userPath(h.email), value => { value.role = 'customer'; }),
    h => h.mutate(userPath(h.email), value => { value.status = 'suspended'; }),
    h => h.mutate(userPath(h.email), value => { value.mustChangePassword = true; }),
    h => h.mutate(h.orderPath, value => { value.refundedCents = 1; }),
    h => h.mutate(h.queuePath, value => { value.state = 'pending'; }),
    h => h.mutate(h.queuePath, value => { value.lease = { token: 'other worker', expiresAt: h.now() + 1000 }; }),
    h => h.mutate(h.jobPath, value => { value.lease = { token: 'other worker', expiresAt: h.now() + 1000 }; }),
    h => h.mutate(h.jobPath, value => { value.shots[3].output.sha256 = digest('changed output'); }),
    h => h.mutate(h.jobPath, value => { value.shots[3].status = 'processing'; }),
    h => h.mutate(h.jobPath, value => { value.media = { pathname: 'already delivered' }; }),
    h => h.mutate(h.receiptPath, value => { value.decision.cast = 'mismatch'; }),
    h => { h.input.textCorrections[0].text = 'Not in the saved scene'; },
  ];
  for (const change of changes) {
    const f = routeFixture(); change(f.h); const result = await f.invoke();
    assert.ok([409, 503].includes(result.statusCode)); assert.equal(f.calls.length, 0); assert.deepEqual(f.h.writes, []);
  }
  const resumed = routeFixture(); await resumed.h.apply();
  const before = structuredClone([...resumed.h.records]);
  assert.equal((await resumed.invoke()).statusCode, 409); assert.equal(resumed.calls.length, 0);
  assert.deepEqual([...resumed.h.records], before);
});

test('live permission and final revalidation fail closed on revocation, source or queue changes and expiry', async () => {
  for (const change of [
    f => { f.permission.allowed = false; },
    f => { f.permission.environment = 'sandbox'; },
    f => { f.permission.manifestHash = digest('wrong manifest'); },
    f => { f.permission.expiresAt = 'not a date'; },
    f => { f.h.advance(60001); },
    f => f.h.mutate(f.h.orderPath, value => { value.refundedCents = 1; }),
    f => f.h.mutate(userPath(f.h.email), value => { value.status = 'suspended'; }),
    f => f.h.mutate(f.h.jobPath, value => { value.shots[3].output.sha256 = digest('changed'); }),
    f => f.h.mutate(f.h.queuePath, value => { value.orderId = digest('foreign order'); }),
    f => f.h.mutate(f.h.queuePath, value => { value.state = 'pending'; }),
    f => f.h.mutate(f.h.queuePath, value => { value.lease = { token: 'new lease', expiresAt: f.h.now() + 1000 }; }),
  ]) {
    const f = routeFixture(); f.hooks.authorize = () => change(f);
    assert.ok([409, 503].includes((await f.invoke()).statusCode)); assert.equal(f.calls.length, 1); assert.deepEqual(f.h.writes, []);
  }
});

test('the exact partially saved grant and retrying job can renew permission while its queue is still attention', async () => {
  const f = routeFixture();
  f.h.hooks.beforeWrite = path => { if (path === f.h.queuePath) throw Error('Synthetic queue write unavailable'); };
  await assert.rejects(f.h.apply());
  assert.ok(f.h.value(f.h.grantPath)); assert.equal(f.h.value(f.h.jobPath).finishingFailure.state, 'retrying');
  assert.equal(f.h.value(f.h.queuePath).state, 'attention');
  assert.equal(f.h.value(f.h.queuePath).visualReviewRecoveryHash, undefined);
  const before = structuredClone([...f.h.records]), writes = structuredClone(f.h.writes);
  const result = await f.invoke();
  assert.equal(result.statusCode, 200); assert.equal(result.body.recoveryRequestHash, hash(f.h.input));
  assert.deepEqual([...f.h.records], before); assert.deepEqual(f.h.writes, writes);
});
