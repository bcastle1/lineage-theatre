// Offline only: every provider/storage dependency used here is injected in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUN_KEY, EXECUTE_FLAG, candidateCanaryProfile, candidateIdentity, candidateOperationBounds,
  verifyCandidateGrant, createGuardedCandidateClient } from '../scripts/test-kling-element-contract.mjs';
const sourceRoot = resolve(process.env.LINEAGE_CANARY_SOURCE_ROOT || process.cwd());
const load = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const { digest } = await load('api/_lib/auth.mjs');
const { createFalClient, FAL_MODELS } = await load('api/_lib/fal-client.mjs');
const { FAL_RECIPE_VERSION, falShotInput, characterReferenceInput, characterViewInput, createFalProductionAdapter } = await load('api/_lib/fal-production.mjs');
const at = 1_800_000_000_000, email = 'erik@brocotech.ai', id = candidateIdentity(email), ownerHash = digest(email);
const profile = candidateCanaryProfile(), rates = { videoMicroUsdPerSecond: 150_000, referenceMicroUsd: 300_000 };
function grantFixture() {
  return { version: 1, kind: profile.summary.kind, runKey: RUN_KEY, characterBindingVersion: 2, ownerHash, preparedId: id,
    manifestHash: profile.fixedHash, recipe: FAL_RECIPE_VERSION, maximumCostCents: 360, maximumVideoRequests: 3,
    maximumReferenceRequests: 4, ...rates, quotedCostCents: 360, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    quoteReference: digest(`${FAL_RECIPE_VERSION}:kling:${profile.fixedHash}:${rates.videoMicroUsdPerSecond}:${rates.referenceMicroUsd}`),
    approvedAt: new Date(at - 1000).toISOString(), expiresAt: new Date(at + 600_000).toISOString() };
}
function requests() {
  const refs = Object.fromEntries(profile.plan.characters.map(character => [character.id, {
    frontalImageUrl: `https://v3.fal.media/${character.id}-front.jpg`, referenceImageUrls: [`https://v3.fal.media/${character.id}-view.jpg`],
  }]));
  return [...candidateOperationBounds(id)].map(([identity, bound]) => ({ identity, endpoint: bound.endpoint,
    input: bound.kind === 'reference-front' ? characterReferenceInput(profile.manifest, bound.character)
      : bound.kind === 'reference-view' ? characterViewInput(profile.manifest, bound.character, refs[bound.character.id].frontalImageUrl)
      : falShotInput(profile.manifest, bound.shot, 'kling', refs) }));
}
function guarded(overrides = {}) {
  return createGuardedCandidateClient({ id, ownerHash, now: () => at, grantContext: async () => ({ grant: grantFixture() }),
    pricing: async () => rates, client: { get: async () => null, poll: async () => null, submit: async request => request }, ...overrides });
}
test('new immutable identity has exactly three bound videos and four references, distinct from all earlier canaries', () => {
  assert.equal(id, 'f7d53722-1e84-bb97-9948-2deb3741c07a');
  assert.equal(profile.fixedHash, '242696e7d84c765468f5e33717b32480326da65488f0d7ff8573b2938ad70358');
  assert.equal(profile.manifest.productionPlan.characterBindingVersion, 2);
  assert.equal(profile.plan.generatedSeconds, 16); assert.equal(profile.manifest.targetDurationSeconds, 15);
  const bounds = candidateOperationBounds(id); assert.equal(bounds.size, 7);
  assert.deepEqual([...bounds.values()].filter(v => v.shot).map(v => v.seconds), [6, 5, 5]);
  assert.equal([...bounds.values()].filter(v => v.kind === 'reference-front').length, 2);
  assert.equal([...bounds.values()].filter(v => v.kind === 'reference-view').length, 2);
  for (const oldRun of ['kling-production-canary-20261020-v1', 'kling-quality-canary-20261022-v1', 'kling-verification-canary-20261105-v1', 'kling-character-binding-canary-20261105-v1']) {
    assert.notEqual(digest(`${email}:${oldRun}`).slice(0, 32), id.replaceAll('-', ''));
  }
  const oldId = '2e006bb4-45c8-50cf-0c5b-2bf3e44c9e26', oldHash = 'c6d95029a8578bbb140acea253346116cf86040ab82932f629d30e61e965627b';
  for (const shot of profile.plan.shots) assert.equal(bounds.has(digest(`${FAL_RECIPE_VERSION}:kling:${digest(`${oldId}:${oldHash}:${shot.id}`)}`)), false);
});
test('plan and negative CLI paths run without credentials; old approval flags cannot authorize this new budget', () => {
  const script = fileURLToPath(new URL('../scripts/test-kling-element-contract.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: sourceRoot,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test', LINEAGE_CANARY_SOURCE_ROOT: sourceRoot } });
  const plan = run('plan'); assert.equal(plan.status, 0, plan.stderr);
  const result = JSON.parse(plan.stdout); assert.equal(result.characterBindingVersion, 2); assert.equal(result.maximumCostCents, 360);
  assert.equal(result.referenceRequests, 4); assert.equal(result.frontalReferences, 2); assert.equal(result.additionalViews, 2);
  assert.equal(result.invoiceCreated, false); assert.equal(result.customerPaymentCreated, false);
  assert.match(result.approvalStatus, /separate/); assert.equal(result.requiresProductionHeartbeat, true);
  assert.notEqual(EXECUTE_FLAG, '--execute-approved-300-cents-20261105');
  for (const action of ['prepare', 'step', 'finish', 'run']) for (const flag of [[], ['--execute-approved-300-cents-20261105'], ['--execute-approved-new-300-cents-binding-v1-20261105']]) {
    const rejected = run(action, ...flag); assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stdout).code, 'CANARY_USAGE');
  }
});
test('grant rejects historical, foreign, expanded, mismatched, expired, future and overlong authorization', () => {
  const context = { ownerHash, id, now: at }; assert.equal(verifyCandidateGrant(grantFixture(), context).maximumCostCents, 360);
  const changes = [g => g.runKey = 'kling-verification-canary-20261105-v1', g => g.characterBindingVersion = 1,
    g => g.ownerHash = 'f'.repeat(64), g => g.preparedId = '2e006bb4-45c8-50cf-0c5b-2bf3e44c9e26',
    g => g.manifestHash = 'c6d95029a8578bbb140acea253346116cf86040ab82932f629d30e61e965627b', g => g.recipe = 'changed',
    g => g.maximumCostCents++, g => g.maximumVideoRequests++, g => g.maximumReferenceRequests++,
    g => g.videoMicroUsdPerSecond++, g => g.referenceMicroUsd++, g => g.quotedCostCents--,
    g => g.quoteReference = 'b'.repeat(64), g => g.fictionalOnly = false, g => g.funding = 'customer-payment',
    g => g.expiresAt = new Date(at).toISOString(), g => g.approvedAt = new Date(at + 1).toISOString(),
    g => g.expiresAt = new Date(at + 24 * 3600_000).toISOString()];
  for (const change of changes) { const grant = grantFixture(); change(grant); assert.throws(() => verifyCandidateGrant(grant, context), { code: 'CANARY_GRANT_REQUIRED' }); }
});
test('only exact fixed reference and bound video payloads may reach the provider', async () => {
  let submits = 0;
  const guard = guarded({ client: { submit: async request => { submits++; return request; } } });
  for (const request of requests()) assert.deepEqual(await guard.submit(request), request);
  assert.equal(submits, 7);
  const video = requests().find(r => r.endpoint === FAL_MODELS.kling);
  for (const change of [r => r.identity = 'f'.repeat(64), r => r.endpoint = FAL_MODELS.reference,
    r => r.input.duration = '15', r => r.input.generate_audio = false, r => r.input.prompt += 'changed',
    r => r.input.elements.pop(), r => r.input.elements[0] = null, r => r.input.image_urls = ['legacy'],
    r => r.input.elements[0].reference_image_urls.push('additional'), r => r.input.resolution = '1080p',
    r => delete r.input.elements[0].frontal_image_url,
    r => r.input.elements[0].reference_image_urls = [r.input.elements[0].frontal_image_url]]) {
    const request = structuredClone(video); change(request); await assert.rejects(guard.submit(request)); assert.equal(submits, 7);
  }
  const reference = requests().find(r => r.endpoint === FAL_MODELS.reference); reference.input.num_images = 2;
  await assert.rejects(guard.submit(reference), { code: 'CANARY_REFERENCE_INPUT_CHANGED' }); assert.equal(submits, 7);
});
test('price and immutable grant are rechecked immediately before a provider submission', async () => {
  let submits = 0, reads = 0;
  const client = { submit: async () => { submits++; } }, request = requests()[0];
  await assert.rejects(guarded({ client, pricing: async () => ({ ...rates, videoMicroUsdPerSecond: 150_001 }) }).submit(request), { code: 'CANARY_PRICE_EXCEEDS_APPROVAL' });
  await assert.rejects(guarded({ client, grantContext: async () => {
    const grant = grantFixture(); if (++reads > 1) grant.expiresAt = new Date(at + 500_000).toISOString(); return { grant };
  } }).submit(request), { code: 'CANARY_GRANT_BINDING_CHANGED' });
  assert.equal(submits, 0); assert.equal(reads, 2);
});
test('additional views stay bound to their single-image context and cannot create a fifth reference', async () => {
  let submits = 0;
  const guard = guarded({ client: { submit: async request => { submits++; return request; } } });
  const bounds = candidateOperationBounds(id), view = requests().find(request => bounds.get(request.identity).kind === 'reference-view');
  assert.equal((await guard.submit(view)).identity, view.identity); assert.equal(submits, 1);
  for (const change of [r => { delete r.input.context; }, r => { r.input.context.push(r.input.context[0]); },
    r => { r.input.context[0].image_url = 'https://untrusted.invalid/front.jpg'; }, r => { r.input.num_images = 2; },
    r => { r.input.prompt += ' Different person'; }, r => { r.identity = digest('unapproved-fifth-reference'); }]) {
    const request = structuredClone(view); change(request); await assert.rejects(guard.submit(request)); assert.equal(submits, 1);
  }
});
test('the complete seven-operation bound remains idempotent across repeated invocations', async () => {
  const records = new Map(); let posts = 0, revision = 0;
  const client = createFalClient({ key: 'synthetic-offline-key', now: () => at,
    read: async path => structuredClone(records.get(path) || null),
    write: async (path, value, etag) => {
      const previous = records.get(path); if (previous && previous.etag !== etag) throw Error('conflict');
      records.set(path, { value: structuredClone(value), etag: String(++revision) });
    }, fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST'); const requestId = `offline-request-${++posts}`;
      return new Response(JSON.stringify({ request_id: requestId, status_url: `${url}/requests/${requestId}/status`, response_url: `${url}/requests/${requestId}` }));
    } });
  const guard = guarded({ client });
  for (let repetition = 0; repetition < 2; repetition++) for (const request of requests()) assert.equal((await guard.submit(request)).state, 'queued');
  assert.equal(posts, 7); assert.equal(records.size, 7);
});
test('an uncertain provider POST is durably retained and repeat invocation cannot POST again or touch old records', async () => {
  const oldPath = 'production/fal/requests/old-canary.json', oldRecord = { value: { state: 'completed', sentinel: 'unchanged' }, etag: 'old' };
  const records = new Map([[oldPath, structuredClone(oldRecord)]]); let posts = 0, writes = 0;
  const client = createFalClient({ key: 'synthetic-offline-key', now: () => at,
    read: async path => structuredClone(records.get(path) || null),
    write: async (path, value, etag) => {
      const previous = records.get(path); if (previous && previous.etag !== etag) throw Error('conflict');
      records.set(path, { value: structuredClone(value), etag: String(++writes) });
    }, fetchImpl: async (_url, request) => { assert.equal(request.method, 'POST'); posts++; throw Error('synthetic transport ambiguity'); } });
  const guard = guarded({ client }), request = requests()[0];
  assert.equal((await guard.submit(request)).state, 'uncertain');
  assert.equal((await guard.submit(request)).state, 'uncertain');
  assert.equal((await guard.poll(request.identity)).state, 'uncertain');
  assert.equal(posts, 1); assert.deepEqual(records.get(oldPath), oldRecord); assert.equal(records.size, 2);
});
test('normal candidate adapter cannot quote with the earlier worker heartbeat; the harness has no health exemption', async () => {
  let reads = 0;
  const adapter = createFalProductionAdapter({ model: 'kling', requireWorker: true, key: 'synthetic-offline-key', now: () => at,
    pricing: async () => ({ ...rates, expiresAt: new Date(at + 60_000).toISOString() }),
    read: async path => { reads++; assert.equal(path, 'production/worker-health.json'); return { value: {
      model: 'kling', recipe: FAL_RECIPE_VERSION, ready: true, deliveryChecksVersion: 1, referencePhotoVersion: 1,
      visualContinuityVersion: 1, checkedAt: new Date(at).toISOString() } }; } });
  await assert.rejects(adapter.quote({ manifest: profile.manifest, manifestHash: profile.fixedHash })); assert.equal(reads, 1);
});
