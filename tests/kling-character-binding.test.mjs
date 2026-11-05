import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { buildFilmManifest, fictionalOperatorProject, createFilmProductionService, productionJobPath } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { KlingCharacterBindingError, KLING_CAST_BINDING_DIRECTION, normalizeKlingInputReferences } from '../api/_lib/kling-character-binding.mjs';
import { falPlan, falShotInput, createFalProductionAdapter, FAL_RECIPE_VERSION, FalProductionPlanError } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { klingCanaryProfile } from '../scripts/test-kling-production.mjs';

const build = project => planKlingShots(buildFilmManifest(project || fictionalOperatorProject()).manifest);
const refs = manifest => Object.fromEntries(manifest.screenplay.characters.map(c => [c.id, `https://v3.fal.media/${c.id}.jpg`]));
const payload = manifest => falShotInput(manifest, manifest.shots[0], 'kling', refs(manifest));

test('new plans bind cast elements in exact shot order, including reversed screenplay order', () => {
  const project = fictionalOperatorProject();
  project.scenes.forEach(scene => scene.characterIds.reverse());
  const manifest = build(project), before = JSON.stringify(manifest), input = payload(manifest);
  assert.equal(manifest.productionPlan.characterBindingVersion, 1);
  assert.deepEqual(input.elements, [{ reference_image_urls: ['https://v3.fal.media/alice.jpg'] },
    { reference_image_urls: ['https://v3.fal.media/ada.jpg'] }]);
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

test('unknown or inconsistent binding versions fail instead of silently reverting to images', () => {
  for (const version of [null, false, true, 0, 2, '1']) {
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
test('both historical canaries retain every original manifest and request byte', () => {
  for (const old of historical) {
    const { manifest } = klingCanaryProfile({ quality: old.quality }), before = JSON.stringify(manifest);
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
  visualChecksVersion: 1, characterBindingVersion: 1, checkedAt: new Date(NOW).toISOString() });
test('new binding requires a fresh capable worker before quotes or any new reference or video request', async () => {
  const manifest = build(), manifestHash = digest(JSON.stringify(manifest)); let health, prices = 0, submissions = 0;
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async path => path === 'production/worker-health.json' && health ? { value: health } : null,
    pricing: async () => { prices++; return { videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000, expiresAt: new Date(NOW + 60000).toISOString() }; },
    client: { get: async () => null, submit: () => { submissions++; return { state: 'queued' }; } } });
  const request = { manifest, manifestHash, shot: manifest.shots[0], productionId: 'fixture-production',
    idempotencyKey: digest('binding-capability'), authorizeSpend: async () => true };
  for (const value of [undefined, { ...healthy(), characterBindingVersion: undefined }, { ...healthy(), characterBindingVersion: 2 },
    { ...healthy(), checkedAt: new Date(NOW - 180001).toISOString() }]) {
    health = value;
    await assert.rejects(adapter.quote({ manifest, manifestHash })); await assert.rejects(adapter.submitShot(request));
    assert.equal(prices, 0); assert.equal(submissions, 0);
  }
  health = healthy();
  const quote = await adapter.quote({ manifest, manifestHash }); assert.equal(quote.providerCostCents, 300);
  assert.equal((await adapter.submitShot(request)).status, 'processing'); assert.equal(submissions, 2);
});

test('provider dispatch normalizes each element image once and keeps completed reference identities', async () => {
  const manifest = build(), manifestHash = digest(JSON.stringify(manifest)), productionId = 'fixture-production';
  const records = new Map(manifest.screenplay.characters.map(character => [digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${character.id}`),
    { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: refs(manifest)[character.id] }] } }]));
  let submitted; const normalized = [];
  const adapter = createFalProductionAdapter({ key: 'synthetic-key', now: () => NOW,
    read: async path => path === 'production/worker-health.json' ? { value: healthy() } : null,
    normalizeKlingReference: async url => { normalized.push(url); return 'normalized:' + url; },
    client: { get: async id => records.get(id), submit: async request => { submitted = request; return { state: 'queued' }; } } });
  await adapter.submitShot({ manifest, manifestHash, shot: manifest.shots[0], productionId,
    idempotencyKey: digest('dispatch-binding'), authorizeSpend: async () => true });
  assert.deepEqual(normalized, manifest.shots[0].characterIds.map(id => refs(manifest)[id]));
  assert.deepEqual(submitted.input.elements, normalized.map(url => ({ reference_image_urls: ['normalized:' + url] })));
  assert.equal(submitted.endpoint, FAL_MODELS.kling); assert.equal('image_urls' in submitted.input, false);
});

test('shared render and recovery normalization supports new, historical and empty casts without changing prompts', async () => {
  const empty = fictionalOperatorProject(); empty.characters = []; empty.scenes.forEach(scene => { scene.characterIds = []; });
  for (const manifest of [build(), klingCanaryProfile({ quality: true }).manifest, build(empty)]) {
    const input = payload(manifest), before = JSON.stringify(input), calls = [];
    const normalized = await normalizeKlingInputReferences(manifest, input, async url => { calls.push(url); return 'normalized:' + url; });
    assert.equal(JSON.stringify(input), before); assert.equal(normalized.prompt, input.prompt);
    assert.deepEqual(calls, manifest.shots[0].characterIds.map(id => refs(manifest)[id]));
    if (input.elements) assert.deepEqual(normalized.elements, calls.map(url => ({ reference_image_urls: ['normalized:' + url] })));
    else if (input.image_urls) assert.deepEqual(normalized.image_urls, calls.map(url => 'normalized:' + url));
    else { assert.equal('elements' in normalized, false); assert.equal('image_urls' in normalized, false); }
  }
});

test('operator playback preserves all three fixed manifests and preparation cannot silently reuse an old identity', async () => {
  const actor = { email: OWNER_EMAIL, role: 'owner', status: 'active' }, records = new Map([[userPath(OWNER_EMAIL), { value: actor, etag: 'owner' }]]);
  const read = async path => records.get(path);
  for (const manifest of [...historical.map(old => klingCanaryProfile({ quality: old.quality }).manifest), build()]) {
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
  for (const manifest of [...historical.map(old => klingCanaryProfile({ quality: old.quality }).manifest), build()]) {
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
