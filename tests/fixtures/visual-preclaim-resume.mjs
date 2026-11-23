import { digest } from '../../api/_lib/auth.mjs';
import { createPreclaimVisualReviewResume, visualReviewPreclaimResumePath } from '../../api/_lib/film-visual-review-recovery.mjs';
import { fixture, correctionFor } from './visual-review-recovery.mjs';

export const sha = value => digest(JSON.stringify(value));
export async function preclaimFixture() {
  const h = fixture(); h.input.textCorrections = [correctionFor(h)]; await h.apply(); h.advance(60000);
  h.mutate(h.jobPath, job => {
    job.finishingFailure = { ...job.finishingFailure, state: 'attention', reason: 'VISUAL_REVIEW_REQUIRED',
      recordedAt: new Date(h.now()).toISOString() };
    job.revision++; job.updatedAt = new Date(h.now()).toISOString();
  });
  h.mutate(h.queuePath, queue => {
    queue.state = 'attention'; queue.attempts = 1; queue.updatedAt = new Date(h.now()).toISOString();
    queue.lastResult = 'REVIEW_REQUIRED'; queue.lastFailure = { stage: 'visual-review', reason: 'VISUAL_REVIEW_REQUIRED' };
    queue.nextAttemptAt = h.now() + 10000;
  });
  h.writes.length = 0; h.authorizationCalls.length = 0;
  const job = h.value(h.jobPath), resumePath = visualReviewPreclaimResumePath(job), resumeHooks = {}, lists = [], permissions = [];
  const resumeInput = { email: h.email, id: job.id, manifestHash: job.manifestHash,
    recoveryGrantHash: sha(job.visualReviewRecovery), jobHash: sha(job), queueHash: sha(h.value(h.queuePath)) };
  const listBlobs = async options => {
    lists.push(structuredClone(options));
    const override = await resumeHooks.list?.(options); if (override !== undefined) return override;
    const paths = [...h.records.keys()].filter(path => path.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0, selected = paths.slice(start, start + options.limit);
    return { blobs: selected.map(pathname => ({ pathname })), hasMore: start + selected.length < paths.length,
      ...(start + selected.length < paths.length ? { cursor: String(start + selected.length) } : {}) };
  };
  const resumeService = createPreclaimVisualReviewResume({ read: h.read, write: h.write, now: h.now, listBlobs,
    authorize: async args => {
      permissions.push(structuredClone(args));
      const override = await resumeHooks.authorize?.(args); if (override !== undefined) return override;
      return { allowed: true, environment: 'production', manifestHash: args.manifestHash,
        recoveryRequestHash: sha(args.recoveryPlan), expiresAt: new Date(h.now() + 60000).toISOString() };
    } });
  const bindingPrefix = `production/visual-review-bindings/${job.ownerHash}/${job.id}/`;
  return { ...h, job, resumePath, resumeInput, resumeService, resumeHooks, listBlobs, lists, permissions, bindingPrefix,
    resume: () => resumeService(resumeInput, { apply: true }) };
}
