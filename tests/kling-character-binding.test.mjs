import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { buildFilmManifest, fictionalOperatorProject, createFilmProductionService, productionJobPath } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { KlingCharacterBindingError, KLING_CAST_BINDING_DIRECTION, normalizeKlingInputReferences, validateKlingImageElement } from '../api/_lib/kling-character-binding.mjs';
import { falPlan, falShotInput, characterViewIdentity, characterViewInput, createFalProductionAdapter, FAL_RECIPE_VERSION, FalProductionPlanError } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { klingCanaryProfile } from '../scripts/test-kling-production.mjs';

const build = project => planKlingShots(buildFilmManifest(project || fictionalOperatorProject()).manifest);
const frontRefs = manifest => Object.fromEntries(manifest.screenplay.characters.map(c => [c.id, `https://v3.fal.media/${c.id}.jpg`]));
const refs = manifest => Object.fromEntries(Object.entries(frontRefs(manifest)).map(([id, url]) => [id,
  manifest.productionPlan?.characterBindingVersion === 2 ? { frontalImageUrl: url, referenceImageUrls: [`https://v3.fal.media/${id}-side.jpg`] } : url]));
const payload = manifest => falShotInput(manifest, manifest.shots[0], 'kling', refs(manifest));

test('new plans bind cast elements in exact shot order, including reversed screenplay order', () => {
  const project = fictionalOperatorProject();
  project.scenes.forEach(scene => scene.characterIds.reverse());
  const manifest = build(project), before = JSON.stringify(manifest), input = payload(manifest);
  assert.equal(manifest.productionPlan.characterBindingVersion, 2);
  assert.deepEqual(input.elements, [{ frontal_image_url: 'https://v3.fal.media/alice.jpg', reference_image_urls: ['https://v3.fal.media/alice-side.jpg'] },
    { frontal_image_url: 'https://v3.fal.media/ada.jpg', reference_image_urls: ['https://v3.fal.media/ada-side.jpg'] }]);
  assert.match(input.prompt, /@Element1 Fictional Alice: Adult wearing a blue apron\./);
  assert.match(input.prompt, /@Element2 Fictional Ada: Adult wearing a green apron\./);
  assert.ok(input.prompt.includes(KLING_CAST_BINDING_DIRECTION));
  assert.match(input.prompt, /Scene title: Planting/);
  assert.match(input.prompt, /Film context only \(not this cut's action\): Two fictional sisters share a garden harvest\./);
  assert.equal('image_urls' in input, false);
  assert.doesNotMatch(input.prompt, /@Image\d/);
  assert.equal(JSON.stringify(manifest), before);
});

test('empty cast uses no fabricated elements, reference images or casting directions', () => {
  const project = fictionalOperatorProject(); project.characters = [];
  project.scenes.forEach(scene => { scene.characterIds = []; scene.visual = 'An empty garden.'; scene.narration = ''; });
  const manifest = build(project), input = payload(manifest);
  assert.equal('elements' in input, false); assert.equal('image_urls' in input, false);
  assert.doesNotMatch(input.prompt, /@Element|one distinct cast identity/);
  assert.equal(falPlan(manifest, 'kling').referenceCount, 0);
});

test('observed provider 422 image-element condition rejects reference-only, empty and duplicate views', async () => {
  // Production returned HTTP 422 on 2026-11-05: "Either frontal_image_url
  // and reference_image_urls or video_url must be provided". The official
  // O3 API also specifies 1-3 additional views. Test that external condition,
  // including the old request that our former payload-only tests accepted.
  const front = 'https://v3.fal.media/front.jpg', side = 'https://v3.fal.media/side.jpg';
  const oldRequest = { reference_image_urls: [front] };
  for (const element of [oldRequest, { frontal_image_url: front }, { frontal_image_url: front, reference_image_urls: [] },
    { frontal_image_url: front, reference_image_urls: [front] }, { frontal_image_url: front, reference_image_urls: [side, side] },
    { frontal_image_url: front, reference_image_urls: ['1', '2', '3', '4'] }])
    assert.throws(() => validateKlingImageElement(element), KlingCharacterBindingError);
  assert.deepEqual(validateKlingImageElement({ frontal_image_url: front, reference_image_urls: [side] }),
    { frontal_image_url: front, reference_image_urls: [side] });
  await assert.rejects(normalizeKlingInputReferences(build(), { elements: [{ frontal_image_url: front, reference_image_urls: [side] }] },
    async () => 'data:image/jpeg;base64,same-normalized-pixels'), KlingCharacterBindingError);
});

test('unknown or inconsistent binding versions fail instead of silently reverting to images', () => {
  for (const version of [null, false, true, 0, 3, '1', '2']) {
    const manifest = build(); manifest.productionPlan.characterBindingVersion = version;
    assert.throws(() => payload(manifest), KlingCharacterBindingError);
    assert.throws(() => planKlingShots(manifest), KlingCharacterBindingError);
  }
  const manifest = build(); delete manifest.visualContinuity;
  assert.throws(() => payload(manifest), KlingCharacterBindingError);
  const original = buildFilmManifest(fictionalOperatorProject()).manifest;
  assert.throws(() => planKlingShots(original, { visualContinuity: false, characterBinding: true }), KlingCharacterBindingError);
  assert.equal(planKlingShots(original, { visualContinuity: false }).productionPlan.characterBindingVersion, undefined);
});

// Hashes were derived independently from deployed commit 49e468f before the change.
const historical = [
  { quality: false, manifestHash: '02168601049cab97e4381981f5aa73dcd05b8b9553cf9f6017a40408c808b2ac', hashes: [
    '28d044bfe334342439c6ab426eca75c680e2327591e5db207dcd6fe4795d0179',
    '03351974bda9e1341ced86102d94122c2f7f2c0893f721089577d5903d9274e7',
    'f672179eddab373d9beaf42e34d1a665773ad46b66de436fbca96f7b1728cb5e'] },
  { quality: true, manifestHash: 'c6d95029a8578bbb140acea253346116cf86040ab82932f629d30e61e965627b', hashes: [
    '0d01c19d66c0d99310f19f76e82d3e3f60d408996be4973fd261168f74d98290',
    'fdf9d504c7274c7f5affa3c98e5348328cd5a312bb16e898c8802abbcd57eef4',
    'eb546cc126924cec2bf776783254bb2f7f72279f8b72db6a24458dc4bc423d58'] },
];
// Independently recorded from deployed 37916f5 before the version-2 change.
historical.push({ binding: 1, manifestHash: 'd6985ce486f09c921345bc96443c831f39f6c984408280cb44aed45e26323701', hashes: [
  '301152e45bf2085c513d8b94a30a093139c64a89fa59d5742a1b327f51e4124e',
  'a412b42a4dd84b3f3b004a8f8b2b0b89d4bbb6d2a2d71c92b328de5df9b4b886',
  '7713538f952f078d701e5ec3bd1448cdb5b27459ae63d7f523eb1149d9b3449b'] });
const historicalManifest = old => old.binding === 1
  ? planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest, { characterBindingVersion: 1 })
  : klingCanaryProfile({ quality: old.quality }).manifest;

test('all historical canaries retain every original manifest and request byte', () => {
  for (const old of historical) {
    const manifest = historicalManifest(old), before = JSON.stringify(manifest);
    assert.equal(digest(before), old.manifestHash);
    assert.equal(planKlingShots(manifest), manifest);
    assert.equal(JSON.stringify(planKlingShots(manifest, { characterBinding: true })), before);
    assert.deepEqual(manifest.shots.map(shot => digest(JSON.stringify(falShotInput(manifest, shot, 'kling', refs(manifest))))), old.hashes);
  }
});

test('new payload preserves established render translations, exact speech and the saved screenplay', () => {
  const project = fictionalOperatorProject();
  project.characters[0].description = 'Animation maintains attentive eyes and a green apron.';
  project.scenes[0].visual = 'Cinematic animation of both sisters planting. Caption: "An imaginary village"';
  project.scenes[0].narration = 'Together, they plant.'; project.scenes[0].dialogue = 'Ada: Carefully, Alice.';
  const manifest = build(project), before = JSON.stringify(manifest), input = payload(manifest);
  assert.ok(input.prompt.includes('The character maintains attentive eyes and a green apron.'));
  assert.ok(input.prompt.includes('photorealistic historical filmmaking of both sisters planting.'));
  assert.doesNotMatch(input.prompt, /Caption:|Cinematic animation|Animation maintains/);
  assert.ok(input.prompt.includes(project.scenes[0].narration)); assert.ok(input.prompt.includes(project.scenes[0].dialogue));
  assert.equal(JSON.stringify(manifest), before);
});

test('compact element prompts preserve all cast bindings, scene context and speech; oversize fails before spending', async () => {
  let compact;
  for (let count = 1; count < 180; count++) {
    const project = fictionalOperatorProject(); project.scenes[0].visual += ' Detailed garden.'.repeat(count);
    const manifest = build(project);
    try { const input = payload(manifest); if (input.prompt.includes('fixed narrator/voices')) { compact = { manifest, input }; break; } }
    catch (error) { assert.ok(error instanceof FalProductionPlanError); }
  }
  assert.ok(compact);
  const { manifest, input } = compact, shot = manifest.shots[0];
  for (const text of [KLING_CAST_BINDING_DIRECTION, manifest.screenplay.logline, shot.title, shot.visual, shot.narration,
    ...manifest.screenplay.characters.map(c => c.description)]) assert.ok(input.prompt.includes(text));
  assert.ok(Buffer.byteLength(input.prompt) < 2400); assert.ok(Buffer.byteLength(JSON.stringify(input.prompt)) < 2400);
  const project = fictionalOperatorProject(); project.scenes[0].visual += 'é'.repeat(2000);
  const tooLong = build(project);
  const adapter = createFalProductionAdapter({ read: async () => null,
    client: { get: async () => null, submit: () => assert.fail('No provider submission') } });
  await assert.rejects(adapter.submitShot({ manifest: tooLong, manifestHash: digest(JSON.stringify(tooLong)),
    shot: tooLong.shots[0], productionId: 'fixture-production', idempotencyKey: digest('oversize-binding'),
    authorizeSpend: () => assert.fail('No spend authorization') }), FalProductionPlanError);
});

test('split cuts retain their source scene, title and stable per-character binding without inventing action', () => {
  const project = fictionalOperatorProject(); project.duration = 60; project.scenes = [project.scenes[0]];
  const manifest = build(project); assert.equal(manifest.shots.length, 4);
  for (const shot of manifest.shots) {
    const input = falShotInput(manifest, shot, 'kling', refs(manifest));
    assert.equal(shot.continuity.sourceSceneId, 'scene-001'); assert.equal(shot.title, project.scenes[0].title);
    assert.deepEqual(input.elements, payload(manifest).elements);
    assert.ok(input.prompt.includes(shot.visual)); assert.ok(input.prompt.includes(shot.narration || '(none)'));
  }
});

const NOW = Date.parse('2026-11-05T12:00:00Z');
const healthy = () => ({ ready: true, model: 'kling', recipe: FAL_RECIPE_VERSION, deliveryChecksVersion: 1,
  visualChecksVersion: 1, characterBindingVersion: 2, checkedAt: new Date(NOW).toISOString() });

test('retired version 1 never reprices or creates another request but its original operations still reconcile', async () => {
  const manifest = historicalManifest(historical[2]), manifestHash = digest(JSON.stringify(manifest));
  const idempotencyKey = digest('fixture-production:' + manifestHash + ':' + manifest.shots[0].id);
  const identity = digest(`${FAL_RECIPE_VERSION}:kling:${idempotencyKey}`); let saved, polled = 0;
  assert.equal(identity, '5d5593f5df8ec1506ebd268206e0c860ba3424158afb4ae424c845e8a4a9b5be');
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW, read: async () => null,
    pricing: () => assert.fail('No pricing for retired contracts'),
    client: { get: async id => id === identity ? saved : null,
      poll: async id => { assert.equal(id, identity); polled++; return saved; }, submit: () => assert.fail('No new provider operations') } });
  const request = { manifest, manifestHash, shot: manifest.shots[0], productionId: 'fixture-production', idempotencyKey,
    authorizeSpend: () => assert.fail('No spending authorization') };
  await assert.rejects(adapter.quote({ manifest, manifestHash }), { code: 'FILM_CHARACTER_BINDING_RETIRED' });
  await assert.rejects(adapter.submitShot(request), { code: 'FILM_CHARACTER_BINDING_RETIRED' });
  saved = { state: 'queued', endpoint: FAL_MODELS.kling, requestId: 'original-fixture-request' };
  assert.equal((await adapter.reconcileShot(request)).status, 'queued'); assert.equal(polled, 1);
  saved = { ...saved, state: 'failed' };
  assert.equal((await adapter.reconcileShot(request)).status, 'failed'); assert.equal(polled, 1);
});

test('retired version 1 finishes polling an existing reference even when another reference was never submitted', async () => {
  const manifest = historicalManifest(historical[2]), manifestHash = digest(JSON.stringify(manifest)), productionId = 'fixture-production';
  const identity = digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${manifest.screenplay.characters[0].id}`);
  let saved = { endpoint: FAL_MODELS.reference, state: 'queued', requestId: 'original-reference-request' }, polls = 0;
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', read: async () => null,
    selectedPhoto: () => assert.fail('No photo read for retired work'),
    client: { get: async id => id === identity ? saved : null,
      poll: async id => { assert.equal(id, identity); polls++; return saved; }, submit: () => assert.fail('No POST') } });
  const request = { manifest, manifestHash, productionId, shot: manifest.shots[0], idempotencyKey: digest('retired-reference-sweep'),
    authorizeSpend: () => assert.fail('No spending authorization') };
  assert.equal((await adapter.reconcileShot(request)).status, 'processing'); assert.equal(polls, 1);
  saved = { ...saved, state: 'completed', result: { images: [{ url: 'https://v3.fal.media/existing.jpg' }] } };
  await assert.rejects(adapter.reconcileShot(request), { code: 'FILM_CHARACTER_BINDING_RETIRED' }); assert.equal(polls, 1);
});

test('additional views depend on the exact completed main image and all seven operations retain stable identities', async () => {
  const manifest = build(), manifestHash = digest(JSON.stringify(manifest)), productionId = 'fixture-production';
  const records = new Map(), submissions = []; let health = healthy();
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async path => path === 'production/worker-health.json' ? { value: health } : null,
    normalizeKlingReference: async url => 'normalized:' + url,
    client: { get: async id => records.get(id), poll: async id => records.get(id), submit: async request => {
      assert.equal(records.has(request.identity), false); submissions.push(request);
      const saved = { state: 'queued', endpoint: request.endpoint, requestId: request.identity }; records.set(request.identity, saved); return saved;
    } } });
  const request = shot => ({ manifest, manifestHash, shot, productionId,
    idempotencyKey: digest(`${productionId}:${manifestHash}:${shot.id}`), authorizeSpend: async () => true });
  await adapter.submitShot(request(manifest.shots[0])); await adapter.submitShot(request(manifest.shots[0]));
  assert.equal(submissions.length, 2); assert.ok(submissions.every(s => !s.input.context));
  for (const character of manifest.screenplay.characters) records.set(digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${character.id}`),
    { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: frontRefs(manifest)[character.id] }] } });
  health = { ...healthy(), characterBindingVersion: 1 };
  await assert.rejects(adapter.submitShot(request(manifest.shots[0]))); assert.equal(submissions.length, 2);
  health = healthy();
  await adapter.submitShot(request(manifest.shots[0])); await adapter.submitShot(request(manifest.shots[0]));
  assert.equal(submissions.length, 4);
  for (const character of manifest.screenplay.characters) {
    const identity = characterViewIdentity(productionId, manifestHash, character.id), sent = submissions.find(s => s.identity === identity);
    assert.equal(sent.endpoint, FAL_MODELS.reference);
    assert.deepEqual(sent.input, characterViewInput(manifest, character, frontRefs(manifest)[character.id]));
    assert.deepEqual(sent.input.context, [{ type: 'image', image_url: frontRefs(manifest)[character.id] }]);
    records.set(identity, { state: 'completed', endpoint: FAL_MODELS.reference,
      result: { images: [{ url: refs(manifest)[character.id].referenceImageUrls[0] }] } });
  }
  for (const shot of manifest.shots) { await adapter.submitShot(request(shot)); await adapter.submitShot(request(shot)); }
  assert.equal(submissions.length, 7); assert.equal(new Set(submissions.map(s => s.identity)).size, 7);
  assert.equal(submissions.filter(s => s.endpoint === FAL_MODELS.kling).length, 3);
});

test('uncertain additional views never retry and duplicate returned images cannot submit a video', async () => {
  for (const outcome of ['uncertain', 'duplicate-url', 'duplicate-bytes']) {
    const manifest = build(), manifestHash = digest(JSON.stringify(manifest)), productionId = 'fixture-production', records = new Map();
    for (const character of manifest.screenplay.characters) {
      records.set(digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${character.id}`),
        { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: frontRefs(manifest)[character.id] }] } });
      records.set(characterViewIdentity(productionId, manifestHash, character.id), outcome === 'uncertain'
        ? { state: 'uncertain', endpoint: FAL_MODELS.reference }
        : { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: outcome === 'duplicate-url'
          ? frontRefs(manifest)[character.id] : refs(manifest)[character.id].referenceImageUrls[0] }] } });
    }
    const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
      read: async path => path === 'production/worker-health.json' ? { value: healthy() } : null,
      normalizeKlingReference: async url => outcome === 'duplicate-bytes' ? 'same-normalized-image' : url,
      client: { get: async id => records.get(id), submit: () => assert.fail('No new POST') } });
    const request = { manifest, manifestHash, shot: manifest.shots[0], productionId, idempotencyKey: digest('blocked-view'),
      authorizeSpend: () => assert.fail('No spending authorization') };
    if (outcome === 'uncertain') {
      assert.equal((await adapter.submitShot(request)).status, 'uncertain'); assert.equal((await adapter.submitShot(request)).status, 'uncertain');
    } else await assert.rejects(adapter.submitShot(request), KlingCharacterBindingError);
  }
});

test('a selected photo remains the main image and only its conditioned additional view is generated', async () => {
  const original = buildFilmManifest(fictionalOperatorProject()).manifest, character = original.screenplay.characters[0];
  const sourceId = '11111111-1111-4111-8111-111111111111', photo = 'data:image/jpeg;base64,ZmFrZQ==';
  character.referencePhotoId = sourceId; character.sourceIds.push(sourceId); original.sources.push({ id: sourceId, type: 'image/jpeg' });
  character.referencePhoto = { version: 1, sourceId, ownerHash: 'a'.repeat(64), sha256: 'b'.repeat(64),
    normalizedSha256: 'c'.repeat(64), contentType: 'image/jpeg', sizeBytes: 100, etag: 'fixture-etag', normalization: 'jpeg-1600-q90-v1' };
  const manifest = planKlingShots(original), manifestHash = digest(JSON.stringify(manifest)), productionId = 'fixture-photo-production';
  assert.equal(falPlan(manifest, 'kling').referenceCount, 3);
  const records = new Map(), submissions = [];
  const other = manifest.screenplay.characters[1];
  records.set(digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${other.id}`),
    { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: frontRefs(manifest)[other.id] }] } });
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async path => path === 'production/worker-health.json' ? { value: { ...healthy(), referencePhotoVersion: 1 } } : null,
    selectedPhoto: async (saved, cast) => { assert.equal(saved, manifest); assert.equal(cast.id, character.id); return photo; },
    client: { get: async id => records.get(id), submit: async request => { submissions.push(request); return { state: 'queued' }; } } });
  await adapter.submitShot({ manifest, manifestHash, productionId, shot: manifest.shots[0], idempotencyKey: digest('photo-view'), authorizeSpend: async () => true });
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.find(s => s.identity === characterViewIdentity(productionId, manifestHash, character.id)).input.context,
    [{ type: 'image', image_url: photo }]);
  assert.ok(submissions.every(s => s.input.context && s.endpoint === FAL_MODELS.reference));
  assert.ok(!submissions.some(s => s.identity === digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${character.id}`)));
});
test('new binding requires a fresh capable worker before quotes or any new reference or video request', async () => {
  const manifest = build(), manifestHash = digest(JSON.stringify(manifest)); let health, prices = 0, submissions = 0;
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async path => path === 'production/worker-health.json' && health ? { value: health } : null,
    pricing: async () => { prices++; return { videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000, expiresAt: new Date(NOW + 60000).toISOString() }; },
    client: { get: async () => null, submit: () => { submissions++; return { state: 'queued' }; } } });
  const request = { manifest, manifestHash, shot: manifest.shots[0], productionId: 'fixture-production',
    idempotencyKey: digest('binding-capability'), authorizeSpend: async () => true };
  for (const value of [undefined, { ...healthy(), characterBindingVersion: undefined }, { ...healthy(), characterBindingVersion: 1 },
    { ...healthy(), checkedAt: new Date(NOW - 180001).toISOString() }]) {
    health = value;
    await assert.rejects(adapter.quote({ manifest, manifestHash })); await assert.rejects(adapter.submitShot(request));
    assert.equal(prices, 0); assert.equal(submissions, 0);
  }
  health = healthy();
  const quote = await adapter.quote({ manifest, manifestHash }); assert.equal(quote.providerCostCents, 360);
  assert.equal((await adapter.submitShot(request)).status, 'processing'); assert.equal(submissions, 2);
});

test('provider dispatch normalizes each element image once and keeps completed reference identities', async () => {
  const manifest = build(), manifestHash = digest(JSON.stringify(manifest)), productionId = 'fixture-production';
  const records = new Map(manifest.screenplay.characters.map(character => [digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${character.id}`),
    { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: frontRefs(manifest)[character.id] }] } }]));
  for (const character of manifest.screenplay.characters) records.set(characterViewIdentity(productionId, manifestHash, character.id),
    { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: refs(manifest)[character.id].referenceImageUrls[0] }] } });
  let submitted; const normalized = [];
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async path => path === 'production/worker-health.json' ? { value: healthy() } : null,
    normalizeKlingReference: async url => { normalized.push(url); return 'normalized:' + url; },
    client: { get: async id => records.get(id), submit: async request => { submitted = request; return { state: 'queued' }; } } });
  await adapter.submitShot({ manifest, manifestHash, shot: manifest.shots[0], productionId,
    idempotencyKey: digest('dispatch-binding'), authorizeSpend: async () => true });
  assert.deepEqual(normalized, manifest.shots[0].characterIds.flatMap(id => [refs(manifest)[id].frontalImageUrl, ...refs(manifest)[id].referenceImageUrls]));
  assert.deepEqual(submitted.input.elements, manifest.shots[0].characterIds.map(id => ({ frontal_image_url: 'normalized:' + refs(manifest)[id].frontalImageUrl,
    reference_image_urls: refs(manifest)[id].referenceImageUrls.map(url => 'normalized:' + url) })));
  assert.equal(submitted.endpoint, FAL_MODELS.kling); assert.equal('image_urls' in submitted.input, false);
});

test('shared render and recovery normalization supports new, historical and empty casts without changing prompts', async () => {
  const empty = fictionalOperatorProject(); empty.characters = []; empty.scenes.forEach(scene => { scene.characterIds = []; });
  for (const manifest of [build(), ...historical.map(historicalManifest), build(empty)]) {
    const input = payload(manifest), before = JSON.stringify(input), calls = [];
    const normalized = await normalizeKlingInputReferences(manifest, input, async url => { calls.push(url); return 'normalized:' + url; });
    assert.equal(JSON.stringify(input), before); assert.equal(normalized.prompt, input.prompt);
    const v2 = manifest.productionPlan.characterBindingVersion === 2;
    assert.deepEqual(calls, manifest.shots[0].characterIds.flatMap(id => v2 ? [refs(manifest)[id].frontalImageUrl, ...refs(manifest)[id].referenceImageUrls] : [refs(manifest)[id]]));
    if (v2 && input.elements) assert.deepEqual(normalized.elements, input.elements.map(element => ({ frontal_image_url: 'normalized:' + element.frontal_image_url,
      reference_image_urls: element.reference_image_urls.map(url => 'normalized:' + url) })));
    else if (input.elements) assert.deepEqual(normalized.elements, calls.map(url => ({ reference_image_urls: ['normalized:' + url] })));
    else if (input.image_urls) assert.deepEqual(normalized.image_urls, calls.map(url => 'normalized:' + url));
    else { assert.equal('elements' in normalized, false); assert.equal('image_urls' in normalized, false); }
  }
});

test('operator playback preserves all four fixed manifests and preparation cannot silently reuse an old identity', async () => {
  const actor = { email: OWNER_EMAIL, role: 'owner', status: 'active' }, records = new Map([[userPath(OWNER_EMAIL), { value: actor, etag: 'owner' }]]);
  const read = async path => records.get(path);
  for (const manifest of [...historical.map(historicalManifest), build()]) {
    const job = { manifest, manifestHash: digest(JSON.stringify(manifest)), mode: 'operator-test',
      provider: { id: 'fal', model: 'kling' }, filmId: manifest.filmId, shots: manifest.shots.map(shot => ({ id: shot.id })) };
    await requireFinishedFilmPayment({ job, email: OWNER_EMAIL, actor, read, now: () => NOW });
  }
  const service = createFilmProductionService({ adapter: { id: 'fal', model: 'kling' }, readRecordImpl: read,
    writeRecordImpl: async (path, value) => records.set(path, { value, etag: 'saved' }) });
  const input = { actor, idempotencyKey: 'binding-operator-identity' };
  const old = await service.prepareOperatorTest({ ...input, characterBinding: false });
  assert.equal(old.manifestHash, historical[1].manifestHash);
  await assert.rejects(service.prepareOperatorTest(input), { code: 'IDEMPOTENCY_CONFLICT' });
  const current = await service.prepareOperatorTest({ actor, idempotencyKey: 'binding-new-operator-identity' });
  assert.notEqual(current.manifestHash, old.manifestHash);
});

test('unchanged historical and new Kling plans reprice under their saved recipe without changing job or quote identity', async () => {
  const email = 'customer@example.invalid', actor = { email }, project = fictionalOperatorProject();
  for (const manifest of [...historical.map(historicalManifest), build()]) {
    const records = new Map(), quotes = [];
    const service = createFilmProductionService({ now: () => NOW,
      readRecordImpl: async path => structuredClone(records.get(path) || null),
      writeRecordImpl: async (path, value) => records.set(path, { value: structuredClone(value), etag: 'fixture' }),
      adapter: { id: 'fal', model: 'kling', environment: 'production', available: true,
        evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true },
        validateManifest: async value => { assert.deepEqual(value, manifest); return { ready: true }; },
        quote: async value => { quotes.push(value); return { manifestHash: value.manifestHash, quoteReference: 'fixture-quote-' + quotes.length,
          currency: 'USD', providerCostCents: 300, expiresAt: new Date(NOW + 60000).toISOString() }; },
        submitShot: () => assert.fail('No generation'), reconcileShot: () => assert.fail('No generation'), pollShot: () => assert.fail('No generation') } });
    const prepared = await service.prepare({ email, project, preparationConsent: true, idempotencyKey: 'saved-kling-reprice-fixture' });
    const path = productionJobPath(email, prepared.id), record = records.get(path), manifestHash = digest(JSON.stringify(manifest));
    // Reproduce the exact shape of a pre-release stored preparation, including
    // the per-shot keys bound to its original manifest hash and prepared ID.
    record.value.manifest = structuredClone(manifest); record.value.manifestHash = manifestHash;
    record.value.shots = manifest.shots.map(shot => ({ id: shot.id, status: 'prepared', requestKey: digest(`${prepared.id}:${manifestHash}:${shot.id}`) }));
    const before = JSON.stringify(record), input = { preparedId: prepared.id, manifestHash, idempotencyKey: 'renew-existing-price-001' };
    const first = await service.quoteForPayment(project, actor, input);
    const repeat = await service.quoteForPayment(project, actor, input);
    const renewed = await service.quoteForPayment(project, actor, { ...input, idempotencyKey: 'renew-existing-price-002' });
    for (const quote of [first, repeat, renewed]) { assert.equal(quote.preparedId, prepared.id); assert.equal(quote.manifestHash, manifestHash); }
    assert.equal(quotes[0].idempotencyKey, quotes[1].idempotencyKey);
    assert.notEqual(quotes[0].idempotencyKey, quotes[2].idempotencyKey);
    assert.ok(quotes.every(value => value.manifestHash === manifestHash && JSON.stringify(value.manifest) === JSON.stringify(manifest)));
    assert.equal(JSON.stringify(records.get(path)), before); assert.equal(records.size, 1);
    const changed = structuredClone(project); changed.scenes[0].narration = 'A different authored opening.';
    await assert.rejects(service.quoteForPayment(changed, actor, input), { code: 'PRODUCTION_PLAN_CHANGED' });
    await assert.rejects(service.quoteForPayment(project, actor, { ...input, manifestHash: 'f'.repeat(64) }), { code: 'PRODUCTION_PLAN_CHANGED' });
    assert.equal(quotes.length, 3);
  }
});
