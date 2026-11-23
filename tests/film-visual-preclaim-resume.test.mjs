import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { VISUAL_RECOVERY_POLICY } from '../api/_lib/film-visual-review-recovery.mjs';
import { preclaimFixture, sha } from './fixtures/visual-preclaim-resume.mjs';

const snapshot = h => structuredClone([...h.records]);
const bindFailureHashes = h => {
  h.resumeInput.jobHash = sha(h.value(h.jobPath)); h.resumeInput.queueHash = sha(h.value(h.queuePath));
};

test('preclaim plan is read-only and applying writes one separate receipt plus exact job/queue controls', async () => {
  const h = await preclaimFixture(), before = snapshot(h), grant = h.value(h.grantPath), prior = h.value(h.receiptPath), job = h.value(h.jobPath);
  assert.equal((await h.resumeService(h.resumeInput)).status, 'planned');
  assert.equal(h.permissions.length, 0); assert.deepEqual(h.writes, []); assert.deepEqual(snapshot(h), before);
  const result = await h.resume(), receipt = h.value(h.resumePath), updated = h.value(h.jobPath), queue = h.value(h.queuePath);
  assert.equal(result.status, 'resumed'); assert.equal(result.additionalReviewAllowance, 0); assert.equal(result.maximumNewVideoRequests, 0);
  assert.deepEqual(h.writes.map(row => row.path), [h.resumePath, h.jobPath, h.queuePath]);
  assert.equal(h.writes[0].etag, undefined); assert.ok(h.writes[1].etag); assert.ok(h.writes[2].etag);
  assert.equal(receipt.requestHash, sha(h.resumeInput)); assert.equal(receipt.jobHash, sha(job));
  assert.equal(receipt.manifest, undefined); assert.equal(receipt.shots, undefined, 'do not duplicate private creative records');
  assert.equal(updated.visualReviewPreclaimResumeHash, sha(receipt)); assert.equal(queue.visualReviewPreclaimResumeHash, sha(receipt));
  assert.equal(queue.state, 'pending'); assert.equal(queue.attempts, 0); assert.equal(updated.finishingFailure.state, 'retrying');
  assert.deepEqual(updated.shots, job.shots); assert.deepEqual(updated.manifest, job.manifest); assert.deepEqual(updated.authorization, job.authorization);
  assert.deepEqual(h.value(h.grantPath), grant); assert.deepEqual(h.value(h.receiptPath), prior); assert.deepEqual(h.value(h.orderPath), h.order);
  assert.deepEqual(h.permissions, [{ email: h.email, preparedId: job.id, manifestHash: job.manifestHash,
    orderId: h.order.id, recoveryPlan: h.resumeInput }]);
});

test('any recovered binding, inference reservation or additional receipt blocks before authorization', async t => {
  for (const [name, path] of [
    ['binding index', h => `${h.bindingPrefix}${VISUAL_RECOVERY_POLICY}/${digest(h.job.shots[2].id)}.json`],
    ['unknown policy index', h => `${h.bindingPrefix}other-policy/claim.json`],
    ['v2 submitting receipt', h => `production/visual-reviews/${h.job.ownerHash}/${h.job.id}/${digest('uncertain inference')}.json`],
    ['operator inference reservation', h => `production/operator-canaries/${h.job.ownerHash}/${h.job.id}/visual-review-claims/${digest('reservation')}.json`],
  ]) await t.test(name, async () => {
    const h = await preclaimFixture(); h.seed(path(h), { version: 2, state: 'submitting' });
    await assert.rejects(h.resume(), { code: 'VISUAL_REVIEW_INVALID' });
    assert.equal(h.permissions.length, 0); assert.deepEqual(h.writes, []);
  });
  const h = await preclaimFixture();
  h.seed(`${h.bindingPrefix}${VISUAL_RECOVERY_POLICY}/${digest(h.job.shots[3].id)}.json`, { version: 1 });
  h.resumeHooks.list = options => options.prefix === h.bindingPrefix ? { blobs: [], hasMore: false } : undefined;
  await assert.rejects(h.resume(), { code: 'VISUAL_REVIEW_INVALID' });
  assert.equal(h.permissions.length, 0, 'direct known indexes also block a stale listing');
});

test('listing uncertainty, malformed pages and pagination loops fail closed', async t => {
  for (const [name, page] of [
    ['missing page', null], ['missing hasMore', { blobs: [] }], ['wrong prefix', { blobs: [{ pathname: 'another-owner/record' }], hasMore: false }],
    ['empty continuation', { blobs: [], hasMore: true, cursor: 'next' }],
    ['excessive page', { blobs: Array.from({ length: 33 }, (_, i) => ({ pathname: `PLACEHOLDER/${i}` })), hasMore: false }],
  ]) await t.test(name, async () => {
    const h = await preclaimFixture(); h.resumeHooks.list = options => page?.blobs?.[0]?.pathname?.startsWith('PLACEHOLDER')
      ? { ...page, blobs: page.blobs.map((_, i) => ({ pathname: `${options.prefix}${i}` })) } : page;
    await assert.rejects(h.resume()); assert.equal(h.permissions.length, 0); assert.deepEqual(h.writes, []);
  });
  const h = await preclaimFixture(); let page = 0;
  h.resumeHooks.list = options => ({ blobs: [{ pathname: `${options.prefix}${++page}` }], hasMore: true, cursor: 'repeat' });
  await assert.rejects(h.resume(), { code: 'VISUAL_REVIEW_INVALID' }); assert.deepEqual(h.writes, []);
});

test('exact owner, paid order, grant, original rejection, attention failure, hashes and absent leases are required', async t => {
  for (const [name, change] of [
    ['not owner', h => h.mutate(userPath(h.email), value => { value.role = 'customer'; })],
    ['revoked payment', h => h.mutate(h.orderPath, value => { value.refundedCents = 1; })],
    ['grant changed', h => h.mutate(h.grantPath, value => { value.approvedAt = '2000-01-01T00:00:00Z'; })],
    ['old review changed', h => h.mutate(h.receiptPath, value => { value.decision.sceneAction = 'consistent'; })],
    ['fourth clip changed', h => h.mutate(h.jobPath, value => { value.shots[3].output.sha256 = digest('different clip'); })],
    ['job lease', h => { h.mutate(h.jobPath, value => { value.lease = { expiresAt: h.now() + 1000 }; }); bindFailureHashes(h); }],
    ['queue lease', h => { h.mutate(h.queuePath, value => { value.lease = { expiresAt: h.now() + 1000 }; }); bindFailureHashes(h); }],
    ['quality mismatch', h => { h.mutate(h.jobPath, value => { value.finishingFailure.reason = 'VISUAL_CONTINUITY_MISMATCH'; }); bindFailureHashes(h); }],
    ['different stage', h => { h.mutate(h.jobPath, value => { value.finishingFailure.stage = 'assembly'; }); bindFailureHashes(h); }],
    ['older failure', h => { h.mutate(h.jobPath, value => { value.finishingFailure.recordedAt = '2000-01-01T00:00:00Z'; }); bindFailureHashes(h); }],
    ['ticket failure changed', h => { h.mutate(h.queuePath, value => { value.lastFailure.reason = 'VISUAL_CONTINUITY_MISMATCH'; }); bindFailureHashes(h); }],
    ['job hash changed', h => { h.resumeInput.jobHash = digest('wrong job'); }],
    ['queue hash changed', h => { h.resumeInput.queueHash = digest('wrong queue'); }],
    ['grant hash changed', h => { h.resumeInput.recoveryGrantHash = digest('wrong grant'); }],
  ]) await t.test(name, async () => {
    const h = await preclaimFixture(); change(h); await assert.rejects(h.resume());
    assert.equal(h.permissions.length, 0); assert.deepEqual(h.writes, []);
  });
});

test('new claims, payment reversal, changed source or leases after durable receipt cannot release the queue', async t => {
  for (const [name, change] of [
    ['claim after receipt', h => h.seed(`${h.bindingPrefix}${VISUAL_RECOVERY_POLICY}/${digest(h.job.shots[1].id)}.json`, { version: 1 })],
    ['payment after receipt', h => h.mutate(h.orderPath, value => { value.refundedCents = 1; })],
    ['source after receipt', h => h.mutate(h.jobPath, value => { value.shots[3].output.sizeBytes++; })],
    ['lease after receipt', h => h.mutate(h.queuePath, value => { value.lease = { expiresAt: h.now() + 1000 }; })],
  ]) await t.test(name, async () => {
    const h = await preclaimFixture(); h.hooks.afterWrite = path => { if (path === h.resumePath) change(h); };
    await assert.rejects(h.resume()); assert.deepEqual(h.writes.map(row => row.path), [h.resumePath]);
    assert.equal(h.value(h.queuePath).state, 'attention');
  });
  const h = await preclaimFixture();
  h.hooks.afterWrite = path => { if (path === h.jobPath) h.seed(`${h.bindingPrefix}${VISUAL_RECOVERY_POLICY}/${digest(h.job.shots[2].id)}.json`, {}); };
  await assert.rejects(h.resume()); assert.equal(h.value(h.queuePath).state, 'attention');
  assert.deepEqual(h.writes.map(row => row.path), [h.resumePath, h.jobPath]);
});

test('fresh resume authorization binds the exact input and a failed renewal cannot queue work', async t => {
  for (const kind of ['denied', 'expired', 'wrong-hash', 'unavailable']) await t.test(kind, async () => {
    const h = await preclaimFixture(); h.hooks.afterWrite = path => { if (path === h.jobPath) h.advance(60001); };
    h.resumeHooks.authorize = args => {
      if (h.permissions.length === 1) return;
      if (kind === 'unavailable') throw Error('Synthetic auth outage');
      return { allowed: kind !== 'denied', environment: 'production', manifestHash: args.manifestHash,
        recoveryRequestHash: kind === 'wrong-hash' ? digest('other') : sha(args.recoveryPlan),
        expiresAt: new Date(h.now() + (kind === 'expired' ? 0 : 60000)).toISOString() };
    };
    await assert.rejects(h.resume()); assert.equal(h.permissions.length, 2);
    assert.equal(h.value(h.queuePath).state, 'attention');
    h.hooks.afterWrite = undefined; h.resumeHooks.authorize = undefined;
    assert.equal((await h.resume()).status, 'resumed');
    assert.deepEqual(h.writes.map(row => row.path), [h.resumePath, h.jobPath, h.queuePath]);
  });
});

test('lost acknowledgments and interrupted readbacks at every write resume the same immutable operation', async t => {
  for (const field of ['resumePath', 'jobPath', 'queuePath']) for (const interrupted of [false, true])
    await t.test(`${field} ${interrupted ? 'interruption' : 'lost acknowledgment'}`, async () => {
      const h = await preclaimFixture(); let fired = false;
      h.hooks.afterWrite = path => {
        if (!fired && path === h[field]) {
          fired = true;
          if (interrupted) h.hooks.beforeRead = readPath => { if (readPath === path) throw Error('Synthetic unavailable readback'); };
          throw Error('Synthetic lost write acknowledgment');
        }
      };
      if (interrupted) await assert.rejects(h.resume()); else assert.equal((await h.resume()).status, 'resumed');
      h.hooks.beforeRead = undefined; h.hooks.afterWrite = undefined; h.advance(2000);
      assert.ok(['resumed', 'already-resumed'].includes((await h.resume()).status));
      assert.deepEqual(h.writes.map(row => row.path), [h.resumePath, h.jobPath, h.queuePath]);
      assert.deepEqual(h.value(h.receiptPath), h.receipt); assert.deepEqual(h.value(h.orderPath), h.order);
    });
});

test('second attention stop and existing model claims cannot replay a used resume or change its original input', async () => {
  const h = await preclaimFixture(); await h.resume();
  h.mutate(h.jobPath, job => { job.finishingFailure.state = 'attention'; job.revision++; });
  h.mutate(h.queuePath, ticket => { ticket.state = 'attention'; ticket.lastResult = 'REVIEW_REQUIRED'; });
  h.seed(`${h.bindingPrefix}${VISUAL_RECOVERY_POLICY}/${digest(h.job.shots[0].id)}.json`, { version: 1 });
  const before = snapshot(h), count = h.writes.length;
  assert.equal((await h.resume()).status, 'already-resumed'); assert.equal(h.writes.length, count); assert.deepEqual(snapshot(h), before);
  bindFailureHashes(h); await assert.rejects(h.resume(), { code: 'VISUAL_REVIEW_INVALID' }); assert.deepEqual(snapshot(h), before);
});

test('concurrent exact approvals with advancing clocks adopt one durable receipt and each control transition once', async () => {
  const h = await preclaimFixture(); let receiptAttempts = 0;
  h.hooks.beforeWrite = path => { if (path === h.resumePath) { receiptAttempts++; h.advance(37); } };
  const results = await Promise.all([h.resume(), h.resume(), h.resume()]);
  assert.ok(results.every(value => ['resumed', 'already-resumed'].includes(value.status)));
  assert.ok(receiptAttempts >= 1);
  assert.deepEqual(h.writes.map(row => row.path), [h.resumePath, h.jobPath, h.queuePath]);
  const receipt = h.value(h.resumePath);
  assert.equal(h.value(h.jobPath).visualReviewPreclaimResumeHash, sha(receipt));
  assert.equal(h.value(h.queuePath).visualReviewPreclaimResumeHash, sha(receipt));
  assert.deepEqual(h.value(h.jobPath).shots, h.job.shots); assert.deepEqual(h.value(h.receiptPath), h.receipt);
});

test('tampered receipt, missing receipt and concurrent CAS changes never overwrite source state', async t => {
  for (const kind of ['missing-receipt', 'tampered-receipt', 'job-conflict', 'queue-conflict']) await t.test(kind, async () => {
    const h = await preclaimFixture();
    if (kind.endsWith('receipt')) {
      h.hooks.beforeWrite = path => { if (path === h.queuePath) throw Error('Synthetic stopped transition'); };
      await assert.rejects(h.resume()); h.hooks.beforeWrite = undefined;
      if (kind === 'missing-receipt') h.records.delete(h.resumePath);
      else h.mutate(h.resumePath, value => { value.recoveryGrantHash = digest('different approval'); });
    } else {
      const path = kind === 'job-conflict' ? h.jobPath : h.queuePath; let changed = false;
      h.hooks.beforeWrite = value => { if (value === path && !changed) { changed = true; h.mutate(path, row => { row.concurrentChange = true; }); } };
    }
    await assert.rejects(h.resume()); assert.equal(h.value(h.queuePath).state, 'attention');
    assert.deepEqual(h.value(h.grantPath), h.job.visualReviewRecovery); assert.deepEqual(h.value(h.receiptPath), h.receipt);
  });
});
