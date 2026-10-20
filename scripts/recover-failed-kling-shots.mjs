// Exact operator recovery only. Default invocation is read-only preparation.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest } from '../api/_lib/auth.mjs';
import { createFailedShotRecovery, parseRecoveryBilling } from '../api/_lib/fal-failed-shot-recovery.mjs';

try {
  const args = process.argv.slice(2), execute = args.includes('--execute');
  if (args[0] !== '--input' || !args[1] || args.length !== (execute ? 3 : 2) || execute && args[2] !== '--execute') throw Error();
  const bytes = await readFile(resolve(args[1])); if (bytes.length > 64 * 1024) throw Error();
  const value = JSON.parse(bytes.toString('utf8'));
  const allowed = ['email', 'preparedId', 'manifestHash', 'correctionId', 'failedRequests', 'billingAccount', 'billingEvidenceFile', 'billingEvidenceSha256', 'rejectionEvidenceFile', 'rejectionEvidenceSha256'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error();
  const billingBytes = await readFile(resolve(value.billingEvidenceFile)), rejectionBytes = await readFile(resolve(value.rejectionEvidenceFile));
  if (rejectionBytes.length > 10 * 1024 * 1024 || digest(rejectionBytes) !== value.rejectionEvidenceSha256) throw Error();
  const billing = parseRecoveryBilling(billingBytes, value.billingEvidenceSha256, value.billingAccount);
  const { email, preparedId, manifestHash, correctionId, failedRequests, rejectionEvidenceSha256 } = value;
  const result = await createFailedShotRecovery().run({ email, preparedId, manifestHash, correctionId, failedRequests, rejectionEvidenceSha256, billing }, { execute });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const stages = new Set(['input-validation', 'context', 'reconcile', 'claim', 'auth', 'submission', 'poll', 'resume']);
  process.stdout.write(`${JSON.stringify({ code: 'KLING_RECOVERY_UNVERIFIED', stage: stages.has(error?.stage) ? error.stage : 'input-validation',
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}), completed: false })}\n`);
  process.exitCode = 1;
}
