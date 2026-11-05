// Offline only: provider and private-record dependencies are injected in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUN_KEY, EXECUTE_FLAG, candidateCanaryProfile, candidateIdentity, candidateOperationBounds,
  verifyCandidateGrant, createGuardedCandidateClient } from '../scripts/test-kling-cast-continuity.mjs';
import { digest } from '../api/_lib/auth.mjs';
import { createFalClient, FAL_MODELS, falRequestPath } from '../api/_lib/fal-client.mjs';
import { FAL_RECIPE_VERSION, falShotInput, characterReferenceInput, characterViewInput,
  startFrameInput, createFalProductionAdapter } from '../api/_lib/fal-production.mjs';

const at = 1_800_000_000_000, email = 'erik@brocotech.ai', id = candidateIdentity(email), ownerHash = digest(email);
const profile = candidateCanaryProfile(), bounds = candidateOperationBounds(id);
const rates = { videoMicroUsdPerSecond: 150_000, referenceMicroUsd: 300_000 };
const imageUrl = bound => `https://v3.fal.media/${bound.character?.id || bound.shot.id}-${bound.kind}.jpg`;
function completedReference(identity) {
  const bound = bounds.get(identity);
  return bound?.endpoint === FAL_MODELS.reference ? { identity, state: 'completed', endpoint: bound.endpoint,
    result: { images: [{ url: imageUrl(bound) }] } } : null;
}
function grantFixture() {
  return { version: 1, kind: profile.summary.kind, runKey: RUN_KEY, characterBindingVersion: 3, ownerHash, preparedId: id,
    manifestHash: profile.fixedHash, recipe: FAL_RECIPE_VERSION, maximumCostCents: 450, maximumVideoRequests: 3,
    maximumReferenceRequests: 7, ...rates, quotedCostCents: 450, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    quoteReference: digest(`${FAL_RECIPE_VERSION}:kling:${profile.fixedHash}:${rates.videoMicroUsdPerSecond}:${rates.referenceMicroUsd}`),
    approvedAt: new Date(at - 1000).toISOString(), expiresAt: new Date(at + 600_000).toISOString() };
}
function requests() {
  const refs = Object.fromEntries(profile.plan.characters.map(character => [character.id, {
    frontalImageUrl: `https://v3.fal.media/${character.id}-reference-front.jpg`,
    referenceImageUrls: [`https://v3.fal.media/${character.id}-reference-view.jpg`],
  }]));
  return [...bounds].map(([identity, bound]) => ({ identity, endpoint: bound.endpoint,
    input: bound.kind === 'reference-front' ? characterReferenceInput(profile.manifest, bound.character)
      : bound.kind === 'reference-view' ? characterViewInput(profile.manifest, bound.character, refs[bound.character.id].frontalImageUrl)
      : bound.kind === 'start-frame' ? startFrameInput(profile.manifest, bound.shot, refs)
      : falShotInput(profile.manifest, bound.shot, 'kling', refs, `https://v3.fal.media/${bound.shot.id}-start-frame.jpg`) }));
}
function guarded(overrides = {}) {
  return createGuardedCandidateClient({ id, ownerHash, now: () => at, read: async () => null, grantContext: async () => ({ grant: grantFixture() }),
    pricing: async () => rates, normalizeReference: async value => value, ...overrides,
    client: { get: async identity => completedReference(identity), poll: async () => null,
      submit: async request => request, ...overrides.client } });
}

test('fixed v3 identity prices exactly two fronts, two views, three starts and three videos', () => {
  assert.equal(id, 'ec43a635-8c7e-8f99-dc90-d4ceb2681bb5');
  assert.equal(profile.fixedHash, '601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f');
  assert.equal(profile.manifest.productionPlan.characterBindingVersion, 3);
  assert.equal(profile.plan.referenceCount, 7); assert.equal(profile.plan.generatedSeconds, 16);
  assert.equal(profile.manifest.targetDurationSeconds, 15); assert.equal(bounds.size, 10);
  assert.deepEqual([...bounds.values()].filter(v => v.kind === 'video').map(v => v.seconds), [6, 5, 5]);
  for (const [kind, count] of [['reference-front', 2], ['reference-view', 2], ['start-frame', 3], ['video', 3]])
    assert.equal([...bounds.values()].filter(v => v.kind === kind).length, count);
  for (const oldRun of ['kling-production-canary-20261020-v1', 'kling-quality-canary-20261022-v1',
    'kling-verification-canary-20261105-v1', 'kling-character-binding-canary-20261105-v1', 'kling-element-contract-canary-20261105-v2'])
    assert.notEqual(digest(`${email}:${oldRun}`).slice(0, 32), id.replaceAll('-', ''));
  const oldId = 'f7d53722-1e84-bb97-9948-2deb3741c07a', oldHash = '242696e7d84c765468f5e33717b32480326da65488f0d7ff8573b2938ad70358';
  for (const shot of profile.plan.shots)
    assert.equal(bounds.has(digest(`${FAL_RECIPE_VERSION}:kling:${digest(`${oldId}:${oldHash}:${shot.id}`)}`)), false);
});

test('offline plan needs no credentials and every prior execution flag is rejected before configuration', () => {
  const script = fileURLToPath(new URL('../scripts/test-kling-cast-continuity.mjs', import.meta.url));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test', LINEAGE_CANARY_SOURCE_ROOT: root } });
  const plan = run('plan'); assert.equal(plan.status, 0, plan.stderr);
  const result = JSON.parse(plan.stdout);
  assert.equal(result.characterBindingVersion, 3); assert.equal(result.maximumCostCents, 450);
  assert.equal(result.referenceRequests, 7); assert.equal(result.composedStartFrames, 3);
  assert.equal(result.frontalReferences, 2); assert.equal(result.additionalViews, 2);
  assert.equal(result.invoiceCreated, false); assert.equal(result.customerPaymentCreated, false);
  assert.match(result.approvalStatus, /separate/); assert.equal(result.requiresProductionHeartbeat, true);
  assert.equal(result.startFramePreflight, 'normal-production-endpoint-and-stored-receipt');
  assert.equal(EXECUTE_FLAG, '--execute-approved-new-450-cents-cast-v3-20261105');
  for (const action of ['prepare', 'step', 'finish', 'run']) for (const flags of [[], ['--execute-approved-300-cents-20261105'],
    ['--execute-approved-new-300-cents-binding-v1-20261105'], ['--execute-approved-new-360-cents-elements-v2-20261105']]) {
    const rejected = run(action, ...flags); assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).code, 'CANARY_USAGE');
  }
});

test('grant rejects historical, foreign, expanded, expired, future and mismatched approval', () => {
  const context = { ownerHash, id, now: at }; assert.equal(verifyCandidateGrant(grantFixture(), context).maximumCostCents, 450);
  const changes = [g => g.runKey = 'kling-element-contract-canary-20261105-v2', g => g.characterBindingVersion = 1,
    g => g.characterBindingVersion = 2, g => g.maximumCostCents = 360, g => g.maximumReferenceRequests = 4,
    g => g.ownerHash = 'f'.repeat(64), g => g.preparedId = 'f7d53722-1e84-bb97-9948-2deb3741c07a',
    g => g.manifestHash = '242696e7d84c765468f5e33717b32480326da65488f0d7ff8573b2938ad70358', g => g.recipe = 'changed',
    g => g.maximumCostCents++, g => g.maximumVideoRequests++, g => g.maximumReferenceRequests++,
    g => g.videoMicroUsdPerSecond++, g => g.referenceMicroUsd++, g => g.quotedCostCents--,
    g => g.quoteReference = 'b'.repeat(64), g => g.fictionalOnly = false, g => g.funding = 'customer-payment',
    g => g.expiresAt = new Date(at).toISOString(), g => g.approvedAt = new Date(at + 1).toISOString(),
    g => g.expiresAt = new Date(at + 24 * 3600_000).toISOString()];
  for (const change of changes) { const grant = grantFixture(); change(grant);
    assert.throws(() => verifyCandidateGrant(grant, context), { code: 'CANARY_GRANT_REQUIRED' }); }
});

test('only the exact ten payloads and dependency identities may reach a provider', async () => {
  let submits = 0; const guard = guarded({ client: { submit: async request => { submits++; return request; } } });
  for (const request of requests()) assert.deepEqual(await guard.submit(request), request);
  assert.equal(submits, 10);
  const video = requests().find(r => r.endpoint === FAL_MODELS.kling);
  for (const change of [r => r.identity = 'f'.repeat(64), r => r.endpoint = FAL_MODELS.reference,
    r => r.input.duration = '15', r => r.input.generate_audio = false, r => r.input.prompt += 'changed',
    r => r.input.elements.pop(), r => r.input.elements[0] = null, r => r.input.image_urls = ['legacy'],
    r => r.input.elements.reverse(), r => r.input.elements[0].reference_image_urls.push('additional'),
    r => r.input.resolution = '1080p', r => delete r.input.elements[0].frontal_image_url,
    r => r.input.elements[0].frontal_image_url = 'https://v3.fal.media/other-person.jpg',
    r => delete r.input.start_image_url, r => r.input.start_image_url = 'https://v3.fal.media/other-scene.jpg']) {
    const request = structuredClone(video); change(request); await assert.rejects(guard.submit(request)); assert.equal(submits, 10);
  }
  const reference = requests()[0]; reference.input.num_images = 2;
  await assert.rejects(guard.submit(reference), { code: 'CANARY_REFERENCE_INPUT_CHANGED' }); assert.equal(submits, 10);
});

test('views and composed starts require exact completed front images in saved shot order', async () => {
  let submits = 0; const guard = guarded({ client: { submit: async request => { submits++; return request; } } });
  for (const kind of ['reference-view', 'start-frame']) {
    const source = requests().find(request => bounds.get(request.identity).kind === kind);
    for (const change of [r => delete r.input.context, r => r.input.context.reverse(),
      r => r.input.context.push(r.input.context[0]), r => r.input.context[0].image_url = 'https://v3.fal.media/unrelated-person.jpg',
      r => r.input.num_images = 2, r => r.input.prompt += ' Different cast', r => r.identity = digest('unapproved-eighth-image')]) {
      const request = structuredClone(source); change(request);
      if (JSON.stringify(request) === JSON.stringify(source)) continue;
      await assert.rejects(guard.submit(request)); assert.equal(submits, 0);
    }
    for (const state of ['queued', 'submitting', 'uncertain', 'failed']) {
      const held = guarded({ client: { get: async identity => ({ ...completedReference(identity), state }), submit: async () => { submits++; } } });
      await assert.rejects(held.submit(source), { code: 'CANARY_REFERENCE_NOT_COMPLETED' }); assert.equal(submits, 0);
    }
  }
});

test('video guard compares normalized start-frame and element bytes, not merely allowed URLs', async () => {
  let submits = 0; const request = requests().find(r => r.endpoint === FAL_MODELS.kling);
  const normalizeReference = async value => 'normalized:' + value;
  const guard = guarded({ normalizeReference, client: { submit: async value => { submits++; return value; } } });
  await assert.rejects(guard.submit(request), { code: 'CANARY_VIDEO_INPUT_CHANGED' });
  request.input.start_image_url = await normalizeReference(request.input.start_image_url);
  for (const element of request.input.elements) {
    element.frontal_image_url = await normalizeReference(element.frontal_image_url);
    element.reference_image_urls = await Promise.all(element.reference_image_urls.map(normalizeReference));
  }
  await guard.submit(request); assert.equal(submits, 1);
  request.input.start_image_url += 'changed'; await assert.rejects(guard.submit(request)); assert.equal(submits, 1);
});

test('live price and immutable grant are rechecked immediately before submission', async () => {
  let submits = 0, reads = 0; const client = { submit: async () => { submits++; } }, request = requests()[0];
  await assert.rejects(guarded({ client, pricing: async () => ({ ...rates, videoMicroUsdPerSecond: 150_001 }) }).submit(request), { code: 'CANARY_PRICE_EXCEEDS_APPROVAL' });
  await assert.rejects(guarded({ client, grantContext: async () => {
    const grant = grantFixture(); if (++reads > 1) grant.expiresAt = new Date(at + 500_000).toISOString(); return { grant };
  } }).submit(request), { code: 'CANARY_GRANT_BINDING_CHANGED' });
  assert.equal(submits, 0); assert.equal(reads, 2);
});

function durableClient(fetchImpl, records = new Map()) {
  let revision = 0;
  const client = createFalClient({ key: 'synthetic-offline-key', now: () => at,
    read: async path => structuredClone(records.get(path) || null),
    write: async (path, value, etag) => {
      const previous = records.get(path); if (previous && previous.etag !== etag) throw Error('conflict');
      records.set(path, { value: structuredClone(value), etag: String(++revision) });
    }, fetchImpl });
  return { client, records };
}
test('all ten operations remain idempotent and no eleventh identity may spend', async () => {
  let posts = 0;
  const { client, records } = durableClient(async (url, options) => {
    assert.equal(options.method, 'POST'); const requestId = `offline-request-${++posts}`;
    return new Response(JSON.stringify({ request_id: requestId, status_url: `${url}/requests/${requestId}/status`, response_url: `${url}/requests/${requestId}` }));
  });
  const guard = guarded({ client });
  for (let repetition = 0; repetition < 2; repetition++) for (const request of requests()) {
    assert.ok(['queued', 'completed'].includes((await guard.submit(request)).state));
    if (request.endpoint === FAL_MODELS.reference) {
      const stored = records.get(falRequestPath(request.identity));
      stored.value = { ...stored.value, ...completedReference(request.identity) };
    }
  }
  assert.equal(posts, 10); assert.equal(records.size, 10);
  await assert.rejects(guard.submit({ ...requests()[0], identity: digest('eleventh-operation') }), { code: 'CANARY_OPERATION_OUTSIDE_BUDGET' });
  assert.equal(posts, 10);
});

test('an ambiguous POST is retained without another request or changes to historical records', async () => {
  const oldPath = 'production/fal/requests/old-canary.json', oldRecord = { value: { state: 'completed', sentinel: 'unchanged' }, etag: 'old' };
  const records = new Map([[oldPath, structuredClone(oldRecord)]]); let posts = 0;
  const { client } = durableClient(async (_url, request) => { assert.equal(request.method, 'POST'); posts++; throw Error('transport ambiguity'); }, records);
  const guard = guarded({ client }), request = requests()[0];
  assert.equal((await guard.submit(request)).state, 'uncertain');
  assert.equal((await guard.submit(request)).state, 'uncertain');
  assert.equal((await guard.poll(request.identity)).state, 'uncertain');
  assert.equal(posts, 1); assert.deepEqual(records.get(oldPath), oldRecord); assert.equal(records.size, 2);
});

test('normal adapter rejects the version 2 worker before quoting this version 3 plan', async () => {
  let prices = 0;
  const adapter = createFalProductionAdapter({ model: 'kling', requireWorker: true, key: 'synthetic-offline-key', now: () => at,
    pricing: async () => { prices++; return { ...rates, expiresAt: new Date(at + 60_000).toISOString() }; },
    read: async () => ({ value: { model: 'kling', recipe: FAL_RECIPE_VERSION, ready: true, deliveryChecksVersion: 1,
      referencePhotoVersion: 1, visualChecksVersion: 1, characterBindingVersion: 2, checkedAt: new Date(at).toISOString() } }) });
  await assert.rejects(adapter.quote({ manifest: profile.manifest, manifestHash: profile.fixedHash })); assert.equal(prices, 0);
});
