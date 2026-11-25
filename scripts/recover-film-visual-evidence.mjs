// Plan-only by default. Applying authorizes one evidence review of a fixed clip
// while preserving the existing payment, rejected receipts and all source clips.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisualEvidenceRecovery } from '../api/_lib/film-visual-evidence-recovery.mjs';
import { createRemoteVisualEvidenceAuthorization } from '../api/_lib/remote-visual-evidence-authorization.mjs';

export const EVIDENCE_APPLY_FLAG = '--apply-reviewed-evidence-recovery';
export async function runVisualEvidenceRecovery(args = process.argv.slice(2), service = createVisualEvidenceRecovery({
  authorize: createRemoteVisualEvidenceAuthorization(),
})) {
  const [action, filename, flag] = args.length === 1 ? ['plan', args[0]] : args;
  if (!['plan', 'apply'].includes(action) || typeof filename !== 'string'
    || !filename || (action === 'plan' ? ![1, 2].includes(args.length) : args.length !== 3 || flag !== EVIDENCE_APPLY_FLAG))
    throw Object.assign(Error('Usage: [plan] <private-plan> or apply <private-plan> --apply-reviewed-evidence-recovery'), { code: 'VISUAL_EVIDENCE_USAGE' });
  const bytes = await readFile(resolve(filename));
  if (bytes.length > 16_000) throw Error('Invalid evidence recovery plan.');
  const input = JSON.parse(bytes.toString('utf8'));
  if (!input || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'email,id,jobHash,manifestHash,priorBindingHash,priorReceiptHash,queueHash')
    throw Error('Invalid evidence recovery plan.');
  return service(input, { apply: action === 'apply' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVisualEvidenceRecovery().then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'stopped', code: ['VISUAL_EVIDENCE_USAGE', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED'].includes(error?.code)
      ? error.code : 'VISUAL_EVIDENCE_RECOVERY_REQUIRED', newVideoRequests: 0 }) + '\n'); process.exitCode = 1;
  });
}
