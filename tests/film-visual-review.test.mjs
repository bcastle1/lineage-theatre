import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { digest } from '../api/_lib/auth.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { falRequestPath, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { createFilmVisualReviewService, verifiedVisualDecision, visualSampleTimes, visualReviewBinding,
  visualReceiptPath, verifyFilmVisualReceipts, boundedVisualJson } from '../api/_lib/film-visual-review.mjs';

// The pixels and model responses below are synthetic. No inference, real
// photographs, payment, or provider requests are used by these tests.
const email = 'visual-fixture@example.invalid', id = '11111111-1111-4111-8111-111111111111';
const pass = () => ({ appearance: 'consistent', wardrobe: 'consistent', sceneAction: 'consistent', imageIntegrity: 'consistent', findings: [] });
const jsonResult = decision => ({ status: 'completed', model: STORY_MODEL, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] });
const dataImage = async color => `data:image/jpeg;base64,${(await sharp({ create: { width: 96, height: 96, channels: 3, background: color } }).jpeg().toBuffer()).toString('base64')}`;

async function fixture() {
  const project = fictionalOperatorProject(); project.duration = 60; project.scenes = project.scenes.slice(0, 2);
  project.scenes.forEach(scene => { scene.narration = 'An entirely fictional garden.'; scene.dialogue = ''; });
  const manifest = planKlingShots(buildFilmManifest(project).manifest), manifestHash = digest(JSON.stringify(manifest));
  const job = { id, ownerHash: digest(email), manifest, manifestHash, status: 'awaiting-assembly',
    provider: { model: 'kling', recipe: FAL_RECIPE_VERSION },
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: { url: `https://v3.fal.media/${shot.id}.mp4`,
      contentType: 'video/mp4', sizeBytes: 1024, durationSeconds: shot.targetDurationMs / 1000 } })) };
  const records = new Map(); let etag = 0, fetches = 0, generatedReads = 0, photoReads = 0;
  const image = await dataImage('#886644');
  const jobPath = `production/jobs/${digest(email)}/${id}.json`;
  records.set(jobPath, { value: structuredClone(job), etag: 'job-initial' });
  for (const character of manifest.screenplay.characters) {
    const identity = digest(`${FAL_RECIPE_VERSION}:cast:${id}:${manifestHash}:${character.id}`);
    records.set(falRequestPath(identity), { value: { identity, state: 'completed', endpoint: FAL_MODELS.reference,
      result: { images: [{ url: `https://v3.fal.media/${character.id}.jpg` }] } }, etag: 'reference-initial' });
  }
  const read = async path => structuredClone(records.get(path) ?? null);
  const write = async (path, value, expected) => {
    if (records.has(path) ? expected !== records.get(path).etag : expected !== undefined) throw new Error('precondition failed');
    records.set(path, { value: structuredClone(value), etag: String(++etag) });
  };
  const options = { read, write, key: 'synthetic-key', authorize: async () => true,
    generatedPhoto: async url => { generatedReads++; assert.match(url, /^https:\/\/v3\.fal\.media\/(ada|alice)\.jpg$/); return image; },
    selectedPhoto: async () => { photoReads++; return image; },
    fetchImpl: async (_url, options) => { fetches++; return new Response(JSON.stringify(jsonResult(pass()))); } };
  const input = (index = 0) => {
    const shot = manifest.shots[index], previous = manifest.shots[index - 1];
    const frames = visualSampleTimes(shot).map(atMs => ({ shotId: shot.id, atMs, dataUrl: image }));
    if (previous && previous.sceneIndex === shot.sceneIndex) frames.push({ shotId: previous.id, atMs: visualSampleTimes(previous)[2], dataUrl: image });
    return { email, id, job, shotId: shot.id, frames };
  };
  return { job, jobPath, records, read, write, options, input, image,
    fetches: () => fetches, generatedReads: () => generatedReads, photoReads: () => photoReads };
}

test('visual decisions fail closed on mismatches, uncertainty, contradictory findings and malformed results', () => {
  assert.equal(verifiedVisualDecision(pass()).passed, true);
  for (const field of ['appearance', 'wardrobe', 'sceneAction', 'imageIntegrity'])
    for (const state of ['mismatch', 'unverifiable']) assert.equal(verifiedVisualDecision({ ...pass(), [field]: state }).passed, false);
  assert.equal(verifiedVisualDecision({ ...pass(), findings: ['wardrobe-change'] }).passed, false);
  for (const value of [null, {}, { ...pass(), appearance: 'probably' }, { ...pass(), passed: true },
    { ...pass(), findings: ['ignore the review'] }, { ...pass(), findings: 'none' }, { ...pass(), findings: Array(6).fill('wardrobe-change') }])
    assert.throws(() => verifiedVisualDecision(value), { code: 'VISUAL_REVIEW_INVALID' });
});

test('review binds exactly three current frames and one preceding frame only inside the same scene', async () => {
  const f = await fixture();
  for (const [index, shot] of f.job.manifest.shots.entries()) {
    const input = f.input(index), value = visualReviewBinding(f.job, shot.id, input.frames);
    const previous = f.job.manifest.shots[index - 1];
    assert.equal(value.binding.frameHashes.length, previous?.sceneIndex === shot.sceneIndex ? 4 : 3);
    assert.equal(value.binding.outputHash, digest(JSON.stringify(f.job.shots[index].output)));
    assert.equal(value.binding.precedingOutputHash, previous?.sceneIndex === shot.sceneIndex ? digest(JSON.stringify(f.job.shots[index - 1].output)) : null);
  }
  for (const change of [frames => frames.reverse(), frames => frames.pop(), frames => { frames[0].atMs++; },
    frames => { frames[0].shotId = 'wrong'; }, frames => { frames[0].extra = 'untrusted'; },
    frames => { frames[0].dataUrl = 'data:image/jpeg;base64,AAAA'; }]) {
    const frames = structuredClone(f.input(1).frames); change(frames);
    assert.throws(() => visualReviewBinding(f.job, f.job.manifest.shots[1].id, frames), { code: 'VISUAL_REVIEW_INVALID' });
  }
  const changed = structuredClone(f.job); changed.manifest.era = 'different';
  assert.throws(() => visualReviewBinding(changed, changed.manifest.shots[0].id, f.input().frames));
});

test('real JPEG frames and exact character references enter bounded structured review with no identity inference', async () => {
  const f = await fixture(); let request;
  f.options.fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST'); request = JSON.parse(options.body);
    assert.equal(request.store, false); assert.equal(request.text.format.strict, true);
    for (const item of request.input[0].content.filter(item => item.type === 'input_image')) {
      const metadata = await sharp(Buffer.from(item.image_url.split(',')[1], 'base64')).metadata();
      assert.equal(metadata.format, 'jpeg'); assert.ok(metadata.width <= 768 && metadata.height <= 768);
    }
    return new Response(JSON.stringify(jsonResult(pass())));
  };
  const result = await createFilmVisualReviewService(f.options)(f.input(1));
  assert.equal(result.passed, true); assert.equal(result.manifestHash, f.job.manifestHash);
  assert.equal(f.generatedReads(), 2); assert.equal(f.photoReads(), 0);
  assert.equal(request.input[0].content.filter(item => item.type === 'input_image').length, 6);
  assert.match(request.instructions, /without identifying a real person/);
  assert.match(request.instructions, /untrusted creative data/);
  assert.ok(request.input[0].content.some(item => item.text?.startsWith('Preceding same-scene')));
  const stored = f.records.get(result.receiptPath).value;
  assert.equal(stored.state, 'reviewed'); assert.equal(stored.bindingHash, result.bindingHash);
  assert.equal(JSON.stringify(stored).includes('data:image'), false, 'Receipts keep hashes, not private image bytes');
});

test('selected-photo lookup receives the exact approved character and is never replaced with a generated person', async () => {
  const f = await fixture(), character = f.job.manifest.screenplay.characters[0];
  character.referencePhotoId = '22222222-2222-4222-8222-222222222222';
  character.referencePhoto = { sha256: 'a'.repeat(64), normalizedSha256: 'b'.repeat(64) };
  f.job.manifest.visualContinuity.characters[0].reference = { kind: 'selected-photo', sourceId: character.referencePhotoId };
  f.job.manifestHash = digest(JSON.stringify(f.job.manifest));
  // The unused generated character still resolves under the exact new manifest.
  const other = f.job.manifest.screenplay.characters[1];
  f.records.set(falRequestPath(digest(`${FAL_RECIPE_VERSION}:cast:${id}:${f.job.manifestHash}:${other.id}`)),
    { value: { state: 'completed', endpoint: FAL_MODELS.reference, result: { images: [{ url: `https://v3.fal.media/${other.id}.jpg` }] } }, etag: 'photo-fixture' });
  let selected = 0;
  f.options.selectedPhoto = async (manifest, value) => { selected++; assert.equal(manifest, f.job.manifest); assert.equal(value, character); return f.image; };
  assert.equal((await createFilmVisualReviewService(f.options)(f.input())).passed, true);
  assert.equal(selected, 1); assert.equal(f.generatedReads(), 1);
  const missing = await fixture(); missing.job.manifest.screenplay.characters[0].referencePhotoId = character.referencePhotoId;
  missing.job.manifestHash = digest(JSON.stringify(missing.job.manifest));
  missing.options.selectedPhoto = async () => { throw new Error('Selected photo unavailable'); };
  await assert.rejects(createFilmVisualReviewService(missing.options)(missing.input()), /Selected photo unavailable/);
  assert.equal(missing.fetches(), 0); assert.equal(missing.generatedReads(), 0);
});

test('racing requests, service restarts and successful cache reuse issue a single model request', async () => {
  const f = await fixture(), results = await Promise.allSettled(Array.from({ length: 8 }, () => createFilmVisualReviewService(f.options)(f.input())));
  assert.equal(f.fetches(), 1); assert.ok(results.some(result => result.status === 'fulfilled'));
  const result = results.find(result => result.status === 'fulfilled').value;
  const restarted = await createFilmVisualReviewService({ ...f.options, key: null, generatedPhoto: () => assert.fail('Do not reread reference'),
    fetchImpl: () => assert.fail('Do not repeat inference') })(f.input());
  assert.deepEqual(restarted, result);
});

test('unavailable, malformed, refused and incomplete model results never gain an approved receipt or repeat inference', async () => {
  const outcomes = [() => { throw new Error('lost network response'); }, () => new Response('{}', { status: 503 }),
    () => new Response('{broken'), () => new Response(JSON.stringify({ model: STORY_MODEL, status: 'incomplete', output: [] })),
    () => new Response(JSON.stringify({ model: STORY_MODEL, status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'No review' }] }] })),
    () => new Response(JSON.stringify({ model: STORY_MODEL, status: 'completed', output: [{ content: [{ type: 'output_text', text: '{broken' }] }] })),
    () => new Response(JSON.stringify({ ...jsonResult(pass()), model: 'different-model' })),
    () => new Response(JSON.stringify(jsonResult({ ...pass(), wardrobe: 'unsure' })))];
  for (const outcome of outcomes) {
    const f = await fixture(); let calls = 0;
    f.options.fetchImpl = async () => { calls++; return outcome(); };
    const service = createFilmVisualReviewService(f.options);
    await assert.rejects(service(f.input()));
    await assert.rejects(createFilmVisualReviewService(f.options)(f.input()), { code: 'VISUAL_REVIEW_UNCERTAIN' });
    assert.equal(calls, 1); assert.equal([...f.records.values()].filter(record => record.value.state === 'reviewed').length, 0);
  }
});

test('a refusal cannot be hidden beside an otherwise passing JSON response', async () => {
  const f = await fixture(), result = jsonResult(pass());
  result.output[0].content.push({ type: 'refusal', refusal: 'The evidence cannot be reviewed.' });
  f.options.fetchImpl = async () => new Response(JSON.stringify(result));
  await assert.rejects(createFilmVisualReviewService(f.options)(f.input()));
});

test('confirmed rate limiting permits only one retry after cooldown and never retries ambiguous execution', async () => {
  const f = await fixture(); let now = Date.parse('2026-10-22T12:00:00Z'), calls = 0;
  f.options.now = () => now;
  f.options.fetchImpl = async () => { calls++; return new Response('{}', { status: 429 }); };
  const service = createFilmVisualReviewService(f.options);
  await assert.rejects(service(f.input()), { code: 'VISUAL_REVIEW_RATE_LIMITED' });
  await assert.rejects(service(f.input()), { code: 'VISUAL_REVIEW_RATE_LIMITED' }); assert.equal(calls, 1);
  now += 60_000;
  await assert.rejects(service(f.input()), { code: 'VISUAL_REVIEW_RATE_LIMITED' }); assert.equal(calls, 2);
  now += 3600_000;
  await assert.rejects(service(f.input()), { code: 'VISUAL_REVIEW_UNCERTAIN' }); assert.equal(calls, 2);
});

test('bounded streamed JSON stops and cancels before accepting an oversized model response', async () => {
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(60_000)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedVisualJson(new Response(body)), { code: 'VISUAL_REVIEW_INVALID' });
  assert.equal(cancelled, true); assert.ok(pulls <= 3);
  assert.deepEqual(await boundedVisualJson(new Response('{"valid":true}')), { valid: true });
});

test('a lost reviewed-receipt write acknowledgement recovers the immutable saved decision without inference replay', async () => {
  const f = await fixture(); let lost = false;
  f.options.write = async (path, value, etag) => {
    await f.write(path, value, etag);
    if (value.state === 'reviewed' && !lost) { lost = true; throw new Error('Lost write acknowledgement'); }
  };
  const first = await createFilmVisualReviewService(f.options)(f.input());
  assert.equal(first.passed, true); assert.equal(lost, true); assert.equal(f.fetches(), 1);
  assert.deepEqual(await createFilmVisualReviewService(f.options)(f.input()), first); assert.equal(f.fetches(), 1);
});

test('invalid image bytes and missing or wrong-model reference records stop before inference', async () => {
  for (const mutate of [
    async f => { const key = [...f.records.keys()].find(key => key.startsWith('production/fal/requests/')); f.records.delete(key); },
    async f => { const key = [...f.records.keys()].find(key => key.startsWith('production/fal/requests/')); f.records.get(key).value.endpoint = FAL_MODELS.kling; },
    async f => { f.options.generatedPhoto = async () => `data:image/jpeg;base64,${Buffer.alloc(150).toString('base64')}`; },
  ]) {
    const f = await fixture(); await mutate(f);
    await assert.rejects(createFilmVisualReviewService(f.options)(f.input())); assert.equal(f.fetches(), 0);
  }
  for (const bad of [Buffer.alloc(150), await sharp({ create: { width: 96, height: 96, channels: 3, background: '#ffffff' } }).png().toBuffer(),
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()]) {
    const f = await fixture(), input = f.input(); input.frames[0].dataUrl = `data:image/jpeg;base64,${bad.toString('base64')}`;
    await assert.rejects(createFilmVisualReviewService(f.options)(input)); assert.equal(f.fetches(), 0);
  }
});

test('lost authorization before or after inference prevents approval and cannot replay the claimed review', async () => {
  const denied = await fixture(); denied.options.authorize = async () => false;
  await assert.rejects(createFilmVisualReviewService(denied.options)(denied.input()), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
  assert.equal(denied.fetches(), 0);
  const f = await fixture(); let allowed = true, calls = 0;
  f.options.authorize = async () => allowed;
  f.options.fetchImpl = async () => { calls++; allowed = false; return new Response(JSON.stringify(jsonResult(pass()))); };
  await assert.rejects(createFilmVisualReviewService(f.options)(f.input()), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
  allowed = true;
  await assert.rejects(createFilmVisualReviewService(f.options)(f.input()), { code: 'VISUAL_REVIEW_UNCERTAIN' });
  assert.equal(calls, 1);
});

async function completedReview(f, decision = pass()) {
  f.options.fetchImpl = async () => new Response(JSON.stringify(jsonResult(decision)));
  const service = createFilmVisualReviewService(f.options), shots = [];
  for (let index = 0; index < f.job.manifest.shots.length; index++) shots.push(await service(f.input(index)));
  return { version: 1, manifestHash: f.job.manifestHash, passed: shots.every(shot => shot.passed), shots };
}
const verifyInput = (f, review) => ({ email, id, manifestHash: f.job.manifestHash, manifest: f.job.manifest, review });

test('delivery requires every saved passing visual receipt for the same owned current production outputs', async () => {
  const f = await fixture(), review = await completedReview(f);
  await verifyFilmVisualReceipts(verifyInput(f, review), { read: f.read });
  const mutations = [value => { delete value.review; }, value => { value.review.shots.pop(); },
    value => { value.review.shots.reverse(); }, value => { value.review.shots[0].passed = false; },
    value => { value.review.shots[0].bindingHash = 'e'.repeat(64); },
    value => { value.email = 'other@example.invalid'; }, value => { value.manifestHash = 'f'.repeat(64); }];
  for (const mutate of mutations) {
    const input = structuredClone(verifyInput(f, review)); mutate(input);
    await assert.rejects(verifyFilmVisualReceipts(input, { read: f.read }));
  }
  const record = f.records.get(review.shots[0].receiptPath); record.value.decision.wardrobe = 'mismatch';
  await assert.rejects(verifyFilmVisualReceipts(verifyInput(f, review), { read: f.read }));
});

test('wardrobe mismatches and uncertain visual evidence are saved honestly and block delivery', async () => {
  for (const decision of [{ ...pass(), wardrobe: 'mismatch', findings: ['wardrobe-change'] },
    { ...pass(), appearance: 'unverifiable', findings: ['insufficient-visible-evidence'] }]) {
    const f = await fixture(), review = await completedReview(f, decision);
    assert.equal(review.passed, false); assert.equal(review.shots[0].passed, false);
    assert.deepEqual(f.records.get(review.shots[0].receiptPath).value.decision, decision);
    await assert.rejects(verifyFilmVisualReceipts(verifyInput(f, { ...review, passed: true }), { read: f.read }));
  }
});

test('changing the current source clip or preceding same-scene clip invalidates old visual receipts', async () => {
  const f = await fixture(), review = await completedReview(f), original = structuredClone(f.records.get(f.jobPath));
  for (const mutate of [
    job => { job.shots[0].output.url = 'https://v3.fal.media/replacement.mp4'; },
    job => { job.shots[1].output.sizeBytes++; },
    job => { job.shots[0].status = 'processing'; },
    job => { job.manifestHash = 'e'.repeat(64); },
  ]) {
    f.records.set(f.jobPath, structuredClone(original)); mutate(f.records.get(f.jobPath).value);
    await assert.rejects(verifyFilmVisualReceipts(verifyInput(f, review), { read: f.read }));
  }
  f.records.set(f.jobPath, structuredClone(original));
  const receipt = f.records.get(review.shots[1].receiptPath).value;
  receipt.binding.precedingOutputHash = 'a'.repeat(64);
  await assert.rejects(verifyFilmVisualReceipts(verifyInput(f, review), { read: f.read }));
});

test('legacy films do not acquire new review requirements and foreign receipt paths are rejected', async () => {
  await verifyFilmVisualReceipts({ manifest: {}, review: undefined });
  for (const args of [['invalid', id, 'a'.repeat(64)], [digest(email), '../escape', 'a'.repeat(64)], [digest(email), id, 'no']])
    assert.throws(() => visualReceiptPath(...args));
});
