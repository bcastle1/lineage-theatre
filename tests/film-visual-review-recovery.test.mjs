import test from 'node:test';
import { fixture, correctionFor } from './fixtures/visual-review-recovery.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { createVisualReviewRecovery, readVisualReviewRecovery, visualReviewRecoveryPath,
  VISUAL_RECOVERY_POLICY } from '../api/_lib/film-visual-review-recovery.mjs';
import { runVisualRecovery, APPLY_FLAG } from '../scripts/recover-film-visual-review.mjs';

const sha = value => digest(JSON.stringify(value));
const copy = value => structuredClone(value);

test('stage recovery plans without writes, live authorization, or alteration of rejected review', async () => {
  const h = fixture(), before = copy([...h.records]);
  const result = await h.service(h.input);
  assert.equal(result.status, 'planned'); assert.equal(result.changed, false);
  assert.equal(result.policy, VISUAL_RECOVERY_POLICY); assert.equal(result.preservedClips, 4);
  assert.equal(result.maximumNewVideoRequests, 0); assert.equal(result.maximumReviewsPerClip, 1);
  assert.equal(h.authorizationCalls.length, 0); assert.equal(h.paymentCalls.length, 1);
  assert.deepEqual(h.writes, []); assert.deepEqual([...h.records], before);
});

test('explicit recovery pins four exact outputs and conditionally resumes only finishing', async () => {
  const h = fixture(), beforeJob = h.value(h.jobPath), beforeReceipt = h.value(h.receiptPath), beforeOrder = h.value(h.orderPath);
  const result = await h.apply(), grant = h.value(h.grantPath), job = h.value(h.jobPath), queue = h.value(h.queuePath);
  assert.equal(result.status, 'resumed'); assert.equal(result.changed, true);
  assert.deepEqual(h.writes.map(row => row.path), [h.grantPath, h.jobPath, h.queuePath]);
  assert.equal(h.writes[0].etag, undefined); assert.ok(h.writes[1].etag); assert.ok(h.writes[2].etag);
  assert.deepEqual(grant.shots, h.input.shots); assert.equal(grant.priorReceiptHash, sha(beforeReceipt));
  assert.deepEqual(grant.priorFailure, beforeJob.finishingFailure); assert.deepEqual(job.shots, beforeJob.shots);
  assert.deepEqual(job.manifest, beforeJob.manifest); assert.deepEqual(job.authorization, beforeJob.authorization);
  assert.equal(job.status, 'awaiting-assembly'); assert.equal(job.finishingFailure.state, 'retrying');
  assert.equal(job.revision, beforeJob.revision + 1); assert.equal(queue.state, 'pending'); assert.equal(queue.attempts, 0);
  assert.equal(queue.visualReviewRecoveryHash, sha(grant)); assert.equal(queue.orderId, h.order.id);
  assert.deepEqual(h.value(h.receiptPath), beforeReceipt); assert.deepEqual(h.value(h.orderPath), beforeOrder);
  assert.deepEqual(await readVisualReviewRecovery(job, { read: h.read }), grant);
  assert.deepEqual(h.authorizationCalls, [{ email: h.email, preparedId: h.job.id,
    manifestHash: h.job.manifestHash, orderId: h.order.id, recoveryPlan: h.input }]);
});

test('owner, payment, exact clips, finishing stage and narrow prior decision are mandatory', async t => {
  const cases = [
    ['customer role', h => h.mutate(userPath(h.email), value => { value.role = 'customer'; })],
    ['suspended owner', h => h.mutate(userPath(h.email), value => { value.status = 'suspended'; })],
    ['password reset pending', h => h.mutate(userPath(h.email), value => { value.mustChangePassword = true; })],
    ['refunded payment', h => h.mutate(h.orderPath, value => { value.refundedCents = 1; })],
    ['payment under reconciliation', h => h.mutate(h.orderPath, value => { value.checkOperation = { state: 'pending' }; })],
    ['active job lease', h => h.mutate(h.jobPath, value => { value.lease = { token: 'synthetic', expiresAt: h.now() + 1000 }; })],
    ['active queue lease', h => h.mutate(h.queuePath, value => { value.lease = { token: 'synthetic', expiresAt: h.now() + 1000 }; })],
    ['changed fourth clip', h => h.mutate(h.jobPath, value => { value.shots[3].output.sha256 = digest('other bytes'); })],
    ['unfinished fourth clip', h => h.mutate(h.jobPath, value => { value.shots[3].status = 'processing'; })],
    ['different failure stage', h => h.mutate(h.jobPath, value => { value.finishingFailure.stage = 'assembly'; })],
    ['different failure reason', h => h.mutate(h.jobPath, value => { value.finishingFailure.reason = 'AUDIO_MISMATCH'; })],
    ['existing media', h => h.mutate(h.jobPath, value => { value.media = { pathname: 'already-delivered' }; })],
    ['queue already running', h => h.mutate(h.queuePath, value => { value.state = 'pending'; })],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const h = fixture(); mutate(h); await assert.rejects(h.apply()); assert.deepEqual(h.writes, []);
  });
  for (const [name, change] of [
    ['appearance mismatch', value => { value.decision.appearance = 'mismatch'; }],
    ['cast mismatch', value => { value.decision.cast = 'mismatch'; }],
    ['additional quality finding', value => { value.decision.findings.push('duplicate-character'); }],
    ['earlier review passed', value => { value.decision.sceneAction = 'consistent'; }],
    ['unknown model', value => { value.model = 'other-model'; }],
    ['uncertain prior inference', value => { value.state = 'uncertain'; }],
  ]) await t.test(name, async () => {
    const h = fixture(); h.mutate(h.receiptPath, change); h.input.receiptHash = sha(h.value(h.receiptPath));
    await assert.rejects(h.apply(), { code: 'VISUAL_REVIEW_INVALID' }); assert.deepEqual(h.writes, []);
  });
  await t.test('unparsed graphic syntax does not qualify', async () => {
    const h = fixture({ noOverlay: true }); await assert.rejects(h.apply(), { code: 'VISUAL_REVIEW_INVALID' });
    assert.deepEqual(h.writes, []);
  });
});

test('fresh production permission must allow the exact production manifest and remain unexpired', async t => {
  for (const permission of [ { allowed: false }, { allowed: true, environment: 'sandbox' },
    { allowed: true, environment: 'production', manifestHash: digest('different manifest'), expiresAt: '2099-01-01T00:00:00Z' },
    { allowed: true, environment: 'production', recoveryRequestHash: digest('different recovery'), expiresAt: '2099-01-01T00:00:00Z' },
    { allowed: true, environment: 'production', expiresAt: '2000-01-01T00:00:00Z' } ]) {
    await t.test(JSON.stringify(permission), async () => {
      const h = fixture({ permission }); permission.manifestHash ??= h.input.manifestHash;
      permission.recoveryRequestHash ??= sha(h.input);
      await assert.rejects(h.apply(), { code: 'VISUAL_REVIEW_INVALID' }); assert.deepEqual(h.writes, []);
    });
  }
});

test('permission expiring during reconciliation renews once for the identical plan before releasing the queue', async t => {
  for (const elapsed of [55000, 60001]) await t.test(`${elapsed}ms reconciliation`, async () => {
    const h = fixture(); h.input.textCorrections = [correctionFor(h)];
    h.hooks.afterWrite = path => { if (path === h.jobPath) h.advance(elapsed); };
    assert.equal((await h.apply()).status, 'resumed');
    assert.equal(h.authorizationCalls.length, 2);
    assert.deepEqual(h.authorizationCalls[1], h.authorizationCalls[0]);
    assert.deepEqual(h.writes.map(row => row.path), [h.grantPath, h.jobPath, h.queuePath]);
    assert.equal(h.value(h.queuePath).state, 'pending');
    assert.deepEqual(h.value(h.jobPath).shots, h.job.shots); assert.deepEqual(h.value(h.receiptPath), h.receipt);
  });
});

test('a denied, expired or differently bound renewal never releases the queue or repeats approval writes', async t => {
  for (const kind of ['denied', 'expired', 'changed-plan', 'unavailable']) await t.test(kind, async () => {
    const permission = {}, h = fixture({ permission });
    Object.assign(permission, { allowed: true, environment: 'production', manifestHash: h.input.manifestHash,
      recoveryRequestHash: sha(h.input), expiresAt: new Date(h.now() + 60000).toISOString() });
    h.hooks.afterWrite = path => { if (path === h.jobPath) h.advance(60001); };
    h.hooks.beforeAuthorize = () => {
      if (h.authorizationCalls.length !== 2) return;
      if (kind === 'unavailable') throw Error('Synthetic authorization outage');
      permission.expiresAt = new Date(h.now() + 60000).toISOString();
      if (kind === 'denied') permission.allowed = false;
      if (kind === 'expired') permission.expiresAt = new Date(h.now()).toISOString();
      if (kind === 'changed-plan') permission.recoveryRequestHash = digest('another approved plan');
    };
    await assert.rejects(h.apply()); assert.equal(h.authorizationCalls.length, 2);
    assert.equal(h.value(h.queuePath).state, 'attention');
    assert.deepEqual(h.writes.map(row => row.path), [h.grantPath, h.jobPath]);
    h.hooks.afterWrite = undefined; h.hooks.beforeAuthorize = undefined;
    Object.assign(permission, { allowed: true, recoveryRequestHash: sha(h.input), expiresAt: new Date(h.now() + 60000).toISOString() });
    assert.equal((await h.apply()).status, 'resumed');
    assert.equal(h.authorizationCalls.length, 3);
    assert.deepEqual(h.writes.map(row => row.path), [h.grantPath, h.jobPath, h.queuePath]);
    assert.deepEqual(h.value(h.receiptPath), h.receipt); assert.deepEqual(h.value(h.orderPath), h.order);
  });
});

test('payment, source and lease changes after durable approval block resuming the queue', async t => {
  for (const [name, change] of [
    ['payment reversal', h => h.mutate(h.orderPath, value => { value.status = 'refunded'; })],
    ['fourth output substitution', h => h.mutate(h.jobPath, value => { value.shots[3].output.url = 'https://v3.fal.media/different.mp4'; })],
    ['owner suspension', h => h.mutate(userPath(h.email), value => { value.status = 'suspended'; })],
    ['new job lease', h => h.mutate(h.jobPath, value => { value.lease = { token: 'new', expiresAt: h.now() + 1000 }; })],
    ['new queue lease', h => h.mutate(h.queuePath, value => { value.lease = { token: 'new', expiresAt: h.now() + 1000 }; })],
  ]) await t.test(name, async () => {
    const h = fixture(); h.hooks.afterWrite = path => { if (path === h.grantPath) change(h); };
    await assert.rejects(h.apply());
    assert.deepEqual(h.writes.map(row => row.path), [h.grantPath]);
    assert.equal(h.value(h.queuePath).state, 'attention');
    assert.equal(h.value(h.jobPath).visualReviewRecovery, undefined);
  });
});

test('lost acknowledgments at each conditional write reconcile without replacing the original receipt or clips', async t => {
  for (const field of ['grantPath', 'jobPath', 'queuePath']) await t.test(field, async () => {
    const h = fixture(); let lost = false;
    h.hooks.afterWrite = path => { if (!lost && path === h[field]) { lost = true; throw Error('Synthetic lost write acknowledgment'); } };
    assert.equal((await h.apply()).status, 'resumed'); assert.equal(lost, true);
    assert.equal((await h.apply()).status, 'already-resumed');
    assert.deepEqual(h.writes.map(row => row.path), [h.grantPath, h.jobPath, h.queuePath]);
    assert.deepEqual(h.value(h.receiptPath), h.receipt); assert.deepEqual(h.value(h.jobPath).shots, h.job.shots);
  });
});

test('a stored write followed by unavailable readback resumes the same grant, job and queue on retry', async t => {
  for (const field of ['grantPath', 'jobPath', 'queuePath']) await t.test(field, async () => {
    const h = fixture(); let interrupted = false;
    h.hooks.afterWrite = path => {
      if (!interrupted && path === h[field]) {
        interrupted = true;
        h.hooks.beforeRead = readPath => { if (readPath === path) throw Error('Synthetic interrupted readback'); };
        throw Error('Synthetic process interrupted');
      }
    };
    await assert.rejects(h.apply());
    h.hooks.beforeRead = undefined; h.hooks.afterWrite = undefined; h.advance(1000);
    const result = await h.apply(); assert.ok(['resumed', 'already-resumed'].includes(result.status));
    assert.deepEqual(h.writes.map(row => row.path), [h.grantPath, h.jobPath, h.queuePath]);
    assert.deepEqual(h.value(h.receiptPath), h.receipt); assert.deepEqual(h.value(h.orderPath), h.order);
  });
});

test('CAS conflicts never overwrite a concurrent job or queue change', async t => {
  for (const field of ['jobPath', 'queuePath']) await t.test(field, async () => {
    const h = fixture(); let conflict = false;
    h.hooks.beforeWrite = path => { if (!conflict && path === h[field]) {
      conflict = true; h.mutate(path, value => { value.concurrentMarker = 'another-worker'; });
    } };
    await assert.rejects(h.apply(), { code: 'VISUAL_REVIEW_INVALID' });
    assert.equal(h.value(h[field]).concurrentMarker, 'another-worker');
    assert.equal(h.value(h.queuePath).state, 'attention');
    assert.deepEqual(h.value(h.receiptPath), h.receipt);
  });
});

test('a second rejected review cannot replay the recovery to reset attention again', async () => {
  const h = fixture(); await h.apply();
  h.mutate(h.jobPath, value => { value.finishingFailure = { ...value.finishingFailure, state: 'attention',
    recordedAt: new Date(h.now() + 1000).toISOString() }; });
  h.mutate(h.queuePath, value => { value.state = 'attention'; value.lastResult = 'NEEDS_ATTENTION'; value.attempts = 1; });
  const before = copy([...h.records]), writes = h.writes.length;
  const result = await h.apply(); assert.equal(result.status, 'already-resumed'); assert.equal(result.changed, false);
  assert.equal(result.queueState, 'attention'); assert.equal(h.writes.length, writes); assert.deepEqual([...h.records], before);
});

test('runtime recovery lookup rejects missing or tampered approval, receipt, current output and stale marker', async t => {
  for (const [name, change] of [
    ['missing grant', h => h.records.delete(h.grantPath)],
    ['changed grant', h => h.mutate(h.grantPath, value => { value.approvedBy = 'other@example.invalid'; })],
    ['changed rejected receipt', h => h.mutate(h.receiptPath, value => { value.decision.sceneAction = 'consistent'; })],
    ['changed fourth current output', h => h.mutate(h.jobPath, value => { value.shots[3].output.sizeBytes++; })],
    ['missing current marker', h => h.mutate(h.jobPath, value => { delete value.visualReviewRecovery; })],
  ]) await t.test(name, async () => {
    const h = fixture(); await h.apply(); const observed = h.value(h.jobPath); change(h);
    await assert.rejects(readVisualReviewRecovery(observed, { read: h.read }), { code: 'VISUAL_REVIEW_INVALID' });
  });
  const h = fixture();
  assert.equal(await readVisualReviewRecovery(h.job, { read: h.read }), null);
  await h.apply(); await assert.rejects(readVisualReviewRecovery(h.job, { read: h.read }), { code: 'VISUAL_REVIEW_INVALID' });
});

test('optional text correction is frozen in the one-use grant without changing the manifest, source clips or receipt', async () => {
  const h = fixture(); h.input.textCorrections = [correctionFor(h)];
  const before = copy([...h.records]);
  assert.equal((await h.service(h.input)).status, 'planned'); assert.deepEqual([...h.records], before);
  const result = await h.apply(), grant = h.value(h.grantPath), job = h.value(h.jobPath);
  assert.deepEqual(grant.textCorrections, h.input.textCorrections);
  assert.equal(result.grantHash, sha(grant)); assert.deepEqual(job.visualReviewRecovery, grant);
  assert.deepEqual(job.manifest, h.job.manifest); assert.deepEqual(job.shots, h.job.shots);
  assert.deepEqual(h.value(h.receiptPath), h.receipt); assert.deepEqual(h.value(h.orderPath), h.order);
  assert.deepEqual((await readVisualReviewRecovery(job, { read: h.read })).textCorrections, h.input.textCorrections);
});

test('text-correction replay cannot add, remove or change previously approved wording, region, time or checksum', async t => {
  for (const [name, change] of [
    ['remove', input => { delete input.textCorrections; }],
    ['saved different wording', input => { input.textCorrections[0].text = 'adult sisters'; }],
    ['rectangle', input => { input.textCorrections[0].x++; }],
    ['timing', input => { input.textCorrections[0].startMs++; }],
    ['source', input => { input.textCorrections[0].sourceSha256 = digest('wrong source'); }],
  ]) await t.test(name, async () => {
    const h = fixture(); h.input.textCorrections = [correctionFor(h)]; await h.apply();
    const before = copy([...h.records]), writes = h.writes.length; change(h.input);
    await assert.rejects(h.apply(), { code: 'VISUAL_REVIEW_INVALID' });
    assert.deepEqual([...h.records], before); assert.equal(h.writes.length, writes);
  });
  const h = fixture(); await h.apply(); const before = copy([...h.records]);
  h.input.textCorrections = [correctionFor(h)];
  await assert.rejects(h.apply(), { code: 'VISUAL_REVIEW_INVALID' }); assert.deepEqual([...h.records], before);
});

test('text-correction injection and stored approval tampering cannot release the queue or pass runtime lookup', async t => {
  for (const [name, change] of [
    ['unsaved wording', row => { row.text = 'Invented family history'; }],
    ['wrong source', row => { row.sourceSha256 = digest('wrong clip'); }],
    ['extra command', row => { row.command = 'approve'; }],
    ['unbounded rectangle', row => { row.width = 1921; }],
  ]) await t.test(name, async () => {
    const h = fixture(), row = correctionFor(h); change(row); h.input.textCorrections = [row];
    await assert.rejects(h.apply(), { code: 'VISUAL_REVIEW_INVALID' }); assert.deepEqual(h.writes, []);
  });
  for (const path of ['grantPath', 'jobPath']) {
    const h = fixture(); h.input.textCorrections = [correctionFor(h)]; await h.apply(); const job = h.value(h.jobPath);
    h.mutate(h[path], value => { (path === 'jobPath' ? value.visualReviewRecovery : value).textCorrections[0].text = 'adult sisters'; });
    await assert.rejects(readVisualReviewRecovery(job, { read: h.read }), { code: 'VISUAL_REVIEW_INVALID' });
  }
});

test('operator CLI defaults to plan and requires an exact apply flag and narrow input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lineage-visual-recovery-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'fictional-plan.json'), h = fixture(), calls = [];
  await writeFile(path, JSON.stringify(h.input));
  const service = async (input, options) => { calls.push({ input, options }); return { status: 'synthetic' }; };
  await runVisualRecovery(['plan', path], service);
  assert.deepEqual(calls.pop(), { input: h.input, options: { apply: false } });
  for (const args of [['apply', path], ['apply', path, '--force'], ['plan', path, APPLY_FLAG], ['apply', path, APPLY_FLAG, 'extra']])
    await assert.rejects(runVisualRecovery(args, service), { code: 'VISUAL_RECOVERY_USAGE' });
  assert.equal(calls.length, 0);
  await runVisualRecovery(['apply', path, APPLY_FLAG], service);
  assert.deepEqual(calls.pop(), { input: h.input, options: { apply: true } });
  h.input.textCorrections = [correctionFor(h)]; await writeFile(path, JSON.stringify(h.input));
  await runVisualRecovery(['plan', path], service);
  assert.deepEqual(calls.pop(), { input: h.input, options: { apply: false } });
  await writeFile(path, JSON.stringify({ ...h.input, bypassPayment: true }));
  await assert.rejects(runVisualRecovery(['apply', path, APPLY_FLAG], service)); assert.equal(calls.length, 0);
});
