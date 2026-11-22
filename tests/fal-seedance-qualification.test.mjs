import test from 'node:test';
import assert from 'node:assert/strict';
import { falQualification, loadSeedanceQualification, qualifiedSeedanceRelease } from '../api/_lib/fal-qualification.mjs';
import { testSeedanceQualification } from './fixtures/seedance-qualification.mjs';

test('only reviewed evidence for both production Seedance routes enables a release', () => {
  const receipt = testSeedanceQualification();
  assert.equal(qualifiedSeedanceRelease(receipt), true);
  const result = loadSeedanceQualification(JSON.stringify(receipt));
  assert.equal(result.qualityScope, 'technical-media-with-per-film-native-audio-duration');
  assert.deepEqual(result.requiredDeliveryChecks, ['full-decode', 'exact-duration', 'native-audio-duration', 'private-artifact']);
  for (const raw of ['', '{', '{}', null, JSON.stringify(falQualification)]) assert.equal(loadSeedanceQualification(raw), null);
  for (const mutate of [q => { q.recipeVersion = falQualification.recipeVersion; }, q => { q.source = 'public-example'; },
    q => { q.commercialUse = false; }, q => { q.reviewedAt = ''; }, q => q.technicalSamples.pop(),
    q => { q.technicalSamples[0].endpoint = q.technicalSamples[1].endpoint; },
    q => { q.technicalSamples[1].mediaSha256 = q.technicalSamples[0].mediaSha256; },
    q => { q.technicalSamples[1].requestId = q.technicalSamples[0].requestId; },
    q => { q.technicalSamples[0].height = 720; }, q => { q.technicalSamples[0].audioCodec = null; },
    q => { q.technicalSamples[0].durationMs = 2000; }, q => { q.technicalSamples[1].browserPlaybackPassed = false; },
    q => { q.technicalSamples[0].fullDecodePassed = false; }, q => { q.technicalSamples[0].nativeAudio = false; }]) {
    const changed = testSeedanceQualification();
    mutate(changed);
    assert.equal(qualifiedSeedanceRelease(changed), false);
    assert.equal(loadSeedanceQualification(JSON.stringify(changed)), null);
  }
});
