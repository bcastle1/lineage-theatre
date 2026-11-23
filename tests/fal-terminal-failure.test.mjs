import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { createFalClient, falRequestPath, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { createFalProductionAdapter } from '../api/_lib/fal-production.mjs';
import { createFilmProductionService, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { createProductionQueue, productionQueuePath } from '../api/_lib/production-queue.mjs';
import { testSeedanceQualification } from './fixtures/seedance-qualification.mjs';

const at = Date.parse('2026-11-24T12:00:00Z');
const requestId = 'offline-terminal-request';
const receipt = { request_id: requestId,
  status_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${requestId}/status`,
  response_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${requestId}` };
const request = { identity: digest('fictional-terminal-request'), endpoint: FAL_MODELS.seedanceText,
  input: { prompt: 'A fictional garden scene.' } };
const terminalBody = { detail: [{ type: 'downstream_service_error', msg: 'Downstream service error', loc: ['body'],
  input: 'PRIVATE_ECHO_MUST_NOT_BE_STORED', ctx: { trace: 'PRIVATE_TRACE_MUST_NOT_BE_STORED' } }] };

function memory() {
  const records = new Map(); let revision = 0;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    assert.equal(etag, records.get(path)?.etag, 'A changed record must defeat the stale conditional write');
    records.set(path, { value: structuredClone(value), etag: String(++revision) });
  };
  return { records, read, write };
}
function fixture(options = {}) {
  const store = memory(), calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    if (init.method === 'POST') return Response.json(receipt);
    if (url.endsWith('/status')) return Response.json(options.status ?? { status: 'COMPLETED', request_id: requestId },
      { status: options.statusHttp ?? 200 });
    if (options.result) return options.result(store);
    return Response.json(options.body ?? terminalBody, { status: options.resultHttp ?? 500 });
  };
  const deps = { ...store, fetchImpl, now: () => at, key: 'offline-fixture-only' };
  return { ...store, calls, deps, client: createFalClient(deps) };
}

test('an exact completed downstream500 becomes a durable fixed failure, preserving its one original request', async () => {
  const h = fixture(); await h.client.submit(request);
  const before = await h.read(falRequestPath(request.identity));
  const result = await h.client.poll(request.identity);
  assert.deepEqual(result, { ...before.value, state: 'failed', failureCode: 'FAL_DOWNSTREAM_SERVICE_FAILED', checkedAt: new Date(at).toISOString() });
  assert.deepEqual((await h.read(falRequestPath(request.identity))).value, result);
  assert.doesNotMatch(JSON.stringify([...h.records]), /PRIVATE_ECHO|PRIVATE_TRACE|downstream_service_error/);
  const restarted = createFalClient(h.deps);
  assert.deepEqual(await restarted.poll(request.identity), result);
  assert.deepEqual(await restarted.submit(request), result);
  assert.deepEqual(h.calls.map(call => call.method), ['POST', 'GET', 'GET']);
});

test('unknown result500, ambiguous status and transport errors retain the unresolved request without a new POST', async () => {
  const cases = [
    { body: { detail: 'Temporary gateway failure' } },
    { body: { detail: [{ ...terminalBody.detail[0], type: 'unknown_error' }] } },
    { body: { detail: [{ ...terminalBody.detail[0], loc: ['query'] }] } },
    { body: { detail: [{ ...terminalBody.detail[0], msg: 'Different failure' }] } },
    { body: { ...terminalBody, video: { url: 'https://v3.fal.media/ambiguous.mp4' } } },
    { resultHttp: 503 }, { status: { status: 'COMPLETED' } },
    { status: { status: 'COMPLETED', request_id: 'another-offline-request' } },
    { status: terminalBody, statusHttp: 500 },
    { result: () => { throw new DOMException('offline timeout', 'TimeoutError'); } },
    { result: () => new Response('not-json', { status: 500 }) },
    { result: () => new Response(' '.repeat(2_000_001), { status: 500 }) },
  ];
  for (const options of cases) {
    const h = fixture(options); await h.client.submit(request); const before = await h.read(falRequestPath(request.identity));
    await assert.rejects(h.client.poll(request.identity));
    assert.deepEqual(await h.read(falRequestPath(request.identity)), before);
    assert.equal((await h.client.submit(request)).state, 'queued');
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('failed-result persistence reconciles lost writes and honors a concurrent completed result', async () => {
  for (const mode of ['write-rejected', 'lost-reply', 'removed-record', 'completed-winner']) {
    const h = fixture(); await h.client.submit(request); const path = falRequestPath(request.identity), before = await h.read(path);
    const completed = { ...before.value, state: 'completed', result: { video: { url: 'https://v3.fal.media/offline.mp4' } } };
    const client = createFalClient({ ...h.deps, write: async (savedPath, value, etag) => {
      assert.equal(value.state, 'failed');
      if (mode === 'lost-reply') await h.write(savedPath, value, etag);
      if (mode === 'removed-record') h.records.delete(savedPath);
      if (mode === 'completed-winner') await h.write(savedPath, completed, etag);
      throw Error('offline conditional write interruption');
    } });
    if (mode === 'removed-record') await assert.rejects(client.poll(request.identity), { code: 'FAL_RECEIPT_UNCONFIRMED' });
    else {
      const result = await client.poll(request.identity);
      assert.deepEqual(result, (await h.read(path)).value, 'Never return an unpersisted terminal state');
      assert.equal(result.state, mode === 'lost-reply' ? 'failed' : mode === 'completed-winner' ? 'completed' : 'queued');
    }
    if (mode === 'write-rejected') assert.deepEqual(await h.read(path), before);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('the real fal adapter and production queue promptly expose terminal failure as attention without another render', async () => {
  const store = memory(), calls = [], email = 'customer@example.invalid'; let clock = at;
  const actor = { email, role: 'customer', status: 'active', approvedBy: 'owner@example.invalid', approvedAt: new Date(at - 1000).toISOString() };
  await store.write(userPath(email), actor);
  const client = createFalClient({ ...store, key: 'offline-only', now: () => clock, fetchImpl: async (url, init) => {
    calls.push({ method: init.method, url });
    if (init.method === 'POST') {
      const id = `offline-shot-${calls.length}`;
      return Response.json({ request_id: id, status_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${id}/status`,
        response_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${id}` });
    }
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED', request_id: url.split('/').at(-2) });
    return Response.json(terminalBody, { status: 500 });
  } });
  const adapter = createFalProductionAdapter({ ...store, client, key: 'offline-only', qualification: testSeedanceQualification(),
    now: () => clock, pricing: async () => ({ videoMicroUsdPerSecond: 1200000, referenceMicroUsd: 0, expiresAt: new Date(clock + 60000).toISOString() }),
    fetchImpl: () => assert.fail('Failed requests cannot fetch media') });
  const grant = async ({ manifestHash }) => ({ allowed: true, manifestHash, environment: 'production', fictionalOnly: false,
    budgetCents: 10000, quoteReference: 'offline-existing-allowance', expiresAt: new Date(clock + 60000).toISOString() });
  const film = createFilmProductionService({ readRecordImpl: store.read, writeRecordImpl: store.write, adapter, now: () => clock, authorize: grant });
  const queue = createProductionQueue({ ...store, film, now: () => clock, paymentService: { authorizeProduction: grant } });
  const job = await film.prepare({ email, project: fictionalOperatorProject(), preparationConsent: true, idempotencyKey: 'offline-terminal-film-001' });
  await queue.enqueue({ actor, id: job.id, orderId: digest('offline-order') });
  const path = productionQueuePath(email, job.id);
  for (let pass = 0; pass <= job.shotCount; pass++) {
    const outcome = await queue.runTicket(path); clock += 6000;
    assert.equal(outcome.state, pass === job.shotCount ? 'attention' : 'pending');
  }
  const status = await queue.status({ email, id: job.id });
  assert.equal(status.status, 'failed'); assert.equal(status.needsAttention, true); assert.equal(status.mediaReady, false);
  assert.equal(status.progress.stage, 'attention'); assert.equal(status.progress.timing, 'paused'); assert.equal(status.progress.percent, null);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_ECHO|PRIVATE_TRACE|downstream_service_error|queue\.fal\.run|refunded|free render/);
  const callsBefore = calls.length;
  await queue.enqueue({ actor, id: job.id, orderId: digest('offline-order') });
  assert.equal((await queue.runTicket(path)).state, 'skipped');
  await film.advance({ email, id: job.id }); assert.equal(calls.length, callsBefore);
});
