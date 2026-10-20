import { digest, readRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { createFalProductionAdapter, FAL_LEGACY_RECIPE_VERSION as FAL_RECIPE_VERSION } from './fal-production.mjs';

const fail = () => { throw new Error('The paid-film comparison authorization could not be verified.'); };
export const comparisonPath = orderId => {
  if (!/^[a-f0-9]{64}$/.test(orderId || '')) fail();
  return `production/fal/comparisons/${orderId}.json`;
};

// Historical comparison ledgers permit reconciliation of their original tasks.
// They can no longer authorize any new provider operation.
export function createFalComparison({ read = readRecord,
  adapterFactory = model => createFalProductionAdapter({ model }), now = Date.now } = {}) {
  async function context(orderId, actorEmail) {
    const owner = await read(userPath(actorEmail));
    const order = (await read(`payments/orders/${orderId}.json`))?.value;
    if (!owner?.etag || !isOwner(owner.value) || owner.value.mustChangePassword
      || !order || order.id !== orderId || order.status !== 'captured' || order.refundedCents !== 0
      || order.refundOperation || order.checkOperation || order.currency !== 'USD') fail();
    const job = (await read(`production/jobs/${digest(order.customerEmail)}/${order.preparedId}.json`))?.value;
    if (!job || job.ownerHash !== digest(order.customerEmail) || job.id !== order.preparedId
      || job.manifestHash !== order.manifestHash || digest(JSON.stringify(job.manifest)) !== order.manifestHash
      || job.filmId !== job.manifest.filmId || job.shots.length !== job.manifest.shots.length
      || job.shots.some((s, i) => s.id !== job.manifest.shots[i].id || !/^[a-f0-9]{64}$/.test(s.requestKey))) fail();
    return { order, job };
  }
  function matches(value, ctx, actorEmail) {
    return value?.version === 1 && value.approvedBy === actorEmail && value.recipe === FAL_RECIPE_VERSION
      && value.orderId === ctx.order.id && value.preparedId === ctx.job.id && value.manifestHash === ctx.job.manifestHash
      && value.customerAmountCents === ctx.order.amountCents && value.customerEmail === ctx.order.customerEmail
      && value.shotKeysHash === digest(JSON.stringify(ctx.job.shots.map(s => [s.id, s.requestKey])))
      && value.funding === 'merchant' && value.maximumCostCents <= 10000 && value.maximumCostCents > 0
      && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > now();
  }
  async function begin({ orderId, actorEmail }) {
    comparisonPath(orderId);
    const ctx = await context(orderId, actorEmail), existing = await read(comparisonPath(orderId));
    if (existing) { if (!matches(existing.value, ctx, actorEmail)) fail(); return existing.value; }
    // Legacy comparison records remain readable; new movies use Kling only.
    throw new Error('New multi-provider comparisons are disabled. Production uses Kling.');
  }
  async function pass({ orderId, actorEmail }) {
    const ctx = await context(orderId, actorEmail);
    const approval = (await read(comparisonPath(orderId)))?.value;
    if (!matches(approval, ctx, actorEmail)) fail();
    const results = [];
    // Sequential admission also respects the account's concurrency cap. Jobs
    // already in fal's queue execute independently and all requests are durable.
    for (const model of ['seedance', 'wan']) {
      const adapter = adapterFactory(model);
      for (const shot of ctx.job.manifest.shots) {
        const current = await context(orderId, actorEmail);
        if (!matches((await read(comparisonPath(orderId)))?.value, current, actorEmail)) fail();
        const saved = ctx.job.shots.find(s => s.id === shot.id);
        const result = await adapter.reconcileShot({ manifest: ctx.job.manifest, manifestHash: ctx.job.manifestHash,
          shot, productionId: ctx.job.id, idempotencyKey: saved.requestKey,
          authorizeSpend: async () => false });
        results.push({ model, shotId: shot.id, ...result });
      }
    }
    return { manifest: ctx.job.manifest, manifestHash: ctx.job.manifestHash, results };
  }
  return { begin, pass };
}
