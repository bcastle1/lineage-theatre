import { fixture as editorialFixture, hash, decision, response } from './visual-editorial-recovery.mjs';
import { createFilmVisualReviewService } from '../../api/_lib/film-visual-review.mjs';
import { createVisualFinalEditorialRecovery } from '../../api/_lib/film-visual-final-editorial-recovery.mjs';
export { hash, decision, response };
export const originalAction = 'He turns the pencil around and offers it, eraser first.';
export const revisedAction = 'He offers the pencil to the child.';
export async function fixture() {
  const h = await editorialFixture({ finalAction: originalAction }); await h.apply();
  let index = 0;
  const reviewer = createFilmVisualReviewService({ read: h.read, write: h.write, now: h.now, key: 'synthetic-only', authorize: async () => true,
    fetchImpl: async () => response(index++ === 3 ? { ...decision(), sceneAction: 'mismatch', findings: ['wrong-action-or-setting'] } : decision()) });
  const v4Proofs = [];
  for (let i = 0; i < 4; i++) v4Proofs.push(await reviewer(h.reviewInput(i)));
  h.mutate(h.jobPath, job => { job.finishingFailure = { version: 1, manifestHash: job.manifestHash,
    stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH', state: 'attention', recordedAt: new Date(h.now()).toISOString() }; });
  h.mutate(h.queuePath, queue => { queue.state = 'attention'; queue.lastResult = 'REVIEW_REQUIRED';
    queue.lastFailure = { stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH' }; });
  const job = h.value(h.jobPath), prior = v4Proofs[3];
  const input = { email: h.email, id: job.id, manifestHash: job.manifestHash, jobHash: hash(job), queueHash: hash(h.value(h.queuePath)),
    priorBindingHash: prior.bindingHash, priorReceiptHash: hash(h.value(prior.receiptPath)), originalAction, revisedAction };
  const options = { ...h.options }, service = createVisualFinalEditorialRecovery(options);
  return { ...h, prior, input, options, service, v4Proofs, passingProofs: v4Proofs.slice(0, 3), apply: () => service(input, { apply: true }) };
}
