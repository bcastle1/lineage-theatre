import test from 'node:test';
import assert from 'node:assert/strict';
import { successorFixture } from './fixtures/narration-successor.mjs';
import { readPaidFilmCorrection } from '../api/_lib/paid-film-correction.mjs';
import { createProductionQueue } from '../api/_lib/production-queue.mjs';
import { narrationSuccessorPath } from '../api/_lib/narration-successor.mjs';
import { FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';

const posts = h => h.calls.filter(row => row.method === 'POST');
const intentPath = h => `production/correction-successor-intents/${h.parent.grant.id}.json`;
const grantPath = h => `production/corrections/${h.correctionId}.json`;
async function finishShots(h) {
  await h.enqueue();
  for (let pass = 0; pass < 8; pass++) {
    await h.run();
    if ((await h.read(h.jobPath(h.targetId))).value.status === 'awaiting-assembly') break;
  }
  const job = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(job.status, 'awaiting-assembly');
  assert.equal(posts(h).length, 3, 'Two predecessor failures plus exactly one new narration request');
  assert.equal(posts(h).at(-1).body.duration, '9');
  assert.equal(posts(h).at(-1).body.resolution, '1080p');
  assert.equal(posts(h).at(-1).body.generate_audio, true);
  for (const old of h.parent.job.shots.filter(shot => shot.id !== h.input.shotId))
    assert.deepEqual(job.shots.find(shot => shot.id === old.id).output, old.output);
}

test('approval interrupted after creating the draft resumes the frozen intent without orphaning or replacing three clips', async () => {
  const h = await successorFixture(), targetPath = h.jobPath(h.targetId);
  const ledger = await h.read(FAL_FUNDING_PATH), order = await h.read(`payments/orders/${h.orderId}.json`);
  const oldSet = h.records.set.bind(h.records), oldGet = h.records.get.bind(h.records);
  let draftWritten = false, interrupted = false;
  h.records.set = (path, value) => { const result = oldSet(path, value); if (path === targetPath) draftWritten = true; return result; };
  h.records.get = path => {
    if (draftWritten && !interrupted && path === targetPath) { interrupted = true; throw Error('Synthetic interruption after durable draft'); }
    return oldGet(path);
  };
  try { await assert.rejects(h.approve(), /interruption after durable draft/); }
  finally { h.records.set = oldSet; h.records.get = oldGet; }
  assert.equal(interrupted, true);
  assert.equal(await h.read(grantPath(h)), null);
  const intent = await h.read(intentPath(h)), draft = await h.read(targetPath);
  h.advance(5000);
  const approved = await h.approve();
  assert.equal(approved.preparedId, h.targetId);
  assert.deepEqual(await h.read(intentPath(h)), intent);
  assert.deepEqual(await h.read(targetPath), draft);
  assert.equal((await h.read(grantPath(h))).value.approvedAt, intent.value.approvedAt);
  assert.deepEqual((await h.read(grantPath(h))).value.partial.providerProof, intent.value.providerProof);
  await finishShots(h);
  assert.deepEqual(await h.read(FAL_FUNDING_PATH), ledger);
  assert.deepEqual(await h.read(`payments/orders/${h.orderId}.json`), order);
});

test('simultaneous approvals adopt one intent and grant despite distinct provider-proof and quote timestamps', async () => {
  let proofs = 0, releaseSecondProof;
  const intentWritten = new Promise(resolve => { releaseSecondProof = resolve; });
  const h = await successorFixture({ beforeSuccessorProof: async () => { if (++proofs === 2) await intentWritten; } });
  const originalSet = h.records.set.bind(h.records), originalQuote = h.adapter.quote;
  let sawIntent = false, quotes = 0, releaseFirstQuote;
  const secondQuote = new Promise(resolve => { releaseFirstQuote = resolve; });
  const quoted = [];
  const barrierTimeout = setTimeout(() => { releaseSecondProof(); releaseFirstQuote(); }, 2000);
  h.records.set = (path, value) => {
    const result = originalSet(path, value);
    if (!sawIntent && path === intentPath(h)) { sawIntent = true; h.advance(37); releaseSecondProof(); }
    return result;
  };
  h.adapter.quote = async args => {
    if (args.manifestHash !== h.built.manifestHash) return originalQuote(args);
    const number = ++quotes;
    if (number === 2) h.advance(37);
    const quote = await originalQuote(args); quoted.push(quote);
    if (number === 1) await secondQuote; else releaseFirstQuote();
    return quote;
  };
  let results;
  try { results = await Promise.allSettled([h.approve(), h.approve()]); }
  finally { clearTimeout(barrierTimeout); h.records.set = originalSet; h.adapter.quote = originalQuote; releaseSecondProof(); releaseFirstQuote(); }
  assert.equal(sawIntent, true); assert.equal(proofs, 2);
  assert.equal(quotes, 2, results.filter(result => result.status === 'rejected').map(result => result.reason?.stack).join('\n'));
  assert.notEqual(quoted[0].expiresAt, quoted[1].expiresAt, 'The two contenders obtained independently timed quotes');
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'],
    results.filter(result => result.status === 'rejected').map(result => result.reason?.stack).join('\n'));
  assert.deepEqual(results[0].value, results[1].value);
  const context = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: h.read, now: h.now });
  await context.recheck();
  assert.equal((await h.read(narrationSuccessorPath(h.parent.grant.id))).value.correctionId, h.correctionId);
  assert.equal((await h.read(intentPath(h))).value.approvedAt, context.grant.approvedAt);
  await finishShots(h);
});

test('lost grant-publication and queue replies reconcile the same successor without another submission', async () => {
  const h = await successorFixture(), originalSet = h.records.set.bind(h.records);
  let lostPublication = false;
  h.records.set = (path, value) => {
    const result = originalSet(path, value);
    if (!lostPublication && path === grantPath(h)) { lostPublication = true; throw Error('Synthetic published grant reply lost'); }
    return result;
  };
  let approved;
  try { approved = await h.approve(); } finally { h.records.set = originalSet; }
  assert.equal(lostPublication, true);
  let lostQueue = false;
  const queue = createProductionQueue({ read: h.read, now: h.now, film: h.film, paymentService: h.service,
    write: async (path, value, etag) => {
      await h.write(path, value, etag);
      if (!lostQueue && path === h.targetQueuePath) { lostQueue = true; throw Error('Synthetic durable queue reply lost'); }
    } });
  await queue.enqueue({ actor: h.actor, id: h.targetId, orderId: h.correctionId });
  assert.equal(lostQueue, true);
  const stable = await h.read(h.jobPath(h.targetId));
  (await Promise.all([h.approve(), h.approve()])).forEach(value => assert.deepEqual(value, approved));
  assert.deepEqual(await h.read(h.jobPath(h.targetId)), stable);
  await finishShots(h);
});
