import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner, OWNER_EMAIL } from './access.mjs';

const HASH = /^[a-f0-9]{64}$/;
const fail = () => Object.assign(new Error('The owner-funded production allowance needs verification.'), { code: 'PRODUCTION_ALLOWANCE_INVALID' });
export function productionAllowancePath(orderId) {
  if (!HASH.test(orderId || '')) throw fail();
  return `production/allowances/${orderId}.json`;
}

// An allowance is a separate merchant expense authorization. It cannot alter a
// customer price, invoice, payment, receipt, or refund, and never proves payment.
export async function readProductionAllowance({ order, read = readRecord, now = Date.now }) {
  const path = productionAllowancePath(order.id), record = await read(path);
  if (!record) return { budgetCents: order.providerCostCents, quoteReference: null, recheck: async () => {
    if (await read(path)) throw fail();
  } };
  const value = record.value, owner = await read(userPath(OWNER_EMAIL));
  if (!record.etag || !owner?.etag || !isOwner(owner.value) || owner.value.mustChangePassword
    || value?.version !== 1 || value.funding !== 'merchant' || value.approvedBy !== OWNER_EMAIL
    || value.orderId !== order.id || value.customerEmail !== order.customerEmail || value.preparedId !== order.preparedId
    || value.manifestHash !== order.manifestHash || value.currency !== 'USD' || value.customerAmountCents !== order.amountCents
    || value.originalProviderCostCents !== order.providerCostCents || value.environment !== order.merchantBinding?.environment
    || !Number.isSafeInteger(value.maximumCostCents) || value.maximumCostCents <= order.providerCostCents || value.maximumCostCents > 100_000_000
    || typeof value.quoteReference !== 'string' || !value.quoteReference.trim() || value.quoteReference.length > 200
    || !Number.isFinite(Date.parse(value.approvedAt)) || Date.parse(value.approvedAt) > now()
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now()) throw fail();
  return { budgetCents: value.maximumCostCents, quoteReference: value.quoteReference, recheck: async () => {
    const current = await read(path), account = await read(userPath(OWNER_EMAIL));
    if (current?.etag !== record.etag || account?.etag !== owner.etag || Date.parse(value.expiresAt) <= now()) throw fail();
  } };
}

export async function createProductionAllowance({ actor, orderId, maximumCostCents, quoteProvider,
  read = readRecord, write = writeRecord, now = Date.now }) {
  const persisted = actor?.email && await read(userPath(actor.email));
  if (!persisted?.etag || !isOwner(persisted.value) || persisted.value.mustChangePassword || !isOwner(actor)) throw fail();
  const path = productionAllowancePath(orderId), order = await read(`payments/orders/${orderId}.json`), value = order?.value;
  if (!order?.etag || value?.id !== orderId || value.status !== 'captured' || value.refundedCents !== 0
    || value.refundOperation || value.checkOperation || !HASH.test(value.manifestHash || '') || value.currency !== 'USD'
    || !Number.isSafeInteger(maximumCostCents) || maximumCostCents <= value.providerCostCents || maximumCostCents > 100_000_000
    || typeof quoteProvider !== 'function') throw fail();
  const existing = await read(path);
  if (existing) {
    await readProductionAllowance({ order: value, read, now });
    if (existing.value.maximumCostCents !== maximumCostCents) throw fail();
    return existing.value;
  }
  const quote = await quoteProvider({ email: value.customerEmail, preparedId: value.preparedId, manifestHash: value.manifestHash,
    environment: value.merchantBinding?.environment, budgetCents: maximumCostCents });
  if (quote?.preparedId !== value.preparedId || quote.manifestHash !== value.manifestHash || quote.environment !== value.merchantBinding?.environment
    || quote.currency !== 'USD' || quote.apiVerified !== true || quote.qualityVerified !== true || quote.commercialTermsVerified !== true
    || !Number.isSafeInteger(quote.maximumCostCents) || quote.maximumCostCents !== maximumCostCents
    || !Number.isSafeInteger(quote.providerCostCents) || quote.providerCostCents < 0 || quote.providerCostCents > maximumCostCents
    || typeof quote.quoteReference !== 'string' || !quote.quoteReference.trim() || quote.quoteReference.length > 200
    || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now()) throw fail();
  if ((await read(`payments/orders/${orderId}.json`))?.etag !== order.etag
    || (await read(userPath(actor.email)))?.etag !== persisted.etag) throw fail();
  const allowance = { version: 1, funding: 'merchant', orderId, customerEmail: value.customerEmail, preparedId: value.preparedId,
    manifestHash: value.manifestHash, currency: 'USD', customerAmountCents: value.amountCents, originalProviderCostCents: value.providerCostCents,
    maximumCostCents, environment: quote.environment, quoteReference: quote.quoteReference, approvedBy: actor.email,
    approvedAt: new Date(now()).toISOString(), expiresAt: quote.expiresAt, reason: 'Fulfill the existing paid film without another customer charge.' };
  await write(path, allowance);
  const saved = await read(path);
  if (!saved?.etag || digest(JSON.stringify(saved.value)) !== digest(JSON.stringify(allowance))) throw fail();
  return saved.value;
}
