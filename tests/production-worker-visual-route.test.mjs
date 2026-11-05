import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { buildFilmManifest, fictionalOperatorProject, productionJobPath } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { FAL_RECIPE_VERSION, startFrameIdentity } from '../api/_lib/fal-production.mjs';
import { falRequestPath, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { productionQueuePath } from '../api/_lib/production-queue.mjs';
import { createFilmVisualReviewService, visualSampleTimes } from '../api/_lib/film-visual-review.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
import { createStartFrameReviewService } from '../api/_lib/film-start-frame-review.mjs';

// Exercise the real route, reference lookup, JPEG validation, receipt writing,
// and authorization callbacks. Only private storage/payment/model IO is fake.
const secret = 'a'.repeat(64), now = 1_800_000_000_000, id = '11111111-1111-4111-8111-111111111111';
const clone = structuredClone;
const decision = { appearance: 'consistent', wardrobe: 'consistent', sceneAction: 'consistent', imageIntegrity: 'consistent', findings: [] };
async function fixture({ operator = false, changeManifest, bindingVersion = 2, startFrame = false } = {}) {
  const email = operator ? OWNER_EMAIL : 'visual-customer@example.invalid';
  const manifest = planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest, {
    characterBinding: bindingVersion !== null, ...(bindingVersion === null ? {} : { characterBindingVersion: bindingVersion }),
  });
  if (changeManifest) changeManifest(manifest);
  const manifestHash = digest(JSON.stringify(manifest));
  const job = { id, filmId: manifest.filmId, ownerHash: digest(email), mode: operator ? 'operator-test' : 'customer',
    status: startFrame ? 'processing' : 'awaiting-assembly', manifest, manifestHash,
    ...(startFrame ? { lease: { token: 'current-generation-lease', expiresAt: now + 90_000 } } : {}),
    provider: { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION },
    authorization: { environment: 'production', manifestHash, budgetCents: bindingVersion === 3 ? 450 : 300, quoteReference: 'b'.repeat(64) },
    shots: manifest.shots.map(shot => ({ id: shot.id, status: startFrame ? 'processing' : 'completed', requestKey: digest(`${id}:${manifestHash}:${shot.id}`),
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
    ...([2, 3].includes(bindingVersion) ? { characterBindingVersion: bindingVersion } : {}),
    maximumCostCents: bindingVersion === 3 ? 450 : bindingVersion === 2 ? 360 : 300,
    maximumVideoRequests: 3, maximumReferenceRequests: bindingVersion === 3 ? 7 : bindingVersion === 2 ? 4 : 2, videoMicroUsdPerSecond: 140_000,
    referenceMicroUsd: 300_000, quoteReference: 'b'.repeat(64), quotedCostCents: bindingVersion === 3 ? 434 : bindingVersion === 2 ? 344 : 284,
    approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600_000).toISOString() };
  const records = new Map(), reads = [], writes = [];
  for (const [path, value] of [[jobPath, job], [userPath(email), user], [orderPath, order], [ticketPath, ticket],
    [grantPath, grant], [leasePath, { token: 'owned-operator-claim', expiresAt: now + 600_000, manifestHash }]])
    records.set(path, { value: clone(value), etag: 'initial' });
  for (const character of manifest.screenplay.characters) {
    const identity = digest(`${FAL_RECIPE_VERSION}:cast:${id}:${manifestHash}:${character.id}`);
    records.set(falRequestPath(identity), { value: { identity, state: 'completed', endpoint: FAL_MODELS.reference,
      result: { images: [{ url: `https://v3.fal.media/${character.id}.jpg` }] } }, etag: 'reference' });
  }
  const image = `data:image/jpeg;base64,${(await sharp({ create: { width: 96, height: 96, channels: 3, background: '#63574a' } }).jpeg().toBuffer()).toString('base64')}`;
  const frames = visualSampleTimes(manifest.shots[0]).map(atMs => ({ shotId: manifest.shots[0].id, atMs, dataUrl: image }));
  const referenceIdentity = startFrameIdentity(id, manifestHash, manifest.shots[0].id);
  records.set(falRequestPath(referenceIdentity), { value: { identity: referenceIdentity, state: 'completed', endpoint: FAL_MODELS.reference,
    result: { images: [{ url: 'https://v3.fal.media/start-frame.jpg' }] } }, etag: 'starting-frame' });
  const body = startFrame
    ? { action: 'review-start-frame', email, preparedId: id, manifestHash, shotId: manifest.shots[0].id, referenceIdentity }
    : { action: 'review-film-visuals', email, preparedId: id, manifestHash, shotId: manifest.shots[0].id, frames };
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
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(bindingVersion === 3 ? { ...decision, cast: 'consistent' } : decision) }] }] }));
        } });
    },
    startFrameReviewFactory: options => {
      reviewCalls++;
      return createStartFrameReviewService({ ...options, write,
        generatedPhoto: async () => image,
        normalizeStartImage: async () => { if (afterReference) await afterReference(); return image; },
        fetchImpl: async () => {
          modelCalls++; if (afterInference) await afterInference();
          return new Response(JSON.stringify({ status: 'completed', model: STORY_MODEL,
            output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...decision, cast: 'consistent' }) }] }] }));
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

test('v3 starting-frame review uses the ordinary paid worker or exact separate fictional grant before rendering', async () => {
  for (const operator of [false, true]) {
    const f = await fixture({ operator, bindingVersion: 3, startFrame: true });
    const result = await f.invoke(); assert.equal(result.statusCode, 200); assert.equal(result.body.passed, true);
    assert.equal(result.body.referenceIdentity, f.body.referenceIdentity); assert.match(result.body.normalizedImageHash, /^[a-f0-9]{64}$/);
    assert.equal(f.counts().modelCalls, 1);
    assert.ok(f.writes.every(w => w.path.startsWith('production/start-frame-reviews/')));
    assert.ok(!JSON.stringify(f.writes).includes('data:image'));
    assert.deepEqual((await f.invoke()).body, result.body); assert.equal(f.counts().modelCalls, 1);
  }
  const finalReview = await fixture({ operator: true, bindingVersion: 3 });
  assert.equal((await finalReview.invoke()).statusCode, 200);
});

test('v3 preflight rejects expired, replaced, completed, foreign and expanded authorizations before spending', async () => {
  const changes = [f => { delete f.records.get(f.jobPath).value.lease; },
    f => { f.records.get(f.jobPath).value.lease.expiresAt = now; },
    f => { f.records.get(f.jobPath).value.status = 'completed'; },
    f => { f.records.get(f.jobPath).value.shots[0].status = 'completed'; },
    f => { f.records.get(f.grantPath).value.maximumReferenceRequests = 8; },
    f => { f.records.get(f.grantPath).value.maximumCostCents = 451; },
    f => { f.records.get(f.grantPath).value.maximumCostCents = 360; f.records.get(f.grantPath).value.maximumReferenceRequests = 4; },
    f => { f.records.get(f.grantPath).value.quoteReference = 'c'.repeat(64); },
    f => { f.records.get(f.jobPath).value.authorization.budgetCents = 900; },
    f => { f.records.get(f.userPath).value.status = 'suspended'; },
    f => { f.records.get(falRequestPath(f.body.referenceIdentity)).value.state = 'queued'; }];
  for (const change of changes) {
    const f = await fixture({ operator: true, bindingVersion: 3, startFrame: true }); change(f);
    assert.notEqual((await f.invoke()).statusCode, 200); assert.equal(f.counts().modelCalls, 0);
  }
  for (const extra of [{ image: 'data:image/jpeg;base64,AAAA' }, { passed: true }]) {
    const f = await fixture({ operator: true, bindingVersion: 3, startFrame: true });
    assert.equal((await f.invoke({ body: { ...f.body, ...extra } })).statusCode, 400); assert.equal(f.counts().modelCalls, 0);
  }
});

test('preflight generation-lease takeover, refund and grant mutation during inference cannot publish a pass', async () => {
  for (const operator of [false, true]) {
    const mutations = [f => { f.records.get(f.jobPath).value.lease.token = 'takeover'; },
      f => { f.records.get(f.jobPath).value.lease.expiresAt = now; },
      operator ? f => { f.records.get(f.grantPath).value.expiresAt = new Date(now - 1).toISOString(); }
        : f => { f.records.get(f.orderPath).value.refundedCents = 1; }];
    for (const mutate of mutations) {
      const f = await fixture({ operator, bindingVersion: 3, startFrame: true }); f.setAfterInference(() => mutate(f));
      assert.notEqual((await f.invoke()).statusCode, 200); assert.equal(f.counts().modelCalls, 1);
      assert.ok(f.writes.every(w => w.value.state !== 'reviewed'));
    }
  }
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

test('historical absent and v1 character bindings retain exactly their original operator grant limits', async () => {
  for (const bindingVersion of [null, 1]) {
    const f = await fixture({ operator: true, bindingVersion });
    assert.equal((await f.invoke()).statusCode, 200); assert.equal(f.counts().paymentCalls, 0);
    for (const changes of [{ maximumCostCents: 360, maximumReferenceRequests: 4, characterBindingVersion: 2 },
      { maximumCostCents: 301 }, { maximumReferenceRequests: 3 }]) {
      const rejected = await fixture({ operator: true, bindingVersion });
      Object.assign(rejected.records.get(rejected.grantPath).value, changes);
      assert.equal((await rejected.invoke()).statusCode, 409); assert.equal(rejected.counts().modelCalls, 0);
    }
  }
});

test('v2 fixed operator review requires the separate 360-cent four-reference grant and cannot expand it', async () => {
  const f = await fixture({ operator: true });
  assert.equal(f.job.manifestHash, '242696e7d84c765468f5e33717b32480326da65488f0d7ff8573b2938ad70358');
  assert.equal((await f.invoke()).statusCode, 200); assert.equal(f.counts().paymentCalls, 0);
  for (const change of [grant => { delete grant.characterBindingVersion; }, grant => { grant.characterBindingVersion = 1; },
    grant => { grant.maximumCostCents = 300; grant.maximumReferenceRequests = 2; },
    grant => { grant.maximumCostCents = 361; }, grant => { grant.maximumCostCents = 400; },
    grant => { grant.maximumReferenceRequests = 5; }, grant => { grant.maximumVideoRequests = 4; }]) {
    const rejected = await fixture({ operator: true }); change(rejected.records.get(rejected.grantPath).value);
    assert.equal((await rejected.invoke()).statusCode, 409); assert.equal(rejected.counts().modelCalls, 0);
    assert.equal(rejected.writes.length, 0);
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
