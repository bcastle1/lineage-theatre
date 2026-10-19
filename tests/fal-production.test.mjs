import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createFalClient, FAL_MODELS, falRequestUrl, falMediaUrl } from '../api/_lib/fal-client.mjs';
import { createFalProductionAdapter, falPlan, falShotInput, FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';

// All qualification, prices, requests and media here are synthetic test data.
// They are not live provider or customer-film completion evidence.
const at = Date.parse('2026-10-18T00:00:00Z');
const qualification = model => ({ version: 1, model, endpoint: FAL_MODELS[model], recipeVersion: FAL_RECIPE_VERSION,
  comparisonManifestHash: 'a'.repeat(64), deliveredMediaSha256: 'b'.repeat(64), commercialUse: true,
  review: { visual: true, speech: true, continuity: true, privatePlayback: true }, requestIds: ['fixture-request-123'],
  reviewedAt: new Date(at).toISOString(), rates: { expiresAt: new Date(at + 86400000).toISOString(), videoMicroUsdPerSecond: 1200000, referenceMicroUsd: 300000 } });
function storage() {
  const records = new Map(); let serial = 0;
  return { records, read: async path => structuredClone(records.get(path) || null),
    write: async (path, value, etag) => {
      if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw Error('precondition failed');
      records.set(path, { value: structuredClone(value), etag: String(++serial) });
    } };
}
const receipt = { request_id: 'fixture-request-123', status_url: 'https://queue.fal.run/alibaba/wan-3.0/requests/fixture-request-123/status',
  response_url: 'https://queue.fal.run/alibaba/wan-3.0/requests/fixture-request-123' };
const json = value => new Response(JSON.stringify(value));
const submit = { identity: digest('fictional request'), endpoint: FAL_MODELS.wan, input: { prompt: 'Fictional test.' } };

test('durable fal operations submit once across racing and restarted clients', async () => {
  const data = storage(); let posts = 0;
  const options = { ...data, key: 'fixture-key', fetchImpl: async () => { posts++; return json(receipt); } };
  const client = createFalClient(options);
  await Promise.all(Array.from({ length: 12 }, () => client.submit(submit)));
  assert.equal(posts, 1);
  const reused = await createFalClient(options).submit(submit);
  assert.equal(reused.requestId, receipt.request_id); assert.equal(posts, 1);
  await assert.rejects(client.submit({ ...submit, input: { prompt: 'Changed content' } }), { code: 'FAL_IDEMPOTENCY_CONFLICT' });
});

test('lost response or missing receipt never permits a second paid POST', async () => {
  for (const response of [() => { throw Error('timeout'); }, () => json({}), () => new Response('', { status: 402 })]) {
    const data = storage(); let posts = 0;
    const client = createFalClient({ ...data, key: 'fixture-key', fetchImpl: async () => { posts++; return response(); } });
    assert.equal((await client.submit(submit)).state, 'uncertain');
    assert.equal((await client.submit(submit)).state, 'uncertain');
    assert.equal((await client.poll(submit.identity)).state, 'uncertain'); assert.equal(posts, 1);
  }
});

test('receipt persistence retry never repeats submission', async () => {
  const data = storage(); let posts = 0, failures = 0;
  const client = createFalClient({ ...data, key: 'fixture-key', write: async (path, value, etag) => {
    if (value.requestId && failures++ === 0) throw Error('storage timeout');
    return data.write(path, value, etag);
  }, fetchImpl: async () => { posts++; return json(receipt); } });
  assert.equal((await client.submit(submit)).requestId, receipt.request_id); assert.equal(posts, 1);
});

test('missing configuration is detected before reserving a new paid operation', async () => {
  const data = storage(), client = createFalClient({ ...data, key: null, fetchImpl: () => assert.fail() });
  await assert.rejects(client.submit(submit), { code: 'FAL_KEY_REQUIRED' }); assert.equal(data.records.size, 0);
});

test('fal status and media URLs cannot forward credentials to arbitrary hosts or another request', () => {
  for (const url of ['https://evil.invalid/r', 'http://queue.fal.run/r', receipt.status_url + '?token=unsafe', receipt.status_url.replace('fixture-request-123', 'another-request-1'), receipt.status_url.replace('/alibaba/wan-3.0/', '/other/model/'), receipt.status_url.replace('https://', 'https://user:secret@')]) {
    assert.throws(() => falRequestUrl(url, FAL_MODELS.wan, receipt.request_id, 'status'));
  }
  assert.equal(falRequestUrl(receipt.status_url, FAL_MODELS.wan, receipt.request_id, 'status'), receipt.status_url);
  for (const url of ['https://fal.media.evil.invalid/file.mp4', 'http://v3.fal.media/file.mp4', 'https://127.0.0.1/file.mp4', 'https://user:secret@v3.fal.media/file.mp4']) assert.throws(() => falMediaUrl(url));
});

test('polling checks terminal provider errors and caches completed results', async () => {
  for (const failed of [false, true]) {
    const data = storage(), methods = [];
    const client = createFalClient({ ...data, key: 'fixture-key', fetchImpl: async (url, options) => {
      methods.push(options.method); assert.equal(options.redirect, 'error');
      if (options.method === 'POST') return json(receipt);
      if (url.endsWith('/status')) return json({ status: 'COMPLETED', request_id: receipt.request_id, ...(failed ? { error: 'fixture' } : {}) });
      return json({ video: { url: 'https://v3.fal.media/fixture.mp4' } });
    } });
    await client.submit(submit); assert.equal((await client.poll(submit.identity)).state, failed ? 'failed' : 'completed');
    await client.poll(submit.identity); assert.deepEqual(methods, failed ? ['POST', 'GET'] : ['POST', 'GET', 'GET']);
  }
});

test('a terminal size rejection is recorded without resubmitting or retaining untrusted details', async () => {
  const data=storage();let posts=0;
  const client=createFalClient({...data,key:'fixture',fetchImpl:async(url,options)=>{
    if(options.method==='POST'){posts++;return json(receipt);}
    return url.endsWith('/status')?json({status:'COMPLETED'}):new Response(JSON.stringify({detail:[{type:'file_too_large',input:'private-reference',msg:'untrusted'}]}),{status:422});
  }});
  await client.submit(submit);const result=await client.poll(submit.identity);
  assert.equal(result.state,'failed');assert.equal(result.failureCode,'FAL_REFERENCE_TOO_LARGE');assert.ok(!JSON.stringify(result).includes('private-reference'));
  await client.poll(submit.identity);assert.equal(posts,1);
});

test('both providers preserve exact speech, references, 1080p and rounded edit handles', () => {
  const { manifest } = buildFilmManifest(fictionalOperatorProject());
  for (const model of ['seedance', 'wan']) {
    const references = Object.fromEntries(manifest.screenplay.characters.map(c => [c.id, `https://v3.fal.media/${c.id}.png`]));
    const body = falShotInput(manifest, manifest.shots[0], model, references);
    assert.equal(body.resolution, '1080p'); assert.ok(body.prompt.includes(manifest.shots[0].narration));
    assert.ok(body.prompt.includes(manifest.shots[0].dialogue));
    assert.ok(Number(body.duration) * 1000 >= manifest.shots[0].targetDurationMs);
    assert.equal((body.image_urls || body.reference_image_urls).length, manifest.shots[0].characterIds.length);
  }
});

test('unsupported plans and missing quality evidence cannot enable production', async () => {
  const { manifest } = buildFilmManifest(fictionalOperatorProject());
  assert.equal(createFalProductionAdapter({ key: 'fixture-key', qualification: null }).available, false);
  for (const change of [m => { m.shots[0].targetDurationMs = 31000; }, m => { m.shots[0].characterIds = ['missing']; }, m => { m.shots[0].narration = 'word '.repeat(500); }, m => { m.shots[1].startMs++; }]) {
    const changed = structuredClone(manifest); change(changed); assert.throws(() => falPlan(changed, 'seedance'));
  }
  const q = qualification('wan'), adapter = createFalProductionAdapter({ model: 'wan', key: 'fixture-key', qualification: q, now: () => at, pricing: async () => q.rates });
  assert.equal(adapter.available, true);
  assert.equal((await adapter.validateManifest(manifest)).maximumCostCents,
    Math.ceil((falPlan(manifest, 'wan').generatedSeconds * 1200000 + 2 * 300000) / 10000));
});

test('reference and render stages require separate current spending approval and reuse saved requests', async () => {
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject());
  const operations = new Map(), submitted = []; let allowed = true, grantChecks = 0;
  const client = { get: async id => operations.get(id), submit: async request => {
    submitted.push(request); const value = { state: 'queued', requestId: `fixture-${submitted.length}`, ...request }; operations.set(request.identity, value); return value;
  }, poll: async id => { const value = operations.get(id); value.state = 'completed';
    value.result = value.endpoint === FAL_MODELS.reference ? { images: [{ url: 'https://v3.fal.media/reference.png' }] } : { video: { url: 'https://v3.fal.media/film.mp4' } }; return value; } };
  const adapter = createFalProductionAdapter({ model: 'wan', client, now: () => at, normalizeReference: async url => url, fetchImpl: async () => new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '100' } }) });
  const input = { manifest, manifestHash, shot: manifest.shots[0], productionId: 'fixture-production', idempotencyKey: digest('fixture-scene'), authorizeSpend: async () => { grantChecks++; return allowed; } };
  assert.equal((await adapter.submitShot(input)).status, 'queued'); assert.equal(submitted.length, 1);
  allowed = false; await assert.rejects(adapter.pollShot(input), /spending is not authorized/); assert.equal(submitted.length, 1);
  allowed = true; await adapter.pollShot(input); await adapter.pollShot(input); const result = await adapter.pollShot(input);
  assert.equal(result.status, 'completed'); assert.equal(submitted.length, 3); assert.equal(grantChecks, 4);
  await adapter.pollShot(input); assert.equal(submitted.length, 3);
  const peer = createFalProductionAdapter({ model: 'seedance', client, now: () => at });
  await peer.submitShot(input); assert.equal(submitted.filter(r => r.endpoint === FAL_MODELS.reference).length, 2);
});
