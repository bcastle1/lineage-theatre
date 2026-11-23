import assert from 'node:assert/strict';
import { retryFixture } from './partial-retry.mjs';
import { sha } from './partial-correction.mjs';
import { digest } from '../../api/_lib/auth.mjs';
import { falRequestPath } from '../../api/_lib/fal-client.mjs';
import { createProductionQueue, productionQueuePath } from '../../api/_lib/production-queue.mjs';
import { readPaidFilmCorrection } from '../../api/_lib/paid-film-correction.mjs';
import { buildNarrationSuccessorManifest, narrationSuccessorPreparedId, narrationSuccessorId,
  verifyNarrationPredecessorFailure } from '../../api/_lib/narration-successor.mjs';

// Synthetic memory-only predecessor and provider; no external transport.
export async function successorFixture(options = {}) {
  let h; const proofReads = [];
  h = await retryFixture({ ...options, retryModeration422: true, verifySuccessorFailure: async receipt => {
    await options.beforeSuccessorProof?.(h);
    return verifyNarrationPredecessorFailure(receipt, { key: 'offline-only', now: h.now, fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); proofReads.push(url);
      if (url.endsWith('/status')) return Response.json(options.successorProviderStatus ?? { status: 'COMPLETED', request_id: receipt.requestId });
      return Response.json(options.successorProviderBody ?? { detail: [{ type: 'content_policy_violation', loc: ['body'] }] },
        { status: options.successorProviderHttp ?? 422 });
    } });
  } });
  await h.approve(); await h.enqueue();
  for (let i = 0; i < 5; i++) { await h.run(); if ((await h.read(h.jobPath(h.targetId))).value.status === 'failed') break; }
  const parent = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: h.read, now: h.now });
  assert.equal(parent.job.status, 'failed'); assert.equal(parent.retry.pending, false);
  const failed = (await h.read(falRequestPath(parent.retry.grant.operationIdentity))).value;
  assert.equal(failed.failureCode, 'FAL_RENDER_FAILED');
  const narration = 'The fictional sisters quietly rest beside their garden flowers.';
  const built = buildNarrationSuccessorManifest(parent.job.manifest, { shotId: h.input.shotId, narration });
  const targetId = narrationSuccessorPreparedId(h.email, parent.job.id, built.manifestHash);
  const correctionId = narrationSuccessorId(parent.grant.id, built.manifestHash);
  h.mutate('production/worker-health.json', value => { value.narrationSuccessorVersion = 1; value.checkedAt = new Date(h.now()).toISOString(); });
  const input = { actor: h.actor, parentCorrectionId: parent.grant.id, preparedId: targetId, manifestHash: built.manifestHash,
    shotId: h.input.shotId, narration, failedOperationIdentity: failed.identity, failedRequestId: failed.requestId,
    failedRecordHash: sha(failed), maximumNewCostCents: 1080, reason: 'The owner approved this exact fictional narration revision.', confirmed: true,
    billingEvidence: { version: 1, kind: 'owner-reviewed-request-zero-charge-v1', basis: 'provider-request-billing-row',
      account: h.env.FAL_BILLING_ACCOUNT, operationIdentity: failed.identity, requestId: failed.requestId, recordHash: sha(failed),
      costNanoUsd: 0, quantity: 0, evidenceSha256: digest('synthetic exact request zero billing row'),
      observedAt: new Date(h.now()).toISOString(), approvedBy: h.email } };
  const queue = createProductionQueue({ read: h.read, write: h.write, now: h.now, film: h.film, paymentService: h.service });
  const targetQueuePath = productionQueuePath(h.email, targetId);
  return { ...h, parent, failed, input, built, targetId, correctionId, queue, targetQueuePath, successorProofReads: proofReads,
    approve: changes => h.service.approveNarrationSuccessor({ ...input, ...changes }),
    enqueue: () => queue.enqueue({ actor: h.actor, id: targetId, orderId: correctionId }),
    run: async () => { const result = await queue.runTicket(targetQueuePath); h.advance(11000); return result; } };
}
