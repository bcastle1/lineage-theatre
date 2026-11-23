import assert from 'node:assert/strict';
import { partialFixture, sha } from './partial-correction.mjs';
import { digest } from '../../api/_lib/auth.mjs';
import { correctionIdForOrder } from '../../api/_lib/paid-film-correction.mjs';
import { createProductionQueue, productionQueuePath } from '../../api/_lib/production-queue.mjs';
import { falRequestPath } from '../../api/_lib/fal-client.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../../api/_lib/fal-production.mjs';
import { verifyPartialRetryFailure } from '../../api/_lib/partial-correction-retry.mjs';

// Actual production modules, entirely synthetic records and transports.
export async function retryFixture(options = {}) {
  let h;
  const proofReads = [];
  const settings = { nineSecondScene: true, initialNewFailure: true, ...options,
    verifyRetryFailure: async receipt => {
      await options.beforeProof?.(h);
      return verifyPartialRetryFailure(receipt, { key: 'offline-only', now: () => h.now(), fetchImpl: async (url, init) => {
        assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); proofReads.push(url);
        if (url.endsWith('/status')) return Response.json(options.providerStatus ?? { status: 'COMPLETED', request_id: receipt.requestId });
        return Response.json(options.providerBody ?? { detail: [{ type: 'downstream_service_error', msg: 'Downstream service error', loc: ['body'] }] },
          { status: options.providerHttp ?? 500 });
      } });
    } };
  h = await partialFixture(settings); await h.approve();
  const correctionId = correctionIdForOrder(h.orderId);
  const queue = createProductionQueue({ read: h.read, write: h.write, now: h.now, film: h.film, paymentService: h.service });
  await queue.enqueue({ actor: h.actor, id: h.targetId, orderId: correctionId });
  const path = productionQueuePath(h.email, h.targetId);
  for (let pass = 0; pass < 8; pass++) {
    await queue.runTicket(path); h.advance(11000);
    if ((await h.read(h.jobPath(h.targetId))).value.status === 'failed') break;
  }
  const job = (await h.read(h.jobPath(h.targetId))).value;
  assert.equal(job.status, 'failed'); assert.equal(job.shots.filter(row => row.status === 'completed').length, 3);
  job.shots.filter(row => row.status === 'completed').forEach(row => assert.match(row.output.sha256, /^[a-f0-9]{64}$/));
  const selected = job.shots.find(row => row.id === h.input.shotId);
  const failedOperationIdentity = digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${selected.requestKey}`);
  const failed = (await h.read(falRequestPath(failedOperationIdentity))).value;
  assert.equal(failed.failureCode, 'FAL_DOWNSTREAM_SERVICE_FAILED');
  h.mutate('production/worker-health.json', health => { health.partialCorrectionRetryVersion = 1; health.checkedAt = new Date(h.now()).toISOString(); });
  const input = { actor: h.actor, correctionId, preparedId: h.targetId, manifestHash: job.manifestHash, shotId: selected.id,
    failedOperationIdentity, failedRequestId: failed.requestId, failedRecordHash: sha(failed), maximumNewCostCents: 1080,
    reason: 'The owner approved one unchanged fictional scene retry after a confirmed server failure.', confirmed: true,
    billingEvidence: { version: 1, kind: 'owner-reviewed-zero-charge-v1', basis: 'provider-terminal500-nonbilling-policy',
      policyUrl: 'https://fal.ai/docs/documentation/model-apis/pricing', account: h.env.FAL_BILLING_ACCOUNT,
      operationIdentity: failedOperationIdentity, requestId: failed.requestId, recordHash: sha(failed), costNanoUsd: 0,
      evidenceSha256: digest('synthetic provider and policy evidence'), observedAt: new Date(h.now()).toISOString(), approvedBy: h.email } };
  return { ...h, input, job, failed, correctionId, queue, targetQueuePath: path, proofReads, settings,
    approve: changes => h.service.approvePartialRetry({ ...input, ...changes }),
    enqueue: () => queue.enqueue({ actor: h.actor, id: h.targetId, orderId: correctionId }),
    run: async () => { const result = await queue.runTicket(path); h.advance(11000); return result; } };
}
