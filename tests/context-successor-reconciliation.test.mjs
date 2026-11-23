import test from 'node:test';
import assert from 'node:assert/strict';
import { contextSuccessorFixture } from './fixtures/context-successor.mjs';
import { readPaidFilmCorrection } from '../api/_lib/paid-film-correction.mjs';
import { createProductionQueue } from '../api/_lib/production-queue.mjs';
import { FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { buildContextSuccessorManifest, contextSuccessorPreparedId } from '../api/_lib/context-successor.mjs';

const posts = h => h.calls.filter(row => row.method === 'POST');
const intentPath = h => `production/correction-successor-intents/${h.parent.grant.id}.json`;
const grantPath = h => `production/corrections/${h.correctionId}.json`;
async function finishShots(h, initialPosts) {
  await h.enqueue();
  for (let pass = 0; pass < 8; pass++) {
    await h.run();
    if ((await h.read(h.jobPath(h.targetId))).value.status === 'awaiting-assembly') break;
  }
  const job = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(job.status, 'awaiting-assembly');
  assert.equal(posts(h).length, initialPosts + 1);
  assert.equal(posts(h).at(-1).body.duration, '9'); assert.equal(posts(h).at(-1).body.resolution, '1080p');
  assert.equal(posts(h).at(-1).body.generate_audio, true);
  for (const old of h.parent.job.shots.filter(shot => shot.id !== h.input.shotId))
    assert.deepEqual(job.shots.find(shot => shot.id === old.id).output, old.output);
}

test('interrupted context draft resumes frozen approval and reconciles publication and queue replies without repeating paid work', async () => {
  const h = await contextSuccessorFixture(), targetPath = h.jobPath(h.targetId), initialPosts = posts(h).length;
  const ledger = await h.read(FAL_FUNDING_PATH), order = await h.read(`payments/orders/${h.orderId}.json`);
  const oldSet = h.records.set.bind(h.records), oldGet = h.records.get.bind(h.records);
  let draftWritten = false, interrupted = false, lostPublication = false;
  h.records.set = (path, value) => {
    const result = oldSet(path, value);
    if (path === targetPath) draftWritten = true;
    if (path === grantPath(h) && !lostPublication) { lostPublication = true; throw Error('Synthetic published context grant reply lost'); }
    return result;
  };
  h.records.get = path => {
    if (draftWritten && !interrupted && path === targetPath) { interrupted = true; throw Error('Synthetic interruption after context draft'); }
    return oldGet(path);
  };
  let approved, intent;
  try {
    await assert.rejects(h.approve(), /interruption after context draft/);
    assert.equal(await h.read(grantPath(h)), null); intent = await h.read(intentPath(h));
    h.advance(5000); approved = await h.approve();
  } finally { h.records.set = oldSet; h.records.get = oldGet; }
  assert.equal(interrupted, true); assert.equal(lostPublication, true);
  assert.deepEqual(await h.read(intentPath(h)), intent);
  const grant = (await h.read(grantPath(h))).value;
  assert.equal(grant.approvedAt, intent.value.approvedAt); assert.deepEqual(grant.partial.providerProof, intent.value.providerProof);
  let lostQueue = false;
  const queue = createProductionQueue({ read: h.read, now: h.now, film: h.film, paymentService: h.service,
    write: async (path, value, etag) => {
      await h.write(path, value, etag);
      if (!lostQueue && path === h.targetQueuePath) { lostQueue = true; throw Error('Synthetic context queue reply lost'); }
    } });
  await queue.enqueue({ actor: h.actor, id: h.targetId, orderId: h.correctionId }); assert.equal(lostQueue, true);
  (await Promise.all([h.approve(), h.approve()])).forEach(value => assert.deepEqual(value, approved));
  await finishShots(h, initialPosts);
  assert.deepEqual(await h.read(FAL_FUNDING_PATH), ledger);
  assert.deepEqual(await h.read(`payments/orders/${h.orderId}.json`), order);
});

test('simultaneous context approvals with independently timed proofs and quotes converge to one bounded request', async () => {
  let proofs = 0, releaseSecondProof;
  const intentWritten = new Promise(resolve => { releaseSecondProof = resolve; });
  const h = await contextSuccessorFixture({ beforeContextProof: async () => { if (++proofs === 2) await intentWritten; } });
  const initialPosts = posts(h).length, oldSet = h.records.set.bind(h.records), oldQuote = h.adapter.quote;
  let sawIntent = false, quotes = 0, releaseFirstQuote;
  const secondQuote = new Promise(resolve => { releaseFirstQuote = resolve; }), quoted = [];
  const timeout = setTimeout(() => { releaseSecondProof(); releaseFirstQuote(); }, 2000);
  h.records.set = (path, value) => {
    const result = oldSet(path, value);
    if (!sawIntent && path === intentPath(h)) { sawIntent = true; h.advance(37); releaseSecondProof(); }
    return result;
  };
  h.adapter.quote = async args => {
    if (args.manifestHash !== h.built.manifestHash) return oldQuote(args);
    const number = ++quotes; if (number === 2) h.advance(37);
    const quote = await oldQuote(args); quoted.push(quote);
    if (number === 1) await secondQuote; else releaseFirstQuote();
    return quote;
  };
  let results;
  try { results = await Promise.allSettled([h.approve(), h.approve()]); }
  finally { clearTimeout(timeout); h.records.set = oldSet; h.adapter.quote = oldQuote; releaseSecondProof(); releaseFirstQuote(); }
  assert.equal(sawIntent, true); assert.equal(proofs, 2);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'],
    results.filter(result => result.status === 'rejected').map(result => result.reason?.stack).join('\n'));
  assert.equal(quotes, 2); assert.notEqual(quoted[0].expiresAt, quoted[1].expiresAt);
  assert.deepEqual(results[0].value, results[1].value);
  const context = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: h.read, now: h.now });
  await context.recheck(); assert.equal(context.grant.partial.version, 3);
  await finishShots(h, initialPosts);
});

test('a concurrent different context proposal cannot replace the exact winning intent or create another target', async () => {
  let proofs = 0, releaseSecond;
  const firstIntent = new Promise(resolve => { releaseSecond = resolve; });
  const h = await contextSuccessorFixture({ beforeContextProof: async () => { if (++proofs === 2) await firstIntent; } });
  const initialPosts = posts(h).length, oldSet = h.records.set.bind(h.records);
  const filmContext = 'A different fictional garden scene that the first request did not approve.';
  const different = buildContextSuccessorManifest(h.parent.job.manifest, {
    shotId: h.input.shotId, filmContext, historicalBoundaries: h.input.historicalBoundaries });
  const preparedId = contextSuccessorPreparedId(h.email, h.parent.job.id, different.manifestHash);
  const timeout = setTimeout(releaseSecond, 2000);
  h.records.set = (path, value) => {
    const result = oldSet(path, value); if (path === intentPath(h)) releaseSecond(); return result;
  };
  let results;
  try { results = await Promise.allSettled([h.approve(), h.approve({ filmContext, preparedId, manifestHash: different.manifestHash })]); }
  finally { clearTimeout(timeout); h.records.set = oldSet; releaseSecond(); }
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal((await h.read(intentPath(h))).value.manifestHash, h.input.manifestHash);
  assert.equal(await h.read(h.jobPath(preparedId)), null);
  await finishShots(h, initialPosts);
});

test('payment proof expiring during parallel reservation and source rechecks cannot authorize a context request', async () => {
  const h = await contextSuccessorFixture(), originalGet = h.records.get.bind(h.records);
  const writes = h.writes.length, initialPosts = posts(h).length;
  h.settings.proofExpiry = new Date(h.now() + 100).toISOString();
  let expiredDuringRecheck = false;
  h.records.get = path => {
    if (!expiredDuringRecheck && path === FAL_FUNDING_PATH) { expiredDuringRecheck = true; h.advance(200); }
    return originalGet(path);
  };
  try { await assert.rejects(h.approve()); } finally { h.records.get = originalGet; }
  assert.equal(expiredDuringRecheck, true); assert.equal(h.writes.length, writes);
  assert.equal(posts(h).length, initialPosts); assert.equal(await h.read(intentPath(h)), null);
});
