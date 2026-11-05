import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { digest } from '../api/_lib/auth.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { createFalProductionAdapter, FAL_RECIPE_VERSION, characterViewIdentity, startFrameIdentity } from '../api/_lib/fal-production.mjs';
import { createFalClient, falRequestPath, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { falReferenceData, klingReferenceData } from '../api/_lib/fal-reference.mjs';
import { createStartFrameReviewService, verifyStartFrameReceipt } from '../api/_lib/film-start-frame-review.mjs';

const NOW = Date.parse('2026-11-05T20:00:00Z');
const pass = { cast: 'consistent', appearance: 'consistent', wardrobe: 'consistent',
  sceneAction: 'consistent', imageIntegrity: 'consistent', findings: [] };
let sequence = 0;

// The client, adapter, review service, receipt verifier, and image normalizers
// are real. Only private storage and external HTTP responses are simulated.
async function fixture(decision = pass) {
  const fixtureId = ++sequence, email = 'integration@example.invalid', productionId = '11111111-1111-4111-8111-111111111111';
  const manifest = planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest);
  const manifestHash = digest(JSON.stringify(manifest)), shot = manifest.shots[1];
  const records = new Map(), images = new Map(), videoRequests = [], reviews = [];
  let writes = 0, canSpend = true, canReview = true, expireDuringReview = false, normalizedStartData;
  const save = (path, value) => records.set(path, { value: structuredClone(value), etag: `fixture-${++writes}` });
  const read = async path => structuredClone(records.get(path) ?? null);
  const write = async (path, value, expected) => {
    const old = records.get(path);
    if (old ? old.etag !== expected : expected !== undefined) throw Error('CAS conflict');
    save(path, value);
  };
  save(`production/jobs/${digest(email)}/${productionId}.json`, { id: productionId, ownerHash: digest(email),
    manifest, manifestHash, status: 'processing', provider: { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION } });
  save('production/worker-health.json', { ready: true, model: 'kling', recipe: FAL_RECIPE_VERSION,
    deliveryChecksVersion: 1, visualChecksVersion: 1, characterBindingVersion: 3, checkedAt: new Date(NOW).toISOString() });
  async function completedImage(identity, suffix, color, width = 320, height = 400) {
    const url = `https://v3.fal.media/integration-${fixtureId}-${suffix}.jpg`;
    images.set(url, await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer());
    save(falRequestPath(identity), { identity, endpoint: FAL_MODELS.reference, state: 'completed', result: { images: [{ url }] } });
    return url;
  }
  for (const [i, character] of manifest.screenplay.characters.entries()) {
    await completedImage(digest(`${FAL_RECIPE_VERSION}:cast:${productionId}:${manifestHash}:${character.id}`),
      `${character.id}-front`, i ? '#123c97' : '#348125');
    await completedImage(characterViewIdentity(productionId, manifestHash, character.id),
      `${character.id}-view`, i ? '#134294' : '#438b30');
  }
  const referenceIdentity = startFrameIdentity(productionId, manifestHash, shot.id);
  await completedImage(referenceIdentity, 'scene-start', '#638781', 640, 360);
  const mediaFetch = async url => {
    assert.ok(images.has(url), 'Every image must come from the in-memory fixture');
    return new Response(images.get(url), { headers: { 'content-type': 'image/jpeg' } });
  };
  const review = createStartFrameReviewService({ read, write, now: () => NOW, key: 'synthetic-review-key', authorize: async () => canReview,
    generatedPhoto: url => falReferenceData(url, { fetchImpl: mediaFetch }),
    normalizeStartImage: async url => normalizedStartData = await klingReferenceData(url, { fetchImpl: mediaFetch }),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body); reviews.push(body);
      assert.ok(body.text.format.schema.required.includes('cast'));
      assert.equal(body.input[0].content.filter(part => part.type === 'input_image').length, 3);
      if (expireDuringReview) canReview = false;
      return new Response(JSON.stringify({ status: 'completed', model: STORY_MODEL,
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] }));
    } });
  const client = createFalClient({ key: 'synthetic-fal-key', read, write, now: () => NOW,
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') {
        assert.equal(url, 'https://queue.fal.run/fal-ai/kling-video/requests/integration-video/status');
        return new Response(JSON.stringify({ status: 'IN_QUEUE', request_id: 'integration-video' }));
      }
      assert.equal(options.method, 'POST'); assert.equal(url, `https://queue.fal.run/${FAL_MODELS.kling}`);
      videoRequests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ request_id: 'integration-video',
        status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/integration-video/status',
        response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/integration-video' }));
    } });
  const adapter = createFalProductionAdapter({ key: 'synthetic-fal-key', read, client, now: () => NOW,
    normalizeKlingReference: url => klingReferenceData(url, { fetchImpl: mediaFetch }),
    validateStartFrame: input => review({ ...input, productionId: input.preparedId }) });
  const request = { email, productionId, manifest, manifestHash, shot,
    idempotencyKey: digest(`${productionId}:${manifestHash}:${shot.id}`), authorizeSpend: async () => canSpend };
  return { adapter, request, records, reviews, videoRequests, read, referenceIdentity,
    normalizedStart: () => normalizedStartData,
    setSpend: value => { canSpend = value; }, setReview: value => { canReview = value; },
    expireDuringReview: () => { expireDuringReview = true; },
    receipts: () => [...records.entries()].filter(([path]) => path.startsWith('production/start-frame-reviews/')).map(([, record]) => record.value) };
}

test('real adapter accepts a persisted cast pass and submits its exact normalized start frame once', async () => {
  const f = await fixture();
  assert.equal((await f.adapter.submitShot(f.request)).status, 'queued');
  assert.equal(f.reviews.length, 1); assert.equal(f.videoRequests.length, 1);
  assert.equal(f.receipts().length, 1); const receipt = f.receipts()[0];
  assert.equal(receipt.state, 'reviewed'); assert.deepEqual(receipt.decision, pass);
  assert.equal(receipt.binding.normalizedImageHash, digest(f.videoRequests[0].start_image_url));
  assert.equal(f.videoRequests[0].elements.length, 2);
  assert.equal((await f.adapter.reconcileShot(f.request)).status, 'queued');
  assert.equal(f.reviews.length, 1); assert.equal(f.videoRequests.length, 1);
});

test('real cast failure persists its decision and prevents every video POST on repeated advances', async () => {
  const failed = { ...pass, cast: 'mismatch', findings: ['duplicate-or-extra-person'] };
  const f = await fixture(failed);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.adapter.submitShot(f.request);
    assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'CAST_START_FRAME_MISMATCH');
  }
  assert.equal(f.reviews.length, 1); assert.equal(f.videoRequests.length, 0);
  assert.deepEqual(f.receipts()[0].decision, failed);
});

test('a stored pass survives lost video authorization and is reused after a new authorized advance', async () => {
  const f = await fixture(); f.setSpend(false);
  await assert.rejects(f.adapter.submitShot(f.request), /Production spending is not authorized/);
  assert.equal(f.receipts()[0].state, 'reviewed'); assert.equal(f.videoRequests.length, 0);
  f.setSpend(true);
  assert.equal((await f.adapter.submitShot(f.request)).status, 'queued');
  assert.equal(f.reviews.length, 1); assert.equal(f.videoRequests.length, 1);
});

test('expiry after inference saves an unapproved decision; a renewed advance reuses it without a second review', async () => {
  const f = await fixture(); f.expireDuringReview();
  await assert.rejects(f.adapter.submitShot(f.request), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
  const receipt = f.receipts()[0];
  assert.equal(receipt.state, 'awaiting-authorization'); assert.deepEqual(receipt.decision, pass);
  assert.equal(f.reviews.length, 1); assert.equal(f.videoRequests.length, 0);
  await assert.rejects(verifyStartFrameReceipt({ ...f.request, shotId: f.request.shot.id,
    referenceIdentity: f.referenceIdentity,
    normalizedImageData: f.normalizedStart() }, { read: f.read }), { code: 'VISUAL_REVIEW_REQUIRED' });
  await assert.rejects(f.adapter.submitShot(f.request), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
  assert.equal(f.videoRequests.length, 0); assert.equal(f.reviews.length, 1);
  f.setReview(true);
  assert.equal((await f.adapter.submitShot(f.request)).status, 'queued');
  assert.equal(f.receipts()[0].state, 'reviewed');
  assert.equal(f.reviews.length, 1); assert.equal(f.videoRequests.length, 1);
});
