import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { falPlan, falShotInput, falRecoveryShotInput, startFrameIdentity, startFrameInput, characterViewIdentity, createFalProductionAdapter, FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { normalizeKlingInputReferences } from '../api/_lib/kling-character-binding.mjs';
import { createRemoteStartFrameReview } from '../api/_lib/film-start-frame-client.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';

const NOW = Date.parse('2026-11-05T20:00:00Z');
const build = project => planKlingShots(buildFilmManifest(project || fictionalOperatorProject()).manifest);
const refs = manifest => Object.fromEntries(manifest.screenplay.characters.map(character => [character.id, {
  frontalImageUrl: `https://v3.fal.media/${character.id}.jpg`, referenceImageUrls: [`https://v3.fal.media/${character.id}-side.jpg`],
}]));
const health = version => ({ ready: true, model: 'kling', recipe: FAL_RECIPE_VERSION, deliveryChecksVersion: 1,
  visualChecksVersion: 1, characterBindingVersion: version, checkedAt: new Date(NOW).toISOString() });
const normalized = url => 'normalized:' + url;

function fixture(options = {}) {
  const manifest = build(options.project), manifestHash = digest(JSON.stringify(manifest)), productionId = 'fixture-production';
  const references = refs(manifest), records = new Map(), submitted = [], reviews = [], verified = [], normalization = [];
  const shot = manifest.shots[0], frameIdentity = startFrameIdentity(productionId, manifestHash, shot.id);
  const startUrl = 'https://v3.fal.media/composed-start.jpg';
  for (const character of manifest.screenplay.characters) {
    records.set(digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${character.id}`),
      { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: references[character.id].frontalImageUrl }] } });
    records.set(characterViewIdentity(productionId, manifestHash, character.id),
      { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: references[character.id].referenceImageUrls[0] }] } });
  }
  const proof = { version: 1, passed: true, manifestHash, shotId: shot.id, referenceIdentity: frameIdentity,
    bindingHash: digest('fixture-binding'), normalizedImageHash: digest(normalized(startUrl)), receiptPath: 'production/start-frame-reviews/fixture.json' };
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async path => path === 'production/worker-health.json' ? { value: health(options.workerVersion || 3) } : null,
    normalizeKlingReference: async url => { normalization.push(url); return options.changedBytes && url === startUrl ? 'changed-image' : normalized(url); },
    client: { get: async identity => records.get(identity), poll: async identity => records.get(identity), submit: async request => {
      assert.equal(records.has(request.identity), false); submitted.push(request);
      const saved = { state: 'queued', endpoint: request.endpoint, requestId: request.identity }; records.set(request.identity, saved); return saved;
    } },
    validateStartFrame: async request => { reviews.push(request); if (options.reviewThrows) throw Error('unavailable'); return { ...proof, ...options.proof }; },
    verifyStartFrame: async request => { verified.push(request); assert.equal(request.normalizedImageData, normalized(startUrl));
      assert.equal(request.proof.normalizedImageHash, digest(request.normalizedImageData)); if (options.verifyThrows) throw options.verifyThrows;
      return options.verifyNoProof ? undefined : request.proof;
    },
  });
  const request = { email: 'fictional@example.invalid', manifest, manifestHash, productionId, shot,
    idempotencyKey: digest(`${productionId}:${manifestHash}:${shot.id}`), authorizeSpend: async () => true };
  const completeStart = () => records.set(frameIdentity, { state: 'completed', endpoint: FAL_MODELS.reference,
    result: { images: [{ url: startUrl }] } });
  return { manifest, manifestHash, productionId, references, records, submitted, reviews, verified, normalization, shot,
    frameIdentity, startUrl, proof, adapter, request, completeStart };
}

test('version 3 prices every composed frame and refuses older worker capability before live pricing', async () => {
  const manifest = build(), manifestHash = digest(JSON.stringify(manifest)); let version = 2, prices = 0;
  assert.equal(manifest.productionPlan.characterBindingVersion, 3);
  assert.equal(manifestHash, '601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f');
  assert.equal(falPlan(manifest, 'kling').referenceCount, 7);
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async () => ({ value: health(version) }), pricing: async () => { prices++; return {
      videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000, expiresAt: new Date(NOW + 60000).toISOString() }; } });
  await assert.rejects(adapter.quote({ manifest, manifestHash })); assert.equal(prices, 0);
  version = 3; assert.equal((await adapter.quote({ manifest, manifestHash })).providerCostCents, 450);
  const v2 = planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest, { characterBindingVersion: 2 });
  assert.equal((await adapter.quote({ manifest: v2, manifestHash: digest(JSON.stringify(v2)) })).providerCostCents, 360);
});

test('composition consumes exact main portraits in shot order and keeps saved action unchanged', () => {
  const project = fictionalOperatorProject(); project.scenes[0].characterIds.reverse();
  project.scenes[0].visual = 'Ada stays on the right; Alice kneels on the left, tending the garden.';
  const manifest = build(project), before = JSON.stringify(manifest), references = refs(manifest);
  const input = startFrameInput(manifest, manifest.shots[0], references);
  assert.deepEqual(input.context, [{ type: 'image', image_url: references.alice.frontalImageUrl }, { type: 'image', image_url: references.ada.frontalImageUrl }]);
  assert.equal(input.aspect_ratio, '16:9'); assert.equal(input.num_images, 1); assert.equal(input.resolution, '4K');
  assert.ok(input.prompt.includes(project.scenes[0].visual)); assert.ok(input.prompt.includes(project.scenes[0].narration));
  assert.ok(input.prompt.indexOf('Image 1: Fictional Alice') < input.prompt.indexOf('Image 2: Fictional Ada'));
  assert.equal(JSON.stringify(manifest), before);
});

test('queued composition is created once; review and video wait for its completed result', async () => {
  const f = fixture();
  assert.equal((await f.adapter.submitShot(f.request)).status, 'processing');
  assert.equal((await f.adapter.submitShot(f.request)).status, 'processing');
  assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].identity, f.frameIdentity);
  assert.deepEqual(f.submitted[0].input, startFrameInput(f.manifest, f.shot, f.references));
  assert.equal(f.reviews.length, 0); assert.equal(f.verified.length, 0);
  f.completeStart();
  assert.equal((await f.adapter.submitShot(f.request)).status, 'queued');
  assert.equal(f.submitted.length, 2); const video = f.submitted[1];
  assert.equal(video.endpoint, FAL_MODELS.kling); assert.equal(video.input.start_image_url, normalized(f.startUrl));
  assert.equal(f.verified.length, 1); assert.equal(f.reviews.length, 1);
  assert.deepEqual(f.reviews[0], { email: f.request.email, preparedId: f.productionId, manifestHash: f.manifestHash,
    shotId: f.shot.id, referenceIdentity: f.frameIdentity });
  assert.deepEqual(f.normalization, [f.startUrl, ...f.shot.characterIds.flatMap(id => [f.references[id].frontalImageUrl, ...f.references[id].referenceImageUrls])]);
  await f.adapter.pollShot(f.request);
  assert.equal(f.submitted.length, 2); assert.equal(f.reviews.length, 1, 'Existing video polls never invoke another image review');
});

test('a definite cast mismatch blocks the video with a terminal fixed failure code', async () => {
  const f = fixture({ proof: { passed: false } }); f.completeStart();
  const result = await f.adapter.submitShot(f.request);
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'CAST_START_FRAME_MISMATCH');
  assert.equal(f.submitted.length, 0); assert.equal(f.verified.length, 0);
});

test('starting-frame composition runs alongside additional views while video waits for both and preflight', async () => {
  const f = fixture();
  for (const character of f.manifest.screenplay.characters) f.records.delete(characterViewIdentity(f.productionId, f.manifestHash, character.id));
  assert.equal((await f.adapter.submitShot(f.request)).status, 'processing');
  assert.equal(f.submitted.length, 3);
  assert.deepEqual(new Set(f.submitted.map(request => request.identity)), new Set([
    ...f.manifest.screenplay.characters.map(character => characterViewIdentity(f.productionId, f.manifestHash, character.id)), f.frameIdentity]));
  assert.ok(f.submitted.every(request => request.endpoint === FAL_MODELS.reference));
  f.completeStart(); assert.equal((await f.adapter.submitShot(f.request)).status, 'processing');
  assert.equal(f.submitted.length, 3); assert.equal(f.reviews.length, 1); assert.equal(f.verified.length, 0);
  for (const character of f.manifest.screenplay.characters) f.records.set(characterViewIdentity(f.productionId, f.manifestHash, character.id),
    { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: f.references[character.id].referenceImageUrls[0] }] } });
  assert.equal((await f.adapter.submitShot(f.request)).status, 'queued');
  assert.equal(f.submitted.length, 4); assert.equal(f.submitted[3].endpoint, FAL_MODELS.kling); assert.equal(f.verified.length, 1);
});

test('known terminal dependency failures prevent spending on missing parallel dependencies', async () => {
  for (const failedKind of ['view', 'start']) {
    const f = fixture();
    for (const character of f.manifest.screenplay.characters) f.records.delete(characterViewIdentity(f.productionId, f.manifestHash, character.id));
    const identity = failedKind === 'start' ? f.frameIdentity
      : characterViewIdentity(f.productionId, f.manifestHash, f.manifest.screenplay.characters[1].id);
    f.records.set(identity, { state: 'failed', endpoint: FAL_MODELS.reference });
    assert.equal((await f.adapter.submitShot(f.request)).status, 'failed'); assert.equal(f.submitted.length, 0); assert.equal(f.reviews.length, 0);
  }
});

test('failed and uncertain starting-frame generation cannot retry or trigger review/video', async () => {
  for (const state of ['failed', 'uncertain', 'submitting']) {
    const f = fixture(); f.records.set(f.frameIdentity, { state, endpoint: FAL_MODELS.reference });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.adapter.reconcileShot(f.request);
      assert.equal(result.status, state === 'failed' ? 'failed' : 'uncertain');
    }
    assert.equal(f.submitted.length, 0); assert.equal(f.reviews.length, 0);
  }
});

test('passed responses cannot bypass independent stored-receipt verification or changed normalized bytes', async () => {
  for (const options of [{ proof: { manifestHash: 'f'.repeat(64) } }, { proof: { normalizedImageHash: undefined } },
    { proof: { referenceIdentity: 'f'.repeat(64) } }, { reviewThrows: true }, { changedBytes: true }, { verifyNoProof: true },
    { verifyThrows: Object.assign(Error('missing immutable receipt'), { code: 'VISUAL_REVIEW_REQUIRED' }) }]) {
    const f = fixture(options); f.completeStart(); await assert.rejects(f.adapter.submitShot(f.request));
    assert.equal(f.submitted.length, 0);
  }
  const mismatch = fixture({ verifyThrows: Object.assign(Error('failed receipt'), { code: 'CAST_START_FRAME_MISMATCH' }) });
  mismatch.completeStart(); assert.equal((await mismatch.adapter.submitShot(mismatch.request)).failureCode, 'CAST_START_FRAME_MISMATCH');
  assert.equal(mismatch.submitted.length, 0);
});

test('failed-shot payload reconstruction requires the same saved start image and normalizes it', async () => {
  const f = fixture();
  assert.throws(() => falRecoveryShotInput(f.manifest, f.shot, f.references));
  const body = falRecoveryShotInput(f.manifest, f.shot, f.references, f.startUrl);
  assert.deepEqual(body, falShotInput(f.manifest, f.shot, 'kling', f.references, f.startUrl));
  const result = await normalizeKlingInputReferences(f.manifest, body, async url => normalized(url));
  assert.equal(result.start_image_url, normalized(f.startUrl));
  assert.equal(body.start_image_url, f.startUrl, 'Recovery never mutates the stored reconstruction');
});

test('empty cast still has a composed environment and its start image is normalized without fabricated elements', async () => {
  const project = fictionalOperatorProject(); project.characters = [];
  project.scenes.forEach(scene => { scene.characterIds = []; scene.visual = 'An empty garden.'; scene.narration = ''; });
  const manifest = build(project), input = startFrameInput(manifest, manifest.shots[0], {});
  assert.equal('context' in input, false); assert.equal(falPlan(manifest, 'kling').referenceCount, 3);
  const body = falShotInput(manifest, manifest.shots[0], 'kling', {}, 'https://v3.fal.media/empty.jpg');
  const result = await normalizeKlingInputReferences(manifest, body, async url => normalized(url));
  assert.equal(result.start_image_url, normalized('https://v3.fal.media/empty.jpg'));
  assert.equal('elements' in result, false); assert.equal('image_urls' in result, false);
});

test('remote preflight uses the protected action and rejects unbounded or unsuccessful responses', async () => {
  const input = { email: 'fictional@example.invalid', preparedId: 'fixture', manifestHash: digest('manifest'),
    shotId: 'shot-001', referenceIdentity: digest('reference') };
  let request;
  const call = createRemoteStartFrameReview({ env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://lineagetheater.com/api/production-worker'); request = options;
    return new Response(JSON.stringify({ passed: true }));
  } });
  await call(input); assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), { action: 'review-start-frame', ...input });
  for (const response of [new Response('failure', { status: 503 }), new Response('x'.repeat(8193)), new Response('not json')])
    await assert.rejects(createRemoteStartFrameReview({ env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, fetchImpl: async () => response })(input));
});
