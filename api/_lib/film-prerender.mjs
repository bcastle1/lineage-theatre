import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { accessStatusForUser, isOwner } from './access.mjs';
import { readPricingSettings } from './admin.mjs';
import { createFalFunding } from './fal-funding.mjs';
import { validateStoredProductionMedia, requireFinishedFilmPayment } from './production-media.mjs';
import { FilmProductionError } from './film-production.mjs';
import { head } from '@vercel/blob';
import { heartbeatSupports } from './worker-models.mjs';

export const PRERENDER_FLOW = 'render-before-payment-v1';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const cents = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
const fail = (code = 'PRERENDER_UNAVAILABLE', message = 'Film creation is unavailable. Your saved film remains unchanged.', status = 503) => new FilmProductionError(message, status, code);
function identity(email, id) {
  if (typeof email !== 'string' || email !== email.trim().toLowerCase() || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email) || !UUID.test(id || '')) throw fail();
  return digest(email);
}
export const preRenderPath = (email, id) => `production/prerenders/${identity(email, id)}/${id}.json`;
const orderIdFor = (email, hash) => digest(`${email}:production:${hash}`);
function validGrant(grant, job, email, id) {
  return grant?.version === 1 && grant.kind === PRERENDER_FLOW && grant.id === digest(`prerender:${email}:${job?.manifestHash}`)
    && grant.ownerHash === identity(email, id) && grant.preparedId === id && grant.manifestHash === job?.manifestHash
    && job?.id === id && job.ownerHash === grant.ownerHash && job.mode === 'customer' && HASH.test(job.manifestHash || '')
    && job.manifest && digest(JSON.stringify(job.manifest)) === job.manifestHash && grant.filmId === job.filmId
    && job.provider?.id === 'fal' && job.provider.model === 'seedance' && grant.model === job.provider.model && grant.recipe === job.provider.recipe
    && grant.orderId === orderIdFor(email, job.manifestHash) && grant.fundingId === digest(`prerender-funding:${grant.id}`)
    && HASH.test(grant.quoteId || '') && cents(grant.maximumCostCents) && cents(grant.providerCostCents)
    && grant.maximumCostCents >= grant.providerCostCents && cents(grant.amountCents) && Number.isSafeInteger(grant.markupCents)
    && grant.markupCents >= 0 && grant.amountCents === grant.providerCostCents + grant.markupCents
    && Number.isSafeInteger(grant.pricingRevision) && grant.pricingRevision >= 0 && typeof grant.quoteReference === 'string'
    && grant.quoteReference.length > 0 && grant.quoteReference.length <= 200 && Number.isFinite(Date.parse(grant.createdAt));
}
export async function readPreRenderGrant({ email, id, job, read = readRecord }) {
  const grant = (await read(preRenderPath(email, id)))?.value;
  if (!grant) return null;
  if (!validGrant(grant, job, email, id)) throw fail('PRERENDER_INVALID', 'This saved film needs administrator review.', 409);
  return grant;
}
function completedMedia(job, email, grant) {
  const media = validateStoredProductionMedia(job, email);
  if (job.authorization?.environment !== 'production' || job.authorization.manifestHash !== grant.manifestHash
    || job.authorization.budgetCents !== grant.maximumCostCents || job.authorization.quoteReference !== grant.quoteReference) throw fail();
  return media;
}
export async function preRenderPresentation({ email, id, job, read = readRecord, now = Date.now }) {
  const grant = await readPreRenderGrant({ email, id, job, read });
  if (!grant) return null;
  let artifactReady = false, paid = false;
  try { completedMedia(job, email, grant); artifactReady = true; } catch { /* Only verified completed private artifacts are purchasable. */ }
  if (artifactReady) {
    try { await requireFinishedFilmPayment({ job, email, actor: (await read(userPath(email)))?.value, read, now }); paid = true; } catch { /* Payment remains required. */ }
  }
  return { deliveryFlow: PRERENDER_FLOW, artifactReady, purchaseReady: artifactReady && !paid, paymentLocked: !paid,
    price: { amountCents: grant.amountCents, currency: 'USD', preparedId: id, manifestHash: grant.manifestHash } };
}

// This studio allowance authorizes expense, never a sale. One unpaid film per
// account remains reserved until genuine payment; abandonment is a studio cost.
export function createFilmPreRenderService({ read = readRecord, write = writeRecord, now = Date.now, env = process.env,
  film, pricingSettings = readPricingSettings, funding = createFalFunding({ read, write, now, env }), headBlob = head } = {}) {
  const getFilm = async () => film || (await import('./film-production.mjs')).filmProduction;
  async function account(email) {
    const actor = (await read(userPath(email)))?.value;
    if (!actor || actor.email !== email || actor.mustChangePassword || accessStatusForUser(actor) !== 'approved')
      throw fail('PRODUCTION_ACCESS_REQUIRED', 'Sign in with an approved account to create this film.', 403);
    if (env.QUICKBOOKS_ENVIRONMENT !== 'production' || ![undefined, 'approved', 'owner'].includes(env.LINEAGE_PAYMENT_ACCESS)
      || env.LINEAGE_PAYMENT_ACCESS === 'owner' && !isOwner(actor)) throw fail('PRODUCTION_ACCESS_REQUIRED', 'Film creation is not enabled for this account.', 403);
    return actor;
  }
  async function context(email, id) {
    const service = await getFilm(), job = await service.getPrepared({ email, id });
    identity(email, id);
    return { service, job, grant: await readPreRenderGrant({ email, id, job, read }) };
  }
  async function lockOwner(email, id, manifestHash) {
    const path = `production/prerenders/${identity(email, id)}/active.json`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await read(path), value = old?.value;
      if (value?.preparedId === id && value.manifestHash === manifestHash && value.ownerHash === digest(email)) return;
      if (value) {
        if (value.ownerHash !== digest(email) || !UUID.test(value.preparedId || '') || !HASH.test(value.manifestHash || '')) throw fail();
        const previous = (await context(email, value.preparedId)).job;
        try { validateStoredProductionMedia(previous, email); await requireFinishedFilmPayment({ job: previous, email, actor: await account(email), read, now }); }
        catch { throw fail('UNPAID_FILM_EXISTS', 'Finish the purchase of your existing film before creating another. Contact the studio about an abandoned film.', 409); }
      }
      const next = { version: 1, ownerHash: digest(email), preparedId: id, manifestHash, createdAt: new Date(now()).toISOString() };
      try { await write(path, next, old?.etag); } catch { continue; }
      if (digest(JSON.stringify((await read(path))?.value)) === digest(JSON.stringify(next))) return;
    }
    throw fail();
  }
  const fundingInput = (email, grant) => ({ orderId: grant.fundingId, customerEmail: email, preparedId: grant.preparedId,
    manifestHash: grant.manifestHash, quoteId: grant.quoteId, maximumCostCents: grant.maximumCostCents });
  const reserve = (email, grant) => funding.reserve(fundingInput(email, grant));
  async function start(actor, { preparedId: id, productionConsent, acceptedPriceCents } = {}) {
    const email = actor?.email; identity(email, id); await account(email);
    if (productionConsent !== true || !cents(acceptedPriceCents)) throw fail('PRERENDER_CONSENT_REQUIRED', 'Confirm the displayed price and allow this saved film to be created before payment.', 400);
    const { service, job, grant: existing } = await context(email, id);
    if (job.partialCorrection) throw fail('PRODUCTION_CORRECTION_REQUIRED', 'Continue this film through its approved correction.', 409);
    const path = preRenderPath(email, id);
    let grant = existing;
    if (!grant) {
      if (job.mode !== 'customer' || job.status !== 'prepared' || job.shots.some(shot => shot.status !== 'prepared') || job.provider?.model !== 'seedance') throw fail();
      if (await read(`payments/orders/${orderIdFor(email, job.manifestHash)}.json`) || await read(`payments/orders/${digest(`${email}:${job.manifestHash}`)}.json`))
        throw fail('ORDER_ALREADY_EXISTS', 'This saved film already has a payment request. Continue with that order.', 409);
      const quote = await service.quoteForProductionBudget({ email, preparedId: id, manifestHash: job.manifestHash, environment: 'production', budgetCents: 100_000_000 });
      const settings = await pricingSettings();
      if (!cents(quote.maximumCostCents) || !cents(quote.providerCostCents) || quote.maximumCostCents < quote.providerCostCents
        || quote.preparedId !== id || quote.manifestHash !== job.manifestHash || quote.environment !== 'production'
        || quote.apiVerified !== true || quote.qualityVerified !== true || quote.commercialTermsVerified !== true || Date.parse(quote.expiresAt) <= now()
        || !Number.isInteger(settings?.markupBasisPoints) || settings.markupBasisPoints < 0 || settings.markupBasisPoints > 100_000
        || !Number.isSafeInteger(settings.revision) || settings.revision < 0) throw fail();
      const markupCents = Number((BigInt(quote.providerCostCents) * BigInt(settings.markupBasisPoints) + 5000n) / 10000n);
      if (acceptedPriceCents !== quote.providerCostCents + markupCents) throw fail('PRICE_CHANGED', 'The film price changed. Refresh the price before starting creation.', 409);
      const grantId = digest(`prerender:${email}:${job.manifestHash}`);
      grant = { version: 1, kind: PRERENDER_FLOW, id: grantId, ownerHash: digest(email), preparedId: id, manifestHash: job.manifestHash,
        filmId: job.filmId, filmTitle: job.manifest.title, model: job.provider.model, recipe: job.provider.recipe,
        orderId: orderIdFor(email, job.manifestHash), fundingId: digest(`prerender-funding:${grantId}`), quoteId: digest(`prerender-price:${grantId}`),
        maximumCostCents: quote.maximumCostCents, providerCostCents: quote.providerCostCents, amountCents: acceptedPriceCents, markupCents,
        pricingRevision: settings.revision, quoteReference: quote.quoteReference, createdAt: new Date(now()).toISOString() };
      await lockOwner(email, id, job.manifestHash);
      await account(email);
      try { await write(path, grant); } catch { /* Recover only this exact immutable grant. */ }
      const saved = (await read(path))?.value;
      if (digest(JSON.stringify(saved)) !== digest(JSON.stringify(grant))) throw fail();
    }
    if (grant.amountCents !== acceptedPriceCents) throw fail('PRICE_CHANGED', 'Use the saved film price before continuing.', 409);
    const order = (await read(`payments/orders/${grant.orderId}.json`))?.value;
    if (order && order.deliveryFlow !== PRERENDER_FLOW) throw fail('ORDER_ALREADY_EXISTS', 'Continue with the existing payment request for this film.', 409);
    const ticketPath = `production/queue/${digest(email)}/${id}.json`, old = await read(ticketPath);
    if (!old && job.status !== 'completed') {
      const health = (await read('production/worker-health.json'))?.value, checkedAt = Date.parse(health?.checkedAt);
      if (!heartbeatSupports(health, grant.model, grant.recipe) || health.preRenderAuthorizationVersion !== 1
        || health.deliveryChecksVersion !== 1 || !Number.isFinite(checkedAt) || checkedAt > now() || now() - checkedAt > 180_000)
        throw fail('PRERENDER_WORKER_REQUIRED', 'The film worker is being prepared. Your saved film and price remain available.');
      await reserve(email, grant);
      await account(email);
      const ticket = { version: 1, email, id, orderId: grant.orderId, manifestHash: job.manifestHash,
        authorizationKind: PRERENDER_FLOW, preRenderGrantId: grant.id, state: 'pending', attempts: 0, nextAttemptAt: now(), createdAt: new Date(now()).toISOString() };
      try { await write(ticketPath, ticket); } catch { /* Lost replies require the same exact ticket identity. */ }
    }
    const ticket = (await read(ticketPath))?.value;
    if (job.status !== 'completed' && (ticket?.authorizationKind !== PRERENDER_FLOW || ticket.preRenderGrantId !== grant.id
      || ticket.email !== email || ticket.id !== id || ticket.manifestHash !== job.manifestHash || ticket.orderId !== grant.orderId)) throw fail();
    return preRenderPresentation({ email, id, job: await service.getPrepared({ email, id }), read, now });
  }
  async function authorize({ email, preparedId: id, manifestHash, orderId }) {
    await account(email);
    const { service, job, grant } = await context(email, id);
    if (!grant || grant.manifestHash !== manifestHash || grant.orderId !== orderId || !['prepared', 'processing', 'uncertain', 'awaiting-assembly'].includes(job.status)) throw fail();
    const order = (await read(`payments/orders/${grant.orderId}.json`))?.value;
    if (order && order.deliveryFlow !== PRERENDER_FLOW) throw fail();
    const lock = (await read(`production/prerenders/${digest(email)}/active.json`))?.value;
    if (lock?.preparedId !== id || lock.manifestHash !== manifestHash || lock.ownerHash !== digest(email)) throw fail();
    const ticket = (await read(`production/queue/${digest(email)}/${id}.json`))?.value;
    if (ticket?.authorizationKind !== PRERENDER_FLOW || ticket.preRenderGrantId !== grant.id || ticket.state !== 'pending'
      || ticket.email !== email || ticket.id !== id || ticket.orderId !== orderId || ticket.manifestHash !== manifestHash
      || typeof ticket.lease?.token !== 'string' || !ticket.lease.token || !(ticket.lease.expiresAt > now())) throw fail();
    const fresh = await service.quoteForProductionBudget({ email, preparedId: id, manifestHash, environment: 'production', budgetCents: grant.maximumCostCents });
    if (fresh.maximumCostCents > grant.maximumCostCents || fresh.providerCostCents > grant.maximumCostCents || fresh.manifestHash !== manifestHash
      || fresh.environment !== 'production' || !Number.isFinite(Date.parse(fresh.expiresAt)) || Date.parse(fresh.expiresAt) <= now()) throw fail();
    if (typeof funding.verifyReservation !== 'function' || await funding.verifyReservation(fundingInput(email, grant)) !== true) throw fail();
    await account(email);
    if (digest(JSON.stringify((await read(preRenderPath(email, id)))?.value)) !== digest(JSON.stringify(grant))) throw fail();
    const currentTicket = (await read(`production/queue/${digest(email)}/${id}.json`))?.value;
    if (currentTicket?.lease?.token !== ticket.lease.token || !(currentTicket.lease.expiresAt > now())
      || currentTicket.authorizationKind !== PRERENDER_FLOW || currentTicket.preRenderGrantId !== grant.id) throw fail();
    return { allowed: true, manifestHash, environment: 'production', fictionalOnly: false, budgetCents: grant.maximumCostCents,
      quoteReference: grant.quoteReference, expiresAt: new Date(Math.min(Date.parse(fresh.expiresAt), now() + 60_000)).toISOString() };
  }
  async function purchaseQuote({ email, preparedId: id }) {
    await account(email);
    const { job, grant } = await context(email, id);
    if (!grant) return null;
    let media;
    try { media = completedMedia(job, email, grant); }
    catch { throw fail('FILM_NOT_READY_FOR_PAYMENT', 'Your film is still being created. Payment becomes available after the finished film passes verification.', 409); }
    let stored;
    try { stored = await headBlob(media.pathname); } catch { throw fail('FILM_NOT_READY_FOR_PAYMENT', 'The finished film could not be confirmed in storage. Please try again before paying.', 409); }
    if (stored?.pathname !== media.pathname || stored.size !== media.sizeBytes || stored.contentType !== media.contentType)
      throw fail('FILM_NOT_READY_FOR_PAYMENT', 'The finished film needs storage verification before payment.', 409);
    return { preparedId: id, manifestHash: grant.manifestHash, filmId: grant.filmId, filmTitle: grant.filmTitle, environment: 'production', currency: 'USD',
      providerCostCents: grant.providerCostCents, maximumCostCents: grant.maximumCostCents, quoteReference: grant.quoteReference,
      amountCents: grant.amountCents, markupCents: grant.markupCents, pricingRevision: grant.pricingRevision,
      expiresAt: new Date(now() + 15 * 60_000).toISOString(), pricingBasis: 'provider-quote', apiVerified: true, qualityVerified: true, commercialTermsVerified: true,
      deliveryFlow: PRERENDER_FLOW, preRenderGrantId: grant.id, artifactSha256: media.sha256 };
  }
  async function verifyPurchase(q) {
    const fresh = await purchaseQuote({ email: q.customerEmail, preparedId: q.preparedId });
    if (!fresh || ['manifestHash', 'filmId', 'amountCents', 'providerCostCents', 'markupCents', 'pricingRevision', 'quoteReference', 'deliveryFlow', 'preRenderGrantId', 'artifactSha256'].some(field => fresh[field] !== q[field])) throw fail();
    return fresh;
  }
  return { start, authorize, purchaseQuote, verifyPurchase };
}
export const filmPreRender = createFilmPreRenderService();

export async function authorizeFilmProduction(input, { paymentService, preRenderService = filmPreRender, read = readRecord, spending = true } = {}) {
  const ticket = (await read(`production/queue/${identity(input.email, input.preparedId)}/${input.preparedId}.json`))?.value;
  if (ticket?.authorizationKind === PRERENDER_FLOW) {
    if (ticket.email !== input.email || ticket.id !== input.preparedId || ticket.orderId !== input.orderId || ticket.manifestHash !== input.manifestHash)
      throw fail();
    return preRenderService.authorize(input, { spending });
  }
  return paymentService.authorizeProduction(input);
}
