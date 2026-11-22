import { FAL_MODELS } from './fal-client.mjs';

// Technical qualification of the completed Kling comparison, reviewed against
// its saved decode and browser receipts on 2026-10-20. It establishes usable
// 1080p native-audio output, not historical accuracy or a finished-film review.
// Each production still requires the worker's speech/media/private-file checks.
export const falQualification = Object.freeze({
  version: 2, model: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/reference-to-video',
  recipeVersion: 'lineage-realistic-kling-o3-v1',
  commercialUse: true,
  commercialUseSource: 'https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video',
  technicalSample: Object.freeze({
    requestId: '01a15722-00e5-73e2-ad6d-673e229aaf48',
    mediaSha256: '89e0a5f126c7aff58d1150b894a2bb7892bd802baaf6c4762b2d1a97c80adcbe',
    durationMs: 12042, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac',
    fullDecodePassed: true, browserPlaybackPassed: true, nativeAudio: true,
  }),
  requiredDeliveryChecks: Object.freeze(['full-decode', 'exact-duration', 'script-speech', 'private-artifact']),
  qualityScope: 'technical-media-with-per-film-speech-gate',
  knownLimitations: Object.freeze([
    'The sample contains period-detail concerns; historical accuracy is not qualified.',
    'ASR spelling varied between passes; exact name pronunciation, distinct voices and lip synchronization are not qualified.',
    'One short scene does not establish likeness or continuity throughout a film.',
  ]),
  reviewedAt: '2026-10-20T16:09:30Z',
});

export const SEEDANCE_RECIPE_VERSION = 'lineage-realistic-seedance-2.5-us-v1';
const seedanceEndpoints = [FAL_MODELS.seedanceText, FAL_MODELS.seedance];
const seedanceChecks = ['full-decode', 'exact-duration', 'native-audio-duration', 'private-artifact'];

export function qualifiedSeedanceRelease(receipt) {
  if (receipt?.version !== 3 || receipt.model !== 'seedance' || receipt.recipeVersion !== SEEDANCE_RECIPE_VERSION
    || receipt.source !== 'production-account' || receipt.commercialUse !== true
    || !Number.isFinite(Date.parse(receipt.reviewedAt))
    || !Array.isArray(receipt.technicalSamples) || receipt.technicalSamples.length !== seedanceEndpoints.length) return false;
  const samples = receipt.technicalSamples;
  return seedanceEndpoints.every(endpoint => samples.some(sample => sample?.endpoint === endpoint
    && sample.commercialUseSource === `https://fal.ai/models/${endpoint}`
    && /^[\w-]{8,100}$/.test(sample.requestId || '') && /^[a-f0-9]{64}$/.test(sample.mediaSha256 || '')
    && sample.width === 1920 && sample.height === 1080 && sample.videoCodec === 'h264' && sample.audioCodec === 'aac'
    && Number.isSafeInteger(sample.durationMs) && sample.durationMs >= 3900 && sample.durationMs <= 15500
    && sample.nativeAudio === true && sample.fullDecodePassed === true && sample.browserPlaybackPassed === true))
    && new Set(samples.map(sample => sample.requestId)).size === samples.length
    && new Set(samples.map(sample => sample.mediaSha256)).size === samples.length;
}

// Load the operator's reviewed receipt for this deployment. An empty config,
// a different model's receipt, or a public provider example cannot qualify it.
export function loadSeedanceQualification(raw = process.env.FILM_SEEDANCE_QUALIFICATION) {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  let receipt;
  try { receipt = JSON.parse(raw); } catch { return null; }
  if (!qualifiedSeedanceRelease(receipt)) return null;
  return { ...receipt, qualityScope: 'technical-media-with-per-film-native-audio-duration',
    requiredDeliveryChecks: [...seedanceChecks],
    knownLimitations: ['The media checks verify decoded audio duration. They do not verify spoken words, likeness or historical accuracy.'] };
}
