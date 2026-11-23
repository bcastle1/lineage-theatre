import test from 'node:test';
import assert from 'node:assert/strict';
import { retryFixture } from './fixtures/partial-retry.mjs';
import { createProductionQueue } from '../api/_lib/production-queue.mjs';
import { partialRetryPath } from '../api/_lib/partial-correction-retry.mjs';
import { FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { falRequestPath } from '../api/_lib/fal-client.mjs';

const posts = h => h.calls.filter(call => call.method === 'POST');
const retained = h => h.job.shots.filter(shot => shot.id !== h.input.shotId);
const currentJob = async h => (await h.read(h.jobPath(h.targetId))).value;

test('lost queue-resume reply reconciles its already-published retry without changing three completed clips or funding', async () => {
  const h = await retryFixture(), oldClips = structuredClone(retained(h));
  const ledger = await h.read(FAL_FUNDING_PATH), order = await h.read(`payments/orders/${h.orderId}.json`);
  const source = await h.read(h.jobPath(h.source.id)), initialPosts = posts(h).length;
  const first = await h.approve();
  assert.equal((await currentJob(h)).partialCorrectionRetry.id, first.id);
  assert.equal((await h.read(partialRetryPath(h.correctionId))).value.id, first.id);

  let lost = false;
  const queue = createProductionQueue({ read: h.read, now: h.now, film: h.film, paymentService: h.service,
    write: async (path, value, etag) => {
      await h.write(path, value, etag);
      if (!lost && path === h.targetQueuePath && value.state === 'pending') {
        lost = true; throw Error('Synthetic queue write succeeded but its reply was lost');
      }
    } });
  await assert.rejects(queue.enqueue({ actor: h.actor, id: h.targetId, orderId: h.correctionId }), /reply was lost/);
  assert.equal((await h.read(h.targetQueuePath)).value.state, 'pending');
  const resumedJob = await h.read(h.jobPath(h.targetId));
  const reconciled = await Promise.all([h.approve(), h.approve(), h.approve()]);
  reconciled.forEach(result => assert.deepEqual(result, first));
  await h.enqueue();
  assert.deepEqual(await h.read(h.jobPath(h.targetId)), resumedJob, 'Reconciliation must not reset the resumed shot again');
  assert.equal(posts(h).length, initialPosts);

  await h.run(); await h.run();
  const deliveredToAssembly = await currentJob(h);
  assert.equal(deliveredToAssembly.status, 'awaiting-assembly');
  assert.deepEqual(deliveredToAssembly.shots.filter(shot => shot.id !== h.input.shotId), oldClips);
  assert.equal(posts(h).length, initialPosts + 1);
  assert.deepEqual(posts(h).at(-1).body, posts(h)[0].body, 'The retry is the exact unchanged provider input');
  assert.equal(posts(h).at(-1).body.duration, '9');
  assert.equal(posts(h).at(-1).body.resolution, '1080p');
  assert.equal(posts(h).at(-1).body.generate_audio, true);
  assert.deepEqual(await h.read(FAL_FUNDING_PATH), ledger);
  assert.deepEqual(await h.read(`payments/orders/${h.orderId}.json`), order);
  assert.deepEqual(await h.read(h.jobPath(h.source.id)), source);
});

test('concurrent initial approvals adopt one durable retry even with different provider-proof timestamps', async () => {
  let proofs = 0, releaseSecond;
  const firstClaim = new Promise(resolve => { releaseSecond = resolve; });
  const h = await retryFixture({ beforeProof: async () => { if (++proofs === 2) await firstClaim; } });
  const originalSet = h.records.set.bind(h.records);
  let intercepted = false;
  h.records.set = (path, value) => {
    const result = originalSet(path, value);
    if (!intercepted && path === `production/correction-retry-claims/${h.correctionId}.json`) {
      intercepted = true; h.advance(37); releaseSecond();
    }
    return result;
  };
  let outcomes;
  try { outcomes = await Promise.allSettled([h.approve(), h.approve()]); }
  finally { h.records.set = originalSet; releaseSecond(); }
  assert.equal(intercepted, true);
  assert.equal(proofs, 2);
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'fulfilled'],
    outcomes.filter(result => result.status === 'rejected').map(result => result.reason?.stack).join('\n'));
  assert.deepEqual(outcomes[0].value, outcomes[1].value);
  const retry = (await h.read(partialRetryPath(h.correctionId))).value;
  assert.equal(retry.id, outcomes[0].value.id);
  assert.equal((await currentJob(h)).partialCorrectionRetry.id, retry.id);
  await h.enqueue(); await h.run(); await h.run();
  assert.equal(posts(h).length, 2, 'One original failed submission plus exactly one approved replacement');
  assert.equal((await currentJob(h)).status, 'awaiting-assembly');
});

test('lost replacement submission stays uncertain and cannot acquire another paid attempt', async () => {
  const h = await retryFixture(), first = await h.approve();
  h.settings.lostSubmit = true;
  await h.enqueue(); await h.run();
  const retry = (await h.read(partialRetryPath(h.correctionId))).value;
  assert.equal((await h.read(falRequestPath(retry.operationIdentity))).value.state, 'uncertain');
  assert.equal(posts(h).length, 2);
  assert.deepEqual(await h.approve(), first);
  await h.enqueue();
  for (let pass = 0; pass < 3; pass++) await h.run();
  assert.equal(posts(h).length, 2);
  assert.equal((await h.read(falRequestPath(retry.operationIdentity))).value.state, 'uncertain');
  assert.deepEqual((await currentJob(h)).shots.filter(shot => shot.id !== h.input.shotId), retained(h));
});

test('a terminal failure of the sole replacement cannot reset the job or create a third request', async () => {
  const h = await retryFixture(); await h.approve(); h.settings.retryFailure = true;
  await h.enqueue(); await h.run(); await h.run();
  const before = await h.read(h.jobPath(h.targetId)), retry = (await h.read(partialRetryPath(h.correctionId))).value;
  assert.equal(before.value.status, 'failed');
  assert.equal((await h.read(falRequestPath(retry.operationIdentity))).value.state, 'failed');
  assert.equal(posts(h).length, 2);
  await h.approve(); await h.enqueue(); await h.run();
  assert.deepEqual(await h.read(h.jobPath(h.targetId)), before);
  assert.equal(posts(h).length, 2);
});
