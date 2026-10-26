import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { digest } from '../api/_lib/auth.mjs';
import { FAL_MODELS, createFalClient } from '../api/_lib/fal-client.mjs';
import { createFalProductionAdapter, falAdapterForSavedProvider, falPlan, falShotInput,
  characterReferenceInput, characterAlternateReferenceInput, FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { FILM_PERFORMANCE_RECIPE, KLING_VOICES, validateFilmPerformance, validatePerformanceOutput } from '../api/_lib/film-performance.mjs';
import { planKlingShots } from '../api/_lib/kling-film-plan.mjs';
import { filmOverlayAss } from '../scripts/assemble-film.mjs';
import { savedOverlays, stripFilmOverlayDirectives } from '../api/_lib/film-overlay-directives.mjs';

// All requests, grants, prices, media metadata and qualification here are
// synthetic. This exercises durable contracts, not live lip-sync quality.
const at = Date.parse('2026-10-26T00:00:00Z');
const qualification = { version: 2, model: 'kling', endpoint: FAL_MODELS.kling, recipeVersion: FAL_RECIPE_VERSION,
  commercialUse: true, commercialUseSource: `https://fal.ai/models/${FAL_MODELS.kling}`,
  technicalSample: { requestId: 'fixture-request-123', mediaSha256: 'b'.repeat(64), durationMs: 5000,
    width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac', fullDecodePassed: true, browserPlaybackPassed: true, nativeAudio: true },
  qualityScope: 'technical-media-with-per-film-speech-gate', knownLimitations: ['Synthetic test only.'],
  requiredDeliveryChecks: ['full-decode', 'exact-duration', 'script-speech', 'private-artifact'], reviewedAt: new Date(at).toISOString() };
const rates = { videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000, referenceEditMicroUsd: 150000,
  speechMicroUsd: 7000, lipsyncMicroUsdPerSecond: 14000, lipsyncBillingIncrementSeconds: 5,
  pricingVersion: 'fixture-current', expiresAt: new Date(at + 86400000).toISOString() };
const urls = { front: 'https://v3.fal.media/front.jpg', alternate: 'https://v3.fal.media/alternate.jpg',
  source: 'https://v3.fal.media/source.mp4', synced: 'https://v3.fal.media/synced.mp4', audio: 'https://v3.fal.media/narration.mp3' };

function fixture(mode = 'dialogue', seconds = 5) {
  const text = mode === 'silent' ? '' : 'We will share the harvest.';
  const scene = { characterIds: ['ada'], visual: 'Ada stands beside a workbench in a timber greenhouse. Sunlight crosses planted beds.',
    narration: mode === 'narration' ? text : '', dialogue: mode === 'dialogue' ? `Ada: ${text}` : '' };
  const base = { version: 1, filmId: 'synthetic-film', era: '1832', style: 'Documentary', targetDurationSeconds: seconds,
    performance: { version: 1, recipe: FILM_PERFORMANCE_RECIPE, narratorVoiceId: KLING_VOICES[0].id },
    screenplay: { logline: 'A fictional family shares its harvest.', characters: [{ id: 'ada', name: 'Ada',
      description: 'An adult with dark hair tied low.', wardrobe: 'Green apron over a cream shirt, no tie.', voiceId: KLING_VOICES[1].id,
      sourceIds: [] }], scenes: [scene] },
    shots: [{ id: 'shot-001', sceneIndex: 0, startMs: 0, targetDurationMs: seconds * 1000, ...scene,
      dramatization: 'Fictional scene; no historical claims.' }] };
  const manifest = planKlingShots(base);
  assert.equal(validateFilmPerformance(manifest), true);
  return { manifest, manifestHash: digest(JSON.stringify(manifest)), shot: manifest.shots[0],
    productionId: 'synthetic-production', idempotencyKey: digest(`fixture-shot-${mode}`), authorizeSpend: async () => true };
}
function harness(input = fixture()) {
  const records = new Map(), submitted = [], heads = []; let grants = 0, allowed = true;
  const client = {
    get: async id => records.get(id),
    submit: async request => { submitted.push(request); const value = { ...request, state: 'queued', requestId: `fixture-request-${submitted.length}` };
      records.set(request.identity, value); return value; },
    poll: async id => { const value = records.get(id); value.state = 'completed';
      value.result = value.endpoint === FAL_MODELS.reference ? { images: [{ url: urls.front }] }
        : value.endpoint === FAL_MODELS.referenceEdit ? { images: [{ url: urls.alternate }] }
          : value.endpoint === FAL_MODELS.lipsync ? { video: { url: urls.synced } }
            : value.endpoint === FAL_MODELS.speech ? { audio: { url: urls.audio } } : { video: { url: urls.source } };
      return value; }
  };
  const options = { client, qualification, key: 'synthetic', now: () => at, pricing: async () => rates, read: async () => null,
    normalizeKlingReference: async url => url,
    fetchImpl: async (url, init) => { heads.push({ url, init }); return new Response(null, {
      headers: { 'content-type': url === urls.audio ? 'audio/mpeg' : 'video/mp4', 'content-length': '100' } }); } };
  input.authorizeSpend = async () => { grants++; return allowed; };
  return { input, records, submitted, heads, options, adapter: createFalProductionAdapter(options),
    grants: () => grants, allow: value => { allowed = value; },
    async finish(adapter = this.adapter) { for (let i = 0; i < 8; i++) { const result = await adapter.pollShot(input);
      if (result.status === 'completed') return result; } assert.fail('Fixture did not finish'); } };
}

test('new recipe uses paired character elements, approved wardrobe, no generated text, and no native voice IDs', () => {
  const { manifest, shot } = fixture(), before = JSON.stringify(manifest);
  const body = falShotInput(manifest, shot, 'kling', { ada: urls.front }, { ada: urls.alternate });
  assert.deepEqual(body.elements, [{ frontal_image_url: urls.front, reference_image_urls: [urls.alternate] }]);
  assert.equal(body.generate_audio, false); assert.equal(body.duration, '5');
  for (const field of ['image_urls', 'voice_id', 'voice_ids']) assert.equal(body[field], undefined);
  assert.match(body.prompt, /@Element1 Ada/); assert.match(body.prompt, /Green apron over a cream shirt/);
  assert.match(body.prompt, /approved wardrobe overrides reference clothing/); assert.match(body.prompt, /only this face is visible/);
  assert.match(body.prompt, /foreground, middle distance and background/); assert.match(body.prompt, /No generated writing anywhere/);
  assert.match(characterReferenceInput(manifest, manifest.screenplay.characters[0]).prompt, /face straight toward camera/);
  assert.match(characterReferenceInput(manifest, manifest.screenplay.characters[0]).prompt, /Green apron over a cream shirt/);
  const edit = characterAlternateReferenceInput(manifest, manifest.screenplay.characters[0], urls.front);
  assert.deepEqual(edit.image_urls, [urls.front]); assert.equal(edit.resolution, '1K'); assert.equal(edit.num_images, 1);
  assert.equal(edit.enable_web_search, false); assert.match(edit.prompt, /wardrobe overrides the reference clothing/);
  assert.equal(JSON.stringify(manifest), before);
  assert.throws(() => falShotInput(manifest, shot, 'kling', { ada: urls.front }));
  assert.throws(() => falShotInput(manifest, shot, 'kling', { ada: urls.front }, { ada: urls.front }));
});

test('dialogue completes only after durable sync; exact stock voice/text and source/final provenance are bound', async () => {
  const h = harness();
  for (const expected of ['processing', 'processing', 'queued', 'queued']) assert.equal((await h.adapter.pollShot(h.input)).status, expected);
  assert.equal(h.submitted.length, 4);
  assert.deepEqual(h.submitted.map(value => value.endpoint), [FAL_MODELS.reference, FAL_MODELS.referenceEdit, FAL_MODELS.kling, FAL_MODELS.lipsync]);
  const body = h.submitted[3].input;
  assert.deepEqual(body, { video_url: urls.source, text: h.input.shot.performance.text, voice_id: KLING_VOICES[1].id,
    voice_language: 'en', voice_speed: 1, enable_safety_checker: true });
  const result = await createFalProductionAdapter(h.options).reconcileShot(h.input);
  assert.equal(result.status, 'completed'); assert.equal(result.output.url, urls.synced); assert.equal(result.output.audio, undefined);
  assert.equal(result.output.performance.sourceVideoUrlSha256, digest(urls.source));
  assert.equal(result.output.performance.outputVideoUrlSha256, digest(urls.synced));
  assert.equal(result.output.performance.videoOperationId, h.submitted[2].identity);
  assert.equal(result.output.performance.speechOperationId, h.submitted[3].identity);
  validatePerformanceOutput(h.input.manifest, h.input.shot, result.output);
  assert.equal(h.grants(), 4);
  await h.adapter.reconcileShot(h.input); assert.equal(h.submitted.length, 4); assert.equal(h.grants(), 4);
  assert.ok(h.heads.every(({ init }) => init.method === 'HEAD' && init.redirect === 'error' && init.credentials === 'omit'));
});

test('narration/action cuts derive varied camera direction from saved scenePart while dialogue keeps its clear-face setup', () => {
  for (const mode of ['narration', 'silent']) {
    const { manifest, shot } = fixture(mode), prompts = [];
    for (let part = 1; part <= 5; part++) {
      shot.scenePart = part;
      prompts.push(falShotInput(manifest, shot, 'kling', { ada: urls.front }, { ada: urls.alternate }).prompt);
    }
    assert.match(prompts[0], /Wide establishing view/); assert.match(prompts[1], /Medium action view/);
    assert.match(prompts[2], /Environmental or hand-detail insert/); assert.match(prompts[3], /Restrained lateral camera view/);
    assert.equal(new Set(prompts.slice(0, 4)).size, 4); assert.equal(prompts[0], prompts[4]);
    for (const prompt of prompts) { assert.ok(prompt.includes(shot.visual)); assert.match(prompt, /No new location or person/); }
  }
  const { manifest, shot } = fixture(); shot.scenePart = 3;
  const prompt = falShotInput(manifest, shot, 'kling', { ada: urls.front }, { ada: urls.alternate }).prompt;
  assert.match(prompt, /only this face is visible/); assert.doesNotMatch(prompt, /Environmental or hand-detail insert/);
});

test('exact application titles are preserved in ASS and saved visuals but excluded from new provider prompts', () => {
  const { manifest, shot } = fixture();
  const visual = 'A physician examines the approved manuscript. Opening title: “The Long Road”. '
    + 'Small location title: Dr. A. B. Example, 1972. Title card: Mr. Example and Dr. Jones. '
    + 'End card: “Their shared legacy”. On-screen text: “A new season”. '
    + 'Overlay identifies examples from their career: “A careful study”. Small location caption: “The old clinic”. '
    + 'The window curtains move in the breeze.';
  shot.visual = visual; manifest.screenplay.scenes[0].visual = visual; manifest.visualContinuity.scenes[0].direction = visual;
  const before = JSON.stringify(manifest), overlays = savedOverlays(visual), ass = filmOverlayAss(manifest);
  const prompt = falShotInput(manifest, shot, 'kling', { ada: urls.front }, { ada: urls.alternate }).prompt;
  assert.equal(overlays.length, 7);
  for (const overlay of overlays) { assert.ok(ass.includes(overlay.text)); assert.ok(!prompt.includes(overlay.text), overlay.text); }
  assert.ok(ass.includes('Dr. A. B. Example, 1972.')); assert.ok(ass.includes('Mr. Example and Dr. Jones.'));
  assert.match(prompt, /A physician examines the approved manuscript/); assert.match(prompt, /The window curtains move in the breeze/);
  assert.doesNotMatch(prompt, /Opening title:|Title card:|End card:|Small location caption:/i);
  assert.equal(JSON.stringify(manifest), before);
});

test('overlay stripping preserves ordinary historical document prose, unknown directions and unaccepted text', () => {
  for (const prose of [
    'A hand holds a handwritten letter bearing the words “Dear friend”. The page edges show age.',
    'A volume has a title: “The Family Record” and a worn leather cover.',
    'The story includes a title and an end card without supplied text.',
    'An unknown direction: “A historical document”.',
    `Opening title: “${'x'.repeat(161)}”`,
  ]) assert.equal(stripFilmOverlayDirectives(prose), prose);
  assert.equal(stripFilmOverlayDirectives('Opening title: “The title: A fictional story.” Caption: “Another title”. A garden.'), ' . A garden.');
});

test('narration uses selected stock TTS with separate bounded audio; silent cuts never buy speech', async () => {
  for (const mode of ['narration', 'silent']) {
    const h = harness(fixture(mode)), result = await h.finish();
    assert.equal(result.output.url, urls.source);
    assert.equal(h.submitted.some(value => value.endpoint === FAL_MODELS.lipsync), false);
    if (mode === 'narration') {
      const speech = h.submitted.find(value => value.endpoint === FAL_MODELS.speech);
      assert.equal(speech.input.voice_id, h.input.manifest.performance.narratorVoiceId);
      assert.equal(speech.input.text, h.input.shot.performance.text);
      assert.deepEqual(result.output.audio, { url: urls.audio, sizeBytes: 100, contentType: 'audio/mpeg', durationSeconds: 5 });
      assert.equal(result.output.performance.audioUrlSha256, digest(urls.audio));
      assert.equal(h.submitted.length, 4);
    } else { assert.equal(result.output.audio, undefined); assert.equal(result.output.performance.speechOperationId, null); assert.equal(h.submitted.length, 3); }
    validatePerformanceOutput(h.input.manifest, h.input.shot, result.output);
  }
});

test('each alternate and sync stage checks current spending permission, and denied grants create no request', async () => {
  const h = harness(); await h.adapter.submitShot(h.input); h.allow(false);
  await assert.rejects(h.adapter.pollShot(h.input), /spending is not authorized/); assert.equal(h.submitted.length, 1);
  h.allow(true); await h.adapter.pollShot(h.input); await h.adapter.pollShot(h.input);
  h.allow(false); await assert.rejects(h.adapter.pollShot(h.input), /spending is not authorized/);
  assert.equal(h.submitted.length, 3); assert.equal(h.submitted.some(value => value.endpoint === FAL_MODELS.lipsync), false);
});

test('selected original photographs are preserved as the front element, priced only for the alternate, and never replaced when missing', async () => {
  const input = fixture(), sourceId = '11111111-1111-4111-8111-111111111111';
  const original = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#4c6345' } }).jpeg().toBuffer();
  const data = `data:image/jpeg;base64,${original.toString('base64')}`;
  const character = input.manifest.screenplay.characters[0];
  character.referencePhotoId = sourceId; character.sourceIds = [sourceId];
  character.referencePhoto = { version: 1, sourceId, ownerHash: digest('synthetic-owner'), sha256: digest(original), normalizedSha256: digest(original),
    contentType: 'image/jpeg', sizeBytes: original.length, etag: 'synthetic-etag', normalization: 'jpeg-1600-q90-v1' };
  input.manifest.sources = [{ id: sourceId, type: 'image/jpeg' }];
  input.manifest.visualContinuity.characters[0].reference = { kind: 'selected-photo', sourceId };
  input.manifestHash = digest(JSON.stringify(input.manifest));
  const before = JSON.stringify(input.manifest), h = harness(input);
  h.options.selectedPhoto = async (_manifest, selected) => { assert.equal(selected, character); return data; };
  const adapter = createFalProductionAdapter(h.options), quote = await adapter.quote(input);
  assert.equal(quote.providerCostCents, 97); // $0.75 video + $0.15 alternate + $0.07 sync; no invented front.
  const result = await h.finish(adapter); assert.equal(result.status, 'completed');
  assert.deepEqual(h.submitted.map(value => value.endpoint), [FAL_MODELS.referenceEdit, FAL_MODELS.kling, FAL_MODELS.lipsync]);
  assert.deepEqual(h.submitted[0].input.image_urls, [data]); assert.equal(h.submitted[1].input.elements[0].frontal_image_url, data);
  assert.equal(JSON.stringify(input.manifest), before);
  const missing = harness(input);
  missing.options.selectedPhoto = async () => { throw Error('Selected original is unavailable'); };
  await assert.rejects(createFalProductionAdapter(missing.options).submitShot(input), /Selected original/);
  assert.equal(missing.submitted.length, 0); assert.equal(missing.grants(), 0);
});

test('uncertain or failed alternate/speech stays terminal without raw-video success or another paid submission', async () => {
  for (const endpoint of [FAL_MODELS.referenceEdit, FAL_MODELS.lipsync, FAL_MODELS.speech]) for (const state of ['uncertain', 'submitting', 'failed']) {
    const h = harness(fixture(endpoint === FAL_MODELS.speech ? 'narration' : 'dialogue'));
    for (let i = 0; i < 5 && !h.submitted.some(value => value.endpoint === endpoint); i++) await h.adapter.pollShot(h.input);
    const operation = h.submitted.find(value => value.endpoint === endpoint), saved = h.records.get(operation.identity);
    saved.state = state; delete saved.requestId;
    const count = h.submitted.length, grantCount = h.grants();
    for (let i = 0; i < 2; i++) {
      const result = await createFalProductionAdapter(h.options).reconcileShot(h.input);
      assert.equal(result.status, state === 'failed' ? 'failed' : 'uncertain'); assert.equal(result.output, undefined);
    }
    assert.equal(h.submitted.length, count); assert.equal(h.grants(), grantCount);
  }
});

test('saved sync operations reconcile without downloading an expired original source or submitting again', async () => {
  for (const pending of [false, true]) {
    const h = harness(); for (let i = 0; i < 4; i++) await h.adapter.pollShot(h.input);
    const count = h.submitted.length, grantCount = h.grants();
    if (pending) h.options.client.poll = async id => {
      const saved = h.records.get(id); assert.equal(saved.endpoint, FAL_MODELS.lipsync);
      saved.state = 'processing'; return saved;
    };
    h.options.fetchImpl = async url => { assert.equal(url, urls.synced, 'the expired original is not needed after sync was journaled');
      return new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '100' } }); };
    const result = await createFalProductionAdapter(h.options).reconcileShot(h.input);
    assert.equal(result.status, pending ? 'processing' : 'completed');
    assert.equal(result.output?.url, pending ? undefined : urls.synced);
    assert.equal(h.submitted.length, count); assert.equal(h.grants(), grantCount);
  }
});

test('new quote prices one alternate per used character and rounds each dialogue clip to five-second units', async () => {
  for (const [mode, seconds, expected] of [['dialogue', 7, 164], ['narration', 5, 121], ['silent', 5, 120]]) {
    const input = fixture(mode, seconds); let pricingOptions;
    const adapter = createFalProductionAdapter({ qualification, now: () => at, pricing: async (model, options) => { pricingOptions = options; return rates; } });
    const plan = falPlan(input.manifest, 'kling'), quote = await adapter.quote(input);
    assert.equal(plan.referenceEditCount, 1); assert.equal(quote.providerCostCents, expected);
    assert.deepEqual(pricingOptions, { performance: true }); assert.equal(adapter.modelVersion, FAL_RECIPE_VERSION);
    assert.equal(adapter.recipeForManifest(input.manifest), FILM_PERFORMANCE_RECIPE);
    assert.equal(falAdapterForSavedProvider({ id: 'fal', model: 'kling', recipe: FILM_PERFORMANCE_RECIPE }).recipeForManifest(input.manifest), FILM_PERFORMANCE_RECIPE);
  }
});

test('new pricing rejects missing/changed billing basis and binds all reviewed rate fields in quote identity', async () => {
  const input = fixture();
  for (const mutation of [r => { delete r.speechMicroUsd; }, r => { r.referenceEditMicroUsd = -1; }, r => { r.lipsyncBillingIncrementSeconds = 1; }]) {
    const changed = { ...rates }; mutation(changed);
    const adapter = createFalProductionAdapter({ qualification, now: () => at, pricing: async () => changed });
    await assert.rejects(adapter.quote(input));
  }
  const quote = async r => createFalProductionAdapter({ qualification, now: () => at, pricing: async () => r }).quote(input);
  assert.notEqual((await quote(rates)).quoteReference, (await quote({ ...rates, speechMicroUsd: 8000 })).quoteReference);
});

test('new quotes require upgraded live worker; legacy worker heartbeat cannot accept new paid films', async () => {
  const input = fixture(), heartbeat = { recipe: FILM_PERFORMANCE_RECIPE, model: 'kling', ready: true, deliveryChecksVersion: 1,
    checkedAt: new Date(at).toISOString(), visualChecksVersion: 1 };
  const adapter = createFalProductionAdapter({ qualification, now: () => at, requireWorker: true, pricing: async () => rates,
    read: async path => { assert.equal(path, 'production/worker-health-performance-v1.json'); return { value: heartbeat }; } });
  await assert.rejects(adapter.quote(input), /voice and lip-sync/);
  heartbeat.filmPerformanceVersion = 1; await assert.rejects(adapter.quote(input), /voice and lip-sync/);
  heartbeat.visualChecksVersion = 2; assert.ok((await adapter.quote(input)).providerCostCents > 0);
  heartbeat.recipe = FAL_RECIPE_VERSION; await assert.rejects(adapter.quote(input), /temporarily unavailable/);
  heartbeat.recipe = FILM_PERFORMANCE_RECIPE; heartbeat.checkedAt = new Date(at - 180001).toISOString();
  await assert.rejects(adapter.quote(input), /temporarily unavailable/);
  heartbeat.checkedAt = new Date(at).toISOString(); input.manifest.sound = { musicRequested: true };
  input.manifestHash = digest(JSON.stringify(input.manifest));
  await assert.rejects(adapter.quote(input), /music production/);
  heartbeat.performanceMusicVersion = 1; assert.ok((await adapter.quote(input)).providerCostCents > 0);
});

test('invalid voice, extra dialogue face, missing elements and oversized complete prompts fail before spend', async () => {
  for (const mutate of [m => { m.shots[0].performance.voiceId = 'unapproved-voice'; }, m => { m.shots[0].characterIds.push('ada'); },
    m => { m.screenplay.characters[0].description = 'Detailed appearance. '.repeat(300); m.visualContinuity.characters[0].appearance = m.screenplay.characters[0].description; }]) {
    const input = fixture(); mutate(input.manifest); input.manifestHash = digest(JSON.stringify(input.manifest));
    const h = harness(input); await assert.rejects(h.adapter.submitShot(input)); assert.equal(h.submitted.length, 0); assert.equal(h.grants(), 0);
  }
});

test('new endpoint client allowlist retains one POST after uncertain transport and excludes unapproved speech endpoints', async () => {
  for (const endpoint of [FAL_MODELS.referenceEdit, FAL_MODELS.speech, FAL_MODELS.lipsync]) {
    const records = new Map(); let posts = 0, serial = 0;
    const options = { key: 'fixture', read: async path => structuredClone(records.get(path) || null),
      write: async (path, value, etag) => { if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw Error('precondition failed');
        records.set(path, { value: structuredClone(value), etag: String(++serial) }); },
      fetchImpl: async () => { posts++; throw Error('lost response'); } };
    const request = { identity: digest(endpoint), endpoint, input: { text: 'Fictional test.' } };
    assert.equal((await createFalClient(options).submit(request)).state, 'uncertain');
    assert.equal((await createFalClient(options).submit(request)).state, 'uncertain'); assert.equal(posts, 1);
    await assert.rejects(createFalClient(options).submit({ ...request, input: { text: 'Changed words.' } }), { code: 'FAL_IDEMPOTENCY_CONFLICT' });
  }
  const client = createFalClient({ fetchImpl: () => assert.fail('No unapproved request') });
  for (const endpoint of ['fal-ai/kling-video/lipsync/audio-to-video', 'fal-ai/kling-video/create-voice'])
    await assert.rejects(client.submit({ endpoint, identity: digest(endpoint), input: {} }), { code: 'FAL_MODEL_INVALID' });
});

test('racing workers and process restarts submit each paid stage once, including sync with a lost response', async () => {
  for (const lostSync of [false, true]) {
    const records = new Map(), remote = new Map(), posts = []; let serial = 0;
    const read = async path => structuredClone(records.get(path) || null);
    const write = async (path, value, etag) => { if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw Error('precondition failed');
      records.set(path, { value: structuredClone(value), etag: String(++serial) }); };
    const fetchImpl = async (url, init) => {
      if (init.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '100' } });
      if (init.method === 'POST') {
        const endpoint = new URL(url).pathname.slice(1), id = `fixture-request-${posts.length + 1}`;
        posts.push(endpoint); remote.set(id, endpoint);
        if (lostSync && endpoint === FAL_MODELS.lipsync) throw Error('Response lost after submission');
        const root = endpoint.split('/').slice(0, 2).join('/');
        return new Response(JSON.stringify({ request_id: id, status_url: `https://queue.fal.run/${root}/requests/${id}/status`, response_url: `https://queue.fal.run/${root}/requests/${id}` }));
      }
      if (url.endsWith('/status')) return new Response(JSON.stringify({ status: 'COMPLETED' }));
      const endpoint = remote.get(url.split('/').at(-1));
      return new Response(JSON.stringify(endpoint === FAL_MODELS.reference ? { images: [{ url: urls.front }] }
        : endpoint === FAL_MODELS.referenceEdit ? { images: [{ url: urls.alternate }] }
          : { video: { url: endpoint === FAL_MODELS.lipsync ? urls.synced : urls.source } }));
    };
    const input = fixture();
    const adapter = () => createFalProductionAdapter({ client: createFalClient({ read, write, fetchImpl, key: 'fixture' }), read,
      qualification, normalizeKlingReference: async url => url, fetchImpl });
    for (let phase = 0; phase < 8; phase++) await Promise.all(Array.from({ length: 8 }, () => adapter().pollShot(input)));
    assert.deepEqual(posts, [FAL_MODELS.reference, FAL_MODELS.referenceEdit, FAL_MODELS.kling, FAL_MODELS.lipsync]);
    const final = await adapter().reconcileShot(input);
    assert.equal(final.status, lostSync ? 'uncertain' : 'completed');
    assert.equal(final.output?.url, lostSync ? undefined : urls.synced);
  }
});

test('legacy reviewed-replacement metadata cannot bypass a separately priced new performance sync contract', async () => {
  const h = harness();
  const adapter = createFalProductionAdapter({ ...h.options, read: async () => ({ value: { version: 1, replacementIdentity: digest('replacement') } }) });
  await assert.rejects(adapter.submitShot(h.input)); assert.equal(h.submitted.length, 0); assert.equal(h.grants(), 0);
});

test('invalid sync output, oversized source and malformed narration metadata cannot become completed film output', async () => {
  for (const kind of ['oversized-source', 'wrong-final-type', 'bad-audio-host', 'bad-endpoint-binding']) {
    const h = harness(fixture(kind === 'bad-audio-host' ? 'narration' : 'dialogue'));
    if (kind === 'oversized-source') h.options.fetchImpl = async () => new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': String(101 * 1024 * 1024) } });
    if (kind === 'wrong-final-type') h.options.fetchImpl = async url => new Response(null, { headers: { 'content-type': url === urls.synced ? 'text/html' : 'video/mp4', 'content-length': '100' } });
    const poll = h.options.client.poll;
    h.options.client.poll = async id => { const saved = await poll(id);
      if (kind === 'bad-audio-host' && saved.endpoint === FAL_MODELS.speech) saved.result.audio.url = 'https://unapproved.invalid/audio.mp3';
      if (kind === 'bad-endpoint-binding' && saved.endpoint === FAL_MODELS.lipsync) saved.endpoint = FAL_MODELS.speech;
      return saved; };
    await assert.rejects(h.finish(createFalProductionAdapter(h.options)));
    if (kind === 'oversized-source') assert.equal(h.submitted.some(value => value.endpoint === FAL_MODELS.lipsync), false);
  }
});
