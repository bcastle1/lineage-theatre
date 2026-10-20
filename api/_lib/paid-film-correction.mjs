import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { createFalFunding, readFalCreditCents } from './fal-funding.mjs';
import { FAL_RECIPE_VERSION, falPlan } from './fal-production.mjs';
import { FAL_MODELS, falRequestPath } from './fal-client.mjs';

const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => digest(JSON.stringify(value));
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const jobPath = (email, id) => `production/jobs/${digest(email)}/${id}.json`;
const targetPath = (email, id) => `production/correction-targets/${digest(email)}/${id}.json`;
const claimPath = id => `production/correction-claims/${id}.json`;
export const correctionIdForOrder = id => digest(`merchant-funded-correction-v1:${id}`);
export function productionCorrectionPath(id) {
  if (!HASH.test(id || '')) throw invalid();
  return `production/corrections/${id}.json`;
}
export class PaidFilmCorrectionError extends Error {
  constructor(message = 'This film correction needs verification before production can continue.', status = 409, code = 'PRODUCTION_CORRECTION_INVALID') {
    super(message); this.name = 'PaidFilmCorrectionError'; this.status = status; this.code = code;
  }
}
const invalid = () => new PaidFilmCorrectionError();
const cents = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
const correctionBudget = value => cents(value) && value <= 1980;
const sourceFields = ['id', 'customerEmail', 'preparedId', 'manifestHash', 'filmId', 'quoteId', 'checkoutMethod',
  'currency', 'amountCents', 'providerCostCents', 'markupCents', 'capturedAt', 'invoiceId', 'customerId',
  'merchantBinding', 'confirmationSource', 'accountingPayments', 'paymentIds'];
export const correctionSourceHash = order => hash(Object.fromEntries(sourceFields.map(key => [key, order?.[key]])));
function paid(order, email, now) {
  return order?.customerEmail === email && HASH.test(order.id || '') && order.id === digest(`${email}:production:${order.manifestHash}`)
    && UUID.test(order.preparedId || '') && HASH.test(order.manifestHash || '') && order.status === 'captured'
    && order.checkoutMethod === 'quickbooks-hosted-invoice' && order.provider === 'quickbooks'
    && order.confirmationSource === 'quickbooks-accounting' && order.currency === 'USD' && cents(order.amountCents)
    && order.refundedCents === 0 && !order.refundOperation && !order.checkOperation && (!order.refunds || order.refunds.length === 0)
    && order.merchantBinding?.environment === 'production' && HASH.test(order.merchantBinding.grantId || '')
    && /^[0-9]{1,30}$/.test(order.merchantBinding.realmId || '') && /^[0-9]{1,30}$/.test(order.invoiceId || '')
    && order.balanceCents === 0 && time(order.capturedAt) && Date.parse(order.capturedAt) <= now()
    && time(order.accountingCheckedAt) && Date.parse(order.accountingCheckedAt) <= now()
    && order.lastCheckStage === 'complete' && order.lastCheckFailureReason === null
    && Array.isArray(order.accountingPayments) && order.accountingPayments.length > 0 && order.accountingPayments.length <= 100
    && order.accountingPayments.every(p => /^[0-9]{1,30}$/.test(p?.id || '') && cents(p.allocatedCents))
    && new Set(order.accountingPayments.map(p => p.id)).size === order.accountingPayments.length
    && order.accountingPayments.reduce((sum, p) => sum + p.allocatedCents, 0) === order.amountCents;
}
function validJob(job, email, id, manifestHash) {
  return job?.id === id && UUID.test(id || '') && job.ownerHash === digest(email) && job.mode === 'customer'
    && job.manifestHash === manifestHash && HASH.test(manifestHash || '') && job.manifest && hash(job.manifest) === manifestHash
    && job.filmId === job.manifest.filmId && Array.isArray(job.shots) && job.shots.length > 0
    && job.shots.length === job.manifest.shots?.length && job.shots.every((shot, i) => shot.id === job.manifest.shots[i].id);
}
function quoteValid(q, grant, now, fresh = true) {
  return q?.preparedId === grant.preparedId && q.manifestHash === grant.manifestHash && q.environment === 'production'
    && q.currency === 'USD' && q.apiVerified === true && q.qualityVerified === true && q.commercialTermsVerified === true
    && cents(q.providerCostCents) && cents(q.maximumCostCents) && q.providerCostCents <= q.maximumCostCents
    && q.maximumCostCents <= grant.maximumCostCents && typeof q.quoteReference === 'string' && q.quoteReference.trim()
    && q.quoteReference.length <= 200 && time(q.expiresAt) && (!fresh || Date.parse(q.expiresAt) > now());
}
function summary(grant) {
  return { correctionId: grant.id, originalOrderId: grant.originalOrderId, preparedId: grant.preparedId,
    manifestHash: grant.manifestHash, maximumCostCents: grant.maximumCostCents, status: 'authorized', customerChargeCents: 0 };
}

// This separate private grant never changes an invoice, paid quote, order,
// receipt, or the original film. The source claim permits one correction only.
export async function readPaidFilmCorrection({ email, job, correctionId, read = readRecord, now = Date.now }) {
  if (typeof email !== 'string' || email !== email.trim().toLowerCase()) throw invalid();
  const index = job ? await read(targetPath(email, job.id)) : null;
  const id = correctionId || index?.value?.correctionId;
  if (!id) return null;
  if (!HASH.test(id)) throw invalid();
  const record = await read(productionCorrectionPath(id)), grant = record?.value;
  if (!record?.etag || grant?.version !== 1 || grant.id !== id || grant.kind !== 'merchant-funded-correction'
    || grant.status !== 'authorized' || grant.customerEmail !== email || grant.approvedBy !== email
    || !HASH.test(grant.originalOrderId || '') || id !== correctionIdForOrder(grant.originalOrderId)
    || !HASH.test(grant.sourceOrderHash || '') || !HASH.test(grant.originalManifestHash || '')
    || !UUID.test(grant.originalPreparedId || '') || !UUID.test(grant.preparedId || '') || !HASH.test(grant.manifestHash || '')
    || grant.originalPreparedId === grant.preparedId || grant.originalManifestHash === grant.manifestHash
    || !correctionBudget(grant.maximumCostCents) || grant.customerChargeCents !== 0 || grant.environment !== 'production'
    || grant.model !== 'kling' || grant.recipe !== FAL_RECIPE_VERSION
    || typeof grant.reason !== 'string' || grant.reason.trim().length < 10 || grant.reason.length > 500
    || !time(grant.approvedAt) || Date.parse(grant.approvedAt) > now() || !quoteValid(grant.quote, grant, now, false)) throw invalid();
  const claim = await read(claimPath(id)), owner = await read(userPath(email));
  const targetIndex = index || await read(targetPath(email, grant.preparedId));
  const expectedIndex = { version: 1, correctionId: id, preparedId: grant.preparedId, manifestHash: grant.manifestHash, grantHash: hash(grant) };
  if (!claim?.etag || hash(claim.value) !== hash(grant) || !owner?.etag || !isOwner(owner.value) || owner.value.mustChangePassword
    || owner.value.email !== email || !targetIndex?.etag || hash(targetIndex.value) !== hash(expectedIndex)) throw invalid();
  const target = await read(jobPath(email, grant.preparedId)), original = await read(`payments/orders/${grant.originalOrderId}.json`);
  const source = await read(jobPath(email, grant.originalPreparedId)), value = original?.value;
  if (!target?.etag || !validJob(target.value, email, grant.preparedId, grant.manifestHash)
    || job && hash(job) !== hash(target.value) || target.value.filmId !== grant.filmId
    || hash(target.value.manifest.screenplay) !== grant.screenplayHash || hash(target.value.manifest.sources) !== grant.sourcesHash
    || !source?.etag || !validJob(source.value, email, grant.originalPreparedId, grant.originalManifestHash)
    || !original?.etag || !paid(value, email, now) || value.id !== grant.originalOrderId
    || value.preparedId !== grant.originalPreparedId || value.manifestHash !== grant.originalManifestHash
    || correctionSourceHash(value) !== grant.sourceOrderHash) throw invalid();
  return { grant, order: value, job: target.value, recheck: async () => {
    const current = await Promise.all([read(productionCorrectionPath(id)), read(claimPath(id)), read(targetPath(email, grant.preparedId)),
      read(userPath(email)), read(jobPath(email, grant.preparedId)), read(`payments/orders/${grant.originalOrderId}.json`), read(jobPath(email, grant.originalPreparedId))]);
    if (current.some((r, i) => r?.etag !== [record, claim, targetIndex, owner, target, original, source][i]?.etag)) throw invalid();
  } };
}

export function correctionCoverage(context) {
  const { grant, order } = context;
  return { kind: 'original-payment', correctionId: grant.id, orderId: order.id, originalPreparedId: grant.originalPreparedId,
    amountCents: order.amountCents, currency: 'USD', receiptAvailable: true, customerChargeCents: 0 };
}

export function createPaidFilmCorrections({ read = readRecord, write = writeRecord, now = Date.now,
  quoteProvider = async ({ email, preparedId, manifestHash, budgetCents }) => {
    const { falProductionAdapter: adapter } = await import('./fal-production.mjs');
    const record = await read(jobPath(email, preparedId)), job = record?.value;
    if (!record?.etag || !validJob(job, email, preparedId, manifestHash) || !adapter.available
      || adapter.model !== 'kling' || adapter.modelVersion !== FAL_RECIPE_VERSION) throw invalid();
    const validation = await adapter.validateManifest(structuredClone(job.manifest));
    if (validation?.ready !== true || !cents(validation.maximumCostCents) || validation.maximumCostCents > budgetCents) throw invalid();
    // Pricing is read-only, including after a shot has started. The immutable
    // grant retains its execution identity; no provider operation is replayed.
    const quote = await adapter.quote({ manifest: structuredClone(job.manifest), manifestHash,
      idempotencyKey: digest(`correction-price:${preparedId}:${manifestHash}:${now()}`) });
    if (quote?.manifestHash !== manifestHash || (await read(jobPath(email, preparedId)))?.etag !== record.etag) throw invalid();
    return { ...quote, preparedId, manifestHash, environment: 'production', maximumCostCents: validation.maximumCostCents,
      apiVerified: adapter.evidence?.apiVerified === true, qualityVerified: adapter.evidence?.qualityVerified === true,
      commercialTermsVerified: adapter.evidence?.commercialTermsVerified === true };
  },
  recoveryQuoteProvider = async ({ email, preparedId, manifestHash }) => {
    // An explicitly stopped queue has no fresh worker heartbeat. This separate
    // read-only price check retains the qualified model and exact saved plan.
    const { createFalProductionAdapter } = await import('./fal-production.mjs');
    const adapter = createFalProductionAdapter({ requireWorker: false });
    const record = await read(jobPath(email, preparedId)), job = record?.value;
    if (!record?.etag || !validJob(job, email, preparedId, manifestHash) || !adapter.available
      || adapter.model !== 'kling' || adapter.modelVersion !== FAL_RECIPE_VERSION) throw invalid();
    const validation = await adapter.validateManifest(structuredClone(job.manifest));
    const quote = await adapter.quote({ manifest: structuredClone(job.manifest), manifestHash });
    if (validation?.ready !== true || !cents(validation.maximumCostCents) || quote?.manifestHash !== manifestHash
      || (await read(jobPath(email, preparedId)))?.etag !== record.etag) throw invalid();
    return { ...quote, preparedId, manifestHash, environment: 'production', maximumCostCents: validation.maximumCostCents,
      apiVerified: adapter.evidence.apiVerified === true, qualityVerified: adapter.evidence.qualityVerified === true,
      commercialTermsVerified: adapter.evidence.commercialTermsVerified === true };
  },
  readRecoveryCreditCents = readFalCreditCents,
  verifyPaidSale = input => import('./hosted-checkout.mjs').then(m => m.hostedCheckout.verifyPaidSale(input)),
  reserveFunding = createFalFunding({ read, write, now }).reserve } = {}) {
  async function immutable(path, value) {
    try { await write(path, value); } catch { /* An uncertain write is reconciled by exact readback; never overwritten. */ }
    const saved = await read(path);
    if (!saved?.etag || hash(saved.value) !== hash(value)) throw invalid();
    return saved;
  }
  async function approve({ actor, originalOrderId, preparedId, manifestHash, maximumCostCents, reason, confirmed } = {}) {
    const owner = actor?.email && await read(userPath(actor.email));
    if (!owner?.etag || !isOwner(actor) || actor.mustChangePassword || !isOwner(owner.value) || owner.value.mustChangePassword
      || actor.email !== owner.value.email || confirmed !== true) throw new PaidFilmCorrectionError('Owner confirmation is required for a merchant-funded correction.', 403);
    const email = actor.email;
    if (!HASH.test(originalOrderId || '') || !UUID.test(preparedId || '') || !HASH.test(manifestHash || '') || !correctionBudget(maximumCostCents)
      || typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 500 || /[<>\x00-\x1f\x7f]/.test(reason)) throw invalid();
    const original = await read(`payments/orders/${originalOrderId}.json`), order = original?.value;
    if (!original?.etag || !paid(order, email, now) || order.id !== originalOrderId || order.preparedId === preparedId || order.manifestHash === manifestHash) throw invalid();
    const id = correctionIdForOrder(originalOrderId), path = productionCorrectionPath(id), saved = await read(path);
    const saleInput = { email, orderId: originalOrderId, preparedId: order.preparedId, manifestHash: order.manifestHash };
    const matches = g => g?.originalOrderId === originalOrderId && g.preparedId === preparedId && g.manifestHash === manifestHash
      && g.maximumCostCents === maximumCostCents && g.reason === reason && g.sourceOrderHash === correctionSourceHash(order);
    if (saved) {
      const context = await readPaidFilmCorrection({ email, correctionId: id, read, now });
      if (!matches(context.grant)) throw invalid();
      const proof = await verifyPaidSale(saleInput);
      if (correctionSourceHash(proof?.order) !== context.grant.sourceOrderHash || Date.parse(proof.expiresAt) <= now()) throw invalid();
      await context.recheck(); await proof.recheck();
      return summary(context.grant);
    }
    const target = await read(jobPath(email, preparedId)), job = target?.value;
    if (!target?.etag || !validJob(job, email, preparedId, manifestHash) || job.status !== 'prepared'
      || job.shots.some(shot => shot.status !== 'prepared') || job.authorization || job.provider || job.lease) throw invalid();
    const existingTarget = await read(targetPath(email, preparedId));
    if (existingTarget && existingTarget.value.correctionId !== id) throw invalid();
    let grant = (await read(claimPath(id)))?.value;
    if (grant && !matches(grant)) throw invalid();
    if (!grant) {
      const quote = await quoteProvider({ email, preparedId, manifestHash, environment: 'production', budgetCents: maximumCostCents });
      grant = { version: 1, kind: 'merchant-funded-correction', status: 'authorized', id, originalOrderId,
        originalPreparedId: order.preparedId, originalManifestHash: order.manifestHash, sourceOrderHash: correctionSourceHash(order),
        customerEmail: email, preparedId, manifestHash, filmId: job.filmId, screenplayHash: hash(job.manifest.screenplay),
        sourcesHash: hash(job.manifest.sources), model: 'kling', recipe: FAL_RECIPE_VERSION, environment: 'production',
        maximumCostCents, customerChargeCents: 0, quote, approvedBy: email, approvedAt: new Date(now()).toISOString(), reason };
    }
    if (!quoteValid(grant.quote, grant, now, false)) throw invalid();
    const executionQuote = Date.parse(grant.quote.expiresAt) > now() ? grant.quote
      : await quoteProvider({ email, preparedId, manifestHash, environment: 'production', budgetCents: grant.quote.maximumCostCents });
    if (!quoteValid(executionQuote, grant, now) || executionQuote.maximumCostCents > grant.quote.maximumCostCents) throw invalid();
    const proof = await verifyPaidSale(saleInput);
    if (correctionSourceHash(proof?.order) !== grant.sourceOrderHash || !time(proof.expiresAt) || Date.parse(proof.expiresAt) <= now()) throw invalid();
    await proof.recheck();
    if ((await read(jobPath(email, preparedId)))?.etag !== target.etag || (await read(userPath(email)))?.etag !== owner.etag) throw invalid();
    await immutable(claimPath(id), grant);
    await immutable(targetPath(email, preparedId), { version: 1, correctionId: id, preparedId, manifestHash, grantHash: hash(grant) });
    await reserveFunding({ orderId: id, quoteId: hash(grant), customerEmail: email, preparedId, manifestHash, maximumCostCents });
    await proof.recheck();
    if (Date.parse(proof.expiresAt) <= now() || (await read(jobPath(email, preparedId)))?.etag !== target.etag
      || (await read(userPath(email)))?.etag !== owner.etag || !quoteValid(executionQuote, grant, now)) throw invalid();
    await immutable(path, grant);
    const context = await readPaidFilmCorrection({ email, correctionId: id, read, now });
    return summary(context.grant);
  }
  async function authorizeProduction({ email, orderId, preparedId, manifestHash }) {
    const context = await readPaidFilmCorrection({ email, correctionId: orderId, read, now });
    if (!context || context.grant.preparedId !== preparedId || context.grant.manifestHash !== manifestHash) throw invalid();
    const { grant, job } = context;
    if (!['prepared', 'processing', 'uncertain', 'awaiting-assembly'].includes(job.status)) throw invalid();
    const started = job.status !== 'prepared' || job.shots.some(shot => shot.status !== 'prepared');
    if (started && (job.authorization?.correctionId !== grant.id || job.authorization.originalOrderId !== grant.originalOrderId
      || job.authorization.quoteReference !== grant.quote.quoteReference || job.authorization.budgetCents !== grant.quote.maximumCostCents
      || job.authorization.manifestHash !== manifestHash || job.authorization.environment !== 'production'
      || job.provider?.id !== 'fal' || job.provider.model !== 'kling' || job.provider.recipe !== grant.recipe)) throw invalid();
    const executionQuote = await quoteProvider({ email, preparedId, manifestHash, environment: 'production', budgetCents: grant.quote.maximumCostCents });
    if (!quoteValid(executionQuote, grant, now) || executionQuote.maximumCostCents > grant.quote.maximumCostCents) throw invalid();
    const proof = await verifyPaidSale({ email, orderId: grant.originalOrderId, preparedId: grant.originalPreparedId, manifestHash: grant.originalManifestHash });
    if (correctionSourceHash(proof?.order) !== grant.sourceOrderHash || !time(proof.expiresAt) || Date.parse(proof.expiresAt) <= now()) throw invalid();
    await context.recheck(); await proof.recheck();
    const until = Math.min(Date.parse(proof.expiresAt), Date.parse(executionQuote.expiresAt), now() + 60_000);
    if (until <= now()) throw invalid();
    const expiresAt = new Date(until).toISOString();
    return { allowed: true, manifestHash, budgetCents: grant.quote.maximumCostCents, quoteReference: grant.quote.quoteReference,
      expiresAt, environment: 'production', fictionalOnly: false, correctionId: grant.id, originalOrderId: grant.originalOrderId };
  }
  async function authorizeFailedShotRecovery({ email, correctionId, preparedId, manifestHash, recoveryId,
    originalIdentity, originalRequestId, replacementIdentity } = {}) {
    if (![correctionId, manifestHash, recoveryId, originalIdentity, replacementIdentity].every(value => HASH.test(value || ''))
      || !UUID.test(preparedId || '') || !/^[a-zA-Z0-9_-]{8,100}$/.test(originalRequestId || '')
      || recoveryId !== digest(`kling-prompt-recovery-v1:${originalIdentity}:${originalRequestId}`)
      || replacementIdentity !== digest(`${recoveryId}:replacement-v1`)) throw invalid();
    const context = await readPaidFilmCorrection({ email, correctionId, read, now });
    if (!context || context.grant.preparedId !== preparedId || context.grant.manifestHash !== manifestHash) throw invalid();
    const { grant, job } = context, at = now();
    if (job.status !== 'failed' || job.lease?.expiresAt > at || job.artifact
      || job.authorization?.correctionId !== grant.id || job.authorization.originalOrderId !== grant.originalOrderId
      || job.authorization.quoteReference !== grant.quote.quoteReference || job.authorization.budgetCents !== grant.quote.maximumCostCents
      || job.authorization.manifestHash !== manifestHash || job.authorization.environment !== 'production'
      || job.provider?.id !== 'fal' || job.provider.model !== 'kling' || job.provider.recipe !== grant.recipe) throw invalid();
    const snapshots = [];
    const snapshot = async path => { const record = await read(path); snapshots.push({ path, etag: record?.etag }); return record; };
    const queue = await snapshot(`production/queue/${digest(email)}/${preparedId}.json`), ticket = queue?.value;
    const saved = await snapshot(`production/fal/failed-shot-recoveries/${recoveryId}.json`), claim = saved?.value;
    if (!queue?.etag || ticket.version !== 1 || ticket.state !== 'attention' || ticket.email !== email || ticket.id !== preparedId
      || ticket.orderId !== correctionId || ticket.manifestHash !== manifestHash || ticket.lease?.expiresAt > at
      || !saved?.etag || claim.version !== 1 || claim.kind !== 'kling-failed-shot-recovery-v1'
      || claim.recoveryId !== recoveryId || claim.ownerHash !== digest(email) || claim.preparedId !== preparedId
      || claim.manifestHash !== manifestHash || claim.correctionId !== correctionId || claim.model !== 'kling'
      || claim.recipe !== grant.recipe || claim.maximumCostCents !== grant.quote.maximumCostCents
      || claim.maximumTotalCostCents !== grant.maximumCostCents || claim.maximumCostCents !== claim.maximumTotalCostCents
      || claim.originalIdentity !== originalIdentity || claim.originalRequestId !== originalRequestId
      || claim.replacementIdentity !== replacementIdentity || claim.endpoint !== FAL_MODELS.kling
      || !HASH.test(claim.originalInputHash || '') || !HASH.test(claim.inputHash || '') || claim.inputHash === claim.originalInputHash
      || claim.terminalFailure !== 'PROMPT_LENGTH_422' || claim.zeroChargeCents !== 0
      || !HASH.test(claim.billingEvidenceSha256 || '') || !HASH.test(claim.rejectionEvidenceSha256 || '')
      || !time(claim.billingObservedAt) || !time(claim.createdAt) || Date.parse(claim.billingObservedAt) > Date.parse(claim.createdAt)
      || Date.parse(claim.createdAt) > at || !Number.isSafeInteger(claim.priorSpendCents) || claim.priorSpendCents < 0
      || !correctionBudget(claim.totalReplacementMaximumCents) || !correctionBudget(claim.replacementMaximumCents)
      || claim.priorSpendCents + claim.totalReplacementMaximumCents > grant.quote.maximumCostCents
      || !Array.isArray(claim.originalRequests) || claim.originalRequests.length !== job.shots.length
      || !Array.isArray(claim.selectedRequests) || claim.selectedRequests.length < 1 || claim.selectedRequests.length > 2
      || claim.selectedRequests.length > job.shots.length) throw invalid();
    const plan = falPlan(job.manifest, 'kling');
    const selected = new Map();
    for (const item of claim.selectedRequests) {
      if (!Number.isSafeInteger(item?.shotIndex) || item.shotIndex < 1 || item.shotIndex > job.shots.length
        || !/^[a-zA-Z0-9_-]{8,100}$/.test(item.requestId || '') || selected.has(item.shotIndex)) throw invalid();
      selected.set(item.shotIndex, item.requestId);
    }
    if (new Set(claim.originalRequests.map(item => item?.requestId)).size !== job.shots.length) throw invalid();
    let originalSpend = 0, replacementCeiling = 0;
    for (let index = 0; index < job.shots.length; index++) {
      const shot = job.shots[index], identity = digest(`${grant.recipe}:kling:${shot.requestKey}`);
      if (!HASH.test(shot.requestKey || '') || shot.providerJobId !== `fal-${identity}`) throw invalid();
      const record = await snapshot(falRequestPath(identity)), receipt = record?.value;
      const charge = claim.originalRequests.find(item => item.requestId === receipt?.requestId);
      if (!record?.etag || receipt.version !== 1 || receipt.identity !== identity || receipt.endpoint !== FAL_MODELS.kling
        || !HASH.test(receipt.inputHash || '') || !/^[a-zA-Z0-9_-]{8,100}$/.test(receipt.requestId || '')
        || !charge || !Number.isSafeInteger(charge.amountCents) || charge.amountCents < 0) throw invalid();
      originalSpend += charge.amountCents;
      if (selected.has(index + 1)) {
        if (selected.get(index + 1) !== receipt.requestId || receipt.state !== 'failed' || receipt.failureCode !== 'FAL_RENDER_FAILED'
          || receipt.result || charge.amountCents !== 0 || !['failed', 'queued', 'processing', 'uncertain'].includes(shot.status)) throw invalid();
        replacementCeiling += plan.shots[index].seconds * 15;
      } else if (receipt.state !== 'completed' || charge.amountCents !== plan.shots[index].seconds * 14) throw invalid();
      if (identity === originalIdentity && (claim.shotIndex !== index + 1 || claim.shotId !== shot.id
        || !selected.has(index + 1) || receipt.requestId !== originalRequestId || receipt.inputHash !== claim.originalInputHash
        || claim.providerSeconds !== plan.shots[index].seconds || claim.replacementMaximumCents !== plan.shots[index].seconds * 15)) throw invalid();
    }
    if (selected.get(claim.shotIndex) !== originalRequestId || claim.shotId !== job.shots[claim.shotIndex - 1]?.id
      || originalIdentity !== digest(`${grant.recipe}:kling:${job.shots[claim.shotIndex - 1]?.requestKey}`)
      || claim.priorSpendCents < originalSpend + plan.referenceCount * 30
      || claim.totalReplacementMaximumCents !== replacementCeiling || claim.replacementMaximumCents > claim.totalReplacementMaximumCents
      || await snapshot(falRequestPath(replacementIdentity)) || await snapshot(`production/fal/choices/${originalIdentity}.json`)) throw invalid();
    const executionQuote = await recoveryQuoteProvider({ email, preparedId, manifestHash, environment: 'production', budgetCents: grant.quote.maximumCostCents });
    if (!quoteValid(executionQuote, grant, now) || executionQuote.maximumCostCents > grant.quote.maximumCostCents) throw invalid();
    // Only the remaining repair ceiling needs wallet capacity. The original
    // correction reservation, invoice and paid amount are never recreated.
    const available = await readRecoveryCreditCents();
    if (!Number.isSafeInteger(available) || available < claim.totalReplacementMaximumCents) throw invalid();
    const proof = await verifyPaidSale({ email, orderId: grant.originalOrderId, preparedId: grant.originalPreparedId, manifestHash: grant.originalManifestHash });
    if (correctionSourceHash(proof?.order) !== grant.sourceOrderHash || !time(proof.expiresAt) || Date.parse(proof.expiresAt) <= now()) throw invalid();
    await context.recheck(); await proof.recheck();
    for (const saved of snapshots) if ((await read(saved.path))?.etag !== saved.etag) throw invalid();
    const until = Math.min(Date.parse(proof.expiresAt), Date.parse(executionQuote.expiresAt), now() + 60_000);
    if (until <= now()) throw invalid();
    return { allowed: true, environment: 'production', fictionalOnly: false, preparedId, manifestHash, correctionId,
      originalOrderId: grant.originalOrderId, budgetCents: grant.quote.maximumCostCents, quoteReference: grant.quote.quoteReference,
      recoveryId, originalIdentity, originalRequestId, replacementIdentity, inputHash: claim.inputHash,
      replacementMaximumCents: claim.replacementMaximumCents, totalReplacementMaximumCents: claim.totalReplacementMaximumCents,
      expiresAt: new Date(until).toISOString() };
  }
  return { approve, authorizeProduction, authorizeFailedShotRecovery };
}
export const paidFilmCorrections = createPaidFilmCorrections();
