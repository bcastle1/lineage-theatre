const stages = new Set(['download', 'speech-review', 'visual-review', 'assembly', 'private-upload', 'stored-verification']);
const reasons = new Set(['MEDIA_SIZE_INVALID', 'MEDIA_SIZE_CHANGED', 'MEDIA_DOWNLOAD_INCOMPLETE', 'MEDIA_RESPONSE_INVALID',
  'ASSEMBLY_NOT_READY', 'ASSEMBLY_REPORT_INVALID', 'WORKER_CLAIM_EXPIRED', 'STORED_ARTIFACT_INVALID',
  'STORED_MEDIA_MISSING', 'STORED_MEDIA_CHANGED', 'STORED_CHECKSUM_MISMATCH', 'SPEECH_REVIEW_REQUIRED',
  'SPEECH_DURATION_INVALID', 'SPEECH_UNEXPECTED', 'SPEECH_SCRIPT_MISMATCH', 'SPEECH_TIMING_INVALID',
  'SPEECH_BOUNDARY_UNCLEAR', 'SPEECH_SHOT_INVALID', 'SPEECH_RECOGNITION_FAILED', 'SPEECH_AUDIO_EDIT_FAILED',
  'VISUAL_REVIEW_REQUIRED', 'VISUAL_REVIEW_UNAVAILABLE', 'VISUAL_CONTINUITY_MISMATCH',
  'DOWNLOAD_FAILED', 'ASSEMBLY_FAILED', 'PRIVATE_UPLOAD_FAILED', 'STORED_VERIFICATION_FAILED']);
const fallback = { download: 'DOWNLOAD_FAILED', 'speech-review': 'SPEECH_REVIEW_REQUIRED', assembly: 'ASSEMBLY_FAILED',
  'visual-review': 'VISUAL_REVIEW_REQUIRED', 'private-upload': 'PRIVATE_UPLOAD_FAILED', 'stored-verification': 'STORED_VERIFICATION_FAILED' };
const tagged = new WeakMap();
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');

// Retain the original error and its class; persist only fixed diagnostic tags.
export function markFinishingFailure(error, stage, reason) {
  if (object(error)) {
    const previous = tagged.get(error);
    tagged.set(error, { stage: stages.has(stage) ? stage : previous?.stage,
      reason: reasons.has(reason) ? reason : previous?.reason });
  }
  return error;
}

export function finishingFailure(error, stage) {
  const detail = object(error) ? tagged.get(error) : undefined;
  const safeStage = stages.has(detail?.stage) ? detail.stage : stages.has(stage) ? stage : null;
  return safeStage ? { stage: safeStage, reason: reasons.has(detail?.reason) ? detail.reason : fallback[safeStage] } : null;
}

export function sanitizeFinishingFailure(value) {
  return stages.has(value?.stage) && reasons.has(value?.reason) ? { stage: value.stage, reason: value.reason } : null;
}
