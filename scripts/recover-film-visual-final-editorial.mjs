// Plan-only by default. Applying authorizes one final-scene editorial review of a fixed clip
// while preserving the existing payment, rejected receipts and all source clips.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisualFinalEditorialRecovery } from '../api/_lib/film-visual-final-editorial-recovery.mjs';
import { createRemoteVisualFinalEditorialAuthorization } from '../api/_lib/remote-visual-final-editorial-authorization.mjs';

export const FINAL_EDITORIAL_APPLY_FLAG = '--apply-reviewed-final-editorial-recovery';
export async function runVisualFinalEditorialRecovery(args = process.argv.slice(2), service = createVisualFinalEditorialRecovery({
  authorize: createRemoteVisualFinalEditorialAuthorization(),
})) {
  const [action, filename, flag] = args.length === 1 ? ['plan', args[0]] : args;
  if (!['plan', 'apply'].includes(action) || typeof filename !== 'string'
    || !filename || (action === 'plan' ? ![1, 2].includes(args.length) : args.length !== 3 || flag !== FINAL_EDITORIAL_APPLY_FLAG))
    throw Object.assign(Error('Usage: [plan] <private-plan> or apply <private-plan> --apply-reviewed-final-editorial-recovery'), { code: 'VISUAL_FINAL_EDITORIAL_USAGE' });
  const bytes = await readFile(resolve(filename));
  if (bytes.length > 16_000) throw Error('Invalid final-scene editorial recovery plan.');
  const input = JSON.parse(bytes.toString('utf8'));
  if (!input || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'email,id,jobHash,manifestHash,originalAction,priorBindingHash,priorReceiptHash,queueHash,revisedAction')
    throw Error('Invalid final-scene editorial recovery plan.');
  return service(input, { apply: action === 'apply' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVisualFinalEditorialRecovery().then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'stopped', code: ['VISUAL_FINAL_EDITORIAL_USAGE', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED'].includes(error?.code)
      ? error.code : 'VISUAL_FINAL_EDITORIAL_RECOVERY_REQUIRED', newVideoRequests: 0 }) + '\n'); process.exitCode = 1;
  });
}
