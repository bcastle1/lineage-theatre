// Separate immutable sample identity; never renew or replay the older canary.
import { runKlingCanary } from './test-kling-production.mjs';
import { finishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
runKlingCanary(process.argv.slice(2), { quality: true }).catch(error => {
  const diagnostic = finishingFailure(error);
  console.log(JSON.stringify({ status: 'attention', code: /^CANARY_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'CANARY_OPERATION_FAILED',
    ...(diagnostic ? { finishing: diagnostic } : {}), automaticPaidRetry: false }));
  process.exitCode = 1;
});
