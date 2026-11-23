import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import {
  SEEDANCE_CANARY_KIND, SEEDANCE_CANARY_MANIFEST_HASH, SEEDANCE_CANARY_MAX_CENTS,
  seedanceCanaryProfile, seedanceCanaryIdentity, verifySeedanceCanaryGrant,
} from '../api/_lib/seedance-operator-canary.mjs';

// Pure synthetic grants only. No storage, pricing, model or provider calls.
const now = Date.parse('2026-11-22T12:00:00Z');
const email = OWNER_EMAIL;
function fixture() {
  const { ownerHash, id } = seedanceCanaryIdentity(email);
  const grant = {
    version: 1, kind: SEEDANCE_CANARY_KIND, ownerHash, preparedId: id,
    manifestHash: SEEDANCE_CANARY_MANIFEST_HASH, recipe: SEEDANCE_RECIPE_VERSION,
    funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    maximumCostCents: 1920, maximumVideoRequests: 3, maximumReferenceRequests: 0,
    maximumVisualReviewRequests: 3, maximumStartFrameReviews: 0,
    videoMicroUsdPerSecond: 1_200_000, referenceMicroUsd: 0, quotedCostCents: 1920,
    quoteReference: digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${SEEDANCE_CANARY_MANIFEST_HASH}:1200000:0`),
    approvedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  return { grant, context: { email, ownerHash, id, now } };
}
const rejected = (grant, context, message) => assert.throws(
  () => verifySeedanceCanaryGrant(grant, context), { code: 'CANARY_GRANT_REQUIRED' }, message,
);

test('Seedance operator profile pins one fictional 15-second edit and three bounded native-audio operations', () => {
  const profile = seedanceCanaryProfile();
  assert.equal(SEEDANCE_CANARY_KIND, 'fictional-seedance-production-canary-v1');
  assert.equal(SEEDANCE_CANARY_MANIFEST_HASH, 'a0fa6c25abc352d29194e392c93f5e9d0fab73478ea165abb1aaff1e6b11922a');
  assert.equal(SEEDANCE_CANARY_MAX_CENTS, 1920);
  assert.equal(profile.runKey, 'seedance-production-canary-20261122-v1');
  assert.equal(profile.fixedHash, SEEDANCE_CANARY_MANIFEST_HASH);
  assert.equal(digest(JSON.stringify(profile.manifest)), profile.fixedHash);
  assert.equal(profile.manifest.targetDurationSeconds, 15);
  assert.equal(profile.manifest.productionPlan.provider, 'seedance');
  assert.equal(profile.plan.generatedSeconds, 16);
  assert.equal(profile.plan.referenceCount, 0);
  assert.deepEqual(profile.plan.shots.map(shot => [shot.id, shot.seconds, shot.endpoint]), [
    ['shot-001', 6, 'bytedance/seedance-2.5/us/text-to-video'],
    ['shot-002', 5, 'bytedance/seedance-2.5/us/text-to-video'],
    ['shot-003', 5, 'bytedance/seedance-2.5/us/text-to-video'],
  ]);
  assert.ok(profile.plan.characters.every(character => character.referencePhotoId === undefined));
  assert.equal(Math.ceil(profile.plan.generatedSeconds * 1_200_000 / 10_000), SEEDANCE_CANARY_MAX_CENTS);
});

test('Seedance canary identity is deterministic and binds the owner to the single approved run', () => {
  const profile = seedanceCanaryProfile(), seed = digest(`${email}:${profile.runKey}`);
  const expected = { ownerHash: digest(email),
    id: `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}` };
  assert.deepEqual(seedanceCanaryIdentity(email), expected);
  assert.deepEqual(seedanceCanaryIdentity(email), seedanceCanaryIdentity(email));
  const { grant, context } = fixture();
  assert.equal(verifySeedanceCanaryGrant(grant, context), grant);
  const changedId = '00000000-0000-4000-8000-000000000001';
  rejected({ ...grant, preparedId: changedId }, { ...context, id: changedId }, 'another same-sample preparation cannot extend the allowance');
  rejected(grant, { ...context, email: 'another-owner@example.invalid' }, 'owner email is part of the approved identity');
  rejected(grant, { ...context, ownerHash: 'f'.repeat(64) }, 'context cannot substitute another owner hash');
  rejected(grant, { ...context, id: changedId }, 'context cannot substitute another preparation');
});

test('Seedance grant rejects altered model, owner, plan, funding and approval bindings', () => {
  const { grant, context } = fixture();
  const changes = [
    ['version', 2], ['kind', 'fictional-kling-quality-canary-v1'], ['ownerHash', 'f'.repeat(64)],
    ['preparedId', '00000000-0000-4000-8000-000000000001'], ['manifestHash', 'f'.repeat(64)],
    ['recipe', 'lineage-realistic-kling-o3-v1'], ['funding', 'customer-payment'], ['fictionalOnly', false],
    ['quoteReference', 'f'.repeat(64)], ['quoteReference', 'invalid'],
  ];
  for (const [field, value] of changes) rejected({ ...grant, [field]: value }, context, field);
  for (const field of Object.keys(grant)) {
    const incomplete = { ...grant }; delete incomplete[field];
    rejected(incomplete, context, `missing ${field}`);
  }
  for (const value of [undefined, null, false, [], 'grant']) rejected(value, context, 'malformed grant');
});

test('Seedance grant cannot expand or reinterpret any provider or review spending ceiling', () => {
  const { grant, context } = fixture();
  const changes = [
    ['maximumCostCents', 1921], ['maximumCostCents', 1919], ['maximumCostCents', '1920'],
    ['maximumVideoRequests', 4], ['maximumVideoRequests', 2], ['maximumReferenceRequests', 1],
    ['maximumVisualReviewRequests', 4], ['maximumVisualReviewRequests', 2], ['maximumStartFrameReviews', 1],
    ['videoMicroUsdPerSecond', 1_200_001], ['videoMicroUsdPerSecond', 1_199_999],
    ['referenceMicroUsd', 1], ['quotedCostCents', 1921], ['quotedCostCents', 1919],
  ];
  for (const [field, value] of changes) rejected({ ...grant, [field]: value }, context, `${field}=${value}`);
  const changedRate = 1_200_001;
  rejected({ ...grant, videoMicroUsdPerSecond: changedRate,
    quoteReference: digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${SEEDANCE_CANARY_MANIFEST_HASH}:${changedRate}:0`) }, context,
  'a self-consistent replacement quote cannot raise the approved rate');
});

test('Seedance approval is current, finite and bounded to its original 24-hour window', () => {
  const { grant, context } = fixture();
  const approvedAt = Date.parse(grant.approvedAt);
  const fullWindow = { ...grant, expiresAt: new Date(approvedAt + 24 * 3600_000).toISOString() };
  assert.equal(verifySeedanceCanaryGrant(fullWindow, context), fullWindow);
  for (const change of [
    { approvedAt: new Date(now + 1).toISOString() }, { approvedAt: 'invalid' },
    { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now - 1).toISOString() },
    { expiresAt: new Date(approvedAt + 24 * 3600_000 + 1).toISOString() },
    { expiresAt: 'invalid' }, { expiresAt: null },
  ]) rejected({ ...grant, ...change }, context, JSON.stringify(change));
  rejected(grant, { ...context, now: Number.NaN }, 'invalid verification time');
  rejected(grant, { ...context, now: Number.POSITIVE_INFINITY }, 'unbounded verification time');
});
