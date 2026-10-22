// One explicitly approved, merchant-funded fictional canary. No invoice,
// customer payment, customer film, provider retry or qualification is created.
// The fixed identity and five durable provider operations cap this run at $3.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { isOwner } from '../api/_lib/access.mjs';
import { buildFilmManifest, fictionalOperatorProject, createFilmProductionService, productionJobPath } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { createFalProductionAdapter, falPlan, FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { createFalClient, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { createFalPricing } from '../api/_lib/fal-pricing.mjs';
import { createWorkerAssembly, verifyPublishedFilm } from './production-worker.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { createFilmVisualReviewer, createRemoteVisualReview } from './review-film-visuals.mjs';
import { boundedVisualJson } from '../api/_lib/film-visual-review.mjs';

const RUN_KEY = 'kling-production-canary-20261020-v1';
const FIXED_HASH = '02168601049cab97e4381981f5aa73dcd05b8b9553cf9f6017a40408c808b2ac';
const MAX_CENTS = 300;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = (value, code) => { if (!value) fail(code); };
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const stamp = () => new Date().toISOString();

export function klingCanaryProfile({ quality = false } = {}) {
  requireValue(typeof quality === 'boolean', 'CANARY_USAGE');
  const runKey = quality ? 'kling-quality-canary-20261022-v1' : RUN_KEY;
  const fixedHash = quality ? 'c6d95029a8578bbb140acea253346116cf86040ab82932f629d30e61e965627b' : FIXED_HASH;
  const manifest = planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest, { visualContinuity: quality });
  const plan = falPlan(manifest, 'kling'), manifestHash = digest(JSON.stringify(manifest));
  requireValue(manifestHash === fixedHash && manifest.targetDurationSeconds === 15 && plan.shots.length === 3
    && plan.generatedSeconds === 16 && plan.referenceCount === 2 && plan.characters.length === 2
    && plan.characters.every(character => character.referencePhotoId === undefined), 'CANARY_FIXED_PLAN_CHANGED');
  const summary = { kind: quality ? 'fictional-kling-quality-canary-v1' : 'fictional-kling-production-canary-v1', manifestHash, durationSeconds: 15,
    providerSeconds: plan.generatedSeconds, videoRequests: 3, referenceRequests: 2, maximumCostCents: MAX_CENTS,
    recipe: FAL_RECIPE_VERSION, invoiceCreated: false, customerPaymentCreated: false };
  return { runKey, fixedHash, manifest, plan, summary };
}

// The staged quality runtime must qualify itself before the production timer
// advertises its new gate. This bypass is confined to this fixed owner canary;
// the customer adapter continues requiring the production heartbeat.
export function createKlingCanaryAdapter({ quality = false, ...options } = {}) {
  requireValue(typeof quality === 'boolean', 'CANARY_USAGE');
  return createFalProductionAdapter({ ...options, model: 'kling', requireWorker: !quality });
}

// Only the separate quality canary may target the staged deployment. The
// ordinary production worker continues using its fixed public origin. Server
// credentials remain in Vercel; this transport forwards only the worker secret
// and an optional deployment-protection token to one validated team host.
export function createKlingQualityVisualReview({ env = process.env, fetchImpl = fetch } = {}) {
  const origin = env.LINEAGE_CANARY_REVIEW_ORIGIN;
  if (origin === undefined) return createRemoteVisualReview({ env, fetchImpl });
  let url;
  try { url = new URL(origin); } catch { fail('CANARY_REVIEW_ORIGIN_INVALID'); }
  requireValue(typeof origin === 'string' && origin === url.origin && url.protocol === 'https:'
    && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash
    && /^lineage-theater-[a-z0-9]+-erik-4774s-projects\.vercel\.app$/.test(url.hostname), 'CANARY_REVIEW_ORIGIN_INVALID');
  const bypass = env.LINEAGE_CANARY_AUTOMATION_BYPASS;
  requireValue(bypass === undefined || typeof bypass === 'string' && bypass.length > 0 && bypass.length <= 2048
    && !/[\r\n\x00-\x1f\x7f]/.test(bypass), 'CANARY_REVIEW_BYPASS_INVALID');
  return async body => {
    requireValue(/^[a-f0-9]{64}$/.test(env.LINEAGE_WORKER_SECRET || ''), 'CANARY_WORKER_SECRET_REQUIRED');
    const response = await fetchImpl(`${origin}/api/production-worker`, { method: 'POST', redirect: 'error', credentials: 'omit',
      cache: 'no-store', signal: AbortSignal.timeout(170_000),
      headers: { Authorization: `Bearer ${env.LINEAGE_WORKER_SECRET}`, 'Content-Type': 'application/json',
        ...(bypass === undefined ? {} : { 'x-vercel-protection-bypass': bypass }) },
      body: JSON.stringify({ ...body, action: 'review-film-visuals' }) });
    if (!response.ok) { await response.body?.cancel(); fail('CANARY_VISUAL_REVIEW_UNAVAILABLE'); }
    return boundedVisualJson(response, 4096);
  };
}

export function verifyKlingCanaryGrant(grant, { quality = false, ownerHash, id, now = Date.now() }) {
  const { fixedHash, summary } = klingCanaryProfile({ quality });
  requireValue(grant?.version === 1 && grant.kind === summary.kind && grant.ownerHash === ownerHash
    && grant.preparedId === id && grant.manifestHash === fixedHash && grant.recipe === FAL_RECIPE_VERSION
    && grant.maximumCostCents === MAX_CENTS && grant.maximumVideoRequests === 3 && grant.maximumReferenceRequests === 2
    && Number.isSafeInteger(grant.videoMicroUsdPerSecond) && grant.videoMicroUsdPerSecond > 0
    && Number.isSafeInteger(grant.referenceMicroUsd) && grant.referenceMicroUsd > 0
    && Math.ceil((16 * grant.videoMicroUsdPerSecond + 2 * grant.referenceMicroUsd) / 10000) <= MAX_CENTS
    && grant.funding === 'existing-merchant-provider-credit' && grant.fictionalOnly === true
    && /^[a-f0-9]{64}$/.test(grant.quoteReference || '') && Date.parse(grant.expiresAt) > now,
  'CANARY_GRANT_REQUIRED');
  return grant;
}

export function createGuardedKlingCanaryClient({ quality = false, id, grantContext, client, pricing }) {
  const { fixedHash, plan } = klingCanaryProfile({ quality });
  const operationBounds = new Map([
    ...plan.characters.map(character => [digest(`${FAL_RECIPE_VERSION}:cast:${id}:${fixedHash}:${character.id}`), { endpoint: FAL_MODELS.reference }]),
    ...plan.shots.map(shot => [digest(`${FAL_RECIPE_VERSION}:kling:${digest(`${id}:${fixedHash}:${shot.id}`)}`), { endpoint: FAL_MODELS.kling, seconds: shot.seconds }]),
  ]);
  return { get: client.get, poll: client.poll, submit: async request => {
    // Historical requests may be read/polled under their original identities,
    // but this script can never resubmit or extend the October 20 allowance.
    requireValue(quality, 'CANARY_HISTORICAL_SUBMISSION_DISABLED');
    const { grant } = await grantContext();
    const bound = operationBounds.get(request.identity);
    requireValue(bound?.endpoint === request.endpoint, 'CANARY_OPERATION_OUTSIDE_BUDGET');
    if (request.endpoint === FAL_MODELS.kling) requireValue(request.input.duration === String(bound.seconds)
      && request.input.generate_audio === true && request.input.image_urls?.length === 2
      && request.input.aspect_ratio === '16:9', 'CANARY_VIDEO_INPUT_CHANGED');
    else requireValue(request.input.resolution === '4K' && request.input.num_images === 1
      && request.input.limit_generations === true, 'CANARY_REFERENCE_INPUT_CHANGED');
    const live = await pricing('kling');
    const cents = Math.ceil((plan.generatedSeconds * live.videoMicroUsdPerSecond + plan.referenceCount * live.referenceMicroUsd) / 10000);
    requireValue(cents <= grant.maximumCostCents && live.videoMicroUsdPerSecond <= grant.videoMicroUsdPerSecond
      && live.referenceMicroUsd <= grant.referenceMicroUsd, 'CANARY_PRICE_EXCEEDS_APPROVAL');
    const latest = await grantContext();
    requireValue(digest(JSON.stringify(latest.grant)) === digest(JSON.stringify(grant)), 'CANARY_GRANT_BINDING_CHANGED');
    return client.submit(request);
  } };
}

export async function runKlingCanary(args = process.argv.slice(2), { quality = false } = {}) {
  const [action, confirmation] = args;
  requireValue(['plan', 'prepare', 'step', 'finish', 'status'].includes(action)
    && args.length === (['prepare', 'step', 'finish'].includes(action) ? 2 : 1)
    && (!['prepare', 'step', 'finish'].includes(action) || confirmation === '--execute-approved-300-cents'), 'CANARY_USAGE');
  const { runKey, fixedHash, manifest, plan, summary } = klingCanaryProfile({ quality });
  if (action === 'plan') { emit(summary); return; }
  const email = String(process.env.LINEAGE_CANARY_OWNER_EMAIL || '').trim().toLowerCase();
  requireValue(/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email), 'CANARY_OWNER_EMAIL_REQUIRED');
  requireValue(Boolean(process.env.BLOB_READ_WRITE_TOKEN), 'CANARY_STORAGE_REQUIRED');
  const ownerHash = digest(email), seed = digest(`${email}:${runKey}`);
  const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}`;
  const jobPath = productionJobPath(email, id), grantPath = `production/operator-canaries/${ownerHash}/${id}/grant.json`;
  const artifactPath = `production/operator-canaries/${ownerHash}/${id}/artifact.json`;
  const lockPath = `production/operator-canaries/${ownerHash}/${id}/finishing-lease.json`;
  async function owner() {
    const actor = (await readRecord(userPath(email)))?.value;
    requireValue(isOwner(actor) && actor.email === email && !actor.mustChangePassword, 'CANARY_ACTIVE_OWNER_REQUIRED');
    return actor;
  }
  function exactJob(job) {
    requireValue(job?.id === id && job.ownerHash === ownerHash && job.mode === 'operator-test'
      && job.manifestHash === fixedHash && digest(JSON.stringify(job.manifest)) === fixedHash
      && job.filmId === manifest.filmId && job.shots?.length === 3
      && job.shots.every((shot, index) => shot.id === manifest.shots[index].id
        && shot.requestKey === digest(`${id}:${fixedHash}:${shot.id}`))
      && (!job.provider || job.provider.id === 'fal' && job.provider.model === 'kling' && job.provider.recipe === FAL_RECIPE_VERSION),
    'CANARY_JOB_CHANGED');
    return job;
  }
  async function grantContext() {
    await owner();
    const job = exactJob((await readRecord(jobPath))?.value);
    const grant = (await readRecord(grantPath))?.value;
    verifyKlingCanaryGrant(grant, { quality, ownerHash, id });
    return { job, grant };
  }
  const operationBounds = new Map([
    ...plan.characters.map(character => [digest(`${FAL_RECIPE_VERSION}:cast:${id}:${fixedHash}:${character.id}`), { endpoint: FAL_MODELS.reference }]),
    ...plan.shots.map(shot => [digest(`${FAL_RECIPE_VERSION}:kling:${digest(`${id}:${fixedHash}:${shot.id}`)}`), { endpoint: FAL_MODELS.kling, seconds: shot.seconds }]),
  ]);
  const key = () => process.env.FAL_KLING_KEY;
  const client = createFalClient({ key });
  const guardedClient = createGuardedKlingCanaryClient({ quality, id, grantContext, client,
    pricing: model => createFalPricing({ key })(model) });
  const adapter = createKlingCanaryAdapter({ quality, key, client: guardedClient });
  const film = createFilmProductionService({ adapter,
    authorize: async input => {
      const { grant } = await grantContext();
      requireValue(input.email === email && input.id === id && input.manifestHash === fixedHash && input.mode === 'operator-test'
        && input.authorizationReference === grantPath, 'CANARY_GRANT_BINDING_CHANGED');
      return { allowed: true, fictionalOnly: true, manifestHash: fixedHash, environment: 'production',
        budgetCents: MAX_CENTS, quoteReference: grant.quoteReference,
        expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), Date.now() + 30_000)).toISOString() };
    },
    verifyAssembledMedia: verifyPublishedFilm,
  });
  if (action === 'prepare') {
    const actor = await owner();
    if (!quality) {
      exactJob((await readRecord(jobPath))?.value);
      await grantContext();
      emit({ ...summary, preparedId: id, status: 'existing-historical-canary' });
      return;
    }
    requireValue(adapter.available, 'CANARY_PROVIDER_UNAVAILABLE');
    const rates = await createFalPricing({ key })('kling');
    const quote = await adapter.quote({ manifest, manifestHash: fixedHash });
    requireValue(quote.currency === 'USD' && quote.providerCostCents > 0 && quote.providerCostCents <= MAX_CENTS, 'CANARY_PRICE_EXCEEDS_APPROVAL');
    requireValue(Math.ceil((16 * rates.videoMicroUsdPerSecond + 2 * rates.referenceMicroUsd) / 10000) <= MAX_CENTS, 'CANARY_PRICE_EXCEEDS_APPROVAL');
    const prepared = await film.prepareOperatorTest({ actor, idempotencyKey: runKey });
    requireValue(prepared.id === id && prepared.manifestHash === fixedHash, 'CANARY_PREPARATION_CHANGED');
    if (!(await readRecord(grantPath))) {
      const job = exactJob((await readRecord(jobPath))?.value);
      requireValue(job.status === 'prepared' && job.shots.every(shot => shot.status === 'prepared'), 'CANARY_ALREADY_STARTED_WITHOUT_GRANT');
      const grant = { version: 1, kind: summary.kind, ownerHash, preparedId: id, manifestHash: fixedHash,
        recipe: FAL_RECIPE_VERSION, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
        maximumCostCents: MAX_CENTS, maximumVideoRequests: 3, maximumReferenceRequests: 2,
        videoMicroUsdPerSecond: rates.videoMicroUsdPerSecond, referenceMicroUsd: rates.referenceMicroUsd,
        quoteReference: quote.quoteReference, quotedCostCents: quote.providerCostCents,
        approvedAt: stamp(), expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() };
      try { await writeRecord(grantPath, grant); } catch { /* Exact existing readback is required below. */ }
    }
    await grantContext();
    emit({ ...summary, preparedId: id, status: prepared.status, providerSubmissions: 0 });
    return;
  }
  if (action === 'status') {
    await owner();
    const job = exactJob((await readRecord(jobPath))?.value);
    const operations = [];
    for (const [identity, bound] of operationBounds) {
      const saved = await client.get(identity);
      requireValue(!saved || saved.endpoint === bound.endpoint, 'CANARY_OPERATION_CHANGED');
      operations.push({ identity, kind: bound.endpoint === FAL_MODELS.kling ? 'video' : 'reference',
        state: saved?.state || 'not-submitted', requestId: saved?.requestId || null });
    }
    emit({ ...summary, preparedId: id, status: job.status, completedShots: job.shots.filter(shot => shot.status === 'completed').length,
      operations, media: job.media || null });
    return;
  }
  const { job } = await grantContext();
  if (action === 'step') {
    requireValue(!['uncertain', 'failed'].includes(job.status), 'CANARY_RECONCILIATION_REQUIRED');
    const result = await film.advance({ email, id, actor: await owner(), authorizationReference: grantPath });
    emit({ ...summary, preparedId: id, status: result.status });
    return;
  }
  requireValue(job.status === 'awaiting-assembly' || job.status === 'completed', 'CANARY_NOT_READY_FOR_FINISHING');
  if (job.status === 'completed') { emit({ ...summary, preparedId: id, status: 'completed', media: job.media }); return; }
  const previous = await readRecord(lockPath);
  requireValue(!previous?.value?.token || previous.value.expiresAt <= Date.now(), 'CANARY_FINISHING_BUSY');
  const token = randomUUID();
  await writeRecord(lockPath, { token, expiresAt: Date.now() + 30 * 60_000, manifestHash: fixedHash }, previous?.etag);
  const stillOwned = async () => {
    const lock = (await readRecord(lockPath))?.value;
    const { job: current } = await grantContext();
    return lock?.token === token && lock.expiresAt > Date.now() && lock.manifestHash === fixedHash && current.status === 'awaiting-assembly';
  };
  try {
    let artifact = (await readRecord(artifactPath))?.value;
    if (!artifact) {
      // No payment exemption is injected into the paid soundtrack fallback.
      // Native speech must pass the same real ASR gate as a customer film.
      const reviewVisuals = quality ? createFilmVisualReviewer({ review: createKlingQualityVisualReview() }) : undefined;
      artifact = await createWorkerAssembly({ adapter, ...(quality ? { reviewVisuals } : {}) })({ email, id, job, stillOwned });
      await verifyPublishedFilm({ email, id, manifestHash: fixedHash, artifact, manifest });
      try { await writeRecord(artifactPath, artifact); } catch { /* Immutable readback below is mandatory. */ }
      const saved = (await readRecord(artifactPath))?.value;
      requireValue(saved?.sha256 === artifact.sha256 && saved.manifestHash === fixedHash, 'CANARY_ARTIFACT_CHANGED');
      artifact = saved;
    }
    requireValue(artifact?.manifestHash === fixedHash && artifact.speechReview?.passed === true, 'CANARY_SPEECH_NOT_VERIFIED');
    await film.acceptAssembly({ email, id, manifestHash: fixedHash, artifact, stillOwned });
    emit({ ...summary, preparedId: id, status: 'completed', sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
      durationSeconds: artifact.durationSeconds, speechPassed: artifact.speechReview?.passed === true, privateReadbackVerified: true });
  } finally {
    const lock = await readRecord(lockPath);
    if (lock?.value.token === token) await writeRecord(lockPath, { ...lock.value, token: null, expiresAt: 0 }, lock.etag);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runKlingCanary().catch(error => {
    const diagnostic = finishingFailure(error);
    emit({ status: 'attention', code: /^CANARY_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'CANARY_OPERATION_FAILED',
      ...(diagnostic ? { finishing: diagnostic } : {}), automaticPaidRetry: false });
    process.exitCode = 1;
  });
}
