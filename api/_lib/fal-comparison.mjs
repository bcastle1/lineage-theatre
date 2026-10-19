import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { createFalProductionAdapter, falPlan, FAL_RECIPE_VERSION } from './fal-production.mjs';

const fail = () => { throw new Error('The paid-film comparison authorization could not be verified.'); };
export const comparisonPath = orderId => {
  if (!/^[a-f0-9]{64}$/.test(orderId || '')) fail();
  return `production/fal/comparisons/${orderId}.json`;
};

// Merchant-funded acceptance renders use the SAME shot request identities that
// normal paid production will read. Selecting a candidate never renders it again.
// This ledger does not change a customer payment or assert provider qualification.
export function createFalComparison({ read = readRecord, write = writeRecord,
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
  async function begin({ orderId, actorEmail, maximumCostCents, rates }) {
    comparisonPath(orderId);
    const ctx = await context(orderId, actorEmail), existing = await read(comparisonPath(orderId));
    if (existing) { if (!matches(existing.value, ctx, actorEmail)) fail(); return existing.value; }
    if (ctx.job.status !== 'prepared' || ctx.job.shots.some(s => s.status !== 'prepared')
      || !Number.isSafeInteger(maximumCostCents) || maximumCostCents < 1 || maximumCostCents > 10000
      || !rates || now() - Date.parse(rates.checkedAt) > 3600000 || Date.parse(rates.checkedAt) > now()
      || !Number.isFinite(Date.parse(rates.checkedAt))) fail();
    let cost = 0;
    for (const model of ['seedance', 'wan']) {
      if (!Number.isSafeInteger(rates[model]) || rates[model] <= 0) fail();
      cost += falPlan(ctx.job.manifest, model).generatedSeconds * rates[model];
    }
    if (!Number.isSafeInteger(rates.reference) || rates.reference <= 0) fail();
    cost += falPlan(ctx.job.manifest, 'seedance').referenceCount * rates.reference;
    const estimatedCostCents = Math.ceil(cost / 10000);
    if (estimatedCostCents > maximumCostCents) fail();
    const value = { version: 1, recipe: FAL_RECIPE_VERSION, orderId, preparedId: ctx.job.id,
      manifestHash: ctx.job.manifestHash, customerEmail: ctx.order.customerEmail,
      customerAmountCents: ctx.order.amountCents, funding: 'merchant', approvedBy: actorEmail,
      shotKeysHash: digest(JSON.stringify(ctx.job.shots.map(s => [s.id, s.requestKey]))),
      models: ['seedance', 'wan'], maximumCostCents, estimatedCostCents, rates,
      approvedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 7 * 86400000).toISOString() };
    await write(comparisonPath(orderId), value);
    if (!matches((await read(comparisonPath(orderId)))?.value, ctx, actorEmail)) fail();
    return value;
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
        const saved = ctx.job.shots.find(s => s.id === shot.id);
        const result = await adapter.reconcileShot({ manifest: ctx.job.manifest, manifestHash: ctx.job.manifestHash,
          shot, productionId: ctx.job.id, idempotencyKey: saved.requestKey,
          authorizeSpend: async () => {
            const current = await context(orderId, actorEmail), approvalNow = (await read(comparisonPath(orderId)))?.value;
            return matches(approvalNow, current, actorEmail) && current.job.status === 'prepared'
              && current.job.shots.every(s => s.status === 'prepared');
          } });
        results.push({ model, shotId: shot.id, ...result });
      }
    }
    return { manifest: ctx.job.manifest, manifestHash: ctx.job.manifestHash, results };
  }
  return { begin, pass };
}
