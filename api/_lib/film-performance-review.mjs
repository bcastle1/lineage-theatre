import { digest, readRecord } from './auth.mjs';
import { validateFilmPerformance, validatePerformanceOutput, FILM_PERFORMANCE_RECIPE } from './film-performance.mjs';
import { markFinishingFailure } from './film-finishing-diagnostics.mjs';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const performanceReviewFailure = (reason = 'PERFORMANCE_REVIEW_REQUIRED') => markFinishingFailure(Object.assign(
  new Error('The selected voice and mouth movements need review. The original performance and saved payment record are retained.'),
  { code: 'FILM_PERFORMANCE_REVIEW_REQUIRED' }), 'speech-review', reason);
const requireValue = value => { if (!value) throw performanceReviewFailure('PERFORMANCE_PROVENANCE_INVALID'); };
const duration = value => Number.isFinite(value) && value > 0 && value <= 11;
const size = value => Number.isSafeInteger(value) && value >= 16 && value <= 250 * 1024 * 1024;

export function validatePerformanceMusicReceipt(receipt, manifest) {
  if (manifest.sound?.musicRequested !== true) { requireValue(receipt?.requested === false && Object.keys(receipt).length === 1); return receipt; }
  requireValue(receipt?.version === 1 && receipt.requested === true && receipt.recipe === 'original-midi-fluidr3-performance-v1'
    && receipt.durationSeconds === manifest.targetDurationSeconds && HASH.test(receipt.midiSha256 || '') && size(receipt.midiBytes)
    && HASH.test(receipt.scoreSha256 || '') && size(receipt.scoreBytes) && HASH.test(receipt.soundfontSha256 || '')
    && receipt.soundfontPackage === 'fluid-soundfont-gm' && receipt.soundfontPackageVersion === '3.1-5.3'
    && receipt.maximumScorePeak === 0.1 && receipt.speechGain === 0.95 && receipt.scoreGain === 0.25
    && receipt.speechOffsetSamples === 0 && receipt.sampleRate === 48000 && receipt.channels === 2);
  return receipt;
}

export function performanceReceiptPath(ownerHash, id, bindingHash) {
  requireValue(HASH.test(ownerHash || '') && UUID.test(id || '') && HASH.test(bindingHash || ''));
  return `production/performance-reviews/${ownerHash}/${id}/${bindingHash}.json`;
}

export function validatePerformanceReviewProof({ manifest, manifestHash, ownerHash, id, artifactSha256, review }) {
  if (!validateFilmPerformance(manifest)) return null;
  requireValue(HASH.test(manifestHash || '') && digest(JSON.stringify(manifest)) === manifestHash && HASH.test(artifactSha256 || '')
    && review?.version === 1 && review.recipe === FILM_PERFORMANCE_RECIPE && review.passed === true
    && review.manifestHash === manifestHash && review.artifactSha256 === artifactSha256
    && review.shotCount === manifest.shots.length && HASH.test(review.bindingHash || '')
    && review.receiptPath === performanceReceiptPath(ownerHash, id, review.bindingHash));
  return Object.fromEntries(['version', 'recipe', 'manifestHash', 'passed', 'artifactSha256', 'bindingHash', 'receiptPath', 'shotCount']
    .map(key => [key, review[key]]));
}

export function validatePerformanceReviewBinding(binding, { job, ownerHash, id, artifactSha256, speechReview }) {
  requireValue(validateFilmPerformance(job?.manifest) && job.ownerHash === ownerHash && job.id === id
    && digest(JSON.stringify(job.manifest)) === job.manifestHash && binding?.version === 1 && binding.recipe === FILM_PERFORMANCE_RECIPE
    && binding.ownerHash === ownerHash && binding.id === id && binding.manifestHash === job.manifestHash
    && binding.artifactSha256 === artifactSha256 && HASH.test(artifactSha256 || '')
    && HASH.test(binding.speechReviewSha256 || '') && Array.isArray(binding.shots) && binding.shots.length === job.manifest.shots.length
    && Array.isArray(job.shots) && job.shots.length === binding.shots.length);
  requireValue(speechReview?.passed === true && speechReview.version === 1 && speechReview.method === 'local-speech-transcription'
    && digest(JSON.stringify(speechReview)) === binding.speechReviewSha256 && Array.isArray(speechReview.shots)
    && speechReview.shots.length === binding.shots.length);
  validatePerformanceMusicReceipt(binding.music, job.manifest);
  for (const [index, shot] of job.manifest.shots.entries()) {
    const saved = job.shots[index], measured = binding.shots[index], spoken = speechReview.shots[index];
    requireValue(saved.id === shot.id && saved.status === 'completed' && measured?.shotId === shot.id
      && spoken?.shotId === shot.id && spoken.scriptMatched === true && !spoken.edit && !spoken.repairProof && !spoken.adjacentContextProof
      && measured.outputHash === digest(JSON.stringify(saved.output)));
    const provenance = validatePerformanceOutput(job.manifest, shot, saved.output);
    requireValue(JSON.stringify(measured.provenance) === JSON.stringify(provenance)
      && HASH.test(measured.videoSha256 || '') && size(measured.videoBytes)
      && measured.videoBytes === saved.output.sizeBytes && HASH.test(measured.selectedAudioContainerSha256 || '')
      && size(measured.selectedAudioContainerBytes) && duration(measured.videoDurationSeconds)
      && Number.isFinite(measured.videoStartSeconds)
      && Number.isFinite(measured.videoFrameRate) && measured.videoFrameRate >= 1 && measured.videoFrameRate <= 60
      && Math.abs(measured.videoDurationSeconds - shot.targetDurationMs / 1000) <= 1 / measured.videoFrameRate + 0.002
      && duration(measured.selectedAudioDurationSeconds) && Math.abs(measured.selectedAudioDurationSeconds - shot.targetDurationMs / 1000) <= 0.05);
    const mode = shot.performance.mode;
    if (mode === 'dialogue') requireValue(measured.audioSelection === 'embedded-synchronized'
      && measured.selectedAudioContainerSha256 === measured.videoSha256 && measured.selectedAudioContainerBytes === measured.videoBytes
      && measured.providerAudioSha256 === null && measured.providerAudioBytes === null
      && Number.isFinite(measured.sourceAudioStartSeconds)
      && Math.abs(measured.sourceAudioStartSeconds - measured.videoStartSeconds) <= Math.max(1 / measured.videoFrameRate, 0.05) + 0.002
      && measured.sourceAudioDurationSeconds === measured.selectedAudioDurationSeconds);
    else if (mode === 'narration') requireValue(measured.audioSelection === 'stock-narration-silence-padded'
      && HASH.test(measured.providerAudioSha256 || '') && size(measured.providerAudioBytes)
      && measured.providerAudioBytes === saved.output.audio.sizeBytes && duration(measured.sourceAudioDurationSeconds)
      && Number.isFinite(measured.sourceAudioStartSeconds)
      && measured.sourceAudioDurationSeconds <= shot.targetDurationMs / 1000);
    else requireValue(measured.audioSelection === 'planned-silence' && measured.providerAudioSha256 === null
      && measured.providerAudioBytes === null && measured.sourceAudioDurationSeconds === null && measured.sourceAudioStartSeconds === null);
  }
  return binding;
}

export async function verifyFilmPerformanceReceipts({ email, id, manifestHash, manifest, artifactSha256, review, speechReview }, { read = readRecord } = {}) {
  const ownerHash = digest(email), proof = validatePerformanceReviewProof({ manifest, manifestHash, ownerHash, id, artifactSha256, review });
  if (!proof) return;
  const job = (await read(`production/jobs/${ownerHash}/${id}.json`))?.value;
  requireValue(job?.manifestHash === manifestHash);
  const stored = (await read(proof.receiptPath))?.value;
  requireValue(stored?.version === 1 && stored.state === 'verified' && stored.bindingHash === proof.bindingHash
    && digest(JSON.stringify(stored.binding)) === proof.bindingHash);
  validatePerformanceReviewBinding(stored.binding, { job, ownerHash, id, artifactSha256, speechReview });
}
