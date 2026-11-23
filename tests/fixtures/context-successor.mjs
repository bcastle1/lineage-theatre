import assert from 'node:assert/strict';
import { successorFixture } from './narration-successor.mjs';
import { sha } from './partial-correction.mjs';
import { digest } from '../../api/_lib/auth.mjs';
import { falRequestPath } from '../../api/_lib/fal-client.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../../api/_lib/fal-production.mjs';
import { createProductionQueue, productionQueuePath } from '../../api/_lib/production-queue.mjs';
import { readPaidFilmCorrection } from '../../api/_lib/paid-film-correction.mjs';
import { buildContextSuccessorManifest, contextSuccessorPreparedId, contextSuccessorId } from '../../api/_lib/context-successor.mjs';
import { verifyNarrationPredecessorFailure } from '../../api/_lib/narration-successor.mjs';

// Entirely fictional records and synthetic GET/POST transports. No network.
export async function contextSuccessorFixture(options = {}) {
  let h; const proofReads = [];
  h = await successorFixture({ ...options, narrationModeration422: true, verifyContextFailure: async receipt => {
    await options.beforeContextProof?.(h);
    return verifyNarrationPredecessorFailure(receipt, { key: 'offline-only', now: h.now, fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); proofReads.push(url);
      if (url.endsWith('/status')) return Response.json(options.contextProviderStatus ?? { status: 'COMPLETED', request_id: receipt.requestId });
      return Response.json(options.contextProviderBody ?? { detail: [{ type: 'content_policy_violation', loc: ['body'] }] },
        { status: options.contextProviderHttp ?? 422 });
    } });
  } });
  await h.approve(); await h.enqueue();
  for (let i = 0; i < 8; i++) { await h.run(); if ((await h.read(h.jobPath(h.targetId))).value.status === 'failed') break; }
  const parent = await readPaidFilmCorrection({ email: h.email, correctionId: h.correctionId, read: h.read, now: h.now });
  assert.equal(parent.job.status, 'failed'); assert.equal(parent.grant.partial.version, 2);
  assert.equal(parent.job.shots.filter(row => row.status === 'completed').length, 3);
  const selected = parent.job.shots.find(row => row.id === h.input.shotId);
  const failed = (await h.read(falRequestPath(digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${selected.requestKey}`)))).value;
  assert.equal(failed.failureCode, 'FAL_RENDER_FAILED');
  const filmContext = 'A fictional family garden story about two adult sisters tending flowers.';
  const historicalBoundaries = 'Show only the approved quiet garden path. Do not invent meetings or events.';
  const built = buildContextSuccessorManifest(parent.job.manifest, { shotId: selected.id, filmContext, historicalBoundaries });
  const targetId = contextSuccessorPreparedId(h.email, parent.job.id, built.manifestHash);
  const correctionId = contextSuccessorId(parent.grant.id, built.manifestHash);
  h.mutate('production/worker-health.json', value => { value.sceneContextSuccessorVersion = 1; value.checkedAt = new Date(h.now()).toISOString(); });
  const input = { actor: h.actor, parentCorrectionId: parent.grant.id, preparedId: targetId, manifestHash: built.manifestHash,
    shotId: selected.id, filmContext, historicalBoundaries, failedOperationIdentity: failed.identity, failedRequestId: failed.requestId,
    failedRecordHash: sha(failed), maximumNewCostCents: 1080, reason: 'The owner approved these exact fictional scene instructions.', confirmed: true,
    billingEvidence: { version: 1, kind: 'owner-reviewed-request-zero-charge-v1', basis: 'provider-request-billing-row',
      account: h.env.FAL_BILLING_ACCOUNT, operationIdentity: failed.identity, requestId: failed.requestId, recordHash: sha(failed),
      costNanoUsd: 0, quantity: 0, evidenceSha256: digest('synthetic context predecessor zero billing row'),
      observedAt: new Date(h.now()).toISOString(), approvedBy: h.email } };
  const queue = createProductionQueue({ read: h.read, write: h.write, now: h.now, film: h.film, paymentService: h.service });
  const targetQueuePath = productionQueuePath(h.email, targetId);
  return { ...h, ancestors: [h.parent, parent], parent, failed, input, built, targetId, correctionId, queue, targetQueuePath, contextProofReads: proofReads,
    approve: changes => h.service.approveContextSuccessor({ ...input, ...changes }),
    enqueue: () => queue.enqueue({ actor: h.actor, id: targetId, orderId: correctionId }),
    run: async () => { const result = await queue.runTicket(targetQueuePath); h.advance(11000); return result; } };
}
