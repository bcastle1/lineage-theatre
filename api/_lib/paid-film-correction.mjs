import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { isOwner } from './access.mjs';
import { createFalFunding } from './fal-funding.mjs';
import { FAL_RECIPE_VERSION, SEEDANCE_RECIPE_VERSION } from './fal-production.mjs';
import { buildPartialCorrectionManifest, partialCorrectionPreparedId, buildPartialCorrectionPlan,
  validatePartialCorrection, partialBillingEvidencePath } from './partial-film-correction.mjs';
import { createPartialCorrectionRetry, readPartialCorrectionRetry } from './partial-correction-retry.mjs';
import { createNarrationSuccessor, validateNarrationSuccessor, narrationSuccessorId, NARRATION_SUCCESSOR_KIND } from './narration-successor.mjs';
import { createContextSuccessor, validateContextSuccessor, contextSuccessorId, CONTEXT_SUCCESSOR_KIND } from './context-successor.mjs';

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
const seedanceGrant = grant => grant.model === 'seedance' && grant.recipe === SEEDANCE_RECIPE_VERSION;
const legacyKlingGrant = grant => grant.model === 'kling' && grant.recipe === FAL_RECIPE_VERSION;
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
    || !HASH.test(grant.originalOrderId || '') || id !== (grant.partial?.kind === CONTEXT_SUCCESSOR_KIND
      ? contextSuccessorId(grant.partial.parentCorrectionId, grant.manifestHash) : grant.partial?.kind === NARRATION_SUCCESSOR_KIND
        ? narrationSuccessorId(correctionIdForOrder(grant.originalOrderId), grant.manifestHash) : correctionIdForOrder(grant.originalOrderId))
    || !HASH.test(grant.sourceOrderHash || '') || !HASH.test(grant.originalManifestHash || '')
    || !UUID.test(grant.originalPreparedId || '') || !UUID.test(grant.preparedId || '') || !HASH.test(grant.manifestHash || '')
    || grant.originalPreparedId === grant.preparedId || grant.originalManifestHash === grant.manifestHash
    || !(grant.partial ? cents(grant.maximumCostCents) : correctionBudget(grant.maximumCostCents)) || grant.customerChargeCents !== 0 || grant.environment !== 'production'
    || !(seedanceGrant(grant) || legacyKlingGrant(grant))
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
    || (target.value.manifest.productionPlan?.provider ?? 'kling') !== grant.model
    || job && hash(job) !== hash(target.value) || target.value.filmId !== grant.filmId
    || hash(target.value.manifest.screenplay) !== grant.screenplayHash || hash(target.value.manifest.sources) !== grant.sourcesHash
    || !source?.etag || !validJob(source.value, email, grant.originalPreparedId, grant.originalManifestHash)
    || !original?.etag || !paid(value, email, now) || value.id !== grant.originalOrderId
    || value.preparedId !== grant.originalPreparedId || value.manifestHash !== grant.originalManifestHash
    || correctionSourceHash(value) !== grant.sourceOrderHash) throw invalid();
  const successor = grant.partial?.kind === CONTEXT_SUCCESSOR_KIND
    ? await validateContextSuccessor({ grant, target: target.value, order: value, read, now }) : grant.partial?.kind === NARRATION_SUCCESSOR_KIND
      ? await validateNarrationSuccessor({ grant, target: target.value, order: value, read, now }) : null;
  if (grant.partial && !successor) await validatePartialCorrection({ grant, source: source.value, target: target.value, order: value, read, now });
  const retry = grant.partial && !successor ? await readPartialCorrectionRetry({ grant, job: target.value, order: value }, { read, now }) : null;
  return { grant, order: value, job: target.value, ...(retry ? { retry } : {}), recheck: async () => {
    const current = await Promise.all([read(productionCorrectionPath(id)), read(claimPath(id)), read(targetPath(email, grant.preparedId)),
      read(userPath(email)), read(jobPath(email, grant.preparedId)), read(`payments/orders/${grant.originalOrderId}.json`), read(jobPath(email, grant.originalPreparedId))]);
    if (current.some((r, i) => r?.etag !== [record, claim, targetIndex, owner, target, original, source][i]?.etag)) throw invalid();
    if (successor) await successor.recheck();
    else if (grant.partial) await validatePartialCorrection({ grant, source: source.value, target: target.value, order: value, read, now });
    if (retry) await retry.recheck();
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
      || job.manifest.productionPlan?.provider !== 'seedance' || adapter.model !== 'seedance' || adapter.modelVersion !== SEEDANCE_RECIPE_VERSION) throw invalid();
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
  verifyPaidSale = input => import('./hosted-checkout.mjs').then(m => m.hostedCheckout.verifyPaidSale(input)),
  reserveFunding = createFalFunding({ read, write, now }).reserve,
  verifyFunding = createFalFunding({ read, write, now }).verifyReservation, env = process.env, verifyRetryFailure, verifySuccessorFailure, verifyContextFailure } = {}) {
  async function immutable(path, value) {
    try { await write(path, value); } catch { /* An uncertain write is reconciled by exact readback; never overwritten. */ }
    const saved = await read(path);
    if (!saved?.etag || hash(saved.value) !== hash(value)) throw invalid();
    return saved;
  }
  async function partialQuote({ email, job, partial, maximumCostCents }) {
    const quote = await quoteProvider({ email, preparedId: job.id, manifestHash: job.manifestHash, environment: 'production', budgetCents: maximumCostCents });
    const totalSeconds = partial.generatedSeconds + partial.reused.reduce((sum, row) => sum + row.generatedSeconds, 0);
    // All four requests are text-only Seedance at one rate. Rounding the full
    // quote upward before taking the fraction remains a conservative ceiling.
    const newCost = Math.ceil(quote.maximumCostCents * partial.generatedSeconds / totalSeconds);
    if (!quoteValid(quote, { preparedId: job.id, manifestHash: job.manifestHash, maximumCostCents }, now)
      || !cents(newCost) || newCost > partial.maximumNewCostCents
      || !Number.isSafeInteger(partial.priorCostNanoUsd)
      || BigInt(partial.priorCostNanoUsd) + BigInt(newCost) * 10_000_000n > BigInt(maximumCostCents) * 10_000_000n) throw invalid();
    return { ...quote, providerCostCents: newCost, partialPlanHash: hash(partial) };
  }
  async function heldPartial(email, partial) {
    const held = partial.originalReservation;
    if (partial.billingAccount !== env.FAL_BILLING_ACCOUNT) throw invalid();
    if (await verifyFunding({ orderId: held.orderId, customerEmail: email, preparedId: held.preparedId,
      manifestHash: held.manifestHash, quoteId: held.quoteId, maximumCostCents: held.maximumCostCents }) !== true) throw invalid();
  }
  const verifyCorrectionAuthorization = async (context, maximumNewCostCents) => {
      const { grant, job } = context;
      if (!seedanceGrant(grant) || !grant.partial) throw invalid();
      const quote = await partialQuote({ email: grant.customerEmail, job, partial: grant.partial, maximumCostCents: grant.quote.maximumCostCents });
      if (quote.providerCostCents > maximumNewCostCents || !quoteValid(quote, grant, now)) throw invalid();
      const proof = await verifyPaidSale({ email: grant.customerEmail, orderId: grant.originalOrderId,
        preparedId: grant.originalPreparedId, manifestHash: grant.originalManifestHash });
      const recheck = async () => {
        if (correctionSourceHash(proof?.order) !== grant.sourceOrderHash || !time(proof?.expiresAt) || Date.parse(proof.expiresAt) <= now()
          || !quoteValid(quote, grant, now)) throw invalid();
        await Promise.all([heldPartial(grant.customerEmail, grant.partial), context.recheck(), proof.recheck()]);
        if (Date.parse(proof.expiresAt) <= now() || !quoteValid(quote, grant, now)) throw invalid();
      };
      await recheck(); return { recheck };
    };
  const retryService = createPartialCorrectionRetry({ read, write, now, env,
    ...(verifyRetryFailure ? { verifyFailure: verifyRetryFailure } : {}),
    correctionContext: input => readPaidFilmCorrection({ ...input, read, now }),
    verifyAuthorization: verifyCorrectionAuthorization });
  const approvePartialRetry = input => retryService.approve(input);
  const successorService = createNarrationSuccessor({ read, write, now, env, price: partialQuote,
    authorizeParent: verifyCorrectionAuthorization, ...(verifySuccessorFailure ? { verifyFailure: verifySuccessorFailure } : {}) });
  const approveNarrationSuccessor = input => successorService.approve(input);
  const contextService = createContextSuccessor({ read, write, now, env, price: partialQuote,
    authorizeParent: verifyCorrectionAuthorization, ...(verifyContextFailure ? { verifyFailure: verifyContextFailure } : {}) });
  const approveContextSuccessor = input => contextService.approve(input);
  async function approvePartial({ actor, originalOrderId, preparedId, manifestHash, shotId, visual,
    maximumNewCostCents, reuseEvidence, billingEvidence, reason, confirmed } = {}) {
    const email = actor?.email, owner = email && await read(userPath(email));
    if (!owner?.etag || !isOwner(actor) || !isOwner(owner.value) || owner.value.email !== email
      || actor.mustChangePassword || owner.value.mustChangePassword || confirmed !== true) throw invalid();
    if (!HASH.test(originalOrderId || '') || typeof reason !== 'string' || reason.trim().length < 10
      || reason.length > 500 || /[<>\x00-\x1f\x7f]/.test(reason)) throw invalid();
    const original = await read(`payments/orders/${originalOrderId}.json`), order = original?.value;
    if (!original?.etag || !paid(order, email, now)) throw invalid();
    const source = await read(jobPath(email, order.preparedId));
    if (!source?.etag || !validJob(source.value, email, order.preparedId, order.manifestHash)) throw invalid();
    const sourceQueuePath = `production/queue/${digest(email)}/${order.preparedId}.json`, sourceQueue = await read(sourceQueuePath);
    const health = (await read('production/worker-health.json'))?.value;
    if (!sourceQueue?.etag || sourceQueue.value.state !== 'attention' || source.value.status !== 'failed'
      || sourceQueue.value.lease?.expiresAt > now() || source.value.lease?.expiresAt > now()
      || health?.ready !== true || health.partialCorrectionVersion !== 1 || health.model !== 'seedance'
      || health.recipe !== SEEDANCE_RECIPE_VERSION || !Number.isFinite(Date.parse(health.checkedAt))
      || Date.parse(health.checkedAt) > now() || now() - Date.parse(health.checkedAt) > 180_000) throw invalid();
    const built = buildPartialCorrectionManifest(source.value.manifest, { shotId, visual });
    if (built.manifestHash !== manifestHash || partialCorrectionPreparedId(email, order.preparedId, manifestHash) !== preparedId) throw invalid();
    const correctionId = correctionIdForOrder(originalOrderId), path = productionCorrectionPath(correctionId);
    const saved = await read(path);
    if (saved) {
      const context = await readPaidFilmCorrection({ email, correctionId, read, now }), p = context.grant.partial;
      if (!p || context.grant.preparedId !== preparedId || context.grant.manifestHash !== manifestHash || context.grant.reason !== reason
        || p.shotId !== shotId || p.visual !== visual || p.maximumNewCostCents !== maximumNewCostCents
        || p.billingEvidenceHash !== hash(billingEvidence)
        || !sameReuseEvidence(p.reused, reuseEvidence)) throw invalid();
      const proof = await verifyPaidSale({ email, orderId: originalOrderId, preparedId: order.preparedId, manifestHash: order.manifestHash });
      if (correctionSourceHash(proof?.order) !== context.grant.sourceOrderHash || !time(proof.expiresAt) || Date.parse(proof.expiresAt) <= now()) throw invalid();
      await heldPartial(email, p); await context.recheck(); await proof.recheck();
      return { ...summary(context.grant), maximumNewCostCents: p.maximumNewCostCents };
    }
    const at = new Date(now()).toISOString();
    const draft = { id: preparedId, ownerHash: digest(email), filmId: source.value.filmId, manifestHash, manifest: built.manifest,
      mode: 'customer', provider: { id: 'fal', model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION }, status: 'prepared',
      createdAt: at, updatedAt: at, preparationConsentAt: at, revision: 1,
      shots: built.manifest.shots.map(shot => ({ id: shot.id, status: 'prepared', requestKey: digest(`${preparedId}:${manifestHash}:${shot.id}`) })) };
    const partial = await buildPartialCorrectionPlan({ email, source: source.value, target: draft, order, shotId, visual,
      maximumNewCostCents, reuseEvidence, billingEvidence, account: env.FAL_BILLING_ACCOUNT, read, now });
    draft.partialCorrection = { version: 1, correctionId, planHash: hash(partial) };
    const oldDraft = await read(jobPath(email, preparedId));
    if (oldDraft) {
      if (oldDraft.value.status !== 'prepared' || oldDraft.value.authorization || oldDraft.value.lease
        || hash({ ...oldDraft.value, createdAt: at, updatedAt: at, preparationConsentAt: at }) !== hash(draft)) throw invalid();
    } else await immutable(jobPath(email, preparedId), draft);
    const target = await read(jobPath(email, preparedId)), job = target.value;
    let grant = (await read(claimPath(correctionId)))?.value;
    if (grant && (grant.preparedId !== preparedId || grant.manifestHash !== manifestHash || !sameReuseEvidence(grant.partial?.reused, reuseEvidence)
      || hash(grant.partial) !== hash(partial) || grant.reason !== reason || grant.sourceOrderHash !== correctionSourceHash(order))) throw invalid();
    if (!grant) grant = { version: 1, kind: 'merchant-funded-correction', status: 'authorized', id: correctionId, originalOrderId,
      originalPreparedId: order.preparedId, originalManifestHash: order.manifestHash, sourceOrderHash: correctionSourceHash(order),
      customerEmail: email, preparedId, manifestHash, filmId: job.filmId, screenplayHash: hash(job.manifest.screenplay),
      sourcesHash: hash(job.manifest.sources), model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION, environment: 'production',
      maximumCostCents: order.providerCostCents, customerChargeCents: 0, partial,
      quote: await partialQuote({ email, job, partial, maximumCostCents: order.providerCostCents }), approvedBy: email, approvedAt: at, reason };
    const executionQuote = await partialQuote({ email, job, partial, maximumCostCents: grant.quote.maximumCostCents });
    if (executionQuote.providerCostCents > grant.quote.providerCostCents) throw invalid();
    const proof = await verifyPaidSale({ email, orderId: originalOrderId, preparedId: order.preparedId, manifestHash: order.manifestHash });
    if (correctionSourceHash(proof?.order) !== grant.sourceOrderHash || !time(proof.expiresAt) || Date.parse(proof.expiresAt) <= now()) throw invalid();
    await heldPartial(email, partial); await proof.recheck();
    if ((await read(jobPath(email, preparedId)))?.etag !== target.etag || (await read(userPath(email)))?.etag !== owner.etag
      || (await read(jobPath(email, order.preparedId)))?.etag !== source.etag
      || (await read(sourceQueuePath))?.etag !== sourceQueue.etag) throw invalid();
    await immutable(partialBillingEvidencePath(partial.billingEvidenceHash), billingEvidence);
    await immutable(claimPath(correctionId), grant);
    await immutable(targetPath(email, preparedId), { version: 1, correctionId, preparedId, manifestHash, grantHash: hash(grant) });
    await heldPartial(email, partial); await proof.recheck();
    if (Date.parse(proof.expiresAt) <= now() || (await read(sourceQueuePath))?.etag !== sourceQueue.etag
      || (await read(jobPath(email, order.preparedId)))?.etag !== source.etag) throw invalid();
    await immutable(path, grant);
    const verified = await readPaidFilmCorrection({ email, correctionId, read, now }); await verified.recheck();
    return { ...summary(grant), maximumNewCostCents };
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
    const matches = g => seedanceGrant(g) && g.originalOrderId === originalOrderId && g.preparedId === preparedId && g.manifestHash === manifestHash
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
    if (!target?.etag || !validJob(job, email, preparedId, manifestHash) || job.manifest.productionPlan?.provider !== 'seedance'
      || job.status !== 'prepared' || job.shots.some(shot => shot.status !== 'prepared') || job.authorization || job.lease
      || job.provider && (job.provider.id !== 'fal' || job.provider.model !== 'seedance' || job.provider.recipe !== SEEDANCE_RECIPE_VERSION)
      || job.partialCorrection) throw invalid();
    const existingTarget = await read(targetPath(email, preparedId));
    if (existingTarget && existingTarget.value.correctionId !== id) throw invalid();
    let grant = (await read(claimPath(id)))?.value;
    if (grant && !matches(grant)) throw invalid();
    if (!grant) {
      const quote = await quoteProvider({ email, preparedId, manifestHash, environment: 'production', budgetCents: maximumCostCents });
      grant = { version: 1, kind: 'merchant-funded-correction', status: 'authorized', id, originalOrderId,
        originalPreparedId: order.preparedId, originalManifestHash: order.manifestHash, sourceOrderHash: correctionSourceHash(order),
        customerEmail: email, preparedId, manifestHash, filmId: job.filmId, screenplayHash: hash(job.manifest.screenplay),
        sourcesHash: hash(job.manifest.sources), model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION, environment: 'production',
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
    if (!seedanceGrant(grant) || !['prepared', 'processing', 'uncertain', 'awaiting-assembly'].includes(job.status)) throw invalid();
    const started = job.status !== 'prepared' || job.shots.some(shot => shot.status !== 'prepared');
    if (started && (job.authorization?.correctionId !== grant.id || job.authorization.originalOrderId !== grant.originalOrderId
      || job.authorization.quoteReference !== grant.quote.quoteReference || job.authorization.budgetCents !== grant.quote.maximumCostCents
      || job.authorization.manifestHash !== manifestHash || job.authorization.environment !== 'production'
      || job.provider?.id !== 'fal' || job.provider.model !== grant.model || job.provider.recipe !== grant.recipe)) throw invalid();
    const executionQuote = grant.partial ? await partialQuote({ email, job, partial: grant.partial, maximumCostCents: grant.quote.maximumCostCents })
      : await quoteProvider({ email, preparedId, manifestHash, environment: 'production', budgetCents: grant.quote.maximumCostCents });
    if (!quoteValid(executionQuote, grant, now) || executionQuote.maximumCostCents > grant.quote.maximumCostCents) throw invalid();
    if (job.partialCorrectionRetry && (!context.retry || context.retry.pending
      || executionQuote.providerCostCents > context.retry.grant.maximumNewCostCents)) throw invalid();
    const proof = await verifyPaidSale({ email, orderId: grant.originalOrderId, preparedId: grant.originalPreparedId, manifestHash: grant.originalManifestHash });
    if (correctionSourceHash(proof?.order) !== grant.sourceOrderHash || !time(proof.expiresAt) || Date.parse(proof.expiresAt) <= now()) throw invalid();
    await Promise.all([context.recheck(), proof.recheck(), ...(grant.partial ? [heldPartial(email, grant.partial)] : [])]);
    if (grant.partial) await context.recheck();
    const until = Math.min(Date.parse(proof.expiresAt), Date.parse(executionQuote.expiresAt), now() + 60_000);
    if (until <= now()) throw invalid();
    const expiresAt = new Date(until).toISOString();
    return { allowed: true, manifestHash, budgetCents: grant.quote.maximumCostCents, quoteReference: grant.quote.quoteReference,
      expiresAt, environment: 'production', fictionalOnly: false, correctionId: grant.id, originalOrderId: grant.originalOrderId,
      ...(grant.partial ? { partialCorrectionVersion: 1 } : {}) };
  }
  async function authorizeFailedShotRecovery() {
    throw new PaidFilmCorrectionError('Kling shot replacement has retired.', 410, 'KLING_SHOT_RECOVERY_RETIRED');
  }
  return { approve, approvePartial, approvePartialRetry, approveNarrationSuccessor, approveContextSuccessor, authorizeProduction, authorizeFailedShotRecovery };
}
function sameReuseEvidence(reused, expected) {
  return Array.isArray(reused) && hash(reused.map(({ shotId, operationIdentity, requestId, inputHash, sourceRecordHash, mediaSha256, sizeBytes }) =>
    ({ shotId, operationIdentity, requestId, inputHash, sourceRecordHash, mediaSha256, sizeBytes }))) === hash(expected);
}
export const paidFilmCorrections = createPaidFilmCorrections();
