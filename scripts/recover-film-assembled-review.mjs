// Plan-only by default. Applying authorizes one assembled review of a fixed film
// while preserving the existing payment, rejected receipts and all source clips.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssembledReviewRecovery } from '../api/_lib/film-assembled-review-recovery.mjs';
import { createRemoteAssembledReviewAuthorization } from '../api/_lib/remote-assembled-review-authorization.mjs';

export const ASSEMBLED_REVIEW_APPLY_FLAG = '--apply-reviewed-assembled-review';
export async function runAssembledReviewRecovery(args = process.argv.slice(2), service = createAssembledReviewRecovery({
  authorize: createRemoteAssembledReviewAuthorization(),
})) {
  const [action, filename, flag] = args.length === 1 ? ['plan', args[0]] : args;
  if (!['plan', 'apply'].includes(action) || typeof filename !== 'string'
    || !filename || (action === 'plan' ? ![1, 2].includes(args.length) : args.length !== 3 || flag !== ASSEMBLED_REVIEW_APPLY_FLAG))
    throw Object.assign(Error('Usage: [plan] <private-plan> or apply <private-plan> --apply-reviewed-assembled-review'), { code: 'ASSEMBLED_REVIEW_USAGE' });
  const bytes = await readFile(resolve(filename));
  if (bytes.length > 16_000) throw Error('Invalid assembled review recovery plan.');
  const input = JSON.parse(bytes.toString('utf8'));
  if (!input || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'email,id,jobHash,manifestHash,priorBindingHash,priorReceiptHash,queueHash')
    throw Error('Invalid assembled review recovery plan.');
  return service(input, { apply: action === 'apply' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAssembledReviewRecovery().then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'stopped', code: ['ASSEMBLED_REVIEW_USAGE', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED'].includes(error?.code)
      ? error.code : 'ASSEMBLED_REVIEW_RECOVERY_REQUIRED', newVideoRequests: 0 }) + '\n'); process.exitCode = 1;
  });
}
