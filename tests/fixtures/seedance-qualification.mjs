import { FAL_MODELS } from '../../api/_lib/fal-client.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../../api/_lib/fal-qualification.mjs';

// Synthetic unit-test data. Never install this fixture in a deployment.
export function testSeedanceQualification() {
  return { version: 3, model: 'seedance', recipeVersion: SEEDANCE_RECIPE_VERSION, source: 'production-account',
    commercialUse: true, reviewedAt: '2026-11-22T00:00:00Z',
    technicalSamples: [FAL_MODELS.seedanceText, FAL_MODELS.seedance].map((endpoint, index) => ({
      endpoint, commercialUseSource: `https://fal.ai/models/${endpoint}`, requestId: `fixture-seedance-${index}`,
      mediaSha256: String(index + 1).repeat(64), width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac',
      durationMs: 4020, nativeAudio: true, fullDecodePassed: true, browserPlaybackPassed: true,
    })) };
}
