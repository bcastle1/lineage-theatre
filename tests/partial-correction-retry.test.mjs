import test from 'node:test';
import assert from 'node:assert/strict';
import { retryFixture } from './fixtures/partial-retry.mjs';
import { digest } from '../api/_lib/auth.mjs';
import { sha } from './fixtures/partial-correction.mjs';
import { falRequestPath } from '../api/_lib/fal-client.mjs';
import { FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { productionCorrectionPath, readPaidFilmCorrection } from '../api/_lib/paid-film-correction.mjs';
import { partialRetryPath } from '../api/_lib/partial-correction-retry.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';

const posts = h => h.calls.filter(row => row.method === 'POST');
const unchanged = async h => ({ order: await h.read(`payments/orders/${h.orderId}.json`), source: await h.read(h.jobPath(h.source.id)),
  originalGrant: await h.read(productionCorrectionPath(h.correctionId)), ledger: await h.read(FAL_FUNDING_PATH),
  failed: await h.read(falRequestPath(h.input.failedOperationIdentity)), retained: (await h.read(h.jobPath(h.targetId))).value.shots.filter(row => row.id !== h.input.shotId) });

test('one owner-approved unchanged nine-second retry retains three clips, original payment, failed receipt and existing allowance', async () => {
  const h = await retryFixture(), before = await unchanged(h), count = posts(h).length;
  const result = await h.approve(); assert.equal(result.maximumNewCostCents, 1080); assert.equal(result.customerChargeCents, 0);
  assert.equal(posts(h).length, count, 'Approval is GET-only at the provider');
  assert.equal(h.proofReads.length, 2); assert.deepEqual(await h.approve(), result);
  await h.enqueue(); await h.run(); assert.equal(posts(h).length, count + 1);
  const request = posts(h).at(-1).body;
  assert.equal(request.duration, '9'); assert.equal(request.resolution, '1080p'); assert.equal(request.generate_audio, true);
  assert.deepEqual(request, posts(h)[0].body, 'Retry uses the exact prior input, including prompt, narration and native audio');
  await h.run(); const job = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(job.status, 'awaiting-assembly'); assert.ok(job.shots.every(row => row.status === 'completed')); assert.equal(job.media, undefined);
  assert.deepEqual(await unchanged(h), before); assert.equal(posts(h).length, count + 1);
  await requireFinishedFilmPayment({ job, email: h.email, actor: h.actor, read: h.read, now: h.now });
});

test('a lost retry submit reply remains uncertain and subsequent approval or worker runs cannot submit again', async () => {
  const h = await retryFixture(); await h.approve(); await h.enqueue(); const count = posts(h).length;
  h.settings.lostSubmit = true;
  await h.run(); assert.equal((await h.read(h.jobPath(h.targetId))).value.status, 'uncertain');
  await h.approve(); await h.enqueue(); await h.run(); await h.run();
  assert.equal(posts(h).length, count + 1);
});

test('a terminal retry failure cannot be reset or receive a third request', async () => {
  const h = await retryFixture(); await h.approve(); await h.enqueue(); const count = posts(h).length;
  h.settings.retryFailure = true; await h.run(); await h.run();
  const failed = await h.read(h.jobPath(h.targetId)); assert.equal(failed.value.status, 'failed');
  await h.approve(); await h.enqueue(); await h.run();
  assert.deepEqual(await h.read(h.jobPath(h.targetId)), failed); assert.equal(posts(h).length, count + 1);
});

test('nonterminal, different-request, unknown500 and policy failures cannot authorize a retry', async () => {
  for (const options of [{ providerStatus: { status: 'IN_PROGRESS', request_id: 'offline-new-corrected-scene-1' } },
    { providerStatus: { status: 'COMPLETED', request_id: 'another-request' } }, { providerHttp: 422 }, { providerHttp: 503 },
    { providerBody: { detail: 'gateway failure' } },
    { providerBody: { detail: [{ type: 'downstream_service_error', msg: 'Downstream service error', loc: ['body'] }], video: { url: 'https://v3.fal.media/ambiguous.mp4' } } }]) {
    const h = await retryFixture(options), before = await h.read(h.jobPath(h.targetId));
    await assert.rejects(h.approve()); assert.equal(await h.read(partialRetryPath(h.correctionId)), null);
    assert.deepEqual(await h.read(h.jobPath(h.targetId)), before); assert.equal(posts(h).length, 1);
  }
});

test('wrong owner, input, paid authorization, clips, receipt, evidence, cap and active leases block before a new operation', async () => {
  for (const kind of ['owner', 'confirmation', 'input', 'receipt', 'failure-code', 'new-cap', 'low-cap', 'evidence', 'account',
    'evidence-time', 'clip', 'clip-status', 'auth', 'queue-lease', 'job-lease', 'health', 'refund', 'hold']) {
    const h = await retryFixture();
    if (kind === 'owner') h.input.actor = { email: 'another@example.invalid', role: 'owner' };
    if (kind === 'confirmation') h.input.confirmed = false;
    if (kind === 'input') h.mutate(falRequestPath(h.input.failedOperationIdentity), row => { row.inputHash = digest('changed-input'); });
    if (kind === 'receipt') h.input.failedRequestId = 'another-request';
    if (kind === 'failure-code') {
      h.mutate(falRequestPath(h.input.failedOperationIdentity), row => { row.failureCode = 'FAL_HTTP_500'; });
      const hash = sha((await h.read(falRequestPath(h.input.failedOperationIdentity))).value);
      h.input.failedRecordHash = hash; h.input.billingEvidence.recordHash = hash;
    }
    if (kind === 'new-cap') h.input.maximumNewCostCents++;
    if (kind === 'low-cap') h.input.maximumNewCostCents--;
    if (kind === 'evidence') h.input.billingEvidence.costNanoUsd = 1;
    if (kind === 'account') h.input.billingEvidence.account = 'other-account';
    if (kind === 'evidence-time') h.input.billingEvidence.observedAt = new Date(h.now() + 1).toISOString();
    if (kind === 'clip') h.mutate(h.jobPath(h.targetId), job => { job.shots[0].output.sha256 = digest('changed'); });
    if (kind === 'clip-status') h.mutate(h.jobPath(h.targetId), job => { job.shots[0].status = 'prepared'; });
    if (kind === 'auth') h.mutate(h.jobPath(h.targetId), job => { job.authorization.budgetCents++; });
    if (kind === 'queue-lease') h.mutate(h.targetQueuePath, queue => { queue.lease = { expiresAt: h.now() + 1000 }; });
    if (kind === 'job-lease') h.mutate(h.jobPath(h.targetId), job => { job.lease = { expiresAt: h.now() + 1000 }; });
    if (kind === 'health') h.mutate('production/worker-health.json', health => { delete health.partialCorrectionRetryVersion; });
    if (kind === 'refund') h.settings.reversed = true;
    if (kind === 'hold') h.records.delete(FAL_FUNDING_PATH);
    await assert.rejects(h.approve(), undefined, kind); assert.equal(posts(h).length, 1);
    assert.equal(await h.read(partialRetryPath(h.correctionId)), null);
  }
});

test('payment reversal, account switch and removed hold after approval still stop the worker before POST', async () => {
  for (const kind of ['refund', 'account', 'hold']) {
    const h = await retryFixture(); await h.approve(); await h.enqueue();
    if (kind === 'refund') h.settings.reversed = true;
    if (kind === 'account') { h.env.FAL_BILLING_ACCOUNT = 'switched-account'; h.mutate(FAL_FUNDING_PATH, ledger => { ledger.account = h.env.FAL_BILLING_ACCOUNT; }); }
    if (kind === 'hold') h.records.delete(FAL_FUNDING_PATH);
    await h.run(); assert.equal(posts(h).length, 1, kind);
  }
});

test('retry record and failed receipt changes are detected by the read-only context recheck', async () => {
  for (const kind of ['grant', 'failed', 'choice', 'marker']) {
    const h = await retryFixture(); await h.approve();
    const context = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: h.read, now: h.now });
    if (kind === 'grant') h.mutate(partialRetryPath(h.correctionId), row => { row.maximumNewCostCents++; });
    if (kind === 'failed') h.mutate(falRequestPath(h.input.failedOperationIdentity), row => { row.checkedAt = new Date(h.now()).toISOString(); });
    if (kind === 'choice') h.seed(`production/fal/choices/${h.input.failedOperationIdentity}.json`, {});
    if (kind === 'marker') h.mutate(h.jobPath(h.targetId), job => { delete job.partialCorrectionRetry; });
    await assert.rejects(context.recheck()); await assert.rejects(h.auth()); assert.equal(posts(h).length, 1);
  }
});
