import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteVisualRecoveryAuthorization } from '../api/_lib/remote-visual-recovery-authorization.mjs';

test('paused recovery requests only the fixed web authorization route and exact reviewed plan', async () => {
  const recoveryPlan = { id: 'fictional-reference', shots: [] }, calls = [];
  const authorize = createRemoteVisualRecoveryAuthorization({ env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{"allowed":true}'); } });
  assert.deepEqual(await authorize({ recoveryPlan, orderId: 'not-forwarded' }), { allowed: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://lineagetheater.com/api/production-worker');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'authorize-visual-review-recovery', workerProtocol: 2, recoveryPlan });
  assert.doesNotMatch(calls[0].options.body, /aaaa|not-forwarded/);
});
test('invalid credentials or missing plan cannot send a recovery authorization request', async () => {
  let calls = 0;
  for (const [env, input] of [[{}, { recoveryPlan: {} }], [{ LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, {}]]) {
    await assert.rejects(createRemoteVisualRecoveryAuthorization({ env, fetchImpl: async () => { calls++; } })(input));
  }
  assert.equal(calls, 0);
});
test('rejected, malformed and oversized authorization replies stop without retry or private error text', async () => {
  for (const response of [() => new Response('private details', { status: 409 }), () => new Response('not json'),
    () => new Response('x'.repeat(4097))]) {
    let calls = 0;
    const authorize = createRemoteVisualRecoveryAuthorization({ env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) },
      fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(authorize({ recoveryPlan: {} }), error => !error.message.includes('private details'));
    assert.equal(calls, 1);
  }
});
