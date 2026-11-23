import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { readPaidFilmCorrection } from '../api/_lib/paid-film-correction.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { contextSuccessorFixture } from './fixtures/context-successor.mjs';

async function fixture() {
  const h = await contextSuccessorFixture(); await h.approve();
  const paths = [ `production/correction-claims/${h.correctionId}.json`, userPath(h.email),
    `production/correction-targets/${digest(h.email)}/${h.targetId}.json`, h.jobPath(h.targetId),
    `payments/orders/${h.orderId}.json`, h.jobPath(h.source.id) ];
  return { ...h, paths };
}

function overlap(h, mutatePath) {
  const expected = new Set(h.paths), captured = new Map(); let release, armed = true, peak = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(() => release(), 1000);
  const read = async path => {
    const value = await h.read(path);
    if (!armed || !expected.has(path)) return value;
    captured.set(path, value); peak = Math.max(peak, captured.size);
    if (captured.size === expected.size) {
      armed = false;
      // Even an otherwise-identical rewrite changes the durable validator.
      // It cannot disappear inside a concurrent read snapshot.
      if (mutatePath) h.mutate(mutatePath, () => {});
      release();
    }
    await barrier;
    return value;
  };
  return { read, peak: () => peak, close: () => clearTimeout(timer) };
}

test('nested correction reads overlap independent records and preserve the exact completed-film payment coverage', async () => {
  const h = await fixture(), before = structuredClone([...h.records]), group = overlap(h);
  try {
    const context = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: group.read, now: h.now });
    await context.recheck(); assert.equal(group.peak(), 6);
    assert.equal(context.grant.partial.version, 3); assert.equal(context.order.id, h.orderId);
    assert.deepEqual([...h.records], before);
  } finally { group.close(); }
  await h.enqueue();
  for (let index = 0; index < 6; index++) { await h.run(); if (h.records.get(h.jobPath(h.targetId)).value.status === 'awaiting-assembly') break; }
  const job = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(job.status, 'awaiting-assembly');
  await requireFinishedFilmPayment({ job, email: h.email, actor: h.actor, read: h.read, now: h.now });
});

test('a concurrent rewrite of any claim, owner, index, target, sale or source remains rejected by the exact recheck', async () => {
  const h = await fixture();
  for (const path of h.paths) {
    const group = overlap(h, path);
    try {
      await assert.rejects(async () => {
        const context = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: group.read, now: h.now });
        await context.recheck();
      });
      assert.equal(group.peak(), 6);
    } finally { group.close(); }
  }
});

test('parallel reads never extend a production permission after its payment evidence expires', async () => {
  const h = await fixture(), posts = h.calls.filter(value => value.method === 'POST').length;
  h.settings.proofExpiry = new Date(h.now() + 15000).toISOString();
  h.settings.onProofRecheck = () => h.advance(15001);
  await assert.rejects(h.service.authorizeProduction({ email: h.email, orderId: h.correctionId,
    preparedId: h.targetId, manifestHash: h.built.manifestHash }));
  assert.equal(h.calls.filter(value => value.method === 'POST').length, posts);
});
