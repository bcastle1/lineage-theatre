// DRAFT ONLY: separate NEW $4.50 fal allowance requires explicit user approval.
// Run only from the reviewed candidate source and approved capable worker.
// Never use the old run's approval or modify its records to execute this test.
// No prior canary records, customer payment, invoice, or customer film is modified.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sourceRoot = resolve(process.env.LINEAGE_CANARY_SOURCE_ROOT || process.cwd());
const load = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const { digest, readRecord, writeRecord, userPath } = await load('api/_lib/auth.mjs');
const { isOwner } = await load('api/_lib/access.mjs');
const { buildFilmManifest, fictionalOperatorProject, createFilmProductionService, productionJobPath } = await load('api/_lib/film-production.mjs');
const { planKlingShots } = await load('api/_lib/kling-film-plan.mjs');
const { createFalProductionAdapter, FAL_RECIPE_VERSION, falPlan, falShotInput, characterReferenceInput, characterViewInput, characterViewIdentity, startFrameIdentity, startFrameInput } = await load('api/_lib/fal-production.mjs');
const { createFalClient, FAL_MODELS, falMediaUrl } = await load('api/_lib/fal-client.mjs');
const { klingReferenceData } = await load('api/_lib/fal-reference.mjs');
const { normalizeKlingInputReferences } = await load('api/_lib/kling-character-binding.mjs');
const { createFalPricing } = await load('api/_lib/fal-pricing.mjs');
const { createWorkerAssembly, verifyPublishedFilm } = await load('scripts/production-worker.mjs');
const { finishingFailure, storedFinishingFailure } = await load('api/_lib/film-finishing-diagnostics.mjs');
const { createFilmVisualReviewer, createRemoteVisualReview } = await load('scripts/review-film-visuals.mjs');
export const RUN_KEY = 'kling-cast-continuity-canary-20261105-v3';
export const EXECUTE_FLAG = '--execute-approved-new-450-cents-cast-v3-20261105';
const FIXED_HASH = '601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f';
const MAX_CENTS = 450;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = (value, code) => { if (!value) fail(code); };
const emit = value => { const observed = { observedAt: new Date().toISOString(), ...value }; process.stdout.write(JSON.stringify(observed) + '\n'); return observed; };
const stamp = () => new Date().toISOString();
export function candidateCanaryProfile() {
  const manifest = planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest, { characterBindingVersion: 3 });
  const plan = falPlan(manifest, 'kling'), fixedHash = digest(JSON.stringify(manifest));
  requireValue(fixedHash === FIXED_HASH && manifest.productionPlan?.characterBindingVersion === 3
    && manifest.visualContinuity?.version === 1 && manifest.targetDurationSeconds === 15
    && plan.generatedSeconds === 16 && plan.shots.length === 3 && plan.referenceCount === 7
    && plan.characters.length === 2 && plan.characters.every(character => character.referencePhotoId === undefined), 'CANARY_FIXED_PLAN_CHANGED');
  return { fixedHash, manifest, plan, summary: {
    kind: 'fictional-kling-quality-canary-v1', manifestHash: fixedHash, characterBindingVersion: 3,
    durationSeconds: 15, providerSeconds: 16, videoRequests: 3, referenceRequests: 7,
    frontalReferences: 2, additionalViews: 2, composedStartFrames: 3,
    maximumCostCents: MAX_CENTS, costScope: 'fal-only; normal OpenAI preflight and final verification are separate',
    recipe: FAL_RECIPE_VERSION, invoiceCreated: false, customerPaymentCreated: false,
    approvalStatus: 'separate-live-test-approval-required',
  } };
}
export function candidateIdentity(email) {
  const seed = digest(`${email}:${RUN_KEY}`);
  return `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}`;
}
export function candidateOperationBounds(id) {
  const { fixedHash, plan } = candidateCanaryProfile();
  return new Map([
    ...plan.characters.map(character => [digest(`${FAL_RECIPE_VERSION}:cast:${id}:${fixedHash}:${character.id}`), { endpoint: FAL_MODELS.reference, kind: 'reference-front', character }]),
    ...plan.characters.map(character => [characterViewIdentity(id, fixedHash, character.id), { endpoint: FAL_MODELS.reference, kind: 'reference-view', character }]),
    ...plan.shots.map(shot => [startFrameIdentity(id, fixedHash, shot.id), { endpoint: FAL_MODELS.reference, kind: 'start-frame', shot }]),
    ...plan.shots.map(shot => [digest(`${FAL_RECIPE_VERSION}:kling:${digest(`${id}:${fixedHash}:${shot.id}`)}`), { endpoint: FAL_MODELS.kling, kind: 'video', seconds: shot.seconds, shot }]),
  ]);
}
export function verifyCandidateGrant(grant, { ownerHash, id, now = Date.now() }) {
  const { fixedHash, summary } = candidateCanaryProfile();
  const approved = Date.parse(grant?.approvedAt), expiry = Date.parse(grant?.expiresAt);
  const cost = Math.ceil((16 * grant?.videoMicroUsdPerSecond + 7 * grant?.referenceMicroUsd) / 10000);
  requireValue(grant?.version === 1 && grant.kind === summary.kind && grant.runKey === RUN_KEY
    && grant.characterBindingVersion === 3 && grant.ownerHash === ownerHash && grant.preparedId === id
    && grant.manifestHash === fixedHash && grant.recipe === FAL_RECIPE_VERSION
    && grant.maximumCostCents === MAX_CENTS && grant.maximumVideoRequests === 3 && grant.maximumReferenceRequests === 7
    && Number.isSafeInteger(grant.videoMicroUsdPerSecond) && grant.videoMicroUsdPerSecond > 0
    && Number.isSafeInteger(grant.referenceMicroUsd) && grant.referenceMicroUsd > 0 && cost <= MAX_CENTS
    && grant.quotedCostCents === cost && grant.funding === 'existing-merchant-provider-credit' && grant.fictionalOnly === true
    && grant.quoteReference === digest(`${FAL_RECIPE_VERSION}:kling:${fixedHash}:${grant.videoMicroUsdPerSecond}:${grant.referenceMicroUsd}`)
    && Number.isFinite(approved) && approved <= now && expiry > now && expiry <= approved + 24 * 3600_000,
    'CANARY_GRANT_REQUIRED');
  return grant;
}
export function createGuardedCandidateClient({ id, ownerHash, grantContext, client, pricing, now = Date.now,
  normalizeReference = klingReferenceData }) {
  const { manifest, fixedHash, plan } = candidateCanaryProfile(), bounds = candidateOperationBounds(id);
  const same = (actual, expected, code) => requireValue(digest(JSON.stringify(actual)) === digest(JSON.stringify(expected)), code);
  async function completedImage(identity) {
    const record = await client.get(identity);
    requireValue(record?.identity === identity && record.endpoint === FAL_MODELS.reference
      && record.state === 'completed' && record.result?.images?.length === 1, 'CANARY_REFERENCE_NOT_COMPLETED');
    return falMediaUrl(record.result.images[0].url);
  }
  const frontalImage = character => completedImage(digest(`${FAL_RECIPE_VERSION}:cast:${id}:${fixedHash}:${character.id}`));
  async function shotReferences(shot, withViews) {
    const refs = {};
    for (const characterId of shot.characterIds) {
      const character = plan.characters.find(item => item.id === characterId);
      requireValue(character, 'CANARY_REFERENCE_INPUT_CHANGED');
      refs[characterId] = { frontalImageUrl: await frontalImage(character),
        ...(withViews ? { referenceImageUrls: [await completedImage(characterViewIdentity(id, fixedHash, characterId))] } : {}) };
    }
    return refs;
  }
  return { get: client.get, poll: client.poll, submit: async request => {
    const initial = await grantContext(), grant = verifyCandidateGrant(initial.grant, { ownerHash, id, now: now() });
    const bound = bounds.get(request.identity);
    requireValue(bound?.endpoint === request.endpoint, 'CANARY_OPERATION_OUTSIDE_BUDGET');
    if (bound.kind === 'reference-front') {
      same(request.input, characterReferenceInput(manifest, bound.character), 'CANARY_REFERENCE_INPUT_CHANGED');
    } else if (bound.kind === 'reference-view') {
      same(request.input, characterViewInput(manifest, bound.character, await frontalImage(bound.character)), 'CANARY_VIEW_INPUT_CHANGED');
    } else if (bound.kind === 'start-frame') {
      same(request.input, startFrameInput(manifest, bound.shot, await shotReferences(bound.shot, false)), 'CANARY_START_FRAME_INPUT_CHANGED');
    } else {
      const refs = await shotReferences(bound.shot, true);
      const start = await completedImage(startFrameIdentity(id, fixedHash, bound.shot.id));
      const expected = await normalizeKlingInputReferences(manifest,
        falShotInput(manifest, bound.shot, 'kling', refs, start), normalizeReference);
      same(request.input, expected, 'CANARY_VIDEO_INPUT_CHANGED');
    }
    const live = await pricing('kling');
    requireValue(Number.isSafeInteger(live.videoMicroUsdPerSecond) && live.videoMicroUsdPerSecond > 0
      && Number.isSafeInteger(live.referenceMicroUsd) && live.referenceMicroUsd > 0
      && Math.ceil((16 * live.videoMicroUsdPerSecond + 7 * live.referenceMicroUsd) / 10000) <= MAX_CENTS
      && live.videoMicroUsdPerSecond <= grant.videoMicroUsdPerSecond && live.referenceMicroUsd <= grant.referenceMicroUsd,
      'CANARY_PRICE_EXCEEDS_APPROVAL');
    const latest = await grantContext(); verifyCandidateGrant(latest.grant, { ownerHash, id, now: now() });
    requireValue(digest(JSON.stringify(latest.grant)) === digest(JSON.stringify(grant)), 'CANARY_GRANT_BINDING_CHANGED');
    return client.submit(request);
  } };
}
const timing = job => {
  const startedAt = job.productionStartedAt || job.shots?.map(shot => shot.submittedAt).filter(Boolean).sort()[0] || null;
  const completedAt = job.status === 'completed' ? job.completedAt || null : null;
  return { preparedAt: job.createdAt || null, productionStartedAt: startedAt, completedAt,
    elapsedSinceSubmissionMs: startedAt ? (completedAt ? Date.parse(completedAt) : Date.now()) - Date.parse(startedAt) : null };
};

export async function runDatedCanary(args = process.argv.slice(2)) {
  const quality = true;
  const [action, confirmation] = args;
  requireValue(['plan', 'prepare', 'step', 'finish', 'status', 'run'].includes(action)
    && args.length === (['prepare', 'step', 'finish', 'run'].includes(action) ? 2 : 1)
    && (!['prepare', 'step', 'finish', 'run'].includes(action) || confirmation === EXECUTE_FLAG), 'CANARY_USAGE');
  const { fixedHash, manifest, plan, summary: fixedSummary } = candidateCanaryProfile();
  const runKey = RUN_KEY;
  const summary = { ...fixedSummary, runKey, newIndependentCanary: true,
    visualReview: 'normal-production-endpoint', startFramePreflight: 'normal-production-endpoint-and-stored-receipt', requiresProductionHeartbeat: true };
  if (action === 'run') {
    const runnerStarted = Date.now();
    emit({ ...summary, status: 'run-started', runStartedAt: new Date(runnerStarted).toISOString() });
    await runDatedCanary(['prepare', EXECUTE_FLAG]);
    for (let checks = 0; checks < 240 && Date.now() - runnerStarted < 3_600_000; checks++) {
      const saved = await runDatedCanary(['status']);
      if (saved.status === 'completed') return saved;
      requireValue(!['uncertain', 'failed', 'attention'].includes(saved.status), 'CANARY_RECONCILIATION_REQUIRED');
      if (saved.status === 'awaiting-assembly') return runDatedCanary(['finish', EXECUTE_FLAG]);
      const next = await runDatedCanary(['step', EXECUTE_FLAG]);
      if (next.status === 'awaiting-assembly') return runDatedCanary(['finish', EXECUTE_FLAG]);
      requireValue(!['uncertain', 'failed', 'attention'].includes(next.status), 'CANARY_RECONCILIATION_REQUIRED');
      await new Promise(resolve => setTimeout(resolve, 15_000));
    }
    return emit({ ...summary, status: 'observation-timeout', automaticPaidRetry: false,
      message: 'Read this same canary status before continuing. Do not create another identity.' });
  }
  if (action === 'plan') { emit(summary); return; }
  const email = String(process.env.LINEAGE_CANARY_OWNER_EMAIL || '').trim().toLowerCase();
  requireValue(/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email), 'CANARY_OWNER_EMAIL_REQUIRED');
  requireValue(Boolean(process.env.BLOB_READ_WRITE_TOKEN), 'CANARY_STORAGE_REQUIRED');
  const ownerHash = digest(email), id = candidateIdentity(email);
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
    verifyCandidateGrant(grant, { ownerHash, id });
    return { job, grant };
  }
  const operationBounds = candidateOperationBounds(id);
  const key = () => process.env.FAL_KLING_KEY;
  const client = createFalClient({ key });
  const guardedClient = createGuardedCandidateClient({ id, ownerHash, grantContext, client,
    pricing: model => createFalPricing({ key })(model) });
  const adapter = createFalProductionAdapter({ model: 'kling', requireWorker: true, key, client: guardedClient });
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
    requireValue(adapter.available, 'CANARY_PROVIDER_UNAVAILABLE');
    const rates = await createFalPricing({ key })('kling');
    const quote = await adapter.quote({ manifest, manifestHash: fixedHash });
    requireValue(quote.currency === 'USD' && quote.providerCostCents > 0 && quote.providerCostCents <= MAX_CENTS, 'CANARY_PRICE_EXCEEDS_APPROVAL');
    requireValue(Math.ceil((16 * rates.videoMicroUsdPerSecond + 7 * rates.referenceMicroUsd) / 10000) <= MAX_CENTS, 'CANARY_PRICE_EXCEEDS_APPROVAL');
    const prepared = await film.prepareOperatorTest({ actor, idempotencyKey: runKey, characterBinding: true });
    requireValue(prepared.id === id && prepared.manifestHash === fixedHash, 'CANARY_PREPARATION_CHANGED');
    if (!(await readRecord(grantPath))) {
      const job = exactJob((await readRecord(jobPath))?.value);
      requireValue(job.status === 'prepared' && job.shots.every(shot => shot.status === 'prepared'), 'CANARY_ALREADY_STARTED_WITHOUT_GRANT');
      const approvalTime = Date.now();
      const grant = { version: 1, kind: summary.kind, runKey: RUN_KEY, characterBindingVersion: 3, ownerHash, preparedId: id, manifestHash: fixedHash,
        recipe: FAL_RECIPE_VERSION, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
        maximumCostCents: MAX_CENTS, maximumVideoRequests: 3, maximumReferenceRequests: 7,
        videoMicroUsdPerSecond: rates.videoMicroUsdPerSecond, referenceMicroUsd: rates.referenceMicroUsd,
        quoteReference: quote.quoteReference, quotedCostCents: quote.providerCostCents,
        approvedAt: new Date(approvalTime).toISOString(), expiresAt: new Date(approvalTime + 24 * 3600_000).toISOString() };
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
      operations.push({ identity, kind: bound.kind,
        state: saved?.state || 'not-submitted', requestId: saved?.requestId || null });
    }
    return emit({ ...summary, preparedId: id, status: storedFinishingFailure(job)?.state === 'attention' ? 'attention' : job.status,
      libraryUrl: 'https://lineagetheater.com/#library?film=' + id,
      ...timing(job), completedShots: job.shots.filter(shot => shot.status === 'completed').length,
      operations: operations.map(({ kind, state }) => ({ kind, state })),
      media: job.media ? { sha256: job.media.sha256, sizeBytes: job.media.sizeBytes, durationSeconds: job.media.durationSeconds, contentType: job.media.contentType } : null });
  }
  const { job } = await grantContext();
  requireValue(storedFinishingFailure(job)?.state !== 'attention', 'CANARY_RECONCILIATION_REQUIRED');
  if (action === 'step') {
    requireValue(!['uncertain', 'failed'].includes(job.status), 'CANARY_RECONCILIATION_REQUIRED');
    await film.advance({ email, id, actor: await owner(), authorizationReference: grantPath });
    const advanced = exactJob((await readRecord(jobPath))?.value);
    return emit({ ...summary, preparedId: id, status: advanced.status });
  }
  requireValue(job.status === 'awaiting-assembly' || job.status === 'completed', 'CANARY_NOT_READY_FOR_FINISHING');
  if (job.status === 'completed') return runDatedCanary(['status']);
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
      const reviewVisuals = createFilmVisualReviewer({ review: createRemoteVisualReview() });
      artifact = await createWorkerAssembly({ adapter, ...(quality ? { reviewVisuals } : {}) })({ email, id, job, stillOwned });
      await verifyPublishedFilm({ email, id, manifestHash: fixedHash, artifact, manifest });
      try { await writeRecord(artifactPath, artifact); } catch { /* Immutable readback below is mandatory. */ }
      const saved = (await readRecord(artifactPath))?.value;
      requireValue(saved?.sha256 === artifact.sha256 && saved.manifestHash === fixedHash, 'CANARY_ARTIFACT_CHANGED');
      artifact = saved;
    }
    requireValue(artifact?.manifestHash === fixedHash && artifact.speechReview?.passed === true, 'CANARY_SPEECH_NOT_VERIFIED');
    await film.acceptAssembly({ email, id, manifestHash: fixedHash, artifact, stillOwned });
    const completed = exactJob((await readRecord(jobPath))?.value);
    requireValue(completed.status === 'completed', 'CANARY_COMPLETION_NOT_VERIFIED');
    return emit({ ...summary, preparedId: id, status: 'completed',
      libraryUrl: 'https://lineagetheater.com/#library?film=' + id, ...timing(completed),
      readyObservedAt: stamp(), sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
      durationSeconds: artifact.durationSeconds, speechPassed: artifact.speechReview?.passed === true, privateReadbackVerified: true });
  } catch (error) {
    const failure = finishingFailure(error);
    if (failure) await film.recordFinishingFailure({ email, id, manifestHash: fixedHash, failure,
      needsAttention: true, stillOwned }).catch(() => false);
    throw error;
  } finally {
    const lock = await readRecord(lockPath);
    if (lock?.value.token === token) await writeRecord(lockPath, { ...lock.value, token: null, expiresAt: 0 }, lock.etag);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDatedCanary().catch(error => {
    const diagnostic = finishingFailure(error);
    emit({ status: 'attention', code: /^CANARY_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'CANARY_OPERATION_FAILED',
      ...(diagnostic ? { finishing: diagnostic } : {}), automaticPaidRetry: false });
    process.exitCode = 1;
  });
}
