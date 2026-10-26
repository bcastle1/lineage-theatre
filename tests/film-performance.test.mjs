import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildFilmManifest, fictionalOperatorProject, validateProviderOutput } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { KLING_VOICES, FILM_PERFORMANCE_RECIPE, validateFilmPerformance, validatePerformanceOutput } from '../api/_lib/film-performance.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
function project() {
  const p = fictionalOperatorProject(); p.performanceControlsVersion = 1; p.duration = 30;
  p.narratorVoiceId = KLING_VOICES[0].id;
  p.characters[0].voiceId = KLING_VOICES[1].id; p.characters[0].wardrobe = 'Green apron over a cream linen blouse.';
  p.characters[1].voiceId = KLING_VOICES[0].id; p.characters[1].wardrobe = 'Blue apron and plain brown skirt.';
  p.scenes = [{ ...p.scenes[0], dialogue: 'Fictional Ada: We planted this garden together.\nFictional Alice: Now everyone can share the harvest.' }];
  return p;
}
function planned(p = project()) { return planKlingShots(buildFilmManifest(p).manifest); }
function output(shot) {
  const url = 'https://v3.fal.media/final.mp4';
  return { url, contentType: 'video/mp4', sizeBytes: 100, durationSeconds: shot.targetDurationMs / 1000,
    performance: { version: 1, recipe: FILM_PERFORMANCE_RECIPE, mode: shot.performance.mode, speakerId: shot.performance.speakerId,
      voiceId: shot.performance.voiceId, textSha256: sha(shot.performance.text), videoOperationId: 'a'.repeat(64), speechOperationId: 'b'.repeat(64),
      sourceVideoUrlSha256: sha('https://v3.fal.media/source.mp4'), outputVideoUrlSha256: sha(url), audioUrlSha256: null } };
}
test('new plan freezes selected voices, wardrobe and every word into isolated speaking cuts', () => {
  const p = project(), m = planned(p);
  assert.equal(validateFilmPerformance(m), true);
  assert.equal(m.performance.recipe, FILM_PERFORMANCE_RECIPE);
  assert.equal(m.screenplay.characters[0].wardrobe, p.characters[0].wardrobe);
  const dialogue = m.shots.filter(shot => shot.performance.mode === 'dialogue');
  assert.equal(dialogue.length, 2);
  assert.deepEqual(dialogue.map(shot => shot.characterIds), [['ada'], ['alice']]);
  assert.deepEqual(dialogue.map(shot => shot.performance.voiceId), [KLING_VOICES[1].id, KLING_VOICES[0].id]);
  assert.equal(m.shots.reduce((sum, shot) => sum + shot.targetDurationMs, 0), 30000);
  assert.deepEqual(planKlingShots(m), m);
});
test('long turns split only at word boundaries; no word or punctuation is discarded', () => {
  const p = project(); p.duration = 60; p.scenes[0].narration = '';
  const line = 'We remember the bright mornings, the long summer evenings, and every neighbor who joined us to plant, water, and share this beautiful garden with the whole village.';
  p.scenes[0].dialogue = `Fictional Ada: ${line}`;
  const m = planned(p), shots = m.shots.filter(shot => shot.performance.mode === 'dialogue');
  assert.ok(shots.length > 1);
  assert.equal(shots.map(shot => shot.performance.text).join(' '), line);
  assert.ok(shots.every(shot => shot.performance.text.length <= 120 && shot.targetDurationMs <= 10000));
  assert.equal(validateFilmPerformance(m), true);
});
test('ambiguous or unlabeled speakers and insufficient duration fail before pricing', () => {
  for (const dialogue of ['We share the garden.', 'Unknown: We share the garden.']) {
    const p = project(); p.scenes[0].dialogue = dialogue; assert.throws(() => planned(p), /character|Label/);
  }
  const p = project(); p.duration = 15;
  p.scenes[0].dialogue = Array.from({ length: 8 }, () => 'Fictional Ada: Welcome to our garden.').join('\n');
  assert.throws(() => planned(p), /at least/);
});
test('partial contracts, altered words, actor, voice, or timing cannot downgrade to a legacy plan', () => {
  const m = planned();
  for (const edit of [x => delete x.performance, x => x.performance.version = 2,
    x => x.shots[1].performance.text = 'Changed words.', x => x.shots[1].characterIds.push('alice'),
    x => x.shots[1].performance.voiceId = KLING_VOICES[0].id, x => x.shots[1].startMs += 1]) {
    const changed = structuredClone(m); edit(changed); assert.throws(() => validateFilmPerformance(changed));
  }
  assert.equal(validateFilmPerformance(planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest)), false);
});
test('final dialogue provenance must bind exact selected voice, text and synchronized URL with embedded audio', () => {
  const m = planned(), shot = m.shots.find(shot => shot.performance.mode === 'dialogue'), result = output(shot);
  assert.deepEqual(validateProviderOutput(result, ['v3.fal.media']).performance, result.performance);
  assert.equal(validatePerformanceOutput(m, shot, result).passed, undefined);
  for (const edit of [r => r.url = 'https://v3.fal.media/other.mp4', r => r.performance.textSha256 = 'c'.repeat(64),
    r => r.performance.speechOperationId = null, r => r.performance.voiceId = KLING_VOICES[0].id,
    r => r.audio = { url: 'https://v3.fal.media/dub.mp3' }, r => delete r.performance]) {
    const changed = structuredClone(result); edit(changed); assert.throws(() => validatePerformanceOutput(m, shot, changed), /provenance|match/);
  }
});
test('narration binds separate selected audio, while silent cuts permit no voice operation', () => {
  const m = planned(), shot = m.shots.find(shot => shot.performance.mode === 'narration'), result = output(shot);
  result.audio = { url: 'https://v3.fal.media/narration.mp3' }; result.performance.audioUrlSha256 = sha(result.audio.url);
  assert.ok(validatePerformanceOutput(m, shot, result));
  result.audio.url = 'https://v3.fal.media/other.mp3'; assert.throws(() => validatePerformanceOutput(m, shot, result));
  const p = project(); p.scenes[0].narration = ''; p.scenes[0].dialogue = '';
  const silent = planned(p), s = silent.shots[0], out = output(s); out.performance.speechOperationId = null;
  assert.ok(validatePerformanceOutput(silent, s, out));
});
