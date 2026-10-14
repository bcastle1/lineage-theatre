import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMagicLightActivationStatus, MAGICLIGHT_ACTIVATION_TEST_PATH as PATH } from '../api/_lib/magiclight-activation-status.mjs';
import { MAGICLIGHT_LIVE_TEST_PATH as ORIGINAL, MAGICLIGHT_LIVE_TEST_FIXTURE as FIXTURE } from '../api/_lib/magiclight-live-test.mjs';
import { userPath, digest } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';

const owner = { email: OWNER_EMAIL, role: 'owner', status: 'active' };
const key = 'synthetic-activation-test-key';
const taskId = 'saved-october-8-task';
const now = '2026-10-14T18:00:00.000Z';
function fixture({ missing = false, patch = {}, response = { providerCode: 10000, taskStatus: 1 } } = {}) {
  const records = new Map([
    [userPath(owner.email), { value: owner, etag: 'owner-1' }],
    [ORIGINAL, { value: { untouched: true }, etag: 'operator-1' }],
    ['payments/orders/customer.json', { value: { status: 'captured', amountCents: 378 }, etag: 'payment-1' }],
  ]);
  if (!missing) records.set(PATH, { etag: 'test-1', value: {
    version: 1, id: randomUUID(), changeId: randomUUID(), ownerEmail: owner.email,
    fixtureHash: FIXTURE.hash, keyFingerprint: digest(key), origin: 'https://open.magiclight.ai',
    submissionCount: 1, status: 'submitted', taskId, providerCode: 10000,
    createdAt: '2026-10-08T22:45:52.309Z', updatedAt: '2026-10-08T23:45:30.895Z', ...patch,
  } });
  const initial = structuredClone(records), checks = [], writes = [], configurations = [];
  const env = { MAGICLIGHT_API_KEY: key };
  const service = createMagicLightActivationStatus({ env, now: () => Date.parse(now),
    read: async path => structuredClone(records.get(path) || null),
    write: async (path, value, etag) => {
      assert.equal(path, PATH); assert.equal(records.get(path)?.etag, etag);
      writes.push(path); records.set(path, { value: structuredClone(value), etag: `update-${writes.length}` });
    },
    clientFactory: config => {
      configurations.push(config); assert.equal(config.enableSubmission, false);
      return {
        submitTask: async () => assert.fail('A status check must never submit a task'),
        checkTask: async input => { checks.push(input); return response; },
      };
    },
  });
  return { service, records, initial, checks, writes, configurations, env };
}

test('activation polling checks only the existing October 8 task and cannot change payments or the operator test', async () => {
  const h = fixture();
  assert.deepEqual(Object.keys(h.service).sort(), ['check', 'status']);
  assert.equal((await h.service.status(owner)).test.status, 'submitted');
  assert.equal(h.configurations.length, 0);
  const result = await h.service.check(owner);
  assert.deepEqual(h.checks, [{ taskId }]);
  assert.deepEqual(h.writes, [PATH]);
  assert.equal(result.test.checkedAt, now);
  assert.equal(result.test.finishedVideoAvailable, false);
  assert.equal(result.test.taskStatus, 1);
  assert.equal(result.generationSubmitted, false);
  assert.equal(result.productionReady, false);
  for (const [path, value] of h.initial) if (path !== PATH) assert.deepEqual(h.records.get(path), value);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-activation|saved-october|keyFingerprint|taskId|videoUrl/);
});

test('completed and failed results preserve terminal evidence without exposing a private output URL', async () => {
  for (const taskStatus of [2, 3]) {
    const h = fixture({ response: { providerCode: 10000, taskStatus, taskId,
      ...(taskStatus === 2 ? { videoUrl: 'https://cdn.example.com/private.mp4?signature=secret-output' } : {}) } });
    const result = await h.service.check(owner);
    assert.equal(result.test.status, taskStatus === 2 ? 'completed' : 'failed');
    assert.equal(result.test.finishedVideoAvailable, taskStatus === 2);
    assert.doesNotMatch(JSON.stringify(result), /cdn\.example|private\.mp4|secret-output/);
    await h.service.check(owner);
    assert.equal(h.checks.length, 1);
  }
});

test('missing or unconfirmed saved task cannot create a job or contact the provider', async () => {
  for (const options of [{ missing: true }, { patch: { status: 'uncertain', taskId: undefined } }]) {
    const h = fixture(options);
    await h.service.check(owner);
    assert.equal(h.checks.length, 0); assert.equal(h.configurations.length, 0);
    assert.equal(h.writes.length, 0); assert.deepEqual(h.records, h.initial);
  }
});

test('owner revocation and a changed key or record binding block polling', async () => {
  for (const change of [h => { h.env.MAGICLIGHT_API_KEY = 'rotated-key'; },
    h => { h.records.get(PATH).value.fixtureHash = 'f'.repeat(64); },
    h => { h.records.set(userPath(owner.email), { value: { ...owner, status: 'suspended' }, etag: 'revoked' }); }]) {
    const h = fixture(); change(h);
    await assert.rejects(h.service.check(owner));
    assert.equal(h.configurations.length, 0); assert.equal(h.writes.length, 0);
  }
});
