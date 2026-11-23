import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { createFilmProductionService } from '../api/_lib/film-production.mjs';
import { createFalProductionAdapter } from '../api/_lib/fal-production.mjs';
import { testSeedanceQualification } from './fixtures/seedance-qualification.mjs';
import { createFalClient, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-qualification.mjs';
import { seedanceCanaryProfile, seedanceCanaryIdentity } from '../api/_lib/seedance-operator-canary.mjs';
import { EXECUTE_FLAG, seedanceCanaryOperationBounds, seedanceCanaryFundingInput, createGuardedSeedanceCanaryClient,
  createBoundedSeedanceCanaryReview, createSeedanceCanaryFunding } from '../scripts/test-seedance-production.mjs';

const email = 'erik@brocotech.ai', { ownerHash, id } = seedanceCanaryIdentity(email);
const { runKey, fixedHash, manifest, summary } = seedanceCanaryProfile();
const now = Date.parse('2026-11-22T20:00:00Z');
const rates = () => ({ videoMicroUsdPerSecond: 1_200_000, referenceMicroUsd: 0, expiresAt: new Date(now + 60_000).toISOString() });
const grant = () => ({ version: 1, kind: summary.kind, runKey, ownerHash, preparedId: id, manifestHash: fixedHash,
  recipe: SEEDANCE_RECIPE_VERSION, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
  maximumCostCents: 1920, maximumVideoRequests: 3, maximumReferenceRequests: 0,
  maximumVisualReviewRequests: 3, maximumStartFrameReviews: 0, videoMicroUsdPerSecond: 1_200_000,
  referenceMicroUsd: 0, quotedCostCents: 1920, quoteReference: digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${fixedHash}:1200000:0`),
  approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() });
function memory() {
  const records = new Map(), writes = []; let revision = 0;
  return { records, writes,
    read: async path => records.has(path) ? structuredClone(records.get(path)) : null,
    write: async (path, value, etag) => {
      assert.equal(etag, records.get(path)?.etag, `Conditional write required: ${path}`);
      writes.push(path); const result = { value: structuredClone(value), etag: String(++revision) };
      records.set(path, result); return { etag: result.etag };
    },
    listBlobs: async ({ prefix }) => ({ blobs: [...records.keys()].filter(path => path.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false }),
  };
}
function guarded(options = {}) {
  const store = memory(), calls = [], fundingCalls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (options.method === 'POST') {
      const requestId = `fixture-request-${calls.length}`;
      return Response.json({ request_id: requestId, status_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${requestId}/status`,
        response_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${requestId}` });
    }
    return Response.json({ status: 'IN_PROGRESS' });
  };
  const raw = createFalClient({ ...store, key: () => 'fixture-only', fetchImpl, now: () => now, submissionEndpoints: [FAL_MODELS.seedanceText] });
  const client = createGuardedSeedanceCanaryClient({ email, now: () => now, grantContext: async () => ({ grant: grant() }),
    client: raw, pricing: async () => rates(), funding: { reserve: async input => fundingCalls.push(input) }, ...options });
  return { ...store, calls, fundingCalls, client };
}
const requests = [...seedanceCanaryOperationBounds(id)].map(([identity, bound]) => ({ identity, endpoint: bound.endpoint, input: structuredClone(bound.input) }));

test('offline planning pins the fictional plan, exact three native-audio clips and separate review cost', () => {
  const script = fileURLToPath(new URL('../scripts/test-seedance-production.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'plan'], { encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test' } });
  assert.equal(result.status, 0, result.stderr); const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'offline-plan'); assert.equal(plan.maximumCostCents, 1920);
  assert.equal(plan.manifestHash, fixedHash); assert.equal(plan.invoiceCreated, false); assert.equal(plan.customerPaymentCreated, false);
  assert.equal(plan.customerCheckoutVerified, false); assert.match(plan.costScope, /three GPT-6.2 Astra/);
  assert.deepEqual(requests.map(request => request.input.duration), ['6', '5', '5']);
  for (const request of requests) {
    assert.equal(request.endpoint, FAL_MODELS.seedanceText); assert.equal(request.input.generate_audio, true);
    assert.equal(request.input.resolution, '1080p'); assert.equal(request.input.codec, 'H264');
    assert.equal(request.input.image_urls, undefined);
  }
});

test('all mutating commands require the exact independent 1920-cent approval switch', () => {
  const script = fileURLToPath(new URL('../scripts/test-seedance-production.mjs', import.meta.url));
  for (const action of ['prepare', 'step', 'advance', 'finish']) for (const args of [[action], [action, '--execute-approved-300-cents'], [action, EXECUTE_FLAG, 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test' } });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, 'CANARY_USAGE');
  }
});

test('only three exact durable video identities submit and each checks shared funding first', async () => {
  const h = guarded();
  for (const request of requests) await h.client.submit(request);
  assert.equal(h.calls.length, 3); assert.equal(h.fundingCalls.length, 3);
  assert.ok(h.fundingCalls.every(input => same(input, seedanceCanaryFundingInput(email))));
  for (const request of requests) await h.client.submit(request);
  assert.equal(h.calls.length, 3, 'Existing durable receipts cannot create another fal POST');
  assert.equal(h.fundingCalls.length, 3);
  for (const changed of [{ ...requests[0], identity: 'f'.repeat(64) }, { ...requests[0], endpoint: FAL_MODELS.seedance },
    { ...requests[0], input: { ...requests[0].input, prompt: 'changed story' } }, { ...requests[0], input: { ...requests[0].input, generate_audio: false } }])
    await assert.rejects(h.client.submit(changed), { code: 'CANARY_OPERATION_OUTSIDE_BUDGET' });
  assert.equal(h.calls.length, 3); assert.ok(h.writes.every(path => path.startsWith('production/fal/requests/')));
});
function same(a, b) { return digest(JSON.stringify(a)) === digest(JSON.stringify(b)); }

test('new work stops on price, funding or changed grant while polling existing work needs no balance', async () => {
  for (const options of [
    { pricing: async () => ({ ...rates(), videoMicroUsdPerSecond: 1_200_001 }) },
    { funding: { reserve: async () => { throw new Error('insufficient'); } } },
    { grantContext: async () => ({ grant: { ...grant(), maximumVideoRequests: 4 } }) },
  ]) {
    const h = guarded(options); await assert.rejects(h.client.submit(requests[0])); assert.equal(h.calls.length, 0);
  }
  let reads = 0;
  const h = guarded({ grantContext: async () => ({ grant: { ...grant(), ...(++reads > 1 ? { approvedAt: new Date(now - 2000).toISOString() } : {}) } }) });
  await assert.rejects(h.client.submit(requests[0]), { code: 'CANARY_GRANT_BINDING_CHANGED' }); assert.equal(h.calls.length, 0);
  let reserveAllowed = true;
  const pollable = guarded({ funding: { reserve: async () => { assert.equal(reserveAllowed, true); } } });
  await pollable.client.submit(requests[0]); reserveAllowed = false;
  assert.equal((await pollable.client.poll(requests[0].identity)).state, 'processing');
  assert.equal(pollable.calls.at(-1).method, 'GET');
});

test('uncertain fal claims stop subsequent paid work and never trigger a retry', async () => {
  const store = memory(); let posts = 0;
  const raw = createFalClient({ ...store, key: () => 'fixture-only', now: () => now,
    fetchImpl: async () => { posts++; throw new Error('lost response'); } });
  const client = createGuardedSeedanceCanaryClient({ email, now: () => now, grantContext: async () => ({ grant: grant() }),
    client: raw, pricing: async () => rates(), funding: { reserve: async () => {} } });
  assert.equal((await client.submit(requests[0])).state, 'uncertain');
  assert.equal((await client.submit(requests[0])).state, 'uncertain');
  await assert.rejects(client.submit(requests[1]), { code: 'CANARY_RECONCILIATION_REQUIRED' });
  await assert.rejects(client.poll(requests[0].identity), { code: 'CANARY_RECONCILIATION_REQUIRED' });
  assert.equal(posts, 1);
});

test('the real fixed operator plan advances all three guarded Seedance shots without a customer order', async () => {
  const store = memory(), actor = { email, role: 'owner', status: 'active', mustChangePassword: false };
  await store.write(userPath(email), actor);
  await store.write('production/worker-health.json', { ready: true, model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION,
    workerProtocol: 2, referencePhotoVersion: 1, deliveryChecksVersion: 1, visualChecksVersion: 1, checkedAt: new Date(now).toISOString() });
  let posts = 0, reserves = 0, metadataReads = 0;
  const raw = createFalClient({ ...store, key: () => 'fixture-only', now: () => now,
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') {
        const requestId = `fixture-request-${++posts}`;
        assert.equal(url, `https://queue.fal.run/${FAL_MODELS.seedanceText}`);
        return Response.json({ request_id: requestId, status_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${requestId}/status`,
          response_url: `https://queue.fal.run/bytedance/seedance-2.5/requests/${requestId}` });
      }
      return Response.json(url.endsWith('/status') ? { status: 'COMPLETED' } : { video: { url: 'https://v3.fal.media/fixture-only.mp4' } });
    } });
  const client = createGuardedSeedanceCanaryClient({ email, client: raw, now: () => now,
    grantContext: async () => ({ grant: grant() }), pricing: async () => rates(),
    funding: { reserve: async () => { assert.ok(posts < 3, 'Polling completed work cannot recheck spent funding'); reserves++; } } });
  const adapter = createFalProductionAdapter({ model: 'seedance', requireWorker: true, key: () => 'fixture-only', client,
    qualification: testSeedanceQualification(), read: store.read, pricing: async () => rates(), now: () => now,
    fetchImpl: async (_url, options) => { assert.equal(options.method, 'HEAD'); metadataReads++; return new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '100' } }); } });
  const film = createFilmProductionService({ adapter, readRecordImpl: store.read, writeRecordImpl: store.write, now: () => now,
    authorize: async input => {
      assert.equal(input.mode, 'operator-test'); assert.equal(input.id, id); assert.equal(input.manifestHash, fixedHash);
      return { allowed: true, fictionalOnly: true, manifestHash: fixedHash, environment: 'production', budgetCents: 1920,
        quoteReference: grant().quoteReference, expiresAt: grant().expiresAt };
    } });
  const prepared = await film.prepareOperatorTest({ actor, idempotencyKey: runKey });
  assert.equal(prepared.id, id); assert.equal(prepared.manifestHash, fixedHash);
  let status;
  for (let attempt = 0; attempt < 10; attempt++) {
    status = await film.advance({ email, id, actor, authorizationReference: 'fixture-grant' });
    if (status.completedShots === 3) break;
  }
  assert.equal((await film.getPrepared({ email, id })).status, 'awaiting-assembly');
  assert.equal(status.status, 'processing', 'The customer summary does not expose internal assembly state');
  assert.equal(status.completedShots, 3);
  assert.equal(posts, 3); assert.equal(reserves, 3); assert.equal(metadataReads, 3);
  assert.ok([...store.records.keys()].every(path => !path.startsWith('payments/')));
});

test('operator funding uses the shared ledger without writing customer orders or releasing uncertain holds', async () => {
  const store = memory(), input = seedanceCanaryFundingInput(email);
  const env = { FAL_BILLING_KEY: 'fixture-read-only', FAL_BILLING_ACCOUNT: 'fixture-account' };
  let balance = 30;
  const funding = createSeedanceCanaryFunding({ ...store, env, now: () => now,
    fetchImpl: async () => Response.json({ username: env.FAL_BILLING_ACCOUNT, credits: { currency: 'USD', current_balance: balance } }) });
  await funding.reserve(input);
  assert.deepEqual(store.writes, [FAL_FUNDING_PATH]);
  assert.equal(store.records.get(FAL_FUNDING_PATH).value.entries[0].maximumCostCents, 1920);
  assert.equal(store.records.has(`payments/orders/${input.orderId}.json`), false);
  balance = 1; await assert.rejects(funding.reserve(input));
  assert.equal(store.records.get(FAL_FUNDING_PATH).value.entries.length, 1, 'Failed recheck retains the full commitment');
  const expiredId = 'a'.repeat(64);
  await store.write(`payments/orders/${expiredId}.json`, { id: expiredId, customerEmail: email, preparedId: '00000000-0000-4000-8000-000000000001',
    manifestHash: 'c'.repeat(64), quoteId: 'd'.repeat(64), providerCostCents: 100, status: 'uncertain', currency: 'USD',
    checkoutMethod: 'quickbooks-hosted-invoice', merchantBinding: { environment: 'production' }, expiresAt: new Date(now - 1000).toISOString() });
  const before = structuredClone(store.records.get(`payments/orders/${expiredId}.json`)); store.writes.length = 0; balance = 50;
  await assert.rejects(funding.reserve(input));
  assert.deepEqual(store.records.get(`payments/orders/${expiredId}.json`), before);
  assert.ok(store.writes.every(path => path === FAL_FUNDING_PATH), 'The operator canary cannot fence an unrelated expired customer order');
});

function reviewBody(shot) { return { email, preparedId: id, manifestHash: fixedHash, shotId: shot.id,
  frames: [0, 1, 2].map(atMs => ({ shotId: shot.id, atMs, dataUrl: `data:image/jpeg;base64,fixture-${atMs}` })) }; }
function reviewProof(body) { return { version: 1, manifestHash: fixedHash, shotId: body.shotId,
  bindingHash: digest(JSON.stringify(body)), receiptPath: `production/visual-reviews/fixture/${digest(body.shotId)}.json`, passed: true }; }

test('Astra review has only three durable shot claims, exact successful reuse and no changed-frame calls', async () => {
  const store = memory(); let calls = 0;
  const review = createBoundedSeedanceCanaryReview({ ...store, email, now: () => now, grantContext: async () => ({ grant: grant() }),
    review: async body => { calls++; return reviewProof(body); } });
  for (const shot of manifest.shots) await review(reviewBody(shot));
  assert.equal(calls, 3);
  await review(reviewBody(manifest.shots[0])); assert.equal(calls, 3);
  const changed = reviewBody(manifest.shots[0]); changed.frames[0].dataUrl += 'changed';
  await assert.rejects(review(changed), { code: 'CANARY_VISUAL_REVIEW_ALREADY_ATTEMPTED' });
  await assert.rejects(review({ ...reviewBody(manifest.shots[0]), shotId: 'fourth-shot' }), { code: 'CANARY_VISUAL_INPUT_CHANGED' });
  assert.equal(calls, 3); assert.equal(store.records.size, 3);
});

test('lost or concurrent Astra review cannot issue an additional request', async () => {
  const store = memory(); let calls = 0;
  const review = createBoundedSeedanceCanaryReview({ ...store, email, now: () => now, grantContext: async () => ({ grant: grant() }),
    review: async () => { calls++; throw new Error('lost response'); } });
  const body = reviewBody(manifest.shots[0]);
  const results = await Promise.allSettled([review(body), review(body)]);
  assert.ok(results.every(value => value.status === 'rejected')); assert.equal(calls, 1);
  await assert.rejects(review(body), { code: 'CANARY_VISUAL_REVIEW_ALREADY_ATTEMPTED' }); assert.equal(calls, 1);
  assert.equal([...store.records.values()][0].value.state, 'claimed');
});
