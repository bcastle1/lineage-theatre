// One explicitly approved studio-funded fictional Seedance canary. The fixed
// identity permits three video submissions, zero image submissions, and three
// Astra visual reviews. No customer order, invoice, payment or retry is created.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { isOwner } from '../api/_lib/access.mjs';
import { createFilmProductionService, productionJobPath } from '../api/_lib/film-production.mjs';
import { createFalProductionAdapter, falShotInput } from '../api/_lib/fal-production.mjs';
import { createFalClient, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { createFalPricing } from '../api/_lib/fal-pricing.mjs';
import { createFalFunding, FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-qualification.mjs';
import { seedanceCanaryProfile, seedanceCanaryIdentity, verifySeedanceCanaryGrant } from '../api/_lib/seedance-operator-canary.mjs';
import { createWorkerAssembly, verifyPublishedFilm } from './production-worker.mjs';
import { createFilmVisualReviewer, createRemoteVisualReview } from './review-film-visuals.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

export const EXECUTE_FLAG = '--execute-approved-1920-cents-seedance-20261122';
const MAX_CENTS = 1920;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = (value, code) => { if (!value) fail(code); };
const stamp = () => new Date().toISOString();
const emit = value => { const result = { observedAt: stamp(), ...value }; process.stdout.write(`${JSON.stringify(result)}\n`); return result; };
const same = (a, b) => digest(JSON.stringify(a)) === digest(JSON.stringify(b));

export function seedanceCanaryOperationBounds(id) {
  const { fixedHash, manifest, plan } = seedanceCanaryProfile();
  requireValue(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id || ''), 'CANARY_ID_REQUIRED');
  return new Map(plan.shots.map(shot => [digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${digest(`${id}:${fixedHash}:${shot.id}`)}`),
    { endpoint: FAL_MODELS.seedanceText, shotId: shot.id, seconds: shot.seconds, input: falShotInput(manifest, shot, 'seedance', {}) }]));
}

export function seedanceCanaryFundingInput(email) {
  const { runKey, fixedHash } = seedanceCanaryProfile(), { ownerHash, id } = seedanceCanaryIdentity(email);
  return { orderId: digest(`operator-canary:${ownerHash}:${runKey}`), customerEmail: email, preparedId: id,
    manifestHash: fixedHash, quoteId: digest(`operator-canary-funding:${runKey}:${fixedHash}`), maximumCostCents: MAX_CENTS };
}

// Reuse the shared commitment accounting, but this operator utility may only
// write its ledger. It cannot fence or change a customer payment/order record.
export function createSeedanceCanaryFunding({ write = writeRecord, ...options } = {}) {
  return createFalFunding({ ...options, write: async (path, value, etag) => {
    requireValue(path === FAL_FUNDING_PATH, 'CANARY_FUNDING_WRITE_FORBIDDEN');
    return write(path, value, etag);
  } });
}

export function createGuardedSeedanceCanaryClient({ email, grantContext, client, pricing, funding, now = Date.now }) {
  const { ownerHash, id } = seedanceCanaryIdentity(email), bounds = seedanceCanaryOperationBounds(id);
  const fundingInput = seedanceCanaryFundingInput(email);
  async function get(identity) {
    const bound = bounds.get(identity);
    requireValue(bound, 'CANARY_OPERATION_OUTSIDE_BUDGET');
    const saved = await client.get(identity);
    requireValue(!saved || saved.identity === identity && saved.endpoint === bound.endpoint
      && saved.inputHash === digest(JSON.stringify(bound.input)), 'CANARY_OPERATION_CHANGED');
    return saved;
  }
  return { get, poll: async identity => {
    const saved = await get(identity);
    requireValue(saved && saved.requestId && !['uncertain', 'submitting'].includes(saved.state), 'CANARY_RECONCILIATION_REQUIRED');
    // Polling previously submitted work never depends on the remaining balance.
    await client.poll(identity);
    return get(identity);
  }, submit: async request => {
    const bound = bounds.get(request.identity);
    requireValue(bound?.endpoint === request.endpoint && same(request.input, bound.input), 'CANARY_OPERATION_OUTSIDE_BUDGET');
    const initial = await grantContext();
    const grant = verifySeedanceCanaryGrant(initial.grant, { email, ownerHash, id, now: now() });
    const existing = await get(request.identity);
    if (existing) return existing; // Durable fal claims never authorize another POST.
    for (const identity of bounds.keys()) {
      const prior = await get(identity);
      requireValue(!prior || !['failed', 'uncertain', 'submitting'].includes(prior.state), 'CANARY_RECONCILIATION_REQUIRED');
    }
    const rates = await pricing('seedance');
    requireValue(rates.videoMicroUsdPerSecond === grant.videoMicroUsdPerSecond && rates.referenceMicroUsd === 0
      && Number.isFinite(Date.parse(rates.expiresAt)) && Date.parse(rates.expiresAt) > now()
      && Math.ceil(16 * rates.videoMicroUsdPerSecond / 10000) <= MAX_CENTS, 'CANARY_PRICE_EXCEEDS_APPROVAL');
    await funding.reserve(fundingInput); // Entire shared budget checked before each NEW submission only.
    const latest = await grantContext();
    verifySeedanceCanaryGrant(latest.grant, { email, ownerHash, id, now: now() });
    requireValue(same(latest.grant, grant), 'CANARY_GRANT_BINDING_CHANGED');
    return client.submit({ identity: request.identity, endpoint: bound.endpoint, input: structuredClone(bound.input) });
  } };
}

// Persist a claim before each expensive Astra call. A lost response is retained
// for review, never retried. An exact successful proof may be reused while
// assembling the same artifact again; different frames cannot consume more calls.
export function createBoundedSeedanceCanaryReview({ email, grantContext, review = createRemoteVisualReview(),
  read = readRecord, write = writeRecord, now = Date.now }) {
  const { ownerHash, id } = seedanceCanaryIdentity(email), { fixedHash, manifest } = seedanceCanaryProfile();
  const shots = new Set(manifest.shots.map(shot => shot.id));
  const prefix = `production/operator-canaries/${ownerHash}/${id}/visual-review-claims`;
  return async body => {
    requireValue(body?.email === email && body.preparedId === id && body.manifestHash === fixedHash && shots.has(body.shotId)
      && Array.isArray(body.frames) && body.frames.length === 3, 'CANARY_VISUAL_INPUT_CHANGED');
    const { grant } = await grantContext();
    verifySeedanceCanaryGrant(grant, { email, ownerHash, id, now: now() });
    const inputHash = digest(JSON.stringify(body)), path = `${prefix}/${digest(body.shotId)}.json`;
    let saved = await read(path);
    if (saved) {
      requireValue(saved.value?.version === 1 && saved.value.inputHash === inputHash && saved.value.shotId === body.shotId
        && saved.value.manifestHash === fixedHash && saved.value.state === 'completed', 'CANARY_VISUAL_REVIEW_ALREADY_ATTEMPTED');
      return saved.value.proof;
    }
    const token = randomUUID(), claim = { version: 1, ownerHash, preparedId: id, manifestHash: fixedHash,
      shotId: body.shotId, inputHash, token, state: 'claimed', claimedAt: new Date(now()).toISOString() };
    try { await write(path, claim); } catch { fail('CANARY_VISUAL_REVIEW_ALREADY_ATTEMPTED'); }
    saved = await read(path);
    requireValue(saved?.etag && same(saved.value, claim), 'CANARY_VISUAL_REVIEW_CLAIM_UNCONFIRMED');
    const latest = await grantContext();
    requireValue(same(latest.grant, grant), 'CANARY_GRANT_BINDING_CHANGED');
    const proof = await review(structuredClone(body));
    requireValue(proof?.version === 1 && proof.manifestHash === fixedHash && proof.shotId === body.shotId
      && proof.passed === true && /^[a-f0-9]{64}$/.test(proof.bindingHash || '') && typeof proof.receiptPath === 'string', 'CANARY_VISUAL_REVIEW_FAILED');
    await write(path, { ...claim, state: 'completed', proof, completedAt: new Date(now()).toISOString() }, saved.etag);
    const confirmed = await read(path);
    requireValue(confirmed?.value.state === 'completed' && confirmed.value.token === token && same(confirmed.value.proof, proof), 'CANARY_VISUAL_REVIEW_RECEIPT_UNCONFIRMED');
    return proof;
  };
}

export async function runSeedanceCanary(args = process.argv.slice(2)) {
  const [action, confirmation] = args;
  requireValue(['plan', 'prepare', 'step', 'advance', 'finish', 'status'].includes(action)
    && args.length === (['prepare', 'step', 'advance', 'finish'].includes(action) ? 2 : 1)
    && (!['prepare', 'step', 'advance', 'finish'].includes(action) || confirmation === EXECUTE_FLAG), 'CANARY_USAGE');
  const { runKey, fixedHash, manifest, summary: profileSummary } = seedanceCanaryProfile();
  const summary = { ...profileSummary, runKey, maximumVisualReviewRequests: 3, maximumStartFrameReviews: 0,
    costScope: 'fal-only; at most three GPT-6.2 Astra visual reviews are billed separately',
    customerCheckoutVerified: false, automaticPaidRetry: false };
  if (action === 'plan') return emit({ ...summary, status: 'offline-plan', providerSubmissions: 0 });
  const email = String(process.env.LINEAGE_CANARY_OWNER_EMAIL || '').trim().toLowerCase();
  requireValue(/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email), 'CANARY_OWNER_EMAIL_REQUIRED');
  requireValue(Boolean(process.env.BLOB_READ_WRITE_TOKEN), 'CANARY_STORAGE_REQUIRED');
  const { ownerHash, id } = seedanceCanaryIdentity(email), bounds = seedanceCanaryOperationBounds(id);
  const jobPath = productionJobPath(email, id), base = `production/operator-canaries/${ownerHash}/${id}`;
  const grantPath = `${base}/grant.json`, artifactPath = `${base}/artifact.json`, lockPath = `${base}/finishing-lease.json`;
  async function owner() {
    const actor = (await readRecord(userPath(email)))?.value;
    requireValue(isOwner(actor) && actor.email === email && !actor.mustChangePassword, 'CANARY_ACTIVE_OWNER_REQUIRED');
    return actor;
  }
  function exactJob(job) {
    requireValue(job?.id === id && job.ownerHash === ownerHash && job.mode === 'operator-test'
      && job.manifestHash === fixedHash && digest(JSON.stringify(job.manifest)) === fixedHash && job.filmId === manifest.filmId
      && job.shots?.length === 3 && job.shots.every((shot, index) => shot.id === manifest.shots[index].id
        && shot.requestKey === digest(`${id}:${fixedHash}:${shot.id}`))
      && job.provider?.id === 'fal' && job.provider.model === 'seedance' && job.provider.recipe === SEEDANCE_RECIPE_VERSION,
    'CANARY_JOB_CHANGED');
    return job;
  }
  async function grantContext() {
    await owner();
    const job = exactJob((await readRecord(jobPath))?.value), grant = (await readRecord(grantPath))?.value;
    verifySeedanceCanaryGrant(grant, { email, ownerHash, id });
    return { job, grant };
  }
  const key = () => process.env.FAL_KEY, pricing = createFalPricing({ key });
  const funding = createSeedanceCanaryFunding();
  const client = createFalClient({ key, submissionEndpoints: [FAL_MODELS.seedanceText] });
  const guardedClient = createGuardedSeedanceCanaryClient({ email, grantContext, client, pricing, funding });
  const adapter = createFalProductionAdapter({ model: 'seedance', requireWorker: true, key, client: guardedClient });
  const film = createFilmProductionService({ adapter, authorize: async input => {
    const { grant } = await grantContext();
    requireValue(input.email === email && input.id === id && input.manifestHash === fixedHash && input.mode === 'operator-test'
      && input.authorizationReference === grantPath, 'CANARY_GRANT_BINDING_CHANGED');
    return { allowed: true, fictionalOnly: true, manifestHash: fixedHash, environment: 'production', budgetCents: MAX_CENTS,
      quoteReference: grant.quoteReference, expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), Date.now() + 30_000)).toISOString() };
  }, verifyAssembledMedia: verifyPublishedFilm });
  if (action === 'prepare') {
    const actor = await owner(), existingGrant = await readRecord(grantPath);
    if (existingGrant) {
      const { job } = await grantContext();
      return emit({ ...summary, preparedId: id, status: job.status, existingCanary: true });
    }
    requireValue(adapter.available, 'CANARY_PROVIDER_UNAVAILABLE');
    const rates = await pricing('seedance'), quote = await adapter.quote({ manifest, manifestHash: fixedHash });
    requireValue(rates.videoMicroUsdPerSecond === 1200000 && rates.referenceMicroUsd === 0
      && quote.currency === 'USD' && quote.providerCostCents === MAX_CENTS, 'CANARY_PRICE_EXCEEDS_APPROVAL');
    await funding.reserve(seedanceCanaryFundingInput(email));
    const prepared = await film.prepareOperatorTest({ actor, idempotencyKey: runKey });
    requireValue(prepared.id === id && prepared.manifestHash === fixedHash, 'CANARY_PREPARATION_CHANGED');
    const job = exactJob((await readRecord(jobPath))?.value);
    requireValue(job.status === 'prepared' && job.shots.every(shot => shot.status === 'prepared'), 'CANARY_ALREADY_STARTED_WITHOUT_GRANT');
    const approvedAt = stamp();
    const grant = { version: 1, kind: profileSummary.kind, runKey, ownerHash, preparedId: id, manifestHash: fixedHash,
      recipe: SEEDANCE_RECIPE_VERSION, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
      maximumCostCents: MAX_CENTS, maximumVideoRequests: 3, maximumReferenceRequests: 0,
      maximumVisualReviewRequests: 3, maximumStartFrameReviews: 0,
      videoMicroUsdPerSecond: rates.videoMicroUsdPerSecond, referenceMicroUsd: 0,
      quoteReference: quote.quoteReference, quotedCostCents: quote.providerCostCents,
      approvedAt, expiresAt: new Date(Date.parse(approvedAt) + 24 * 3600_000).toISOString() };
    verifySeedanceCanaryGrant(grant, { email, ownerHash, id });
    try { await writeRecord(grantPath, grant); } catch { /* Only exact existing readback authorizes the fixed run. */ }
    await grantContext();
    return emit({ ...summary, preparedId: id, status: prepared.status, providerSubmissions: 0, fundingReservedCents: MAX_CENTS });
  }
  if (action === 'status') {
    await owner();
    const job = exactJob((await readRecord(jobPath))?.value), operations = [];
    for (const [identity, bound] of bounds) {
      const saved = await guardedClient.get(identity);
      operations.push({ shotId: bound.shotId, seconds: bound.seconds, state: saved?.state || 'not-submitted', hasRequest: Boolean(saved?.requestId) });
    }
    return emit({ ...summary, preparedId: id, status: job.status, completedShots: job.shots.filter(shot => shot.status === 'completed').length,
      operations, ...(job.media ? { sha256: job.media.sha256, sizeBytes: job.media.sizeBytes, durationSeconds: job.media.durationSeconds } : {}) });
  }
  const { job } = await grantContext();
  if (action === 'step' || action === 'advance') {
    requireValue(!['uncertain', 'failed'].includes(job.status), 'CANARY_RECONCILIATION_REQUIRED');
    const result = await film.advance({ email, id, actor: await owner(), authorizationReference: grantPath });
    return emit({ ...summary, preparedId: id, status: result.status });
  }
  requireValue(job.status === 'awaiting-assembly' || job.status === 'completed', 'CANARY_NOT_READY_FOR_FINISHING');
  if (job.status === 'completed') return emit({ ...summary, preparedId: id, status: 'completed', sha256: job.media?.sha256,
    sizeBytes: job.media?.sizeBytes, durationSeconds: job.media?.durationSeconds });
  const previous = await readRecord(lockPath);
  requireValue(!previous?.value?.token || previous.value.expiresAt <= Date.now(), 'CANARY_FINISHING_BUSY');
  const token = randomUUID();
  await writeRecord(lockPath, { token, expiresAt: Date.now() + 30 * 60_000, manifestHash: fixedHash }, previous?.etag);
  const stillOwned = async () => {
    const lock = (await readRecord(lockPath))?.value, { job: current } = await grantContext();
    return lock?.token === token && lock.expiresAt > Date.now() && lock.manifestHash === fixedHash && current.status === 'awaiting-assembly';
  };
  try {
    let artifact = (await readRecord(artifactPath))?.value;
    if (!artifact) {
      const reviewVisuals = createFilmVisualReviewer({ review: createBoundedSeedanceCanaryReview({ email, grantContext }) });
      artifact = await createWorkerAssembly({ adapter, reviewVisuals })({ email, id, job, stillOwned });
      await verifyPublishedFilm({ email, id, manifestHash: fixedHash, artifact, manifest });
      try { await writeRecord(artifactPath, artifact); } catch { /* Immutable exact readback below. */ }
      const saved = (await readRecord(artifactPath))?.value;
      requireValue(saved?.sha256 === artifact.sha256 && saved.manifestHash === fixedHash, 'CANARY_ARTIFACT_CHANGED');
      artifact = saved;
    }
    requireValue(artifact?.manifestHash === fixedHash && artifact.audioReview?.passed === true
      && artifact.audioReview.source === 'seedance-native' && artifact.audioReview.verification === 'audio-decode-and-duration'
      && artifact.audioReview.transcriptVerified === false && artifact.visualReview?.passed === true, 'CANARY_DELIVERY_NOT_VERIFIED');
    await film.acceptAssembly({ email, id, manifestHash: fixedHash, artifact, stillOwned });
    return emit({ ...summary, preparedId: id, status: 'completed', sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
      durationSeconds: artifact.durationSeconds, nativeAudioPassed: true, transcriptVerified: false,
      visualReviewPassed: true, privateReadbackVerified: true });
  } finally {
    const lock = await readRecord(lockPath);
    if (lock?.value.token === token) await writeRecord(lockPath, { ...lock.value, token: null, expiresAt: 0 }, lock.etag);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSeedanceCanary().catch(error => {
    const diagnostic = finishingFailure(error);
    emit({ status: 'attention', code: /^CANARY_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'CANARY_OPERATION_FAILED',
      ...(diagnostic ? { finishing: diagnostic } : {}), automaticPaidRetry: false, fundingHoldRetained: true });
    process.exitCode = 1;
  });
}
