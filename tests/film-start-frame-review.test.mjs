import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { digest } from '../api/_lib/auth.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { FAL_RECIPE_VERSION, startFrameIdentity } from '../api/_lib/fal-production.mjs';
import { falRequestPath, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { createStartFrameReviewService, verifyStartFrameReceipt } from '../api/_lib/film-start-frame-review.mjs';

const email = 'cast-fixture@example.invalid', id = '11111111-1111-4111-8111-111111111111', now = 1_800_000_000_000;
const pass = { cast: 'consistent', appearance: 'consistent', wardrobe: 'consistent', sceneAction: 'consistent', imageIntegrity: 'consistent', findings: [] };
const image = async color => `data:image/jpeg;base64,${(await sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).jpeg().toBuffer()).toString('base64')}`;
async function fixture() {
  const manifest = planKlingShots(buildFilmManifest(fictionalOperatorProject()).manifest, { characterBindingVersion: 3 });
  const manifestHash = digest(JSON.stringify(manifest)), shotId = manifest.shots[1].id;
  const referenceIdentity = startFrameIdentity(id, manifestHash, shotId);
  const job = { id, ownerHash: digest(email), manifestHash, manifest, status: 'processing',
    provider: { id: 'fal', model: 'kling', recipe: FAL_RECIPE_VERSION } };
  const jobPath = `production/jobs/${digest(email)}/${id}.json`, records = new Map();
  const save = (path, value) => records.set(path, { value: structuredClone(value), etag: 'initial' });
  save(jobPath, job);
  for (const character of manifest.screenplay.characters) {
    const identity = digest(`${FAL_RECIPE_VERSION}:cast:${id}:${manifestHash}:${character.id}`);
    save(falRequestPath(identity), { identity, state: 'completed', endpoint: FAL_MODELS.reference,
      result: { images: [{ url: `https://v3.fal.media/${character.id}.jpg` }] } });
  }
  save(falRequestPath(referenceIdentity), { identity: referenceIdentity, state: 'completed', endpoint: FAL_MODELS.reference,
    result: { images: [{ url: 'https://v3.fal.media/scene-2.jpg' }] } });
  let writes = 0, calls = 0, allowed = true, afterInference;
  const normalizedImageData = await image('#346a82'), originalImage = await image('#84783a');
  const read = async path => structuredClone(records.get(path) ?? null);
  const write = async (path, value, expected) => {
    const old = records.get(path);
    if (old ? old.etag !== expected : expected !== undefined) throw Error('CAS conflict');
    records.set(path, { value: structuredClone(value), etag: `write-${++writes}` });
  };
  const options = { read, write, key: 'synthetic-key', now: () => now, authorize: async () => allowed,
    generatedPhoto: async url => { assert.match(url, /^https:\/\/v3\.fal\.media\/(ada|alice)\.jpg$/); return originalImage; },
    normalizeStartImage: async url => { assert.equal(url, 'https://v3.fal.media/scene-2.jpg'); return normalizedImageData; },
    fetchImpl: async (_url, options) => {
      calls++; if (afterInference) await afterInference(options);
      return new Response(JSON.stringify({ status: 'completed', model: STORY_MODEL,
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(pass) }] }] }));
    } };
  const input = { email, productionId: id, manifestHash, shotId, referenceIdentity };
  return { records, jobPath, job, input, normalizedImageData, read, write, options,
    calls: () => calls, deny: () => { allowed = false; }, after: fn => { afterInference = fn; } };
}

test('preflight uses saved exact scene and original cast, persists one proof, and binds normalized submitted bytes', async () => {
  const f = await fixture();
  f.after(options => { const body = JSON.parse(options.body), context = JSON.parse(body.input[0].content[0].text);
    assert.equal(context.scene.title, 'Tending'); assert.equal(context.scene.narration, 'They tend the garden together.');
    assert.deepEqual(context.scene.castIds, ['ada', 'alice']);
    assert.equal(body.input[0].content.filter(c => c.type === 'input_image').length, 3);
    assert.ok(body.text.format.schema.required.includes('cast')); });
  const service = createStartFrameReviewService(f.options), proof = await service(f.input);
  assert.equal(proof.passed, true); assert.equal(proof.normalizedImageHash, digest(f.normalizedImageData));
  assert.deepEqual(await verifyStartFrameReceipt({ ...f.input, proof, normalizedImageData: f.normalizedImageData }, { read: f.read }), proof);
  assert.deepEqual(await service(f.input), proof); assert.equal(f.calls(), 1);
  await assert.rejects(verifyStartFrameReceipt({ ...f.input, proof, normalizedImageData: await image('#654321') }, { read: f.read }));
  await assert.rejects(verifyStartFrameReceipt({ ...f.input, proof: { ...proof, passed: false }, normalizedImageData: f.normalizedImageData }, { read: f.read }));
  assert.deepEqual(await verifyStartFrameReceipt({ ...f.input, normalizedImageData: f.normalizedImageData }, { read: f.read }), proof, 'recovery can verify the same saved proof');
});

test('duplicate, missing, or unverifiable cast fails durably and cannot turn into another review attempt', async () => {
  for (const decision of [{ ...pass, cast: 'mismatch', findings: ['duplicate-or-extra-person'] },
    { ...pass, cast: 'mismatch', findings: ['missing-required-character'] }, { ...pass, cast: 'unverifiable' }]) {
    const f = await fixture(); let calls = 0;
    const service = createStartFrameReviewService({ ...f.options, fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ status: 'completed', model: STORY_MODEL,
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] }));
    } });
    const proof = await service(f.input); assert.equal(proof.passed, false);
    await assert.rejects(verifyStartFrameReceipt({ ...f.input, normalizedImageData: f.normalizedImageData }, { read: f.read }), { code: 'CAST_START_FRAME_MISMATCH' });
    assert.deepEqual(await service(f.input), proof); assert.equal(calls, 1);
  }
});

test('review is bound to owner, manifest, exact image receipt and original character receipts', async () => {
  const f = await fixture(), service = createStartFrameReviewService(f.options), proof = await service(f.input);
  for (const changes of [{ email: 'other@example.invalid' }, { manifestHash: 'a'.repeat(64) },
    { shotId: 'shot-001' }, { referenceIdentity: 'b'.repeat(64) }])
    await assert.rejects(verifyStartFrameReceipt({ ...f.input, ...changes, proof, normalizedImageData: f.normalizedImageData }, { read: f.read }));
  const sourcePath = falRequestPath(f.input.referenceIdentity), source = structuredClone(f.records.get(sourcePath));
  f.records.get(sourcePath).value.result.images[0].url = 'https://v3.fal.media/replacement.jpg';
  await assert.rejects(verifyStartFrameReceipt({ ...f.input, proof, normalizedImageData: f.normalizedImageData }, { read: f.read }));
  f.records.set(sourcePath, source);
  const characterId = digest(`${FAL_RECIPE_VERSION}:cast:${id}:${f.input.manifestHash}:ada`);
  f.records.get(falRequestPath(characterId)).value.result.images[0].url = 'https://v3.fal.media/changed-ada.jpg';
  await assert.rejects(verifyStartFrameReceipt({ ...f.input, proof, normalizedImageData: f.normalizedImageData }, { read: f.read }));
});

test('revoked authorization or changed source after inference cannot publish a pass', async () => {
  for (const mutate of [f => f.deny(), f => { f.records.get(falRequestPath(f.input.referenceIdentity)).value.result.images[0].url = 'https://v3.fal.media/changed.jpg'; }]) {
    const f = await fixture(); f.after(() => mutate(f));
    await assert.rejects(createStartFrameReviewService(f.options)(f.input));
    assert.equal([...f.records.values()].filter(r => r.value.state === 'reviewed').length, 0);
  }
});

test('lost inference response retains claim and never submits another model request', async () => {
  const f = await fixture(); let calls = 0;
  const service = createStartFrameReviewService({ ...f.options, fetchImpl: async () => { calls++; throw Error('lost response'); } });
  await assert.rejects(service(f.input), { code: 'VISUAL_REVIEW_UNCERTAIN' });
  await assert.rejects(service(f.input), { code: 'VISUAL_REVIEW_UNCERTAIN' });
  assert.equal(calls, 1);
});
