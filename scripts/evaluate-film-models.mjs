// Isolated, merchant-funded comparison. This script never writes a production
// job, payment, qualification or Blob record. Keep its private directory intact:
// an exclusive claim permits at most one POST per candidate, even after a crash.
import { open, readFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { digest, readRecord, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL, isOwner, accessStatusForUser } from '../api/_lib/access.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS, falMediaUrl, falRequestUrl } from '../api/_lib/fal-client.mjs';
import { REALISTIC_FILM_DIRECTION, realisticCreativeText } from '../api/_lib/film-visual-style.mjs';

const ENDPOINTS = Object.freeze({ seedance: 'bytedance/seedance-2.5/us/reference-to-video', kling: 'fal-ai/kling-video/o3/pro/reference-to-video' });
// Reviewed 1080p/native-audio bounds; see docs/MODEL-EVALUATION.md. The pricing
// API exposes base units, so a base-price match alone cannot lower these floors.
const RATE_FLOORS = Object.freeze({ seedance: 1_200_000, kling: 150_000 });
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
async function source(preparedId, shotIndex) {
  requireValue(UUID.test(preparedId) && Number.isSafeInteger(shotIndex) && shotIndex >= 0, 'SOURCE_SELECTION_INVALID');
  const owner = (await readRecord(userPath(OWNER_EMAIL)))?.value;
  requireValue(isOwner(owner) && !owner.mustChangePassword && accessStatusForUser(owner) === 'approved', 'OWNER_REQUIRED');
  const job = (await readRecord(`production/jobs/${digest(OWNER_EMAIL)}/${preparedId}.json`))?.value;
  requireValue(job?.status === 'completed' && job.ownerHash === digest(OWNER_EMAIL) && job.id === preparedId
    && job.mode === 'customer' && HASH.test(job.media?.sha256 || '') && HASH.test(job.manifestHash || '')
    && jsonHash(job.manifest) === job.manifestHash && job.filmId === job.manifest.filmId, 'COMPLETED_SOURCE_REQUIRED');
  const shot = job.manifest.shots?.[shotIndex];
  requireValue(shot && Array.isArray(shot.characterIds) && shot.characterIds.length >= 1
    && shot.characterIds.length <= 7 && new Set(shot.characterIds).size === shot.characterIds.length, 'SOURCE_SHOT_INVALID');
  const references = [];
  for (const characterId of shot.characterIds) {
    const character = job.manifest.screenplay.characters.find(value => value.id === characterId);
    const identity = digest(`${FAL_RECIPE_VERSION}:cast:${job.id}:${job.manifestHash}:${characterId}`);
    const record = (await readRecord(`production/fal/requests/${identity}.json`))?.value;
    requireValue(character && record?.state === 'completed' && record.identity === identity
      && record.endpoint === FAL_MODELS.reference && /^[\w-]{8,100}$/.test(record.requestId || '')
      && record.result?.images?.length === 1, 'EXISTING_REFERENCE_REQUIRED');
    references.push({ characterId, identity, requestId: record.requestId, url: falMediaUrl(record.result.images[0].url), character });
  }
  const binding = { preparedId, filmId: job.filmId, manifestHash: job.manifestHash,
    deliveredMediaSha256: job.media.sha256, shotIndex, shotHash: jsonHash(shot), referencesHash: jsonHash(references) };
  return { job, shot, references, binding };
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
function auditedRates(rates, live, seconds) {
  let total = 0;
  for (const [model, endpoint] of Object.entries(ENDPOINTS)) {
    const rate = rates?.[model], current = live.prices[model];
    requireValue(rate && rate.unitPrice === current.unitPrice && rate.unit === current.unit
      && Number.isSafeInteger(rate.maximumMicroUsdPerSecond) && rate.maximumMicroUsdPerSecond > 0
      && rate.maximumMicroUsdPerSecond <= 10_000_000 && typeof rate.sourceUrl === 'string', 'PRICE_REVIEW_REQUIRED');
    const minimum = Math.max(RATE_FLOORS[model], model === 'kling' || ['second', 'seconds'].includes(current.unit)
      ? Math.ceil(current.unitPrice * 1_000_000) : 0);
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
  const context = await source(args['prepared-id'] || '', config.shotIndex), selection = excerpt(config, context.shot);
  const maximumCostCents = Number(args['maximum-cost-cents']);
  requireValue(Number.isSafeInteger(maximumCostCents) && maximumCostCents > 0 && maximumCostCents <= 10000, 'EXPLICIT_BUDGET_REQUIRED');
  const live = await pricing();
  await saveExclusive(join(directory, `pricing-${Date.now()}-${randomUUID()}.json`), live);
  if (!config.rates) { emit({ status: 'price-review-required', ...live, maximumCostCents, providerSubmissions: 0 }); return; }
  const maximumEstimatedCostCents = auditedRates(config.rates, live, selection.durationSeconds);
  requireValue(maximumEstimatedCostCents <= maximumCostCents, 'BUDGET_EXCEEDED');
  const plan = { version: 1, kind: 'isolated-film-model-evaluation', evaluationId: randomUUID(), createdAt: stamp(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), ownerEmail: OWNER_EMAIL, funding: 'merchant',
    source: context.binding, selection, endpoints: ENDPOINTS, inputs: inputs(context, selection), pricing: live,
    rates: config.rates, maximumCostCents, maximumEstimatedCostCents };
  const planSha256 = jsonHash(plan);
  await saveExclusive(join(directory, 'plan.json'), { planSha256, plan });
  emit({ status: 'prepared', planSha256, source: plan.source, durationSeconds: selection.durationSeconds,
    maximumCostCents, maximumEstimatedCostCents, models: Object.keys(ENDPOINTS), providerSubmissions: 0 });
}
async function loadPlan(directory) {
  const saved = await localJson(join(directory, 'plan.json')), plan = saved?.plan;
  requireValue(plan?.version === 1 && plan.kind === 'isolated-film-model-evaluation' && plan.ownerEmail === OWNER_EMAIL
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
    const current = await source(plan.source.preparedId, plan.source.shotIndex);
    requireValue(jsonHash(current.binding) === jsonHash(plan.source), 'SOURCE_CHANGED');
    const selected = excerpt(plan.selection, current.shot);
    requireValue(jsonHash(inputs(current, selected)) === jsonHash(plan.inputs), 'INPUT_CHANGED');
    const live = await pricing(), cost = auditedRates(plan.rates, live, selected.durationSeconds);
    requireValue(cost === plan.maximumEstimatedCostCents && Number.isSafeInteger(plan.maximumCostCents)
      && cost <= plan.maximumCostCents && plan.maximumCostCents <= 10000, 'BUDGET_CHANGED');
    requireValue(Date.parse(plan.expiresAt) > Date.now(), 'CURRENT_PLAN_APPROVAL_REQUIRED');
    const claim = { version: 1, evaluationId: plan.evaluationId, planSha256, model, endpoint,
      inputSha256: jsonHash(plan.inputs[model]), claimedAt: stamp(), state: 'submission-claimed', pricing: live };
    await saveExclusive(claimPath, claim);
    try {
      const response = await request(`https://queue.fal.run/${endpoint}`, 'POST', plan.inputs[model]);
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
async function poll(directory) {
  const { plan, planSha256 } = await loadPlan(directory);
  for (const [model, endpoint] of Object.entries(ENDPOINTS)) {
    const receipt = await localJson(join(directory, `${model}-receipt.json`), true);
    if (!receipt) { emit({ model, status: await localJson(join(directory, `${model}-claim.json`), true) ? 'uncertain-no-resubmission' : 'not-submitted' }); continue; }
    requireValue(receipt.planSha256 === planSha256 && receipt.endpoint === endpoint
      && receipt.inputSha256 === jsonHash(plan.inputs[model]), 'RECEIPT_CONFLICT');
    const terminalPath = join(directory, `${model}-terminal.json`), terminal = await localJson(terminalPath, true);
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
      elapsedSeconds: Math.round((Date.now() - Date.parse(receipt.claimedAt)) / 1000), ...(output ? { output } : {}) };
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
    await saveExclusive(join(directory, `${model}-status-${Date.now()}-${randomUUID()}.json`), snapshot);
    emit(snapshot);
  }
}
async function main() {
  const [action, ...values] = process.argv.slice(2), args = {};
  requireValue(['prepare', 'submit', 'poll'].includes(action) && values.length % 2 === 0, 'COMMAND_INVALID');
  const allowed = { prepare: ['directory', 'prepared-id', 'config', 'maximum-cost-cents'], submit: ['directory', 'approve-plan-sha256'], poll: ['directory'] }[action];
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i].replace(/^--/, '');
    requireValue(values[i].startsWith('--') && allowed.includes(name) && !(name in args) && values[i + 1], 'ARGUMENT_INVALID'); args[name] = values[i + 1];
  }
  requireValue(args.directory, 'DIRECTORY_REQUIRED');
  const directory = resolve(args.directory); await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); requireValue(info.isDirectory() && !info.isSymbolicLink(), 'DIRECTORY_INVALID');
  if (action === 'prepare') await prepare(args, directory);
  else if (action === 'submit') await submit(args, directory);
  else await poll(directory);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  emit({ error: /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'EVALUATION_FAILED', providerSubmissionRetried: false });
  process.exitCode = 1;
});
