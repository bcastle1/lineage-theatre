import sharp from 'sharp';
import { fixture as finalEditorialFixture, hash, decision, response } from './visual-final-editorial-recovery.mjs';
import { createFilmVisualReviewService } from '../../api/_lib/film-visual-review.mjs';
import { createAssembledReviewRecovery } from '../../api/_lib/film-assembled-review-recovery.mjs';
export { hash, decision, response };

export async function fixture() {
  const h = await finalEditorialFixture(); await h.apply();
  const prior = await createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
    fetchImpl: async () => response({ ...decision(), sceneAction: 'mismatch', findings: ['wrong-action-or-setting'] }) })(h.reviewInput(3));
  h.mutate(h.jobPath, job => { job.finishingFailure = { version: 1, manifestHash: job.manifestHash,
    stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH', state: 'attention', recordedAt: new Date(h.now()).toISOString() }; });
  h.mutate(h.queuePath, queue => { queue.state = 'attention'; queue.lastResult = 'REVIEW_REQUIRED';
    queue.lastFailure = { stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH' }; });
  const job = h.value(h.jobPath);
  const input = { email: h.email, id: job.id, manifestHash: job.manifestHash, jobHash: hash(job), queueHash: hash(h.value(h.queuePath)),
    priorBindingHash: prior.bindingHash, priorReceiptHash: hash(h.value(prior.receiptPath)) };
  const options = { ...h.options }, service = createAssembledReviewRecovery(options);
  // Distinct synthetic final pixels demonstrate that the v6 binding covers the
  // rendered artifact, not the v5 source-frame hashes. There is no live media.
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#335533' } }).jpeg().toBuffer();
  const finalDataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  const assembledArtifact = { sha256: 'b'.repeat(64), sizeBytes: 4000, durationSeconds: job.manifest.shots.reduce((sum, shot) => sum + shot.targetDurationMs, 0) / 1000 };
  const reviewInput = (index = 3) => {
    const request = h.reviewInput(index);
    if (index !== 3) return request;
    request.frames = request.frames.map(frame => ({ ...frame, dataUrl: finalDataUrl,
      atMs: frame.atMs + request.job.manifest.shots.find(shot => shot.id === frame.shotId).startMs }));
    return { ...request, assembledArtifact: structuredClone(assembledArtifact) };
  };
  return { ...h, prior, input, options, service, assembledArtifact, finalDataUrl, rawReviewInput: h.reviewInput, reviewInput,
    apply: () => service(input, { apply: true }) };
}
