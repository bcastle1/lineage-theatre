import test from 'node:test';
import assert from 'node:assert/strict';
import { createFalComparison, comparisonPath } from '../api/_lib/fal-comparison.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { FAL_LEGACY_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';

function fixture() {
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject());
  const id = '00000000-0000-4000-8000-000000000002', orderId = digest('fixture-order');
  const job = { id, ownerHash: digest(OWNER_EMAIL), filmId: manifest.filmId, manifest, manifestHash, status: 'prepared',
    shots: manifest.shots.map(s => ({ id: s.id, requestKey: digest(s.id), status: 'prepared' })) };
  const order = { id: orderId, customerEmail: OWNER_EMAIL, preparedId: id, manifestHash, status: 'captured', refundedCents: 0, currency: 'USD', amountCents: 378 };
  const data = new Map([[userPath(OWNER_EMAIL), { email: OWNER_EMAIL, role: 'owner' }], [`payments/orders/${orderId}.json`, order], [`production/jobs/${digest(OWNER_EMAIL)}/${id}.json`, job]]);
  const read = async path => data.has(path) ? { etag: 'fixture-etag', value: structuredClone(data.get(path)) } : null;
  const write = async (path, value) => { if (data.has(path)) throw Error('exists'); data.set(path, structuredClone(value)); };
  const at = Date.parse('2026-10-19T00:00:00Z');
  return { data, read, write, now: () => at, job, order, orderId, actorEmail: OWNER_EMAIL,
    maximumCostCents: 10000, rates: { checkedAt: new Date(at).toISOString(), seedance: 1200000, wan: 200000, reference: 300000 } };
}
function existingApproval(f) {
  f.data.set(comparisonPath(f.orderId), {version:1,approvedBy:f.actorEmail,recipe:FAL_LEGACY_RECIPE_VERSION,
    orderId:f.orderId,preparedId:f.job.id,manifestHash:f.job.manifestHash,customerAmountCents:f.order.amountCents,
    customerEmail:f.order.customerEmail,shotKeysHash:digest(JSON.stringify(f.job.shots.map(s=>[s.id,s.requestKey]))),
    funding:'merchant',maximumCostCents:10000,expiresAt:new Date(f.now()+86400000).toISOString()});
}
test('historical comparison preserves payment and identities but never authorizes new spending', async () => {
  const f = fixture(), before = JSON.stringify(f.order), seen = [];
  existingApproval(f);
  const compare = createFalComparison({ ...f, adapterFactory: model => ({ reconcileShot: async input => {
    assert.equal(await input.authorizeSpend(), false); seen.push([model, input.productionId, input.idempotencyKey]); return { status: 'queued' };
  } }) });
  await compare.begin(f); await compare.begin(f); await compare.pass(f);
  assert.equal(seen.length, 6); assert.equal(JSON.stringify(f.order), before);
  assert.equal(f.data.get(comparisonPath(f.orderId)).funding, 'merchant');
  for (const row of seen) { assert.equal(row[1], f.job.id); assert.ok(f.job.shots.some(s => s.requestKey === row[2])); }
});
test('new legacy comparisons are disabled, and invalid saved approvals cannot reconcile', async () => {
  const fresh=fixture();
  await assert.rejects(createFalComparison(fresh).begin(fresh), /New multi-provider comparisons are disabled/);
  assert.equal(fresh.data.has(comparisonPath(fresh.orderId)),false);
  for (const mutate of [f => { f.order.refundedCents = 1; }, f => { f.data.get(userPath(OWNER_EMAIL)).status = 'suspended'; },
    f => { f.job.manifest.title = 'Changed'; }, f => { f.data.get(comparisonPath(f.orderId)).maximumCostCents=10001; }]) {
    const f = fixture(); existingApproval(f); mutate(f); await assert.rejects(createFalComparison(f).begin(f));
  }
});
test('revocation between shots stops reconciliation even after historical comparison approval', async () => {
  const f = fixture(); existingApproval(f); let calls = 0;
  const compare = createFalComparison({ ...f, adapterFactory: () => ({ reconcileShot: async input => {
    if (++calls === 1) f.order.refundedCents = 378;
    assert.equal(await input.authorizeSpend(), false); return { status: 'queued' };
  } }) });
  await compare.begin(f); await assert.rejects(compare.pass(f)); assert.equal(calls, 1);
});
