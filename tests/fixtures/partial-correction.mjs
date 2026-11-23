import assert from 'node:assert/strict';
import { digest, userPath } from '../../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../../api/_lib/access.mjs';
import { createFilmProductionService, fictionalOperatorProject } from '../../api/_lib/film-production.mjs';
import { createFalProductionAdapter, falPlan, falShotInput, SEEDANCE_RECIPE_VERSION } from '../../api/_lib/fal-production.mjs';
import { createFalClient, falRequestPath, FAL_MODELS } from '../../api/_lib/fal-client.mjs';
import { createFalFunding, FAL_FUNDING_PATH } from '../../api/_lib/fal-funding.mjs';
import { createPaidFilmCorrections, correctionIdForOrder } from '../../api/_lib/paid-film-correction.mjs';
import { buildPartialCorrectionManifest, partialCorrectionPreparedId } from '../../api/_lib/partial-film-correction.mjs';
import { testSeedanceQualification } from './seedance-qualification.mjs';

// Entirely synthetic, memory-only. These records must never be deployed.
export const sha = value => digest(JSON.stringify(value));
export async function partialFixture(options = {}) {
  let clock = Date.parse('2026-11-24T12:00:00Z'), serial = 0;
  const email = OWNER_EMAIL, actor = { email, role: 'owner' }, records = new Map(), writes = [], calls = [], verifications = [];
  const env = { FAL_BILLING_ACCOUNT: 'offline-partial-account', FAL_BILLING_KEY: 'offline-only' };
  const now = () => clock, seed = (path, value) => records.set(path, { value: structuredClone(value), etag: String(++serial) });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => { assert.equal(records.get(path)?.etag, etag); seed(path, value); writes.push(path); };
  const mutate = (path, fn) => { const value = structuredClone(records.get(path).value); fn(value); seed(path, value); };
  const jobPath = id => `production/jobs/${digest(email)}/${id}.json`;
  seed(userPath(email), actor);
  seed('production/worker-health.json', { version: 1, ready: true, model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION,
    workerProtocolVersion: 2, deliveryChecksVersion: 1, preRenderAuthorizationVersion: 1, partialCorrectionVersion: 1,
    checkedAt: new Date(clock).toISOString() });
  const media = new Map(), client = createFalClient({ read, write, now, key: 'offline-only', fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (init.method === 'POST') {
      if (options.lostSubmit) throw Error('Synthetic lost submit reply');
      const id = `offline-new-corrected-scene-${calls.filter(row => row.method === 'POST').length}`;
      return Response.json({ request_id: id, status_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${id}/status`,
        response_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${id}` });
    }
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED', request_id: url.split('/').at(-2) });
    if (options.retryModeration422 && url.endsWith('offline-new-corrected-scene-2'))
      return Response.json({ detail: [{ type: 'content_policy_violation', msg: 'Output video has sensitive content.', loc: ['body'] }] }, { status: 422 });
    if (options.narrationModeration422 && url.endsWith('offline-new-corrected-scene-3'))
      return Response.json({ detail: [{ type: 'content_policy_violation', msg: 'Output video has sensitive content.', loc: ['body'] }] }, { status: 422 });
    if (options.initialNewFailure && url.endsWith('offline-new-corrected-scene-1') || options.retryFailure)
      return Response.json({ detail: [{ type: 'downstream_service_error', msg: 'Downstream service error', loc: ['body'] }] }, { status: 500 });
    return Response.json({ video: { url: 'https://v3.fal.media/fictional-new.mp4', content_type: 'video/mp4', file_size: 128 } });
  } });
  const adapter = createFalProductionAdapter({ read, write, client, key: 'offline-only', now,
    qualification: testSeedanceQualification(), pricing: async () => ({ videoMicroUsdPerSecond: 1200000, referenceMicroUsd: 0,
      expiresAt: new Date(clock + 60000).toISOString() }),
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '128' } });
      return new Response(options.corruptMedia ? Buffer.from('wrong bytes') : media.get(url), { headers: { 'content-type': 'video/mp4' } });
    } });
  let service;
  const film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now, adapter,
    authorize: ({ email, id, manifestHash, authorizationReference }) => service.authorizeProduction({ email, preparedId: id, manifestHash, orderId: authorizationReference }) });
  const project = fictionalOperatorProject(); project.duration = 24;
  project.scenes = ['Plant', 'Water', 'Rest', 'Share'].map(title => ({ ...project.scenes[0], title,
    narration: 'The fictional sisters work together in their quiet garden.', visual: `Fictional garden: ${title.toLowerCase()} beside the path.` }));
  if (options.nineSecondScene) {
    project.duration = 30;
    project.scenes.forEach((scene, i) => { scene.narration = [
      'Fictional sisters work beside flowers.', 'The fictional sisters quietly tend their peaceful garden together.',
      'The fictional sisters slowly walk along the sunny garden path together.',
      'The fictional sisters slowly walk along the sunny garden path together.'][i]; });
  }
  const prepared = await film.prepare({ email, project, preparationConsent: true, idempotencyKey: 'offline-partial-original-001' });
  const source = (await read(jobPath(prepared.id))).value;
  assert.equal(source.shots.length, 4); assert.equal(source.provider.model, 'seedance');
  source.status = 'failed'; source.shots.forEach((shot, i) => { shot.status = i === 2 ? 'failed' : 'completed'; }); seed(jobPath(source.id), source);
  const orderId = digest(`${email}:production:${source.manifestHash}`), cost = (await adapter.validateManifest(source.manifest)).maximumCostCents;
  const order = { id: orderId, customerEmail: email, preparedId: source.id, manifestHash: source.manifestHash, filmId: source.filmId,
    status: 'captured', currency: 'USD', amountCents: cost * 1.5, providerCostCents: cost, markupCents: cost / 2, refundedCents: 0,
    checkoutMethod: 'quickbooks-hosted-invoice', provider: 'quickbooks', confirmationSource: 'quickbooks-accounting',
    quoteId: digest('synthetic-original-quote'), invoiceId: '701', customerId: '702', balanceCents: 0, paymentIds: ['703'],
    accountingPayments: [{ id: '703', allocatedCents: cost * 1.5 }], capturedAt: new Date(clock - 1000).toISOString(),
    accountingCheckedAt: new Date(clock - 1000).toISOString(), lastCheckStage: 'complete', lastCheckFailureReason: null,
    merchantBinding: { environment: 'production', realmId: '704', grantId: digest('synthetic-merchant') } };
  seed(`payments/orders/${orderId}.json`, order);
  const queuePath = `production/queue/${digest(email)}/${source.id}.json`;
  seed(queuePath, { version: 1, state: 'attention', email, id: source.id, orderId, manifestHash: source.manifestHash });
  const reservation = { orderId, ownerHash: digest(email), preparedId: source.id, manifestHash: source.manifestHash,
    quoteId: order.quoteId, maximumCostCents: cost, createdAt: new Date(clock).toISOString() };
  seed(FAL_FUNDING_PATH, { version: 1, account: env.FAL_BILLING_ACCOUNT, revision: 1, entries: [reservation] });
  const reuseEvidence = [], attempts = [], plan = falPlan(source.manifest, 'seedance');
  for (const [index, shot] of plan.shots.entries()) {
    const operationIdentity = digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${source.shots[index].requestKey}`);
    const inputHash = sha(falShotInput(source.manifest, shot, 'seedance', {})), url = `https://v3.fal.media/fictional-source-${index}.mp4`;
    const bytes = Buffer.alloc(128, index + 1); media.set(url, bytes);
    const operation = { version: 1, identity: operationIdentity, endpoint: FAL_MODELS.seedanceText, inputHash,
      state: index === 2 ? 'failed' : 'completed', requestId: `offline-source-${index}`, createdAt: new Date(clock - 1000).toISOString(),
      ...(index === 2 ? { failureCode: 'FAL_RENDER_FAILED' } : { result: { video: { url, content_type: 'video/mp4', file_size: bytes.length } } }) };
    seed(falRequestPath(operationIdentity), operation);
    attempts.push({ operationIdentity, requestId: operation.requestId, recordHash: sha(operation), costNanoUsd: index === 2 ? 0 : shot.seconds * 1200000000 });
    if (index !== 2) reuseEvidence.push({ shotId: shot.id, operationIdentity, requestId: operation.requestId, inputHash,
      sourceRecordHash: sha(operation), mediaSha256: digest(bytes), sizeBytes: bytes.length });
  }
  const billingEvidence = { version: 1, kind: 'owner-reviewed-provider-billing-v1', account: env.FAL_BILLING_ACCOUNT,
    originalOrderId: orderId, sourceManifestHash: source.manifestHash, observedAt: new Date(clock).toISOString(),
    approvedBy: email, completeAttemptHistory: true, evidenceSha256: digest('synthetic private evidence'), attempts };
  const visual = 'An entirely fictional quiet garden path beside flowering plants.', shotId = source.shots[2].id;
  const built = buildPartialCorrectionManifest(source.manifest, { shotId, visual });
  const targetId = partialCorrectionPreparedId(email, source.id, built.manifestHash);
  const funding = createFalFunding({ env, read, write, now, fetchImpl: () => assert.fail('Existing reservation verification must not request balance') });
  service = createPaidFilmCorrections({ env, read, write, now, verifyFunding: funding.verifyReservation,
    ...(options.verifyRetryFailure ? { verifyRetryFailure: options.verifyRetryFailure } : {}),
    ...(options.verifySuccessorFailure ? { verifySuccessorFailure: options.verifySuccessorFailure } : {}),
    ...(options.verifyContextFailure ? { verifyContextFailure: options.verifyContextFailure } : {}),
    reserveFunding: () => assert.fail('Partial correction must not reserve again'),
    verifyPaidSale: async input => {
      verifications.push(input); if (options.reversed) throw Error('Synthetic reversed payment');
      const record = await read(`payments/orders/${orderId}.json`);
      return { order: record.value, expiresAt: options.proofExpiry ?? new Date(clock + 60000).toISOString(),
        recheck: async () => { assert.equal((await read(`payments/orders/${orderId}.json`)).etag, record.etag); await options.onProofRecheck?.(); } };
    }, quoteProvider: async input => {
      const job = (await read(jobPath(input.preparedId))).value;
      const validation = await adapter.validateManifest(job.manifest), quote = await adapter.quote({ manifest: job.manifest, manifestHash: job.manifestHash });
      return { ...quote, preparedId: job.id, environment: 'production', maximumCostCents: validation.maximumCostCents,
        apiVerified: true, qualityVerified: true, commercialTermsVerified: true };
    } });
  const input = { actor, originalOrderId: orderId, preparedId: targetId, manifestHash: built.manifestHash, shotId, visual,
    maximumNewCostCents: plan.shots[2].seconds * 120, reuseEvidence, billingEvidence,
    reason: 'The owner approved this fictional visual-only scene change.', confirmed: true };
  return { records, read, write, seed, mutate, jobPath, queuePath, now, advance: ms => { clock += ms; }, options,
    actor, email, env, source, order, orderId, cost, input, targetId, built, film, adapter, client, service, writes, calls, media, verifications,
    approve: changes => service.approvePartial({ ...input, ...changes }),
    auth: () => service.authorizeProduction({ email, orderId: correctionIdForOrder(orderId), preparedId: targetId, manifestHash: built.manifestHash }) };
}
