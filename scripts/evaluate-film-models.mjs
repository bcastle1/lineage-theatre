// Isolated, merchant-funded comparison. This script never writes a production
// job, payment, qualification or Blob record. Keep its private directory intact:
// an exclusive claim permits at most one POST per candidate, even after a crash.
// Separately claimed recoveries are limited to the reviewed Kling rejections.
import { open, readFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { digest, readRecord, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL, isOwner, accessStatusForUser } from '../api/_lib/access.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS, falMediaUrl, falRequestUrl } from '../api/_lib/fal-client.mjs';
import { REALISTIC_FILM_DIRECTION, realisticCreativeText } from '../api/_lib/film-visual-style.mjs';
import { productionPhotoData } from '../api/_lib/production-photo-reference.mjs';

const ENDPOINTS = Object.freeze({ seedance: 'bytedance/seedance-2.5/us/reference-to-video', kling: 'fal-ai/kling-video/o3/pro/reference-to-video' });
// Reviewed 1080p/native-audio bounds; see docs/MODEL-EVALUATION.md. The pricing
// API exposes base units, so a base-price match alone cannot lower these floors.
const RATE_FLOORS = Object.freeze({ seedance: 1_200_000, kling: 150_000 });
// Reviewed together on the exact US endpoint: the API's 480p/720p base is
// $0.0214/1000 tokens; the published 1080p rate is $0.0234/1000 tokens.
// Preserve that resolution premium and the conservative per-second margin if
// the live base increases. This profile covers 1080p16:9 with images only.
const SEEDANCE_PRICING = Object.freeze({ basePerThousandTokens: 0.0214,
  highResolutionPerThousandTokens: 0.0234, width: 1920, height: 1080, framesPerSecond: 24, tokenPixels: 1024 });
const MAXIMUM_APPROVED_COST_CENTS = 2000;
const REVIEWED_KLING_REJECTION_ID = '01a15695-178d-7d90-838c-6be342ac18c3';
const REVIEWED_KLING_PROMPT_REJECTION_ID = '01a156a6-105b-7ae3-a3af-c84dba6fc6c7';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = (condition, code) => { if (!condition) fail(code); };
const jsonHash = value => digest(JSON.stringify(value));
const stamp = () => new Date().toISOString();
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function localJson(path, optional = false) {
  try {
    const info = await lstat(path);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.size < 2_000_000, 'LOCAL_RECORD_INVALID');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function saveExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}
async function boundedJson(response) {
  requireValue(response.body, 'PROVIDER_RESPONSE_INVALID');
  const reader = response.body.getReader(), parts = []; let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      count += value.byteLength; requireValue(count < 2_000_000, 'PROVIDER_RESPONSE_TOO_LARGE'); parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
async function request(url, method = 'GET', input) {
  requireValue(typeof process.env.FAL_KEY === 'string' && process.env.FAL_KEY.length > 0, 'FAL_KEY_REQUIRED');
  const result = await fetch(url, { method, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!result.ok) { await result.body?.cancel(); fail(`PROVIDER_HTTP_${result.status}`); }
  return boundedJson(result);
}
async function pricing() {
  const query = new URLSearchParams(); Object.values(ENDPOINTS).forEach(endpoint => query.append('endpoint_id', endpoint));
  const result = await request(`https://api.fal.ai/v1/models/pricing?${query}`), prices = {};
  for (const [model, endpoint] of Object.entries(ENDPOINTS)) {
    const rows = result.prices?.filter(row => row.endpoint_id === endpoint);
    requireValue(rows?.length === 1 && rows[0].currency === 'USD' && Number.isFinite(rows[0].unit_price)
      && rows[0].unit_price > 0 && typeof rows[0].unit === 'string', 'PROVIDER_PRICING_INVALID');
    prices[model] = { endpoint, unitPrice: rows[0].unit_price, unit: rows[0].unit, currency: 'USD' };
  }
  return { checkedAt: stamp(), prices };
}
function sourceSelection(config) {
  const { correctedPreparedId, originalManifestHash, correctedManifestHash, shotIndex } = config || {};
  requireValue(UUID.test(correctedPreparedId || '') && HASH.test(originalManifestHash || '')
    && HASH.test(correctedManifestHash || '') && Number.isSafeInteger(shotIndex) && shotIndex >= 0, 'CORRECTED_SOURCE_SELECTION_REQUIRED');
  const mapping = config.referenceCharacterMap ?? {};
  requireValue(mapping && typeof mapping === 'object' && !Array.isArray(mapping)
    && Object.keys(mapping).length <= 7 && Object.entries(mapping).every(([id, originalId]) =>
      id.length > 0 && id.length <= 2000 && typeof originalId === 'string' && originalId.length > 0 && originalId.length <= 2000), 'REFERENCE_MAPPING_INVALID');
  return { correctedPreparedId, originalManifestHash, correctedManifestHash, shotIndex,
    referenceCharacterMap: Object.fromEntries(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))) };
}
function charactersById(manifest) {
  const characters = manifest?.screenplay?.characters;
  requireValue(Array.isArray(characters) && characters.length >= 1 && characters.length <= 16
    && characters.every(character => typeof character?.id === 'string' && character.id.length > 0
      && typeof character.name === 'string' && typeof character.description === 'string')
    && new Set(characters.map(character => character.id)).size === characters.length, 'SOURCE_CAST_INVALID');
  return new Map(characters.map(character => [character.id, character]));
}
async function source(preparedId, config) {
  const selection = sourceSelection(config), { shotIndex, referenceCharacterMap } = selection;
  requireValue(UUID.test(preparedId) && preparedId !== selection.correctedPreparedId, 'SOURCE_SELECTION_INVALID');
  const owner = (await readRecord(userPath(OWNER_EMAIL)))?.value;
  requireValue(isOwner(owner) && !owner.mustChangePassword && accessStatusForUser(owner) === 'approved', 'OWNER_REQUIRED');
  const original = (await readRecord(`production/jobs/${digest(OWNER_EMAIL)}/${preparedId}.json`))?.value;
  requireValue(original?.status === 'completed' && original.ownerHash === digest(OWNER_EMAIL) && original.id === preparedId
    && original.mode === 'customer' && HASH.test(original.media?.sha256 || '') && original.manifestHash === selection.originalManifestHash
    && jsonHash(original.manifest) === original.manifestHash && original.filmId === original.manifest.filmId, 'COMPLETED_SOURCE_REQUIRED');
  const job = (await readRecord(`production/jobs/${digest(OWNER_EMAIL)}/${selection.correctedPreparedId}.json`))?.value;
  requireValue(job?.status === 'prepared' && job.ownerHash === original.ownerHash && job.id === selection.correctedPreparedId
    && job.mode === 'customer' && job.manifestHash === selection.correctedManifestHash
    && jsonHash(job.manifest) === job.manifestHash && job.filmId === job.manifest.filmId && UUID.test(job.filmId || '')
    && Number.isFinite(Date.parse(job.preparationConsentAt)) && !job.media
    && Array.isArray(job.shots) && job.shots.length === job.manifest.shots?.length
    && job.shots.every((shot, index) => shot.status === 'prepared' && shot.id === job.manifest.shots[index].id), 'CORRECTED_PREPARED_SOURCE_REQUIRED');
  // A corrected draft may have a new film ID. The approved plan binds both
  // immutable manifests explicitly, and limits this operation to a visual
  // correction of the original script, scene order and requested runtime.
  requireValue(job.manifest.targetDurationSeconds === original.manifest.targetDurationSeconds
    && job.manifest.ancestor === original.manifest.ancestor && job.manifest.style === original.manifest.style
    && job.manifest.factuality === original.manifest.factuality && job.manifest.shots.length === original.manifest.shots?.length
    && job.manifest.shots.every((shot, index) => ['narration', 'dialogue'].every(field =>
      typeof shot[field] === 'string' && shot[field] === original.manifest.shots[index][field])), 'CORRECTION_CHANGED_SAVED_SCRIPT');
  const originalCharacters = charactersById(original.manifest), characters = charactersById(job.manifest);
  const shot = job.manifest.shots?.[shotIndex];
  requireValue(shot && Array.isArray(shot.characterIds) && shot.characterIds.length >= 1
    && shot.characterIds.length <= 7 && new Set(shot.characterIds).size === shot.characterIds.length, 'SOURCE_SHOT_INVALID');
  const generatedIds = shot.characterIds.filter(id => !characters.get(id)?.referencePhotoId);
  requireValue(Object.keys(referenceCharacterMap).length === generatedIds.length
    && generatedIds.every(id => Object.hasOwn(referenceCharacterMap, id))
    && new Set(Object.values(referenceCharacterMap)).size === generatedIds.length, 'EXPLICIT_REFERENCE_MAPPING_REQUIRED');
  const references = [];
  for (const characterId of shot.characterIds) {
    const character = characters.get(characterId);
    requireValue(character, 'SOURCE_CHARACTER_INVALID');
    if (character.referencePhotoId) {
      const photo = character.referencePhoto;
      requireValue(UUID.test(character.referencePhotoId) && photo?.sourceId === character.referencePhotoId
        && photo.ownerHash === original.ownerHash && HASH.test(photo.sha256 || '') && HASH.test(photo.normalizedSha256 || '')
        && job.manifest.sources?.some(item => item.id === photo.sourceId), 'BOUND_CHARACTER_PHOTO_REQUIRED');
      // The helper freshly checks the owner-scoped ready record, private bytes,
      // source SHA, metadata and deterministic normalized JPEG SHA each time.
      const url = await productionPhotoData(job.manifest, character);
      requireValue(typeof url === 'string' && url.startsWith('data:image/jpeg;base64,'), 'PHOTO_TRANSPORT_INVALID');
      references.push({ characterId, kind: 'selected-photo', photo, url, character });
      continue;
    }
    requireValue(!character.referencePhoto, 'PHOTO_SELECTION_MISSING');
    const originalCharacterId = referenceCharacterMap[characterId], originalCharacter = originalCharacters.get(originalCharacterId);
    requireValue(originalCharacter && originalCharacter.name.trim().toLowerCase() === character.name.trim().toLowerCase(), 'REFERENCE_MAPPING_CHANGED_PERSON');
    const identity = digest(`${FAL_RECIPE_VERSION}:cast:${original.id}:${original.manifestHash}:${originalCharacterId}`);
    const record = (await readRecord(`production/fal/requests/${identity}.json`))?.value;
    requireValue(character && record?.state === 'completed' && record.identity === identity
      && record.endpoint === FAL_MODELS.reference && /^[\w-]{8,100}$/.test(record.requestId || '')
      && record.result?.images?.length === 1, 'EXISTING_REFERENCE_REQUIRED');
    references.push({ characterId, kind: 'existing-generated-reference', originalCharacterId,
      originalCharacterHash: jsonHash(originalCharacter), identity, requestId: record.requestId,
      url: falMediaUrl(record.result.images[0].url), character });
  }
  requireValue(references.some(reference => reference.kind === 'selected-photo'), 'SELECTED_CHARACTER_PHOTO_REQUIRED');
  const referenceBindings = references.map(({ url, character, ...reference }) => ({ ...reference,
    characterHash: jsonHash(character), ...(reference.kind === 'existing-generated-reference' ? { url } : {}) }));
  const binding = { preparedId, filmId: original.filmId, manifestHash: original.manifestHash,
    deliveredMediaSha256: original.media.sha256, correctedPreparedId: job.id, correctedFilmId: job.filmId,
    correctedManifestHash: job.manifestHash, shotIndex, originalShotHash: jsonHash(original.manifest.shots[shotIndex]),
    correctedShotHash: jsonHash(shot), references: referenceBindings, referencesHash: jsonHash(referenceBindings) };
  return { job, shot, references, binding, sourceSelection: selection };
}
function excerpt(config, shot) {
  requireValue(Number.isSafeInteger(config.durationSeconds) && config.durationSeconds >= 4 && config.durationSeconds <= 15,
    'DURATION_MUST_BE_4_TO_15_SECONDS');
  for (const name of ['narration', 'dialogue']) requireValue(typeof config[name] === 'string' && config[name].length <= 5000
    && (config[name] === '' || typeof shot[name] === 'string' && shot[name].includes(config[name])), 'EXCERPT_MUST_MATCH_SAVED_SCRIPT');
  const words = `${config.narration} ${config.dialogue}`.trim().split(/\s+/).filter(Boolean).length;
  requireValue(words >= 1 && words <= config.durationSeconds * 2.5, 'EXCERPT_TOO_LONG');
  return { durationSeconds: config.durationSeconds, narration: config.narration, dialogue: config.dialogue };
}
function inputs(context, selection) {
  const { job, shot, references } = context, urls = references.map(reference => reference.url);
  const common = [REALISTIC_FILM_DIRECTION, `Era: ${job.manifest.era}. ${job.manifest.screenplay.logline}.`,
    `Scene: ${realisticCreativeText(shot.visual)}.`, `Historical boundaries: ${shot.dramatization || 'Do not add undocumented claims.'}`,
    'Use the references only to preserve character identity; begin in the finished scene, never show a reference image.',
    `Speak this narration once, verbatim: ${selection.narration || '(none)'}`,
    `Speak this character dialogue once, verbatim, with distinct voices and synchronized mouths: ${selection.dialogue || '(none)'}`,
    `Start speech immediately and finish before ${selection.durationSeconds - 0.3} seconds. Add no speech.`,
    'Clear natural English speech, restrained cinematic ambience. No music, captions, logos, titles or watermarks.'];
  const prompt = [...references.map((reference, index) => `@Image${index + 1}: ${reference.character.name}; ${realisticCreativeText(reference.character.description)}`), ...common].join('\n');
  requireValue(prompt.length <= 12000, 'PROMPT_TOO_LONG');
  return { seedance: { prompt, task: 'reference', duration: String(selection.durationSeconds),
    image_urls: urls, generate_audio: true, resolution: '1080p', aspect_ratio: '16:9', bitrate_mode: 'high', codec: 'H264' },
  kling: { prompt, duration: String(selection.durationSeconds), image_urls: urls,
    generate_audio: true, aspect_ratio: '16:9', shot_type: 'customize' } };
}
function inputProof(payloads, context) {
  return Object.fromEntries(Object.entries(payloads).map(([model, payload]) => [model, {
    sha256: jsonHash(payload),
    // Persist reviewable inputs without writing private photo bytes twice.
    review: { ...payload, image_urls: payload.image_urls.map((url, index) => context.references[index].kind === 'selected-photo'
      ? { transport: 'base64-data-uri', sourceId: context.references[index].photo.sourceId,
        normalizedSha256: context.references[index].photo.normalizedSha256 } : url) },
  }]));
}
function auditedRates(rates, live, seconds) {
  let total = 0;
  for (const [model, endpoint] of Object.entries(ENDPOINTS)) {
    const rate = rates?.[model], current = live.prices[model];
    requireValue(rate && rate.unitPrice === current.unitPrice && rate.unit === current.unit
      && Number.isSafeInteger(rate.maximumMicroUsdPerSecond) && rate.maximumMicroUsdPerSecond > 0
      && rate.maximumMicroUsdPerSecond <= 10_000_000 && typeof rate.sourceUrl === 'string', 'PRICE_REVIEW_REQUIRED');
    const unit = current.unit.trim().toLowerCase().replace(/\s+/g, ' ');
    let minimum;
    if (model === 'seedance') {
      requireValue(unit === '1000 tokens', 'PRICE_UNIT_UNREVIEWED');
      const profile = SEEDANCE_PRICING, baseRatio = current.unitPrice / profile.basePerThousandTokens;
      const outputTokensPerSecond = profile.width * profile.height * profile.framesPerSecond / profile.tokenPixels;
      const resolutionRate = current.unitPrice * profile.highResolutionPerThousandTokens / profile.basePerThousandTokens;
      const tokenCostMicroUsdPerSecond = outputTokensPerSecond / 1000 * resolutionRate * 1_000_000;
      minimum = Math.ceil(Math.max(RATE_FLOORS.seedance, tokenCostMicroUsdPerSecond,
        RATE_FLOORS.seedance * baseRatio));
    } else {
      requireValue(['second', 'seconds'].includes(unit), 'PRICE_UNIT_UNREVIEWED');
      minimum = Math.ceil(Math.max(RATE_FLOORS.kling, current.unitPrice * 1_000_000));
    }
    requireValue(rate.maximumMicroUsdPerSecond >= minimum, 'PRICE_BOUND_TOO_LOW');
    let url; try { url = new URL(rate.sourceUrl); } catch { fail('PRICE_REVIEW_REQUIRED'); }
    requireValue(url.protocol === 'https:' && url.hostname === 'fal.ai' && url.pathname.startsWith(`/models/${endpoint}`)
      && !url.username && !url.password && !url.search && !url.hash, 'PRICE_SOURCE_INVALID');
    total += Math.ceil(seconds * rate.maximumMicroUsdPerSecond / 10000);
  }
  return total;
}
async function prepare(args, directory) {
  const config = await localJson(resolve(args.config || ''));
  const context = await source(args['prepared-id'] || '', config), selection = excerpt(config, context.shot);
  const maximumCostCents = Number(args['maximum-cost-cents']);
  requireValue(Number.isSafeInteger(maximumCostCents) && maximumCostCents > 0 && maximumCostCents <= MAXIMUM_APPROVED_COST_CENTS, 'EXPLICIT_BUDGET_REQUIRED');
  const live = await pricing();
  await saveExclusive(join(directory, `pricing-${Date.now()}-${randomUUID()}.json`), live);
  if (!config.rates) { emit({ status: 'price-review-required', ...live, maximumCostCents, providerSubmissions: 0 }); return; }
  const maximumEstimatedCostCents = auditedRates(config.rates, live, selection.durationSeconds);
  requireValue(maximumEstimatedCostCents <= maximumCostCents, 'BUDGET_EXCEEDED');
  const plan = { version: 2, kind: 'isolated-film-model-evaluation', evaluationId: randomUUID(), createdAt: stamp(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), ownerEmail: OWNER_EMAIL, funding: 'merchant',
    source: context.binding, sourceSelection: context.sourceSelection, selection, endpoints: ENDPOINTS,
    inputProof: inputProof(inputs(context, selection), context), pricing: live,
    rates: config.rates, maximumCostCents, maximumEstimatedCostCents };
  const planSha256 = jsonHash(plan);
  await saveExclusive(join(directory, 'plan.json'), { planSha256, plan });
  emit({ status: 'prepared', planSha256, source: plan.source, durationSeconds: selection.durationSeconds,
    maximumCostCents, maximumEstimatedCostCents, models: Object.keys(ENDPOINTS), providerSubmissions: 0 });
}
async function loadPlan(directory) {
  const saved = await localJson(join(directory, 'plan.json')), plan = saved?.plan;
  requireValue(plan?.version === 2 && plan.kind === 'isolated-film-model-evaluation' && plan.ownerEmail === OWNER_EMAIL
    && plan.funding === 'merchant' && UUID.test(plan.evaluationId || '') && HASH.test(saved.planSha256 || '')
    && jsonHash(plan) === saved.planSha256 && jsonHash(plan.endpoints) === jsonHash(ENDPOINTS), 'PLAN_INVALID');
  return saved;
}
async function submit(args, directory) {
  const { plan, planSha256 } = await loadPlan(directory);
  requireValue(args['approve-plan-sha256'] === planSha256 && Date.parse(plan.expiresAt) > Date.now(), 'CURRENT_PLAN_APPROVAL_REQUIRED');
  for (const [model, endpoint] of Object.entries(ENDPOINTS)) {
    const claimPath = join(directory, `${model}-claim.json`), existing = await localJson(claimPath, true);
    if (existing) {
      requireValue(existing.planSha256 === planSha256 && existing.endpoint === endpoint, 'CLAIM_CONFLICT');
      emit({ model, status: 'already-claimed-no-resubmission' }); continue;
    }
    const current = await source(plan.source.preparedId, plan.sourceSelection);
    requireValue(jsonHash(current.binding) === jsonHash(plan.source), 'SOURCE_CHANGED');
    const selected = excerpt(plan.selection, current.shot);
    const payloads = inputs(current, selected);
    requireValue(jsonHash(inputProof(payloads, current)) === jsonHash(plan.inputProof), 'INPUT_CHANGED');
    const live = await pricing(), cost = auditedRates(plan.rates, live, selected.durationSeconds);
    requireValue(cost === plan.maximumEstimatedCostCents && Number.isSafeInteger(plan.maximumCostCents)
      && cost <= plan.maximumCostCents && plan.maximumCostCents <= MAXIMUM_APPROVED_COST_CENTS, 'BUDGET_CHANGED');
    requireValue(Date.parse(plan.expiresAt) > Date.now(), 'CURRENT_PLAN_APPROVAL_REQUIRED');
    const claim = { version: 1, evaluationId: plan.evaluationId, planSha256, model, endpoint,
      inputSha256: plan.inputProof[model].sha256, claimedAt: stamp(), state: 'submission-claimed', pricing: live };
    await saveExclusive(claimPath, claim);
    try {
      const response = await request(`https://queue.fal.run/${endpoint}`, 'POST', payloads[model]);
      // Preserve the provider's request identity before validating convenience
      // URLs, so an unexpected receipt remains available for manual reconciliation.
      await saveExclusive(join(directory, `${model}-response.json`), { planSha256, receivedAt: stamp(),
        requestId: response.request_id, statusUrl: response.status_url, responseUrl: response.response_url });
      const receipt = { ...claim, state: 'queued', requestId: response.request_id, receivedAt: stamp(),
        statusUrl: falRequestUrl(response.status_url, endpoint, response.request_id, 'status'),
        responseUrl: falRequestUrl(response.response_url, endpoint, response.request_id, 'result') };
      await saveExclusive(join(directory, `${model}-receipt.json`), receipt);
      emit({ model, status: 'queued', requestId: receipt.requestId });
    } catch (error) {
      await saveExclusive(join(directory, `${model}-uncertain.json`), { planSha256, state: 'uncertain', at: stamp(),
        code: /^PROVIDER_[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'SUBMISSION_RECEIPT_UNCONFIRMED' }).catch(() => {});
      emit({ model, status: 'uncertain-no-resubmission' }); return;
    }
  }
}
async function retryRejectedKling(args, directory) {
  const { plan, planSha256 } = await loadPlan(directory), model = 'kling', endpoint = ENDPOINTS.kling;
  requireValue(args['approve-plan-sha256'] === planSha256 && Date.parse(plan.expiresAt) > Date.now(), 'CURRENT_PLAN_APPROVAL_REQUIRED');
  const recoveryPath = join(directory, 'kling-recovery-claim.json'), existing = await localJson(recoveryPath, true);
  if (existing) {
    requireValue(existing.planSha256 === planSha256 && existing.endpoint === endpoint
      && existing.originalRequestId === REVIEWED_KLING_REJECTION_ID, 'RECOVERY_CLAIM_CONFLICT');
    emit({ model, status: 'recovery-already-claimed-no-resubmission' }); return;
  }
  for (const suffix of ['response', 'receipt', 'uncertain', 'terminal'])
    requireValue(!await localJson(join(directory, `kling-recovery-${suffix}.json`), true), 'RECOVERY_CLAIM_MISSING');
  const originalClaim = await localJson(join(directory, 'kling-claim.json'));
  const original = await localJson(join(directory, 'kling-receipt.json'));
  requireValue(originalClaim.planSha256 === planSha256 && originalClaim.endpoint === endpoint
    && originalClaim.inputSha256 === plan.inputProof.kling.sha256 && originalClaim.evaluationId === plan.evaluationId
    && original.planSha256 === planSha256 && original.endpoint === endpoint && original.evaluationId === plan.evaluationId
    && original.requestId === REVIEWED_KLING_REJECTION_ID && original.inputSha256 === originalClaim.inputSha256
    && original.claimedAt === originalClaim.claimedAt && original.state === 'queued', 'REVIEWED_REJECTION_RECEIPT_REQUIRED');
  const oldTerminal = await localJson(join(directory, 'kling-terminal.json'), true);
  requireValue(!oldTerminal || oldTerminal.planSha256 === planSha256 && oldTerminal.requestId === original.requestId
    && oldTerminal.endpoint === endpoint && oldTerminal.state === 'failed' && !oldTerminal.output, 'ORIGINAL_KLING_OUTPUT_EXISTS');
  const seedance = await localJson(join(directory, 'seedance-receipt.json'));
  const seedanceTerminal = await localJson(join(directory, 'seedance-terminal.json'));
  requireValue(seedance.planSha256 === planSha256 && seedance.endpoint === ENDPOINTS.seedance
    && seedance.inputSha256 === plan.inputProof.seedance.sha256 && seedanceTerminal.planSha256 === planSha256
    && seedanceTerminal.requestId === seedance.requestId && seedanceTerminal.endpoint === ENDPOINTS.seedance
    && seedanceTerminal.state === 'completed' && seedanceTerminal.output, 'COMPLETED_SEEDANCE_REQUIRED');
  const current = await source(plan.source.preparedId, plan.sourceSelection);
  requireValue(jsonHash(current.binding) === jsonHash(plan.source), 'SOURCE_CHANGED');
  const selected = excerpt(plan.selection, current.shot), payloads = inputs(current, selected);
  requireValue(jsonHash(inputProof(payloads, current)) === jsonHash(plan.inputProof), 'INPUT_CHANGED');
  const live = await pricing(), cost = auditedRates(plan.rates, live, selected.durationSeconds);
  requireValue(cost === plan.maximumEstimatedCostCents && Number.isSafeInteger(plan.maximumCostCents)
    && cost <= plan.maximumCostCents && plan.maximumCostCents <= MAXIMUM_APPROVED_COST_CENTS, 'BUDGET_CHANGED');
  const status = await request(falRequestUrl(original.statusUrl, endpoint, original.requestId, 'status'));
  requireValue(status.status === 'COMPLETED' && status.request_id === original.requestId, 'TERMINAL_REJECTION_REQUIRED');
  // A successful, pending, missing or ambiguous result never permits recovery.
  // This GET must return the exact endpoint-specific access rejection already
  // reviewed by the operator, using the newly authorized account credential.
  const result = await fetch(falRequestUrl(original.responseUrl, endpoint, original.requestId, 'result'), {
    method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (result.status !== 403) { await result.body?.cancel(); fail('EXACT_ACCESS_REJECTION_REQUIRED'); }
  const body = await boundedJson(result);
  requireValue(body && !Array.isArray(body) && Object.keys(body).sort().join(',') === 'detail,type'
    && body.type === 'resource_restricted'
    && body.detail === `API key does not have access to model: ${endpoint}`, 'EXACT_ACCESS_REJECTION_REQUIRED');
  const rejectionPath = join(directory, 'kling-confirmed-rejection.json');
  let rejection = await localJson(rejectionPath, true);
  if (rejection) {
    requireValue(rejection.planSha256 === planSha256 && rejection.endpoint === endpoint
      && rejection.originalRequestId === original.requestId && rejection.httpStatus === 403
      && jsonHash(rejection.body) === jsonHash(body), 'REJECTION_RECORD_CONFLICT');
  } else {
    rejection = { version: 1, planSha256, endpoint, originalRequestId: original.requestId,
      httpStatus: 403, body, confirmedAt: stamp() };
    await saveExclusive(rejectionPath, rejection);
  }
  requireValue(Date.parse(plan.expiresAt) > Date.now(), 'CURRENT_PLAN_APPROVAL_REQUIRED');
  const claim = { version: 1, evaluationId: plan.evaluationId, planSha256, model, endpoint,
    recovery: 'reviewed-resource-restricted', originalRequestId: original.requestId,
    rejectionSha256: jsonHash(rejection), inputSha256: plan.inputProof.kling.sha256,
    claimedAt: stamp(), state: 'submission-claimed', pricing: live, maximumEstimatedCostCents: cost };
  await saveExclusive(recoveryPath, claim);
  try {
    const response = await request(`https://queue.fal.run/${endpoint}`, 'POST', payloads.kling);
    await saveExclusive(join(directory, 'kling-recovery-response.json'), { planSha256, receivedAt: stamp(),
      requestId: response.request_id, statusUrl: response.status_url, responseUrl: response.response_url });
    requireValue(response.request_id !== original.requestId, 'RECOVERY_REQUEST_ID_REUSED');
    const receipt = { ...claim, state: 'queued', requestId: response.request_id, receivedAt: stamp(),
      statusUrl: falRequestUrl(response.status_url, endpoint, response.request_id, 'status'),
      responseUrl: falRequestUrl(response.response_url, endpoint, response.request_id, 'result') };
    await saveExclusive(join(directory, 'kling-recovery-receipt.json'), receipt);
    emit({ model, status: 'recovery-queued', requestId: receipt.requestId, originalRequestId: original.requestId });
  } catch (error) {
    await saveExclusive(join(directory, 'kling-recovery-uncertain.json'), { planSha256, state: 'uncertain', at: stamp(),
      code: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'SUBMISSION_RECEIPT_UNCONFIRMED' }).catch(() => {});
    emit({ model, status: 'recovery-uncertain-no-resubmission' });
  }
}
function correctedKlingPrompt(context, selection, prompt) {
  requireValue(typeof prompt === 'string' && prompt.length > 0 && prompt.length <= 2500
    && !prompt.includes('\uFFFD') && selection.durationSeconds === 12, 'AMENDED_PROMPT_INVALID');
  const labels = new Set([...prompt.matchAll(/@Image(\d+)\b/g)].map(match => Number(match[1])));
  const folded = value => value.replace(/\s+/g, ' ').trim().toLowerCase();
  requireValue(labels.size === context.references.length && context.references.every((reference, index) =>
    labels.has(index + 1) && folded(prompt).includes(folded(reference.character.name)))
    && [selection.narration, selection.dialogue].every(text => !text || prompt.includes(text))
    && (!context.shot.dramatization || folded(prompt).includes(folded(context.shot.dramatization))), 'AMENDED_PROMPT_OMITS_SAVED_CONTENT');
  return prompt;
}
async function promptRecoveryContext(plan, planSha256, directory, prompt) {
  const originalClaim = await localJson(join(directory, 'kling-claim.json'));
  const original = await localJson(join(directory, 'kling-receipt.json'));
  const previous = await localJson(join(directory, 'kling-recovery-receipt.json'));
  const previousClaim = await localJson(join(directory, 'kling-recovery-claim.json'));
  const accessRejection = await localJson(join(directory, 'kling-confirmed-rejection.json'));
  requireValue(originalClaim.planSha256 === planSha256 && originalClaim.endpoint === ENDPOINTS.kling
    && originalClaim.inputSha256 === plan.inputProof.kling.sha256 && originalClaim.claimedAt === original.claimedAt
    && original.planSha256 === planSha256 && original.endpoint === ENDPOINTS.kling
    && original.requestId === REVIEWED_KLING_REJECTION_ID && original.inputSha256 === plan.inputProof.kling.sha256
    && previous.planSha256 === planSha256 && previous.endpoint === ENDPOINTS.kling
    && previous.requestId === REVIEWED_KLING_PROMPT_REJECTION_ID && previous.originalRequestId === original.requestId
    && previous.inputSha256 === plan.inputProof.kling.sha256 && previous.state === 'queued'
    && previousClaim.planSha256 === planSha256 && previousClaim.endpoint === ENDPOINTS.kling
    && previousClaim.originalRequestId === original.requestId && previousClaim.claimedAt === previous.claimedAt
    && previousClaim.inputSha256 === previous.inputSha256 && previousClaim.rejectionSha256 === previous.rejectionSha256
    && previous.rejectionSha256 === jsonHash(accessRejection), 'PROMPT_REJECTION_CHAIN_REQUIRED');
  const oldTerminal = await localJson(join(directory, 'kling-recovery-terminal.json'), true);
  requireValue(!oldTerminal || oldTerminal.planSha256 === planSha256 && oldTerminal.requestId === previous.requestId
    && oldTerminal.state === 'failed' && !oldTerminal.output, 'PRIOR_KLING_OUTPUT_EXISTS');
  const seedance = await localJson(join(directory, 'seedance-receipt.json'));
  const terminal = await localJson(join(directory, 'seedance-terminal.json'));
  requireValue(seedance.planSha256 === planSha256 && seedance.endpoint === ENDPOINTS.seedance
    && seedance.inputSha256 === plan.inputProof.seedance.sha256 && terminal.planSha256 === planSha256
    && terminal.requestId === seedance.requestId && terminal.endpoint === ENDPOINTS.seedance
    && terminal.state === 'completed' && terminal.output, 'COMPLETED_SEEDANCE_REQUIRED');
  const current = await source(plan.source.preparedId, plan.sourceSelection);
  requireValue(jsonHash(current.binding) === jsonHash(plan.source), 'SOURCE_CHANGED');
  const selected = excerpt(plan.selection, current.shot), payloads = inputs(current, selected);
  requireValue(jsonHash(inputProof(payloads, current)) === jsonHash(plan.inputProof), 'INPUT_CHANGED');
  const live = await pricing(), originalCost = auditedRates(plan.rates, live, selected.durationSeconds);
  // Reserve the full bound for all three Kling submissions, including the two
  // rejected attempts. No unverified billing exemption can increase this limit.
  const priorKlingReserveCents = 2 * Math.ceil(selected.durationSeconds * plan.rates.kling.maximumMicroUsdPerSecond / 10000);
  const worstCaseCostCents = originalCost + priorKlingReserveCents;
  requireValue(originalCost === plan.maximumEstimatedCostCents && Number.isSafeInteger(plan.maximumCostCents)
    && worstCaseCostCents <= plan.maximumCostCents && plan.maximumCostCents <= MAXIMUM_APPROVED_COST_CENTS, 'BUDGET_CHANGED');
  const status = await request(falRequestUrl(previous.statusUrl, ENDPOINTS.kling, previous.requestId, 'status'));
  requireValue(status.status === 'COMPLETED' && status.request_id === previous.requestId, 'TERMINAL_REJECTION_REQUIRED');
  const response = await fetch(falRequestUrl(previous.responseUrl, ENDPOINTS.kling, previous.requestId, 'result'), {
    method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (response.status !== 422) { await response.body?.cancel(); fail('EXACT_PROMPT_REJECTION_REQUIRED'); }
  const body = await boundedJson(response), expected = { detail: [{ loc: ['body', 'prompt'],
    msg: 'String should have at most 2500 characters', type: 'string_too_long',
    inputSha256: digest(payloads.kling.prompt), ctx: { max_length: 2500 } }] };
  requireValue(body && Object.keys(body).join(',') === 'detail' && Array.isArray(body.detail) && body.detail.length === 1
    && body.detail[0] && Object.keys(body.detail[0]).sort().join(',') === 'ctx,input,loc,msg,type'
    && jsonHash(body.detail[0].loc) === jsonHash(expected.detail[0].loc)
    && body.detail[0].msg === expected.detail[0].msg && body.detail[0].type === expected.detail[0].type
    && body.detail[0].input === payloads.kling.prompt && body.detail[0].ctx
    && Object.keys(body.detail[0].ctx).join(',') === 'max_length' && body.detail[0].ctx.max_length === 2500,
  'EXACT_PROMPT_REJECTION_REQUIRED');
  const payload = { ...payloads.kling, prompt: correctedKlingPrompt(current, selected, prompt) };
  const proof = inputProof({ kling: payload }, current).kling;
  return { previous, payload, proof, live, worstCaseCostCents, priorKlingReserveCents,
    rejection: { planSha256, endpoint: ENDPOINTS.kling, originalRequestId: previous.requestId, httpStatus: 422,
      providerBodySha256: jsonHash(body), body: expected },
    ledgerSha256: jsonHash({ originalClaim, original, previous, previousClaim, accessRejection, seedance, terminal }) };
}
async function prepareKlingPromptRecovery(args, directory) {
  const { plan, planSha256 } = await loadPlan(directory);
  requireValue(args['approve-plan-sha256'] === planSha256 && Date.parse(plan.expiresAt) > Date.now(), 'CURRENT_PLAN_APPROVAL_REQUIRED');
  requireValue(typeof args['prompt-file'] === 'string' && args['prompt-file'].length > 0, 'PRIVATE_PROMPT_FILE_REQUIRED');
  const promptPath = resolve(args['prompt-file']), info = await lstat(promptPath);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 10_000, 'PRIVATE_PROMPT_FILE_INVALID');
  const prompt = (await readFile(promptPath, 'utf8')).replace(/\r\n/g, '\n').trim();
  const context = await promptRecoveryContext(plan, planSha256, directory, prompt);
  requireValue(Date.parse(plan.expiresAt) > Date.now(), 'CURRENT_PLAN_APPROVAL_REQUIRED');
  const rejectionPath = join(directory, 'kling-prompt-confirmed-rejection.json');
  const savedRejection = await localJson(rejectionPath, true);
  if (savedRejection) requireValue(jsonHash(savedRejection) === jsonHash(context.rejection), 'REJECTION_RECORD_CONFLICT');
  else await saveExclusive(rejectionPath, context.rejection);
  const amendment = { version: 1, kind: 'reviewed-kling-prompt-recovery', planSha256,
    originalRequestId: context.previous.requestId, endpoint: ENDPOINTS.kling, createdAt: stamp(), expiresAt: plan.expiresAt,
    sourceSha256: jsonHash(plan.source), ledgerSha256: context.ledgerSha256,
    rejectionSha256: jsonHash(context.rejection), inputProof: context.proof,
    pricing: context.live, priorKlingReserveCents: context.priorKlingReserveCents, worstCaseCostCents: context.worstCaseCostCents };
  const amendmentSha256 = jsonHash(amendment);
  await saveExclusive(join(directory, 'kling-prompt-amendment.json'), { amendmentSha256, amendment });
  emit({ status: 'kling-prompt-amendment-prepared', amendmentSha256, prompt: context.payload.prompt,
    promptCharacters: context.payload.prompt.length, worstCaseCostCents: context.worstCaseCostCents, providerSubmissions: 0 });
}
async function loadKlingPromptAmendment(directory, planSha256) {
  const saved = await localJson(join(directory, 'kling-prompt-amendment.json')), amendment = saved.amendment;
  requireValue(HASH.test(saved.amendmentSha256 || '') && jsonHash(amendment) === saved.amendmentSha256
    && amendment?.version === 1 && amendment.kind === 'reviewed-kling-prompt-recovery' && amendment.planSha256 === planSha256
    && amendment.endpoint === ENDPOINTS.kling && amendment.originalRequestId === REVIEWED_KLING_PROMPT_REJECTION_ID
    && HASH.test(amendment.inputProof?.sha256 || ''), 'PROMPT_AMENDMENT_INVALID');
  return saved;
}
async function submitKlingPromptRecovery(args, directory) {
  const { plan, planSha256 } = await loadPlan(directory);
  const { amendment, amendmentSha256 } = await loadKlingPromptAmendment(directory, planSha256);
  requireValue(args['approve-plan-sha256'] === planSha256 && args['approve-amendment-sha256'] === amendmentSha256
    && Date.parse(plan.expiresAt) > Date.now() && Date.parse(amendment.expiresAt) > Date.now(), 'CURRENT_AMENDMENT_APPROVAL_REQUIRED');
  const claimPath = join(directory, 'kling-prompt-recovery-claim.json'), existing = await localJson(claimPath, true);
  if (existing) {
    requireValue(existing.planSha256 === planSha256 && existing.amendmentSha256 === amendmentSha256, 'RECOVERY_CLAIM_CONFLICT');
    emit({ model: 'kling', status: 'prompt-recovery-already-claimed-no-resubmission' }); return;
  }
  for (const suffix of ['response', 'receipt', 'uncertain', 'terminal'])
    requireValue(!await localJson(join(directory, `kling-prompt-recovery-${suffix}.json`), true), 'RECOVERY_CLAIM_MISSING');
  const context = await promptRecoveryContext(plan, planSha256, directory, amendment.inputProof.review.prompt);
  requireValue(amendment.sourceSha256 === jsonHash(plan.source) && amendment.ledgerSha256 === context.ledgerSha256
    && amendment.rejectionSha256 === jsonHash(context.rejection) && jsonHash(amendment.inputProof) === jsonHash(context.proof)
    && amendment.worstCaseCostCents === context.worstCaseCostCents
    && amendment.priorKlingReserveCents === context.priorKlingReserveCents, 'PROMPT_AMENDMENT_CHANGED');
  requireValue(Date.parse(plan.expiresAt) > Date.now() && Date.parse(amendment.expiresAt) > Date.now(), 'CURRENT_AMENDMENT_APPROVAL_REQUIRED');
  const claim = { version: 1, evaluationId: plan.evaluationId, planSha256, amendmentSha256, model: 'kling', endpoint: ENDPOINTS.kling,
    recovery: 'reviewed-prompt-length', originalRequestId: context.previous.requestId, rejectionSha256: amendment.rejectionSha256,
    inputSha256: context.proof.sha256, claimedAt: stamp(), state: 'submission-claimed', pricing: context.live,
    worstCaseCostCents: context.worstCaseCostCents };
  await saveExclusive(claimPath, claim);
  try {
    const response = await request(`https://queue.fal.run/${ENDPOINTS.kling}`, 'POST', context.payload);
    await saveExclusive(join(directory, 'kling-prompt-recovery-response.json'), { planSha256, amendmentSha256, receivedAt: stamp(),
      requestId: response.request_id, statusUrl: response.status_url, responseUrl: response.response_url });
    requireValue(![REVIEWED_KLING_REJECTION_ID, REVIEWED_KLING_PROMPT_REJECTION_ID].includes(response.request_id), 'RECOVERY_REQUEST_ID_REUSED');
    const receipt = { ...claim, state: 'queued', requestId: response.request_id, receivedAt: stamp(),
      statusUrl: falRequestUrl(response.status_url, ENDPOINTS.kling, response.request_id, 'status'),
      responseUrl: falRequestUrl(response.response_url, ENDPOINTS.kling, response.request_id, 'result') };
    await saveExclusive(join(directory, 'kling-prompt-recovery-receipt.json'), receipt);
    emit({ model: 'kling', status: 'prompt-recovery-queued', requestId: receipt.requestId, amendmentSha256 });
  } catch (error) {
    await saveExclusive(join(directory, 'kling-prompt-recovery-uncertain.json'), { planSha256, amendmentSha256,
      state: 'uncertain', at: stamp(), code: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'SUBMISSION_RECEIPT_UNCONFIRMED' }).catch(() => {});
    emit({ model: 'kling', status: 'prompt-recovery-uncertain-no-resubmission' });
  }
}
async function poll(directory) {
  const { plan, planSha256 } = await loadPlan(directory);
  for (const [model, endpoint] of Object.entries(ENDPOINTS)) {
    const promptRecovery = model === 'kling' ? await localJson(join(directory, 'kling-prompt-recovery-claim.json'), true) : null;
    const amendment = promptRecovery ? await loadKlingPromptAmendment(directory, planSha256) : null;
    const recovery = promptRecovery || (model === 'kling' ? await localJson(join(directory, 'kling-recovery-claim.json'), true) : null);
    const prefix = promptRecovery ? 'kling-prompt-recovery' : recovery ? 'kling-recovery' : model;
    const expectedInputHash = amendment ? amendment.amendment.inputProof.sha256 : plan.inputProof?.[model]?.sha256;
    if (recovery) requireValue(recovery.planSha256 === planSha256 && recovery.endpoint === endpoint
      && recovery.originalRequestId === (promptRecovery ? REVIEWED_KLING_PROMPT_REJECTION_ID : REVIEWED_KLING_REJECTION_ID)
      && recovery.inputSha256 === expectedInputHash && (!amendment || recovery.amendmentSha256 === amendment.amendmentSha256),
    'RECOVERY_CLAIM_CONFLICT');
    const receipt = await localJson(join(directory, `${prefix}-receipt.json`), true);
    if (recovery && !receipt) { emit({ model, status: 'recovery-uncertain-no-resubmission' }); continue; }
    if (!receipt) { emit({ model, status: await localJson(join(directory, `${model}-claim.json`), true) ? 'uncertain-no-resubmission' : 'not-submitted' }); continue; }
    requireValue(receipt.planSha256 === planSha256 && receipt.endpoint === endpoint
      && receipt.inputSha256 === expectedInputHash, 'RECEIPT_CONFLICT');
    if (recovery) requireValue(receipt.originalRequestId === recovery.originalRequestId
      && receipt.rejectionSha256 === recovery.rejectionSha256 && receipt.claimedAt === recovery.claimedAt
      && receipt.requestId !== recovery.originalRequestId && (!amendment || receipt.amendmentSha256 === amendment.amendmentSha256), 'RECOVERY_RECEIPT_CONFLICT');
    const terminalPath = join(directory, `${prefix}-terminal.json`), terminal = await localJson(terminalPath, true);
    if (terminal) {
      requireValue(terminal.planSha256 === planSha256 && terminal.requestId === receipt.requestId && terminal.endpoint === endpoint
        && ['completed', 'failed'].includes(terminal.state) && Number.isFinite(Date.parse(terminal.firstTerminalObservedAt)), 'TERMINAL_RECORD_INVALID');
      emit(terminal); continue;
    }
    const status = await request(falRequestUrl(receipt.statusUrl, endpoint, receipt.requestId, 'status'));
    requireValue(!status.request_id || status.request_id === receipt.requestId, 'PROVIDER_ID_CHANGED');
    let output, state = status.status === 'IN_QUEUE' ? 'queued' : status.status === 'IN_PROGRESS' ? 'processing' : 'uncertain';
    if (status.status === 'COMPLETED') {
      if (status.error || status.error_type) state = 'failed';
      else {
        const result = await request(falRequestUrl(receipt.responseUrl, endpoint, receipt.requestId, 'result'));
        const url = falMediaUrl(result.video?.url);
        const head = await fetch(url, { method: 'HEAD', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20_000) });
        const sizeBytes = Number(head.headers.get('content-length')), contentType = head.headers.get('content-type')?.split(';')[0];
        requireValue(head.ok && contentType === 'video/mp4' && Number.isSafeInteger(sizeBytes)
          && sizeBytes >= 16 && sizeBytes <= 250 * 1024 * 1024, 'MEDIA_METADATA_INVALID');
        state = 'completed'; output = { url, sizeBytes, contentType, requestedDurationSeconds: plan.selection.durationSeconds,
          fullDecodeVerified: false, speechReviewed: false, visualReviewed: false };
      }
    }
    let snapshot = { planSha256, model, endpoint, requestId: receipt.requestId, state, checkedAt: stamp(),
      elapsedSeconds: Math.round((Date.now() - Date.parse(receipt.claimedAt)) / 1000), ...(output ? { output } : {}),
      ...(recovery ? { recovery: recovery.recovery, originalRequestId: recovery.originalRequestId,
        ...(amendment ? { amendmentSha256: amendment.amendmentSha256 } : {}) } : {}) };
    if (['completed', 'failed'].includes(state)) {
      snapshot.firstTerminalObservedAt = snapshot.checkedAt;
      try { await saveExclusive(terminalPath, snapshot); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const first = await localJson(terminalPath);
        requireValue(first.planSha256 === planSha256 && first.requestId === receipt.requestId
          && first.endpoint === endpoint && ['completed', 'failed'].includes(first.state)
          && Number.isFinite(Date.parse(first.firstTerminalObservedAt)), 'TERMINAL_RECORD_INVALID');
        snapshot = first;
      }
    }
    await saveExclusive(join(directory, `${prefix}-status-${Date.now()}-${randomUUID()}.json`), snapshot);
    emit(snapshot);
  }
}
async function main() {
  const [action, ...values] = process.argv.slice(2), args = {};
  requireValue(['prepare', 'submit', 'retry-rejected-kling', 'prepare-kling-prompt-recovery', 'submit-kling-prompt-recovery', 'poll'].includes(action)
    && values.length % 2 === 0, 'COMMAND_INVALID');
  const allowed = { prepare: ['directory', 'prepared-id', 'config', 'maximum-cost-cents'],
    submit: ['directory', 'approve-plan-sha256'], 'retry-rejected-kling': ['directory', 'approve-plan-sha256'],
    'prepare-kling-prompt-recovery': ['directory', 'approve-plan-sha256', 'prompt-file'],
    'submit-kling-prompt-recovery': ['directory', 'approve-plan-sha256', 'approve-amendment-sha256'], poll: ['directory'] }[action];
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i].replace(/^--/, '');
    requireValue(values[i].startsWith('--') && allowed.includes(name) && !(name in args) && values[i + 1], 'ARGUMENT_INVALID'); args[name] = values[i + 1];
  }
  requireValue(args.directory, 'DIRECTORY_REQUIRED');
  const directory = resolve(args.directory); await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); requireValue(info.isDirectory() && !info.isSymbolicLink(), 'DIRECTORY_INVALID');
  if (action === 'prepare') await prepare(args, directory);
  else if (action === 'submit') await submit(args, directory);
  else if (action === 'retry-rejected-kling') await retryRejectedKling(args, directory);
  else if (action === 'prepare-kling-prompt-recovery') await prepareKlingPromptRecovery(args, directory);
  else if (action === 'submit-kling-prompt-recovery') await submitKlingPromptRecovery(args, directory);
  else await poll(directory);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  emit({ error: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'EVALUATION_FAILED', providerSubmissionRetried: false });
  process.exitCode = 1;
});
