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
