// Plans are read-only by default. Applying preserves the rejected receipt and
// source clips, allowing one stage-aware Astra review per clip and no renders.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisualReviewRecovery } from '../api/_lib/film-visual-review-recovery.mjs';
import { createRemoteVisualRecoveryAuthorization } from '../api/_lib/remote-visual-recovery-authorization.mjs';
export const APPLY_FLAG = '--apply-reviewed-stage-recovery';
export async function runVisualRecovery(args = process.argv.slice(2), service = createVisualReviewRecovery({
  authorize: createRemoteVisualRecoveryAuthorization(),
})) {
  const [action, filename, flag] = args;
  if (!['plan', 'apply'].includes(action) || typeof filename !== 'string'
    || args.length !== (action === 'apply' ? 3 : 2) || action === 'apply' && flag !== APPLY_FLAG)
    throw Object.assign(Error('Usage: plan <private-plan> or apply <private-plan> --apply-reviewed-stage-recovery'), { code: 'VISUAL_RECOVERY_USAGE' });
  const bytes = await readFile(resolve(filename));
  if (bytes.length > 16_000) throw Error('Invalid recovery plan.');
  const input = JSON.parse(bytes.toString('utf8'));
  if (!['bindingHash,email,id,manifestHash,receiptHash,shots', 'bindingHash,email,id,manifestHash,receiptHash,shots,textCorrections']
    .includes(Object.keys(input).sort().join(','))) throw Error('Invalid recovery plan.');
  return service(input, { apply: action === 'apply' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVisualRecovery().then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'stopped', code: ['VISUAL_RECOVERY_USAGE', 'VISUAL_REVIEW_INVALID'].includes(error?.code)
      ? error.code : 'VISUAL_RECOVERY_REQUIRED', newVideoRequests: 0 }) + '\n'); process.exitCode = 1;
  });
}
