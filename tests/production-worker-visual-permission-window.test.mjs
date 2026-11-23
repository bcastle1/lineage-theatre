import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { fixture } from './fixtures/visual-review-recovery.mjs';

function setup() {
  const h = fixture(), secret = 'a'.repeat(64), calls = [], hooks = {};
  h.mutate(h.queuePath, value => { value.state = 'pending'; value.lease = { token: 'owned-lease', expiresAt: h.now() + 600000 }; });
  let reviews = 0;
  const handler = createProductionWorkerHandler({ env: { LINEAGE_WORKER_SECRET: secret }, read: h.read, now: h.now, limiter: async () => true,
    paymentService: { authorizeProduction: async input => {
      calls.push(input); await hooks.permission?.(calls.length);
      return { allowed: true, environment: 'production', manifestHash: h.input.manifestHash,
        expiresAt: new Date(h.now() + (hooks.duration?.(calls.length) ?? 60000)).toISOString(), ...hooks.fields };
    } },
    visualReviewFactory: ({ authorize }) => async input => {
      reviews++; await hooks.review?.();
      if (!await authorize(input)) throw Object.assign(Error('No current permission'), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
      return { passed: true };
    } });
  const invoke = async () => {
    const result = { statusCode: 200, setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: {
      action: 'review-film-visuals', workerProtocol: 2, email: h.email, preparedId: h.input.id,
      manifestHash: h.input.manifestHash, shotId: h.job.shots[0].id, frames: [{}, {}, {}] } }, result);
    return result;
  };
  return { h, calls, hooks, invoke, reviews: () => reviews };
}

test('a short exact payment grant is refreshed once without extending either proof deadline', async () => {
  const f = setup(); f.hooks.duration = count => count === 1 ? 4000 : 60000;
  assert.equal((await f.invoke()).statusCode, 200); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.reviews(), 1);
});

test('a cached grant nearing its own deadline is refreshed before the next review authorization', async () => {
  const f = setup(); f.hooks.duration = count => count === 1 ? 6000 : 60000;
  f.hooks.review = () => f.h.advance(1001);
  assert.equal((await f.invoke()).statusCode, 200); assert.equal(f.calls.length, 2);
});

test('persistently short, expired, denied, foreign or malformed grants stop before any review', async () => {
  for (const scenario of ['short', 'expired', 'denied', 'manifest', 'environment', 'invalid-time']) {
    const f = setup();
    if (scenario === 'short') f.hooks.duration = () => 4000;
    if (scenario === 'expired') f.hooks.duration = () => 0;
    if (scenario === 'denied') f.hooks.fields = { allowed: false };
    if (scenario === 'manifest') f.hooks.fields = { manifestHash: digest('foreign manifest') };
    if (scenario === 'environment') f.hooks.fields = { environment: 'sandbox' };
    if (scenario === 'invalid-time') f.hooks.fields = { expiresAt: 'invalid' };
    assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.reviews(), 0);
    assert.equal(f.calls.length, scenario === 'short' ? 2 : 1);
  }
});

test('a changed or revoked queue claim during grant refresh prevents using the new permission', async () => {
  for (const change of [
    value => { value.lease.token = 'new-owner'; }, value => { delete value.lease; },
    value => { value.lease.expiresAt = 0; }, value => { value.state = 'attention'; },
    value => { value.orderId = digest('different order'); },
  ]) {
    const f = setup(); f.hooks.duration = count => count === 1 ? 4000 : 60000;
    f.hooks.permission = count => { if (count === 2) f.h.mutate(f.h.queuePath, change); };
    assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.calls.length, 2); assert.equal(f.reviews(), 0);
  }
});
