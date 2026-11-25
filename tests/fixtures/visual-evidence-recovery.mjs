import sharp from 'sharp';
import { fixture as stageFixture, correctionFor } from './visual-review-recovery.mjs';
import { digest } from '../../api/_lib/auth.mjs';
import { createFilmVisualReviewService, VISUAL_REVIEW_MODEL, visualReceiptPath, visualSampleTimes, visualReviewSampleTimes } from '../../api/_lib/film-visual-review.mjs';
import { createVisualEvidenceRecovery } from '../../api/_lib/film-visual-evidence-recovery.mjs';

export const hash = value => digest(JSON.stringify(value));
export const dimensions = ['appearance', 'wardrobe', 'sceneAction', 'imageIntegrity', 'cast'];
export const decision = (count = 3) => ({ ...Object.fromEntries(dimensions.map(key => [key, 'consistent'])), findings: [],
  observations: dimensions.map((dimension, index) => ({ dimension, sampleIndex: index % count,
    visibleEvidence: `Synthetic visible evidence for ${dimension}.` })) });
export const response = value => Response.json({ status: 'completed', model: VISUAL_REVIEW_MODEL,
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

export async function fixture(fixtureOptions = {}) {
  const h = stageFixture(fixtureOptions);
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#557799' } }).jpeg().toBuffer();
  const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  h.receipt.binding.frameHashes = [digest(bytes), digest(bytes), digest(bytes)];
  h.receipt.bindingHash = hash(h.receipt.binding);
  h.seed(visualReceiptPath(h.job.ownerHash, h.job.id, h.receipt.bindingHash), h.receipt);
  h.input.bindingHash = h.receipt.bindingHash; h.input.receiptHash = hash(h.receipt);
  if (fixtureOptions.textCorrection) {
    const end = h.job.manifest.shots[3].targetDurationMs;
    h.input.textCorrections = [{ ...correctionFor(h), startMs: end - 2000, endMs: end - 1000 }];
  }
  await h.apply();
  const job = h.value(h.jobPath);
  const shot = job.manifest.shots[0];
  const uncertain = { ...decision(), appearance: 'unverifiable', sceneAction: 'unverifiable', findings: ['insufficient-visible-evidence'] };
  const stageProof = await createFilmVisualReviewService({ read: h.read, write: h.write, key: 'synthetic-only', now: h.now,
    authorize: async () => true, fetchImpl: async () => response(uncertain) })({ email: h.email, id: job.id, job,
    shotId: shot.id, frames: visualSampleTimes(shot).map(atMs => ({ shotId: shot.id, atMs, dataUrl })) });
  h.mutate(h.jobPath, value => { value.finishingFailure = { version: 1, manifestHash: job.manifestHash,
    stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH', state: 'attention', recordedAt: new Date(h.now()).toISOString() }; });
  h.mutate(h.queuePath, value => { value.state = 'attention'; value.lastResult = 'REVIEW_REQUIRED';
    value.lastFailure = { stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH' }; });
  const input = { email: h.email, id: job.id, manifestHash: job.manifestHash, jobHash: hash(h.value(h.jobPath)),
    queueHash: hash(h.value(h.queuePath)), priorBindingHash: stageProof.bindingHash, priorReceiptHash: hash(h.value(stageProof.receiptPath)) };
  const options = { read: h.read, write: h.write, now: h.now, authorize: async ({ recoveryPlan, manifestHash }) => ({ allowed: true,
    environment: 'production', manifestHash, recoveryRequestHash: hash(recoveryPlan), expiresAt: new Date(h.now() + 60000).toISOString() }) };
  const service = createVisualEvidenceRecovery(options);
  const reviewInput = (index = 0) => {
    const current = h.value(h.jobPath), selected = current.manifest.shots[index], previous = current.manifest.shots[index - 1];
    const frames = visualReviewSampleTimes(current, selected).map(atMs => ({ shotId: selected.id, atMs, dataUrl }));
    if (previous?.sceneIndex === selected.sceneIndex) frames.push({ shotId: previous.id, atMs: visualSampleTimes(previous)[2], dataUrl });
    return { email: h.email, id: current.id, job: current, shotId: selected.id, frames };
  };
  return { ...h, input, stageProof, options, service, dataUrl, reviewInput, apply: () => service(input, { apply: true }) };
}
