import { fixture as evidenceFixture, hash, decision, response } from './visual-evidence-recovery.mjs';
import { createFilmVisualReviewService } from '../../api/_lib/film-visual-review.mjs';
import { createVisualEditorialRecovery } from '../../api/_lib/film-visual-editorial-recovery.mjs';
export { hash, decision, response };
export const originalAction = 'At the last letter she lifts her finger; they exchange a smile.';
export const revisedAction = 'After the writing, they exchange a smile.';
export async function fixture() {
  const h = await evidenceFixture({ openingAction: originalAction, textCorrection: true });
  // The fixture replaced its initial synthetic v1 receipt with actual JPEG hashes.
  // Remove that unused seed so the private inventory contains the exact history.
  h.records.delete(h.receiptPath);
  await h.apply();
  const prior = await createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
    fetchImpl: async () => response({ ...decision(), sceneAction: 'unverifiable', findings: ['insufficient-visible-evidence'] }) })(h.reviewInput());
  h.mutate(h.jobPath, job => { job.finishingFailure = { version: 1, manifestHash: job.manifestHash,
    stage: 'visual-review', reason: 'VISUAL_EVIDENCE_INSUFFICIENT', state: 'attention', recordedAt: new Date(h.now()).toISOString() }; });
  h.mutate(h.queuePath, queue => { queue.state = 'attention'; queue.lastResult = 'REVIEW_REQUIRED';
    queue.lastFailure = { stage: 'visual-review', reason: 'VISUAL_EVIDENCE_INSUFFICIENT' }; });
  const job = h.value(h.jobPath);
  const input = { email: h.email, id: job.id, manifestHash: job.manifestHash, jobHash: hash(job), queueHash: hash(h.value(h.queuePath)),
    priorBindingHash: prior.bindingHash, priorReceiptHash: hash(h.value(prior.receiptPath)), originalAction, revisedAction };
  const listBlobs = async ({ prefix }) => ({ blobs: [...h.records.keys()].filter(pathname => pathname.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false });
  const options = { ...h.options, listBlobs };
  const service = createVisualEditorialRecovery(options);
  return { ...h, prior, input, options, listBlobs, service, apply: () => service(input, { apply: true }) };
}
