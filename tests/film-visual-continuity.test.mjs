import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { validateVisualContinuity, VisualContinuityPlanError, VISUAL_CONTINUITY_DIRECTION } from '../api/_lib/film-visual-continuity.mjs';
import { falPlan, falShotInput, characterReferenceInput, createFalProductionAdapter, FAL_RECIPE_VERSION, FalProductionPlanError } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';

const references = manifest => Object.fromEntries(manifest.screenplay.characters.map(character => [character.id,
  character.referencePhotoId ? 'data:image/jpeg;base64,ZmFrZQ==' : `https://v3.fal.media/${character.id}.jpg`]));
function fixture() {
  const project = fictionalOperatorProject();
  project.duration = 60;
  project.scenes = project.scenes.slice(0, 2);
  project.scenes[0].visual = 'Fictional Ada and Alice stand in the garden; Ada wears her green apron over a white shirt and narrow black tie.';
  project.scenes[1].visual = 'Years later in the kitchen, Ada explicitly changes to a blue coat over a yellow blouse, without a tie. Alice retains her blue apron.';
  return buildFilmManifest(project).manifest;
}

test('new plans bind appearance and wardrobe before pricing, preserving scripted scene changes across every cut', () => {
  const original = fixture(), before = JSON.stringify(original), planned = planKlingShots(original);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(planned, planKlingShots(original));
  assert.deepEqual(planKlingShots(planned), planned);
  assert.deepEqual(planKlingShots(planned, { visualContinuity: false }), planned);
  assert.notEqual(digest(JSON.stringify(planned)), digest(before));
  assert.deepEqual(planned.screenplay, original.screenplay);
  assert.equal(validateVisualContinuity(planned), planned.visualContinuity);
  assert.equal(planned.visualContinuity.scenes.length, 2);
  assert.equal(planned.visualContinuity.characters.length, 2);
  assert.equal(planned.visualContinuity.characters[0].appearance, original.screenplay.characters[0].description);
  for (const scene of planned.visualContinuity.scenes) {
    const cuts = planned.shots.filter(shot => shot.continuity.sourceSceneId === scene.sceneId);
    assert.ok(cuts.length >= 2);
    assert.ok(cuts.every(shot => shot.visual === scene.direction && shot.sceneIndex === scene.sceneIndex));
    assert.deepEqual(scene.characterIds, original.shots[scene.sceneIndex].characterIds);
    for (const shot of cuts) {
      const input = falShotInput(planned, shot, 'kling', references(planned));
      assert.ok(input.prompt.includes(VISUAL_CONTINUITY_DIRECTION));
      assert.ok(input.prompt.includes(scene.direction));
      assert.doesNotMatch(input.prompt, /References guide identity only/);
      assert.deepEqual(input.image_urls, shot.characterIds.map(id => references(planned)[id]));
      assert.ok(Buffer.byteLength(JSON.stringify(input.prompt), 'utf8') < 2400);
    }
  }
  // Continuity is anchored by the same already-priced portrait per character.
  assert.equal(falPlan(planned, 'kling').referenceCount, falPlan(planKlingShots(original, { visualContinuity: false }), 'kling').referenceCount);
  assert.match(characterReferenceInput(planned, planned.screenplay.characters[0]).prompt, /one clearly visible outfit/);
});

test('selected photos retain their exact source and binding instead of becoming generated portraits', () => {
  const original = fixture(), character = original.screenplay.characters[0];
  const sourceId = '11111111-1111-4111-8111-111111111111';
  character.referencePhotoId = sourceId; character.sourceIds.push(sourceId);
  original.sources.push({ id: sourceId, type: 'image/jpeg' });
  character.referencePhoto = { version: 1, sourceId, ownerHash: 'a'.repeat(64), sha256: 'b'.repeat(64),
    normalizedSha256: 'c'.repeat(64), contentType: 'image/jpeg', sizeBytes: 100, etag: 'fixture-etag', normalization: 'jpeg-1600-q90-v1' };
  const planned = planKlingShots(original);
  assert.deepEqual(planned.visualContinuity.characters[0].reference, { kind: 'selected-photo', sourceId });
  assert.deepEqual(planned.screenplay.characters[0].referencePhoto, character.referencePhoto);
  assert.equal(falPlan(planned, 'kling').referenceCount, 1);
  assert.equal(falShotInput(planned, planned.shots[0], 'kling', references(planned)).image_urls[0], 'data:image/jpeg;base64,ZmFrZQ==');
  assert.throws(() => falShotInput(planned, planned.shots[0], 'kling', {}));
});

test('missing or altered continuity contracts cannot silently fall back to legacy prompts', () => {
  for (const change of [
    manifest => { delete manifest.visualContinuity; },
    manifest => { manifest.visualContinuity.characters[0].appearance = 'A substituted person.'; },
    manifest => { manifest.visualContinuity.characters[0].reference.characterId = 'somebody-else'; },
    manifest => { manifest.visualContinuity.scenes[0].direction = 'A substituted outfit.'; },
    manifest => { manifest.shots[0].visual += ' A new jacket.'; },
    manifest => { manifest.shots[0].continuity.sourceSceneId = 'scene-missing'; },
    manifest => { manifest.visualContinuity.scenes[0].wardrobeRule = 'anything'; },
    manifest => { manifest.visualContinuity.version = 2; },
  ]) {
    const planned = planKlingShots(fixture()); change(planned);
    assert.throws(() => falPlan(planned, 'kling'), VisualContinuityPlanError);
  }
});

test('compact continuity prompts retain all approved creative fields and wardrobe rules or fail before new spend', async () => {
  let compact;
  // Find the transport boundary without encoding an incidental formatter size.
  for (let length = 500; length < 1500; length += 25) {
    const original = fixture();
    original.shots[0].visual = 'A garden with a precisely scripted white shirt and black tie. ' + 'period details '.repeat(Math.ceil(length / 15));
    const planned = planKlingShots(original);
    try {
      const prompt = falShotInput(planned, planned.shots[0], 'kling', references(planned)).prompt;
      if (prompt.includes('fixed narrator/voices')) { compact = { planned, prompt }; break; }
    } catch (error) { assert.ok(error instanceof FalProductionPlanError); }
  }
  assert.ok(compact, 'A compact prompt is exercised');
  const { planned, prompt } = compact, shot = planned.shots[0];
  for (const value of [VISUAL_CONTINUITY_DIRECTION, planned.screenplay.logline,
    ...planned.screenplay.characters.map(character => character.description), shot.visual, shot.narration, shot.dialogue, shot.dramatization])
    assert.ok(prompt.includes(value));
  assert.ok(Buffer.byteLength(prompt, 'utf8') < 2400);
  assert.ok(Buffer.byteLength(JSON.stringify(prompt), 'utf8') < 2400);
  const original = fixture(); original.shots[0].visual += 'é'.repeat(1400);
  const oversized = planKlingShots(original), before = JSON.stringify(oversized);
  const adapter = createFalProductionAdapter({ client: { get: async () => null, submit: () => assert.fail('No provider request') },
    read: async () => null, selectedPhoto: () => assert.fail('No new source read') });
  await assert.rejects(adapter.submitShot({ manifest: oversized, manifestHash: digest(before), shot: oversized.shots[0],
    productionId: 'fictional-production', idempotencyKey: digest('continuity-preflight'), authorizeSpend: () => assert.fail('No new spending') }), FalProductionPlanError);
  assert.equal(JSON.stringify(oversized), before);
});

test('legacy plans retain their exact shape and remain independent of the new appearance checks', () => {
  const legacy = planKlingShots(fixture(), { visualContinuity: false });
  assert.equal(legacy.visualContinuity, undefined);
  assert.deepEqual(planKlingShots(legacy), legacy, 'Already prepared legacy plans never upgrade implicitly');
  assert.deepEqual(legacy.productionPlan, { provider: 'kling', version: 1 });
  assert.equal(validateVisualContinuity(legacy), null);
  assert.match(falShotInput(legacy, legacy.shots[0], 'kling', references(legacy)).prompt, /References guide identity only/);
  assert.doesNotMatch(characterReferenceInput(legacy, legacy.screenplay.characters[0]).prompt, /one clearly visible outfit/);
});

test('new continuity quotes require a ready appearance-checking worker while old plans remain quotable', async () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const qualification = { version: 2, model: 'kling', endpoint: FAL_MODELS.kling, recipeVersion: FAL_RECIPE_VERSION,
    commercialUse: true, commercialUseSource: `https://fal.ai/models/${FAL_MODELS.kling}`,
    technicalSample: { requestId: 'fixture-request-123', mediaSha256: 'b'.repeat(64), durationMs: 12042, width: 1920, height: 1080,
      videoCodec: 'h264', audioCodec: 'aac', fullDecodePassed: true, browserPlaybackPassed: true, nativeAudio: true },
    qualityScope: 'technical-media-with-per-film-speech-gate', knownLimitations: ['Synthetic test only.'],
    requiredDeliveryChecks: ['full-decode', 'exact-duration', 'script-speech', 'private-artifact'], reviewedAt: new Date(now).toISOString() };
  const heartbeat = { recipe: FAL_RECIPE_VERSION, model: 'kling', ready: true, deliveryChecksVersion: 1, checkedAt: new Date(now).toISOString() };
  let prices = 0;
  const adapter = createFalProductionAdapter({ qualification, key: 'fixture', now: () => now, requireWorker: true,
    read: async () => ({ value: heartbeat }), pricing: async () => { prices++; return { videoMicroUsdPerSecond: 1200000,
      referenceMicroUsd: 300000, expiresAt: new Date(now + 3600000).toISOString() }; } });
  await assert.rejects(adapter.validateManifest(planKlingShots(fixture())), /appearance and wardrobe checks/);
  assert.equal(prices, 0);
  assert.equal((await adapter.validateManifest(planKlingShots(fixture(), { visualContinuity: false }))).ready, true);
  heartbeat.visualChecksVersion = 1;
  assert.equal((await adapter.validateManifest(planKlingShots(fixture()))).ready, true);
});
