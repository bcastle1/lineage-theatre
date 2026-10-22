import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../api/_lib/auth.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { FAL_RECIPE_VERSION, createFalProductionAdapter } from '../api/_lib/fal-production.mjs';
import { klingCanaryProfile, createKlingCanaryAdapter, createGuardedKlingCanaryClient,
  verifyKlingCanaryGrant, createKlingQualityVisualReview } from '../scripts/test-kling-production.mjs';

const at = 1_800_000_000_000, email = 'erik@brocotech.ai', ownerHash = digest(email), clone = structuredClone;
function grantFixture() {
  const profile = klingCanaryProfile({ quality: true }), seed = digest(`${email}:${profile.runKey}`);
  const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}`;
  const grant = { version: 1, kind: profile.summary.kind, ownerHash, preparedId: id, manifestHash: profile.fixedHash,
    recipe: FAL_RECIPE_VERSION, maximumCostCents: 300, maximumVideoRequests: 3, maximumReferenceRequests: 2,
    videoMicroUsdPerSecond: 150_000, referenceMicroUsd: 300_000, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    quoteReference: 'b'.repeat(64), expiresAt: new Date(at + 600_000).toISOString() };
  const shot = profile.plan.shots[0];
  const request = { identity: digest(`${FAL_RECIPE_VERSION}:kling:${digest(`${id}:${profile.fixedHash}:${shot.id}`)}`),
    endpoint: FAL_MODELS.kling, input: { duration: String(shot.seconds), generate_audio: true, image_urls: ['reference-one', 'reference-two'], aspect_ratio: '16:9' } };
  return { profile, id, grant, request };
}

test('quality CLI fixes a separate immutable sample and preserves the historical manifest and provider identities', () => {
  const legacy = klingCanaryProfile(), quality = klingCanaryProfile({ quality: true });
  assert.equal(legacy.fixedHash, '02168601049cab97e4381981f5aa73dcd05b8b9553cf9f6017a40408c808b2ac');
  assert.equal(quality.fixedHash, 'c6d95029a8578bbb140acea253346116cf86040ab82932f629d30e61e965627b');
  assert.equal(legacy.manifest.visualContinuity, undefined); assert.equal(quality.manifest.visualContinuity.version, 1);
  assert.notEqual(digest(`${email}:${legacy.runKey}`), digest(`${email}:${quality.runKey}`));
  const script = fileURLToPath(new URL('../scripts/test-kling-quality.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test' } });
  const result = run('plan'); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), quality.summary);
  assert.equal(quality.summary.maximumCostCents, 300); assert.equal(quality.summary.videoRequests, 3); assert.equal(quality.summary.referenceRequests, 2);
  for (const action of ['prepare', 'step', 'finish']) {
    const rejected = run(action); assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stdout).code, 'CANARY_USAGE');
  }
});

test('staged quality canary can quote before the production visual heartbeat while customer quoting remains blocked', async () => {
  const quality = klingCanaryProfile({ quality: true }); let heartbeatReads = 0;
  const options = { key: 'synthetic-fal-key', now: () => at, pricing: async () => ({ videoMicroUsdPerSecond: 150_000,
    referenceMicroUsd: 300_000, expiresAt: new Date(at + 60_000).toISOString() }),
    read: async path => { heartbeatReads++; assert.equal(path, 'production/worker-health.json');
      return { value: { model: 'kling', recipe: FAL_RECIPE_VERSION, ready: true, deliveryChecksVersion: 1,
        referencePhotoVersion: 1, checkedAt: new Date(at).toISOString() } }; } };
  const staged = createKlingCanaryAdapter({ quality: true, ...options });
  assert.equal((await staged.quote({ manifest: quality.manifest, manifestHash: quality.fixedHash })).providerCostCents, 300);
  assert.equal(heartbeatReads, 0);
  const customer = createFalProductionAdapter({ ...options, requireWorker: true });
  await assert.rejects(customer.quote({ manifest: quality.manifest, manifestHash: quality.fixedHash }), /appearance and wardrobe/);
  assert.equal(heartbeatReads, 1);
  const historical = klingCanaryProfile(), legacyAdapter = createKlingCanaryAdapter(options);
  assert.equal((await legacyAdapter.quote({ manifest: historical.manifest, manifestHash: historical.fixedHash })).providerCostCents, 300);
  assert.equal(heartbeatReads, 2);
});

test('quality authorization rejects old, expired, unbound and expanded spending grants', () => {
  const f = grantFixture(), context = { quality: true, ownerHash, id: f.id, now: at };
  assert.equal(verifyKlingCanaryGrant(f.grant, context), f.grant);
  for (const change of [value => { value.kind = 'fictional-kling-production-canary-v1'; }, value => { value.manifestHash = 'f'.repeat(64); },
    value => { value.ownerHash = 'f'.repeat(64); }, value => { value.preparedId = '22222222-2222-4222-8222-222222222222'; },
    value => { value.maximumCostCents++; }, value => { value.maximumVideoRequests++; }, value => { value.maximumReferenceRequests++; },
    value => { value.videoMicroUsdPerSecond++; }, value => { value.referenceMicroUsd++; }, value => { value.fictionalOnly = false; },
    value => { value.recipe = 'changed'; }, value => { value.expiresAt = new Date(at).toISOString(); }, value => { value.quoteReference = 'invalid'; }]) {
    const grant = clone(f.grant); change(grant);
    assert.throws(() => verifyKlingCanaryGrant(grant, context), { code: 'CANARY_GRANT_REQUIRED' });
  }
});

test('historical reconciliation may read and poll but cannot submit any new provider request', async () => {
  const f = grantFixture(); let submissions = 0, grants = 0, prices = 0;
  const legacy = createGuardedKlingCanaryClient({ quality: false, id: f.id,
    grantContext: async () => { grants++; return { grant: f.grant }; }, pricing: async () => { prices++; },
    client: { get: async identity => ({ identity, state: 'completed' }), poll: async identity => ({ identity, state: 'completed' }),
      submit: async () => { submissions++; } } });
  assert.equal((await legacy.get('saved-id')).state, 'completed'); assert.equal((await legacy.poll('saved-id')).state, 'completed');
  await assert.rejects(legacy.submit(f.request), { code: 'CANARY_HISTORICAL_SUBMISSION_DISABLED' });
  assert.deepEqual({ submissions, grants, prices }, { submissions: 0, grants: 0, prices: 0 });
});

test('only bound quality operations can submit and authorization is rechecked after pricing', async () => {
  const f = grantFixture(); let submissions = 0, contexts = 0, changed = false;
  const options = { quality: true, id: f.id,
    grantContext: async () => { contexts++; if (changed) throw Object.assign(Error('expired'), { code: 'CANARY_GRANT_REQUIRED' }); return { grant: f.grant }; },
    pricing: async () => ({ videoMicroUsdPerSecond: 150_000, referenceMicroUsd: 300_000 }),
    client: { get: async () => null, poll: async () => null, submit: async request => { submissions++; return { identity: request.identity }; } } };
  const guarded = createGuardedKlingCanaryClient(options);
  assert.equal((await guarded.submit(f.request)).identity, f.request.identity); assert.equal(submissions, 1); assert.equal(contexts, 2);
  for (const change of [value => { value.identity = 'f'.repeat(64); }, value => { value.endpoint = FAL_MODELS.reference; },
    value => { value.input.duration = '15'; }, value => { value.input.generate_audio = false; }, value => { value.input.image_urls.pop(); }]) {
    const request = clone(f.request); change(request); await assert.rejects(guarded.submit(request)); assert.equal(submissions, 1);
  }
  await assert.rejects(createGuardedKlingCanaryClient({ ...options,
    pricing: async () => ({ videoMicroUsdPerSecond: 150_001, referenceMicroUsd: 300_000 }) }).submit(f.request), { code: 'CANARY_PRICE_EXCEEDS_APPROVAL' });
  await assert.rejects(createGuardedKlingCanaryClient({ ...options, pricing: async () => {
    changed = true; return { videoMicroUsdPerSecond: 150_000, referenceMicroUsd: 300_000 };
  } }).submit(f.request), { code: 'CANARY_GRANT_REQUIRED' });
  assert.equal(submissions, 1);
});

test('staged quality review sends scoped credentials only to the exact validated deployment origin', async () => {
  const origin = 'https://lineage-theater-abc123xyz-erik-4774s-projects.vercel.app', env = {
    LINEAGE_CANARY_REVIEW_ORIGIN: origin, LINEAGE_WORKER_SECRET: 'a'.repeat(64), LINEAGE_CANARY_AUTOMATION_BYPASS: 'synthetic-scoped-bypass' };
  const review = createKlingQualityVisualReview({ env, fetchImpl: async (url, request) => {
    assert.equal(url, `${origin}/api/production-worker`); assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
    assert.equal(request.headers.Authorization, `Bearer ${env.LINEAGE_WORKER_SECRET}`);
    assert.equal(request.headers['x-vercel-protection-bypass'], env.LINEAGE_CANARY_AUTOMATION_BYPASS);
    assert.equal(JSON.parse(request.body).action, 'review-film-visuals'); return new Response('{"passed":true}');
  } });
  assert.equal((await review({ action: 'unauthorized-operation' })).passed, true);
  for (const bad of ['https://evil.example', 'http://lineage-theater-abc123xyz-erik-4774s-projects.vercel.app',
    `${origin}/api/production-worker`, `${origin}/`, `${origin}?secret=not-allowed`, `${origin}#fragment`,
    origin.replace('https://', 'https://user:pass@'), `${origin}:444`, origin.replace('erik-4774s', 'another-team'),
    `${origin}.evil.example`, 'https://lineagetheater.com']) {
    assert.throws(() => createKlingQualityVisualReview({ env: { ...env, LINEAGE_CANARY_REVIEW_ORIGIN: bad } }), { code: 'CANARY_REVIEW_ORIGIN_INVALID' });
  }
  assert.throws(() => createKlingQualityVisualReview({ env: { ...env, LINEAGE_CANARY_AUTOMATION_BYPASS: 'bad\r\nheader' } }), { code: 'CANARY_REVIEW_BYPASS_INVALID' });
  for (const response of [new Response('', { status: 302 }), new Response(' '.repeat(4097))])
    await assert.rejects(createKlingQualityVisualReview({ env, fetchImpl: async () => response })({}));
});

test('quality review without staging configuration retains the ordinary fixed production origin', async () => {
  const review = createKlingQualityVisualReview({ env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://lineagetheater.com/api/production-worker'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers['x-vercel-protection-bypass'], undefined); return new Response('{"passed":true}');
  } });
  assert.equal((await review({})).passed, true);
});
