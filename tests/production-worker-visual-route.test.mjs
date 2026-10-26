import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { buildFilmManifest, fictionalOperatorProject, productionJobPath } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { falRequestPath, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { productionQueuePath } from '../api/_lib/production-queue.mjs';
import { createFilmVisualReviewService, visualSampleTimes } from '../api/_lib/film-visual-review.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
import { FILM_PERFORMANCE_RECIPE } from '../api/_lib/film-performance.mjs';

// Exercise the real route, reference lookup, JPEG validation, receipt writing,
// and authorization callbacks. Only private storage/payment/model IO is fake.
const secret = 'a'.repeat(64), now = 1_800_000_000_000, id = '11111111-1111-4111-8111-111111111111';
const clone = structuredClone;
const decision = { appearance: 'consistent', wardrobe: 'consistent', sceneAction: 'consistent', imageIntegrity: 'consistent', findings: [] };
async function fixture({ operator = false, changeManifest, performance = false, shotIndex = 0 } = {}) {
  const email = operator ? OWNER_EMAIL : 'visual-customer@example.invalid';
  const project = fictionalOperatorProject();
  if (performance) {
    project.performanceControlsVersion = 1; project.duration = 30; project.scenes = project.scenes.slice(0, 1);
    project.scenes[0].narration = 'A fictional garden.';
    project.scenes[0].dialogue = 'Ada: Let us plant together.\nAlice: There is room for both.';
  }
  const manifest = planKlingShots(buildFilmManifest(project).manifest);
  if (changeManifest) changeManifest(manifest);
  const manifestHash = digest(JSON.stringify(manifest));
  const job = { id, filmId: manifest.filmId, ownerHash: digest(email), mode: operator ? 'operator-test' : 'customer',
    status: 'awaiting-assembly', manifest, manifestHash,
    provider: { id: 'fal', model: 'kling', recipe: performance ? FILM_PERFORMANCE_RECIPE : FAL_RECIPE_VERSION },
    authorization: { environment: 'production', manifestHash, budgetCents: 300, quoteReference: 'b'.repeat(64) },
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', requestKey: digest(`${id}:${manifestHash}:${shot.id}`),
      output: { url: `https://v3.fal.media/${shot.id}.mp4`, contentType: 'video/mp4', sizeBytes: 1024, durationSeconds: shot.targetDurationMs / 1000 } })) };
  const orderId = digest(`${email}:production:${manifestHash}`), orderPath = `payments/orders/${orderId}.json`;
  const jobPath = productionJobPath(email, id), ticketPath = productionQueuePath(email, id);
  const grantPath = `production/operator-canaries/${job.ownerHash}/${id}/grant.json`;
  const leasePath = `production/operator-canaries/${job.ownerHash}/${id}/finishing-lease.json`;
  const user = { email, status: 'active', approvedAt: new Date(now - 1000).toISOString(), approvedBy: OWNER_EMAIL,
    ...(operator ? { role: 'owner' } : {}) };
  const order = { id: orderId, customerEmail: email, preparedId: id, filmId: job.filmId, manifestHash, provider: 'quickbooks',
    status: 'captured', capturedAt: new Date(now - 1000).toISOString(), currency: 'USD', amountCents: 500, refundedCents: 0,
    merchantBinding: { environment: 'production', grantId: 'c'.repeat(64) }, providerChargeId: 'synthetic-original-charge' };
  const ticket = { version: 1, state: 'pending', email, id, orderId, manifestHash, lease: { token: 'owned-queue-claim', expiresAt: now + 600_000 } };
  const grant = { version: 1, kind: 'fictional-kling-quality-canary-v1', ownerHash: job.ownerHash, preparedId: id,
    manifestHash, recipe: FAL_RECIPE_VERSION, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    maximumCostCents: 300, maximumVideoRequests: 3, maximumReferenceRequests: 2, videoMicroUsdPerSecond: 140_000,
    referenceMicroUsd: 300_000, quoteReference: 'b'.repeat(64), quotedCostCents: 284,
    approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600_000).toISOString() };
  const records = new Map(), reads = [], writes = [];
  for (const [path, value] of [[jobPath, job], [userPath(email), user], [orderPath, order], [ticketPath, ticket],
    [grantPath, grant], [leasePath, { token: 'owned-operator-claim', expiresAt: now + 600_000, manifestHash }]])
    records.set(path, { value: clone(value), etag: 'initial' });
  for (const character of manifest.screenplay.characters) {
    const identity = digest(`${job.provider.recipe}:cast:${id}:${manifestHash}:${character.id}`);
    records.set(falRequestPath(identity), { value: { identity, state: 'completed', endpoint: FAL_MODELS.reference,
      result: { images: [{ url: `https://v3.fal.media/${character.id}.jpg` }] } }, etag: 'reference' });
  }
  const image = `data:image/jpeg;base64,${(await sharp({ create: { width: 96, height: 96, channels: 3, background: '#63574a' } }).jpeg().toBuffer()).toString('base64')}`;
  const selected = manifest.shots[shotIndex], previous = manifest.shots[shotIndex - 1];
  const frames = visualSampleTimes(selected, performance ? 2 : 1).map(atMs => ({ shotId: selected.id, atMs, dataUrl: image }));
  if (previous?.sceneIndex === selected.sceneIndex) frames.push({ shotId: previous.id,
    atMs: visualSampleTimes(previous, performance ? 2 : 1).at(-1), dataUrl: image });
  const body = { action: 'review-film-visuals', email, preparedId: id, manifestHash, shotId: selected.id, frames };
  const env = { LINEAGE_WORKER_SECRET: secret, OPENAI_API_KEY: 'synthetic-visual-key' };
  let modelCalls = 0, paymentCalls = 0, reviewCalls = 0, limiterCalls = 0, afterInference, afterReference;
  const read = async path => { reads.push(path); return clone(records.get(path) ?? null); };
  const write = async (path, value, expected) => {
    const old = records.get(path);
    if (old ? old.etag !== expected : expected !== undefined) throw Error('private CAS conflict');
    records.set(path, { value: clone(value), etag: `write-${writes.length}` }); writes.push({ path, value: clone(value) });
  };
  const permissions = { allowed: true, environment: 'production', manifestHash, fictionalOnly: false,
    budgetCents: 300, quoteReference: 'b'.repeat(64), expiresAt: new Date(now + 60_000).toISOString() };
  const paymentService = { authorizeProduction: async request => {
    paymentCalls++; assert.deepEqual(request, { email, preparedId: id, manifestHash, orderId });
    const order = records.get(orderPath)?.value;
    if (!order || order.status !== 'captured' || order.refundedCents !== 0) return { allowed: false };
    return clone(permissions);
  } };
  const handler = createProductionWorkerHandler({ env, read, paymentService, now: () => now,
    adapter: { model: 'kling', modelVersion: FAL_RECIPE_VERSION, available: true },
    limiter: async () => { limiterCalls++; return true; },
    visualReviewFactory: options => {
      reviewCalls++;
      return createFilmVisualReviewService({ ...options, write,
        generatedPhoto: async () => { if (afterReference) await afterReference(); return image; },
        selectedPhoto: async () => assert.fail('The fixed fictional fixture has no private real-person photograph'),
        fetchImpl: async (url, request) => {
          modelCalls++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(request.redirect, 'error');
          assert.equal(JSON.parse(request.body).store, false);
          if (afterInference) await afterInference();
          return new Response(JSON.stringify({ status: 'completed', model: STORY_MODEL,
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(performance
              ? { ...decision, textIntegrity: 'consistent', speakerStaging: 'consistent' } : decision) }] }] }));
        } });
    } });
  const invoke = async changes => {
    const result = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: clone(body), ...changes }, result);
    return result;
  };
  return { env, body, job, jobPath, ticketPath, grantPath, leasePath, userPath: userPath(email), orderPath, records, reads, writes,
    permissions, invoke, setAfterInference: value => { afterInference = value; }, setAfterReference: value => { afterReference = value; },
    counts: () => ({ modelCalls, paymentCalls, reviewCalls, limiterCalls }) };
}

test('visual route completes an owned paid film review and returns only the bound receipt', async () => {
  const f = await fixture(), result = await f.invoke();
  assert.equal(result.statusCode, 200); assert.equal(result.body.passed, true); assert.equal(result.body.manifestHash, f.body.manifestHash);
  assert.equal(f.counts().modelCalls, 1); assert.ok(f.counts().paymentCalls >= 1);
  assert.ok(f.writes.every(entry => entry.path.startsWith('production/visual-reviews/')));
  assert.ok(!JSON.stringify(result.body).includes('data:image')); assert.ok(!JSON.stringify(f.writes).includes('data:image'));
  assert.ok(!JSON.stringify(f.writes).includes(f.env.OPENAI_API_KEY));
  const repeated = await f.invoke(); assert.equal(repeated.statusCode, 200); assert.deepEqual(repeated.body, result.body);
  assert.equal(f.counts().modelCalls, 1);
});

test('performance route accepts five current samples and the sixth same-scene boundary sample', async () => {
  for (const shotIndex of [0, 1]) {
    const f = await fixture({ performance: true, shotIndex }), result = await f.invoke();
    assert.equal(f.body.frames.length, shotIndex === 0 ? 5 : 6);
    assert.equal(result.statusCode, 200); assert.equal(result.body.version, 2);
    const receipt = f.records.get(result.body.receiptPath).value;
    assert.equal(receipt.binding.version, 2); assert.equal(receipt.binding.frameHashes.length, f.body.frames.length);
    assert.equal(receipt.decision.textIntegrity, 'consistent'); assert.equal(receipt.decision.speakerStaging, 'consistent');
  }
});

test('six bounded JPEG frames can exceed the old transport cap but oversized payloads fail before private reads', async () => {
  const f = await fixture({ performance: true, shotIndex: 1 });
  const rgb = Buffer.alloc(512 * 512 * 3); let seed = 173;
  for (let index = 0; index < rgb.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; rgb[index] = seed >>> 24; }
  const jpeg = await sharp(rgb, { raw: { width: 512, height: 512, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  assert.ok(jpeg.length <= 250_000);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  f.body.frames.forEach(frame => { frame.dataUrl = dataUrl; });
  const size = Buffer.byteLength(JSON.stringify(f.body)); assert.ok(size > 1_500_000 && size < 2_100_000);
  assert.equal((await f.invoke()).statusCode, 200);
  const oversized = await fixture({ performance: true });
  oversized.body.frames[0].dataUrl = 'a'.repeat(2_100_001);
  assert.notEqual((await oversized.invoke()).statusCode, 200);
  assert.equal(oversized.reads.length, 0); assert.equal(oversized.counts().modelCalls, 0);
});

test('route widening does not let legacy counts approve new cuts or new counts approve legacy cuts', async () => {
  for (const performance of [false, true]) {
    const f = await fixture({ performance });
    if (performance) f.body.frames = f.body.frames.slice(1, 4);
    else f.body.frames.push(...structuredClone(f.body.frames.slice(0, 2)));
    assert.notEqual((await f.invoke()).statusCode, 200); assert.equal(f.counts().modelCalls, 0);
  }
  const f = await fixture({ performance: true });
  f.body.frames.push(...structuredClone(f.body.frames.slice(0, 2)));
  assert.equal((await f.invoke()).statusCode, 400); assert.equal(f.reads.length, 0);
});

test('wrong worker secrets and malformed route bodies cannot read private data or invoke a reviewer', async () => {
  const changes = [f => ({ headers: {} }), f => ({ headers: { authorization: 'Bearer wrong' } }), f => ({ method: 'GET' }),
    f => ({ body: { ...f.body, paid: true } }), f => ({ body: { ...f.body, email: 'OTHER@example.invalid' } }),
    f => ({ body: { ...f.body, preparedId: '../another-film' } }), f => ({ body: { ...f.body, manifestHash: 'wrong' } }),
    f => ({ body: { ...f.body, shotId: 'other-shot' } }), f => ({ body: { ...f.body, frames: [] } })];
  for (const change of changes) {
    const f = await fixture(), result = await f.invoke(change(f));
    assert.notEqual(result.statusCode, 200); assert.equal(f.reads.length, 0);
    assert.equal(f.counts().reviewCalls, 0); assert.equal(f.counts().modelCalls, 0);
  }
});

test('expired leases, revoked users, changed owners, unsupported versions and unpaid films stop before inference', async () => {
  const changes = [
    f => { f.records.get(f.ticketPath).value.lease.expiresAt = now - 1; },
    f => { f.records.get(f.ticketPath).value.state = 'attention'; },
    f => { f.records.get(f.userPath).value.status = 'suspended'; },
    f => { f.records.get(f.userPath).value.mustChangePassword = true; },
    f => { f.records.get(f.userPath).value.email = 'different@example.invalid'; },
    f => { f.records.get(f.jobPath).value.id = '22222222-2222-4222-8222-222222222222'; },
    f => { f.records.get(f.jobPath).value.ownerHash = 'f'.repeat(64); },
    f => { f.records.get(f.jobPath).value.provider.model = 'unrecognized'; },
    f => { f.records.get(f.jobPath).value.manifest.visualContinuity.version = 99; },
    f => { f.records.get(f.orderPath).value.refundedCents = 1; },
  ];
  for (const change of changes) {
    const f = await fixture(); change(f); const result = await f.invoke();
    assert.notEqual(result.statusCode, 200); assert.equal(f.counts().modelCalls, 0); assert.equal(f.writes.length, 0);
  }
});

test('source changes or revocation while reference images load block model submission', async () => {
  const changes = [f => { f.records.get(f.jobPath).value.shots[0].output.sizeBytes++; },
    f => { f.records.get(f.userPath).value.status = 'suspended'; },
    f => { f.records.get(f.orderPath).value.refundedCents = 1; },
    f => { f.records.get(f.ticketPath).value.lease.token = 'replacement-worker'; }];
  for (const change of changes) {
    const f = await fixture(); f.setAfterReference(() => change(f));
    assert.notEqual((await f.invoke()).statusCode, 200); assert.equal(f.counts().modelCalls, 0);
    assert.ok(f.writes.every(entry => entry.value.state !== 'reviewed'));
  }
});

test('refund, source change, lease takeover and user revocation during inference cannot approve the result', async () => {
  const changes = [f => { f.records.get(f.orderPath).value.refundedCents = 1; },
    f => { f.records.get(f.jobPath).value.shots[0].output.url = 'https://v3.fal.media/changed.mp4'; },
    f => { f.records.get(f.ticketPath).value.lease.token = 'replacement-worker'; },
    f => { f.records.get(f.jobPath).value.authorization.budgetCents++; },
    f => { f.records.get(f.jobPath).value.provider.recipe = 'changed-after-authorization'; },
    f => { f.records.get(f.userPath).value.status = 'suspended'; }];
  for (const change of changes) {
    const f = await fixture(); f.setAfterInference(() => change(f));
    assert.notEqual((await f.invoke()).statusCode, 200); assert.equal(f.counts().modelCalls, 1);
    assert.ok(f.writes.every(entry => entry.value.state !== 'reviewed'));
  }
});

test('operator visual review requires the exact fixed fictional film, current owner and bounded grant', async () => {
  const f = await fixture({ operator: true }), result = await f.invoke();
  assert.equal(result.statusCode, 200); assert.equal(result.body.passed, true);
  assert.equal(f.counts().modelCalls, 1); assert.equal(f.counts().paymentCalls, 0);
  const arbitrary = await fixture({ operator: true, changeManifest: manifest => { manifest.screenplay.logline += ' Different family material.'; } });
  assert.notEqual((await arbitrary.invoke()).statusCode, 200); assert.equal(arbitrary.counts().modelCalls, 0);
  const changes = [f => { f.records.get(f.grantPath).value.fictionalOnly = false; },
    f => { f.records.get(f.grantPath).value.kind = 'unrecognized-grant'; },
    f => { f.records.get(f.grantPath).value.expiresAt = new Date(now - 1).toISOString(); },
    f => { f.records.get(f.grantPath).value.manifestHash = 'f'.repeat(64); },
    f => { f.records.get(f.grantPath).value.maximumVideoRequests = 0; },
    f => { f.records.get(f.leasePath).value.manifestHash = 'f'.repeat(64); },
    f => { f.records.get(f.leasePath).value.expiresAt = now - 1; },
    f => { f.records.get(f.userPath).value.role = 'customer'; }];
  for (const change of changes) {
    const g = await fixture({ operator: true }); change(g);
    assert.notEqual((await g.invoke()).statusCode, 200); assert.equal(g.counts().modelCalls, 0);
  }
});

test('operator grant or finishing claim replacement during inference cannot approve an old result', async () => {
  for (const change of [f => { f.records.get(f.leasePath).value.token = 'another-operator-claim'; },
    f => { f.records.get(f.grantPath).value.quoteReference = 'f'.repeat(64); }]) {
    const f = await fixture({ operator: true }); f.setAfterInference(() => change(f));
    assert.notEqual((await f.invoke()).statusCode, 200); assert.equal(f.counts().modelCalls, 1);
    assert.ok(f.writes.every(entry => entry.value.state !== 'reviewed'));
  }
});

test('missing worker or model credentials and invalid JPEG evidence remain unavailable without inference', async () => {
  const worker = await fixture(); worker.env.LINEAGE_WORKER_SECRET = '';
  assert.equal((await worker.invoke()).statusCode, 503); assert.equal(worker.counts().reviewCalls, 0);
  const model = await fixture(); model.env.OPENAI_API_KEY = '';
  assert.equal((await model.invoke()).statusCode, 503); assert.equal(model.counts().modelCalls, 0); assert.equal(model.writes.length, 0);
  const invalid = await fixture(); invalid.body.frames[0].dataUrl = `data:image/jpeg;base64,${Buffer.alloc(200).toString('base64')}`;
  assert.notEqual((await invalid.invoke()).statusCode, 200); assert.equal(invalid.counts().modelCalls, 0); assert.equal(invalid.writes.length, 0);
});
