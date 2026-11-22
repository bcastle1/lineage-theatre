import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots, planSeedanceShots } from '../api/_lib/kling-film-plan.mjs';
import { falPlan, falShotInput } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';

test('Seedance US cuts preserve the complete screenplay and timed edit through ten minutes', () => {
  for (const duration of [15, 60, 120, 600]) {
    const project = fictionalOperatorProject();
    project.duration = duration;
    project.scenes = [project.scenes[0]];
    project.scenes[0].dialogue = 'Ada: Come plant these seeds.\nAlice: I have a spade.';
    const { manifest } = buildFilmManifest(project);
    const planned = planSeedanceShots(manifest), plan = falPlan(planned, 'seedance');
    assert.deepEqual(planned.screenplay, manifest.screenplay);
    assert.deepEqual(planned.productionPlan, { provider: 'seedance', version: 1, visualContinuityVersion: 1 });
    assert.equal(planned.sound.narration, 'provider-native-audio');
    assert.equal(planned.visualContinuity.characters[0].reference.kind, 'screenplay-description');
    assert.equal(planSeedanceShots(planned), planned);
    assert.throws(() => planKlingShots(planned));
    assert.throws(() => falPlan(planned, 'kling'));
    assert.equal(plan.referenceCount, 0);
    assert.equal(plan.generatedSeconds, duration);
    assert.equal(plan.shots.length, Math.ceil(duration / 30));
    let position = 0;
    for (const shot of plan.shots) {
      assert.equal(shot.startMs, position);
      position += shot.targetDurationMs;
      assert.ok(shot.seconds >= 4 && shot.seconds <= 30);
      assert.equal(shot.endpoint, FAL_MODELS.seedanceText);
    }
    assert.equal(position, duration * 1000);
    assert.equal(plan.shots.map(s => s.narration).filter(Boolean).join(' '), project.scenes[0].narration);
    const spokenWords = lines => lines.replace(/(?:^|\n)(?:Ada|Alice):\s*/g, ' ').trim().replace(/\s+/g, ' ');
    assert.equal(spokenWords(plan.shots.map(s => s.dialogue).join('\n')), spokenWords(project.scenes[0].dialogue));
  }
});

test('Seedance bills its four-second minimum and retains a shorter cut in the edit', () => {
  const { manifest } = buildFilmManifest(fictionalOperatorProject());
  const shot = { ...manifest.shots[0], targetDurationMs: 2500, dialogue: '', narration: '' };
  const next = { ...manifest.shots[1], startMs: 2500, targetDurationMs: 12500 };
  const planned = planSeedanceShots({ ...manifest, shots: [shot, next] }), plan = falPlan(planned, 'seedance');
  assert.equal(plan.generatedSeconds, 17);
  const input = falShotInput(planned, plan.shots[0], 'seedance', {});
  assert.equal(input.duration, '4');
  assert.match(input.prompt, /finish before 2\.30s/);
  assert.match(input.prompt, /Hold the ending through 4s/);
});

test('only the selected photographs enter Seedance and their numbers follow each shot’s cast order', () => {
  const project = fictionalOperatorProject();
  const sourceId = '22222222-3333-4444-8555-666666666666';
  project.sources.push({ id: sourceId, name: 'Alice.jpg', type: 'image/jpeg', text: '' });
  project.characters[1].referencePhotoId = sourceId;
  project.characters[1].sourceIds.push(sourceId);
  project.scenes[1].characterIds = ['ada'];
  const { manifest } = buildFilmManifest(project);
  manifest.screenplay.characters[1].referencePhoto = { version: 1, sourceId, ownerHash: 'a'.repeat(64), sha256: 'b'.repeat(64),
    normalizedSha256: 'c'.repeat(64), contentType: 'image/jpeg', sizeBytes: 200, etag: 'synthetic-etag', normalization: 'jpeg-1600-q90-v1' };
  const planned = planSeedanceShots(manifest), plan = falPlan(planned, 'seedance');
  assert.equal(plan.referenceCount, 0);
  assert.deepEqual(plan.shots.map(s => s.endpoint), [FAL_MODELS.seedance, FAL_MODELS.seedanceText, FAL_MODELS.seedance]);
  const alice = 'data:image/jpeg;base64,YWxpY2U=', photos = { alice, ada: 'must never enter the payload' };
  assert.throws(() => falShotInput(planned, plan.shots[0], 'seedance', {}), { code: 'PRODUCTION_PHOTO_UNAVAILABLE' });
  const withPhoto = falShotInput(planned, plan.shots[0], 'seedance', photos);
  assert.deepEqual(withPhoto.image_urls, [alice]);
  assert.equal(withPhoto.task, 'reference');
  assert.match(withPhoto.prompt, /@Image1: Fictional Alice:/);
  assert.doesNotMatch(withPhoto.prompt, /@Image2|@Image1: Fictional Ada/);
  assert.ok(withPhoto.prompt.includes(project.characters[0].description));
  assert.ok(withPhoto.prompt.includes(project.scenes[0].narration));
  const textOnly = falShotInput(planned, plan.shots[1], 'seedance', photos);
  assert.doesNotMatch(textOnly.prompt, /@Image/);
  assert.equal(textOnly.task, undefined);
  assert.equal(textOnly.image_urls, undefined);
  assert.equal(textOnly.seed, undefined);
  for (const input of [withPhoto, textOnly]) {
    assert.equal(input.resolution, '1080p');
    assert.equal(input.aspect_ratio, '16:9');
    assert.equal(input.generate_audio, true);
    assert.equal(input.codec, 'H264');
    assert.equal(input.output_format, 'mp4');
    assert.equal(input.bitrate_mode, 'high');
  }
});
