import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { FAL_MODELS, falRequestPath } from '../api/_lib/fal-client.mjs';
import { createFailedShotRecovery, failedShotRecoveryPath, parseRecoveryBilling, promptLengthRejection, verifyPromptRejectedReceipt } from '../api/_lib/fal-failed-shot-recovery.mjs';

const at = Date.parse('2026-10-20T20:00:00Z'), id = '11111111-1111-4111-8111-111111111111';
const sha = value => digest(JSON.stringify(value));
function fixture(options = {}) {
  let serial = 0, failQueue = options.failQueue, failClaim = options.failClaim;
  const records = new Map(), writes = [], submitted = [], polled = [], authorized = [];
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `v${++serial}` });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (path.includes('/queue/') && failQueue) throw Error('private storage failure');
    if (path.includes('/failed-shot-recoveries/') && failClaim) throw Error('private storage failure');
    const old = records.get(path); assert.equal(old?.etag, etag); writes.push(path); seed(path, value);
    if (options.lostReply) throw Error('private lost reply');
  };
  const manifest = { version: 1, filmId: id, title: 'Fictional recovery', era: 'Fictional era', style: 'Cinematic', targetDurationSeconds: 120,
    screenplay: { logline: 'A fictional garden.', characters: [], scenes: [] }, sources: [], sound: { musicRequested: false },
    shots: Array.from({ length: 12 }, (_, i) => ({ id: `scene-${i + 1}`, startMs: i * 10000, targetDurationMs: 10000,
      characterIds: [], visual: 'A fictional garden.', narration: 'The garden grows.', dialogue: '', dramatization: 'Fictional.' })) };
  const manifestHash = sha(manifest), correctionId = digest('fictional correction'), ownerHash = digest(OWNER_EMAIL);
  const jobPath = `production/jobs/${ownerHash}/${id}.json`, queuePath = `production/queue/${ownerHash}/${id}.json`;
  const identities = manifest.shots.map((_, i) => digest(`${FAL_RECIPE_VERSION}:kling:${digest(`fictional-${i}`)}`));
  const requestIds = manifest.shots.map((_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const makeOutput = i => ({ url: `https://v3.fal.media/fictional-${i}.mp4`, contentType: 'video/mp4', sizeBytes: 100, durationSeconds: 10 });
  const job = { id, ownerHash, mode: 'customer', status: 'failed', manifestHash, manifest, revision: 1,
    provider: { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION }, authorization: { correctionId, manifestHash, budgetCents: 1980, quoteReference: 'fictional-quote' },
    shots: manifest.shots.map((shot, i) => ({ id: shot.id, requestKey: digest(`fictional-${i}`), providerJobId: `fal-${identities[i]}`,
      status: i < 8 ? 'completed' : i === 10 ? 'failed' : 'processing', ...(i < 8 ? { output: makeOutput(i), completedAt: new Date(at - 1000).toISOString() } : {}) })) };
  seed(userPath(OWNER_EMAIL), { email: OWNER_EMAIL, role: 'owner' }); seed(jobPath, job);
  seed(queuePath, { id, email: OWNER_EMAIL, orderId: correctionId, manifestHash, state: 'attention', attempts: 9 });
  for (let i = 0; i < 12; i++) seed(falRequestPath(identities[i]), { version: 1, identity: identities[i], endpoint: FAL_MODELS.kling,
    inputHash: digest(`old-body-${i}`), requestId: requestIds[i], state: i < 8 ? 'completed' : i === 10 ? 'failed' : 'queued',
    ...(i === 10 ? { failureCode: 'FAL_RENDER_FAILED' } : {}), ...(i < 8 ? { result: { video: { url: makeOutput(i).url } } } : {}) });
  const input = { email: OWNER_EMAIL, preparedId: id, manifestHash, correctionId, failedRequests: [10, 11].map(i => ({ shotIndex: i + 1, requestId: requestIds[i] })),
    rejectionEvidenceSha256: digest('fictional rejection evidence'), billing: { sha256: digest('fictional billing evidence'), observedAt: new Date(at - 1000).toISOString(),
      rows: requestIds.map((requestId, i) => ({ requestId, quantity: i < 10 ? 10 : 0, amountCents: i < 10 ? 140 : 0 })) } };
  const grant = { preparedId: id, manifestHash, maximumCostCents: 1980, originalOrderId: digest('fictional original order'), quote: { maximumCostCents: 1980 } };
  const client = {
    get: async identity => (await read(falRequestPath(identity)))?.value,
    poll: async identity => { polled.push(identity); const r = (await read(falRequestPath(identity))).value, i = identities.indexOf(identity);
      if (i >= 10) { r.state = 'failed'; r.failureCode = 'FAL_RENDER_FAILED'; }
      else { r.state = 'completed'; r.result = { video: { url: i < 0 ? `https://v3.fal.media/${identity}.mp4` : makeOutput(i).url } }; }
      seed(falRequestPath(identity), r); return r; },
    submit: async request => { submitted.push(request); assert.equal(await read(falRequestPath(request.identity)), null);
      const r = { version: 1, identity: request.identity, endpoint: request.endpoint, inputHash: sha(request.input),
        state: options.uncertain ? 'uncertain' : 'queued', ...(options.uncertain ? {} : { requestId: `replacement-${submitted.length}` }) };
      seed(falRequestPath(request.identity), r); if (options.submitLostReply) throw Error('lost submit reply'); return r; }
  };
  const authorize = async request => { authorized.push(request); const claim = (await read(failedShotRecoveryPath(request.recoveryId))).value;
    options.authEffect?.({ seed, records, jobPath, queuePath });
    return { ...request, allowed: true, environment: 'production', originalOrderId: grant.originalOrderId, quoteReference: 'fictional-quote', budgetCents: 1980,
      inputHash: claim.inputHash, replacementMaximumCents: claim.replacementMaximumCents, totalReplacementMaximumCents: claim.totalReplacementMaximumCents,
      expiresAt: new Date(at + 60000).toISOString(), ...options.authorization }; };
  const service = createFailedShotRecovery({ read, write, now: () => at, client, authorize,
    correctionContext: async () => ({ grant, recheck: async () => {} }), verifyRejected: async () => { if (options.notRejected) throw Error('not rejected'); return true; },
    buildInput: async (_, shot) => ({ prompt: 'The exact fictional garden narration.', duration: String(shot.seconds), generate_audio: true, image_urls: [] }),
    fetchImpl: async (_, request) => { assert.equal(request.method, 'HEAD'); return new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '100' } }); } });
  return { service, input, records, read, seed, jobPath, queuePath, job, grant, writes, submitted, polled, authorized, identities,
    allowQueue: () => { failQueue = false; }, allowClaim: () => { failClaim = false; } };
}

test('readiness verifies the exact evidence without writes, provider submissions or polling', async () => {
  const h = fixture(), r = await h.service.run(h.input);
  assert.equal(r.status, 'ready-for-explicit-recovery'); assert.equal(r.priorSpendCents, 1400); assert.equal(r.replacementMaximumCents, 300);
  assert.equal(h.writes.length, 0); assert.equal(h.submitted.length, 0); assert.equal(h.polled.length, 0);
});
test('only rejected shots submit once; queued originals reconcile first; all12 resume without changing the first8 clips or script', async () => {
  const h = fixture(), original = structuredClone(h.job);
  const first = await h.service.run(h.input, { execute: true });
  assert.equal(first.status, 'replacement-pending'); assert.equal(h.submitted.length, 2); assert.ok(h.polled.includes(h.identities[11]));
  assert.equal(h.authorized.length, 2);
  const second = await h.service.run(h.input, { execute: true }); assert.equal(second.status, 'awaiting-assembly'); assert.equal(h.submitted.length, 2);
  const saved = (await h.read(h.jobPath)).value;
  assert.deepEqual(saved.manifest, original.manifest); assert.deepEqual(saved.shots.slice(0, 8), original.shots.slice(0, 8));
  assert.deepEqual(saved.shots.map(s => s.requestKey), original.shots.map(s => s.requestKey)); assert.equal(saved.shots.filter(s => s.status === 'completed').length, 12);
  assert.equal((await h.read(h.queuePath)).value.state, 'pending'); assert.ok(h.writes.every(path => path.startsWith('production/')));
});
test('unknown submission outcome remains held and never authorizes another POST', async () => {
  const h = fixture({ uncertain: true }); await h.service.run(h.input, { execute: true }); await h.service.run(h.input, { execute: true });
  assert.equal(h.submitted.length, 2); assert.equal(h.authorized.length, 2); assert.equal((await h.read(h.jobPath)).value.status, 'failed');
});
test('lost POST reply reconciles the saved replacement without spending again', async () => {
  const h = fixture({ submitLostReply: true }); await assert.rejects(h.service.run(h.input, { execute: true }));
  assert.equal(h.submitted.length, 1); await assert.rejects(h.service.run(h.input, { execute: true })); assert.equal(h.submitted.length, 2);
  await h.service.run(h.input, { execute: true }); assert.equal(h.submitted.length, 2);
});
test('failed immutable claim, mismatched grant and changed queue prevent generation', async () => {
  for (const options of [{ failClaim: true }, { authorization: { inputHash: digest('different') } }, { notRejected: true },
    { authEffect: ({ seed, records, queuePath }) => seed(queuePath, { ...records.get(queuePath).value, state: 'pending' }) }]) {
    const h = fixture(options); await assert.rejects(h.service.run(h.input, { execute: true })); assert.equal(h.submitted.length, 0);
  }
});
test('stale zero billing for successful clips, wrong request IDs, uncertain originals and excess budget fail closed', async () => {
  for (const change of [h => { h.input.billing.rows[0].quantity = 0; h.input.billing.rows[0].amountCents = 0; },
    h => { h.input.failedRequests[0].requestId = 'different-request'; },
    h => { const p = falRequestPath(h.identities[10]); h.seed(p, { ...h.records.get(p).value, state: 'uncertain' }); },
    h => { h.grant.maximumCostCents = 1699; h.grant.quote.maximumCostCents = 1699;
      h.seed(h.jobPath, { ...h.job, authorization: { ...h.job.authorization, budgetCents: 1699 } }); },
    h => { h.input.failedRequests = [{ shotIndex: 1, requestId: h.input.billing.rows[0].requestId }]; }]) {
    const h = fixture(); change(h); await assert.rejects(h.service.run(h.input, { execute: true })); assert.equal(h.submitted.length, 0);
  }
});
test('queue-write failure resumes the already-verified job on exact retry without more requests', async () => {
  const h = fixture({ failQueue: true }); await h.service.run(h.input, { execute: true });
  await assert.rejects(h.service.run(h.input, { execute: true })); assert.equal((await h.read(h.jobPath)).value.status, 'awaiting-assembly');
  h.allowQueue(); await h.service.run(h.input, { execute: true }); assert.equal((await h.read(h.queuePath)).value.state, 'pending'); assert.equal(h.submitted.length, 2);
});
test('billing receipt parser pins bytes, account, exact price and amounts without accepting an earlier zero-cost successful row', () => {
  const source = { account: 'fictional-account', endpoint: FAL_MODELS.kling, observedAt: new Date(at).toISOString(),
    rows: Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}date Product10.00$0.14$1.40`) };
  const bytes = Buffer.from(JSON.stringify(source)); assert.equal(parseRecoveryBilling(bytes, digest(bytes), 'fictional-account').rows.length, 12);
  assert.throws(() => parseRecoveryBilling(bytes, digest(bytes), 'different-account'));
  assert.throws(() => parseRecoveryBilling(bytes, digest('different'), 'fictional-account'));
  source.rows[0] = source.rows[0].replace('$1.40', '$0.00'); const changed = Buffer.from(JSON.stringify(source));
  assert.throws(() => parseRecoveryBilling(changed, digest(changed), 'fictional-account'));
});
test('terminal proof accepts only GET-bound prompt-length422, never a processing task or unrelated error', async () => {
  assert.equal(promptLengthRejection({ detail: [{ loc: ['body', 'prompt'], msg: 'size must be between 0 and 2500' }] }), true);
  assert.equal(promptLengthRejection({ detail: [{ loc: ['body', 'image'], msg: 'size must be between 0 and 2500' }] }), false);
  const receipt = { state: 'failed', failureCode: 'FAL_RENDER_FAILED', endpoint: FAL_MODELS.kling, requestId: 'fictional-request',
    statusUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/fictional-request/status', responseUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/fictional-request' };
  const calls = [];
  await verifyPromptRejectedReceipt(receipt, { key: 'fixture-key', fetchImpl: async (url, request) => { calls.push(request.method);
    return url.endsWith('/status') ? Response.json({ status: 'COMPLETED' }) : Response.json({ detail: 'prompt: size must be between 0 and 2500' }, { status: 422 }); } });
  assert.deepEqual(calls, ['GET', 'GET']);
  await assert.rejects(verifyPromptRejectedReceipt(receipt, { key: 'fixture-key', fetchImpl: async () => Response.json({ status: 'IN_PROGRESS' }) }));
  await assert.rejects(verifyPromptRejectedReceipt(receipt, { key: 'fixture-key', fetchImpl: async () => new Response(null, { status: 401 }) }),
    error => error.code === 'KLING_RECOVERY_UNVERIFIED' && error.httpStatus === 401);
});
