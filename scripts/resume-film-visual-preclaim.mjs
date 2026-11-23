// Read-only usage: node scripts/resume-film-visual-preclaim.mjs <private-plan.json>
// Explicit application: apply <private-plan.json> --apply-reviewed-preclaim-resume
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreclaimVisualReviewResume } from '../api/_lib/film-visual-review-recovery.mjs';
import { createRemoteVisualPreclaimResumeAuthorization } from '../api/_lib/remote-visual-preclaim-authorization.mjs';

export const PRECLAIM_APPLY_FLAG = '--apply-reviewed-preclaim-resume';
export async function runVisualPreclaimResume(args = process.argv.slice(2), service = createPreclaimVisualReviewResume({
  authorize: createRemoteVisualPreclaimResumeAuthorization(),
})) {
  const [action, filename, flag] = args.length === 1 ? ['plan', args[0]] : args;
  if (!['plan', 'apply'].includes(action) || typeof filename !== 'string'
    || !filename || (action === 'plan' ? ![1, 2].includes(args.length) : args.length !== 3 || flag !== PRECLAIM_APPLY_FLAG))
    throw Object.assign(Error('Usage: [plan] <private-plan> or apply <private-plan> --apply-reviewed-preclaim-resume'), { code: 'VISUAL_PRECLAIM_USAGE' });
  const bytes = await readFile(resolve(filename));
  if (bytes.length > 16_000) throw Error('Invalid preclaim resume plan.');
  const input = JSON.parse(bytes.toString('utf8'));
  if (!input || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'email,id,jobHash,manifestHash,queueHash,recoveryGrantHash')
    throw Error('Invalid preclaim resume plan.');
  return service(input, { apply: action === 'apply' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVisualPreclaimResume().then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'stopped', code: ['VISUAL_PRECLAIM_USAGE', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED'].includes(error?.code)
      ? error.code : 'VISUAL_PRECLAIM_RESUME_REQUIRED', newVideoRequests: 0 }) + '\n'); process.exitCode = 1;
  });
}
