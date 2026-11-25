import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { fixture as assembledFixture, decision, response as modelResponse } from './fixtures/assembled-review-recovery.mjs';
import { createFilmVisualReviewService } from '../api/_lib/film-visual-review.mjs';
import { verifyPublishedFilm } from '../scripts/production-worker.mjs';

const sha = value => digest(JSON.stringify(value)), secret = 'a'.repeat(64);
function fixture() {
  let clock = Date.parse('2026-12-01T12:00:00Z'), revision = 0;
  const now = () => clock, records = new Map(), calls = [], reads = [], limits = [], hooks = {};
  const email = 'fictional@example.invalid', id = '00000000-0000-4000-8000-000000000099';
  const jobPath = `production/jobs/${digest(email)}/${id}.json`, queuePath = `production/queue/${digest(email)}/${id}.json`;
  const priorPath = 'production/visual-reviews/fictional-prior.json';
  const manifestHash = digest('fictional manifest'), orderId = digest('fictional order');
  const job = { id, manifestHash, status: 'awaiting-assembly', provider: { recipe: SEEDANCE_RECIPE_VERSION },
    manifest: { productionPlan: { version: 1 } } };
  const queue = { id, email, orderId, manifestHash, state: 'attention' };
  const prior = { state: 'reviewed', evidence: 'fictional unavailable evidence' };
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: String(++revision) });
  seed(jobPath, job); seed(queuePath, queue); seed(priorPath, prior);
  const plan = { email, id, manifestHash, jobHash: sha(job), queueHash: sha(queue),
    priorBindingHash: digest('fictional prior binding'), priorReceiptHash: sha(prior) };
  const permission = { allowed: true, environment: 'production', manifestHash,
    expiresAt: new Date(clock + 60000).toISOString() };
  const read = async path => { reads.push(path); await hooks.read?.(path); return structuredClone(records.get(path) || null); };
  // Eligibility itself is covered by the real evidence-recovery service tests.
  // Here the injected inspector exercises transport, immutable snapshots and
  // live permission without allowing the route to mutate or infer.
  const handler = createProductionWorkerHandler({ env: { LINEAGE_WORKER_SECRET: secret }, read, now,
    limiter: async (...args) => { limits.push(args); return hooks.limit !== false; },
    assembledReviewRecoveryFactory: ({ read: trackedRead, write, authorize }) => async input => {
      assert.equal(typeof write, 'function'); assert.equal(typeof authorize, 'function');
      const [savedJob, savedQueue, savedPrior] = await Promise.all([trackedRead(jobPath), trackedRead(queuePath), trackedRead(priorPath)]);
      if (sha(savedJob?.value) !== input.jobHash || sha(savedQueue?.value) !== input.queueHash
        || sha(savedPrior?.value) !== input.priorReceiptHash) throw Object.assign(Error('Changed evidence'), { code: 'VISUAL_REVIEW_INVALID' });
      return { status: hooks.already ? 'already-resumed' : 'planned' };
    },
    paymentService: { authorizeProduction: async input => { calls.push(input); await hooks.authorize?.(); return structuredClone(permission); } },
    visualReviewFactory: () => assert.fail('Recovery authorization cannot infer'),
    startFrameReviewFactory: () => assert.fail('Recovery authorization cannot generate'),
    delivery: { deliver: () => assert.fail('Recovery authorization cannot deliver') } });
  const body = { action: 'authorize-assembled-visual-review-recovery', workerProtocol: 2, recoveryPlan: plan };
  const invoke = async (change = {}) => {
    const result = { statusCode: 200, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body, ...change }, result);
    return result;
  };
  return { records, calls, reads, limits, hooks, seed, jobPath, queuePath, priorPath, job, queue, prior,
    plan, permission, body, invoke, now, advance: value => { clock += value; } };
}

test('assembled review recovery authorization binds the exact stopped plan, rechecks all records and leaves every record unchanged', async () => {
  const f = fixture(), before = structuredClone([...f.records]);
  const response = await f.invoke();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ...f.permission, recoveryRequestHash: sha(f.plan) });
  assert.deepEqual(f.calls, [{ email: f.plan.email, preparedId: f.plan.id, manifestHash: f.plan.manifestHash, orderId: f.queue.orderId }]);
  assert.deepEqual(f.limits, [['production-worker:assembled-visual-review-recovery', 10, 60000]]);
  assert.deepEqual([...f.records], before);
  assert.equal(f.reads.filter(path => path === f.priorPath).length, 2);
});

test('unauthorized, malformed, expanded and rate-limited evidence requests stop before private reads', async () => {
  for (const change of [
    f => ({ headers: { authorization: 'Bearer invalid' } }),
    f => ({ body: { ...f.body, workerProtocol: 1 } }),
    f => ({ body: { ...f.body, apply: true } }),
    f => ({ body: { ...f.body, recoveryPlan: null } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.plan, orderId: f.queue.orderId } } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.plan, priorReceiptHash: 'untrusted' } } }),
    f => ({ body: { ...f.body, recoveryPlan: { ...f.plan, email: '../bad' } } }),
  ]) {
    const f = fixture(), result = await f.invoke(change(f));
    assert.ok([400, 401].includes(result.statusCode)); assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.hooks.limit = false;
  assert.equal((await f.invoke()).statusCode, 429); assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
});

test('a stale snapshot, active claim or already consumed recovery cannot obtain live permission', async () => {
  for (const change of [
    f => { f.body.recoveryPlan = { ...f.plan, jobHash: digest('other job') }; },
    f => { f.body.recoveryPlan = { ...f.plan, priorReceiptHash: digest('other receipt') }; },
    f => { const next = { ...f.queue, lease: { expiresAt: f.now() + 1000 } }; f.seed(f.queuePath, next); f.body.recoveryPlan = { ...f.plan, queueHash: sha(next) }; },
    f => { f.hooks.already = true; },
  ]) {
    const f = fixture(); change(f);
    assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.calls.length, 0);
  }
});

test('revocation, expiry or any changed validated record during live authorization prevents returning permission', async () => {
  for (const change of [
    f => { f.permission.allowed = false; },
    f => { f.permission.environment = 'sandbox'; },
    f => { f.permission.manifestHash = digest('foreign film'); },
    f => { f.permission.expiresAt = 'invalid'; },
    f => f.advance(60001),
    f => f.seed(f.jobPath, { ...f.job, status: 'completed' }),
    f => f.seed(f.queuePath, { ...f.queue, orderId: digest('other payment') }),
    f => f.seed(f.priorPath, { ...f.prior, evidence: 'changed evidence' }),
    f => f.seed(f.priorPath, f.prior),
  ]) {
    const f = fixture(); f.hooks.authorize = () => change(f);
    assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.calls.length, 1);
  }
});

test('a permission expiring during evidence readback is rejected without extending its expiry', async () => {
  const f = fixture(); let advanced = false;
  f.hooks.read = () => { if (f.calls.length && !advanced) { advanced = true; f.advance(60001); } };
  assert.equal((await f.invoke()).statusCode, 409); assert.equal(advanced, true); assert.equal(f.calls.length, 1);
});

test('the real assembled-review-recovery validator authorizes an exact paid v5 ending rejection read-only and cannot invoke review or bypass its prior receipt', async () => {
  const h = await assembledFixture(), calls = [], before = structuredClone([...h.records]), writes = h.writes.length;
  const permission = { allowed: true, environment: 'production', manifestHash: h.input.manifestHash,
    expiresAt: new Date(h.now() + 60000).toISOString() };
  const handler = createProductionWorkerHandler({ env: { LINEAGE_WORKER_SECRET: secret }, read: h.read, now: h.now,
    limiter: async () => true, list: h.listBlobs,
    paymentService: { authorizeProduction: async input => { calls.push(input); return permission; } },
    visualReviewFactory: () => assert.fail('Authorization cannot invoke a visual review'),
    startFrameReviewFactory: () => assert.fail('Authorization cannot generate a starting frame'),
    delivery: { deliver: () => assert.fail('Authorization cannot deliver a film') } });
  const body = { action: 'authorize-assembled-visual-review-recovery', workerProtocol: 2, recoveryPlan: h.input };
  const invoke = async value => {
    const result = { statusCode: 200, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: value }, result);
    return result;
  };
  const result = await invoke(body);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ...permission, recoveryRequestHash: sha(h.input) });
  assert.deepEqual(calls, [{ email: h.email, preparedId: h.input.id, manifestHash: h.input.manifestHash, orderId: h.order.id }]);
  assert.deepEqual([...h.records], before); assert.equal(h.writes.length, writes);
  assert.equal(h.value(h.queuePath).state, 'attention'); assert.equal(h.value(h.jobPath).assembledVisualReviewRecovery, undefined);
  assert.equal((await invoke({ ...body, action: 'review-film-visuals' })).statusCode, 400);
  assert.equal((await invoke({ ...body, recoveryPlan: { ...h.input, priorReceiptHash: digest('foreign receipt') } })).statusCode, 409);
  assert.equal(calls.length, 1); assert.deepEqual([...h.records], before); assert.equal(h.writes.length, writes);
});

test('v6 reviews only the composed ending, reuses the three original passes and verifies the exact published artifact', async () => {
  const h = await assembledFixture(); await h.apply(); let modelCalls = 0;
  const bytes = Buffer.from('0000ftypisomfinalfilm00000000000');
  h.assembledArtifact.sha256 = digest(bytes); h.assembledArtifact.sizeBytes = bytes.length;
  h.mutate(h.queuePath, value => { value.lease = { token: 'fictional-owned-assembly', expiresAt: h.now() + 60000 }; });
  const permission = { allowed: true, environment: 'production', manifestHash: h.input.manifestHash,
    expiresAt: new Date(h.now() + 60000).toISOString() };
  const handler = createProductionWorkerHandler({ env: { LINEAGE_WORKER_SECRET: secret, OPENAI_API_KEY: 'synthetic-only' },
    read: h.read, now: h.now, limiter: async () => true,
    paymentService: { authorizeProduction: async () => permission },
    visualReviewFactory: options => createFilmVisualReviewService({ ...options, write: h.write,
      fetchImpl: async () => { modelCalls++; return modelResponse(decision(9)); } }) });
  const bodyFor = index => { const input = h.reviewInput(index); return {
    action: 'review-film-visuals', workerProtocol: 2, email: h.email, preparedId: input.id,
    manifestHash: h.input.manifestHash, shotId: input.shotId, frames: input.frames,
    ...(input.assembledArtifact ? { assembledArtifact: input.assembledArtifact } : {}),
  }; };
  const invoke = async body => {
    const result = { statusCode: 200, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body }, result); return result;
  };
  const proofs = [];
  for (let index = 0; index < 4; index++) {
    const result = await invoke(bodyFor(index)); assert.equal(result.statusCode, 200);
    assert.equal(result.body.passed, true); proofs.push(result.body);
  }
  assert.deepEqual(proofs.map(value => value.reviewVersion), [4, 4, 4, 6]);
  assert.deepEqual(proofs[3].assembledArtifact, h.assembledArtifact); assert.equal(modelCalls, 1);
  const artifact = { ...h.assembledArtifact, manifestHash: h.input.manifestHash,
    pathname: `production/media/${digest(h.email)}/${h.input.id}/${h.assembledArtifact.sha256}.mp4`,
    contentType: 'video/mp4', technicalSample: false, playable: true, hasAudio: true, width: 1920, height: 1080, frameRate: 24,
    audioReview: { passed: true, source: 'seedance-native', verification: 'audio-decode-and-duration', transcriptVerified: false },
    visualReview: { version: 1, manifestHash: h.input.manifestHash, passed: true, shots: proofs } };
  const published = { email: h.email, id: h.input.id, manifestHash: h.input.manifestHash,
    manifest: h.value(h.jobPath).manifest, artifact };
  const getBlob = async () => ({ blob: { size: bytes.length, contentType: 'video/mp4' }, stream: new Response(bytes).body });
  assert.equal((await verifyPublishedFilm(published, { getBlob, read: h.read })).sha256, artifact.sha256);
  await assert.rejects(verifyPublishedFilm({ ...published, artifact: { ...artifact, durationSeconds: artifact.durationSeconds + 0.1 } }, { getBlob, read: h.read }));
  const ending = bodyFor(3), { assembledArtifact, ...withoutArtifact } = ending;
  for (const body of [withoutArtifact, { ...ending, shotId: bodyFor(0).shotId },
    { ...ending, assembledArtifact: { ...assembledArtifact, path: '/untrusted.mp4' } },
    { ...ending, assembledArtifact: { ...assembledArtifact, sha256: 'invalid' } }])
    assert.equal((await invoke(body)).statusCode, 400);
  assert.equal(modelCalls, 1);
});
