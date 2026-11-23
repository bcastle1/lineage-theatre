// One explicitly approved studio-funded sample. These bounds are shared by
// the worker command and the web visual-review gate; no customer sale is made.
import { digest } from './auth.mjs';
import { buildFilmManifest, fictionalOperatorProject } from './film-production.mjs';
import { planSeedanceShots } from './kling-film-plan.mjs';
import { falPlan, SEEDANCE_RECIPE_VERSION } from './fal-production.mjs';

export const SEEDANCE_CANARY_KIND = 'fictional-seedance-production-canary-v1';
export const SEEDANCE_CANARY_MANIFEST_HASH = 'a0fa6c25abc352d29194e392c93f5e9d0fab73478ea165abb1aaff1e6b11922a';
export const SEEDANCE_CANARY_MAX_CENTS = 1920;
const RUN_KEY = 'seedance-production-canary-20261122-v1';
const RATE = 1_200_000;
const requireValue = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };

export function seedanceCanaryProfile() {
  const manifest = planSeedanceShots(buildFilmManifest(fictionalOperatorProject()).manifest);
  const plan = falPlan(manifest, 'seedance'), fixedHash = digest(JSON.stringify(manifest));
  requireValue(fixedHash === SEEDANCE_CANARY_MANIFEST_HASH && manifest.targetDurationSeconds === 15
    && plan.generatedSeconds === 16 && plan.shots.length === 3 && plan.referenceCount === 0
    && plan.shots.map(shot => shot.seconds).join(',') === '6,5,5'
    && plan.characters.every(character => character.referencePhotoId === undefined), 'CANARY_FIXED_PLAN_CHANGED');
  return { runKey: RUN_KEY, fixedHash, manifest, plan,
    summary: { kind: SEEDANCE_CANARY_KIND, manifestHash: fixedHash, durationSeconds: 15, providerSeconds: 16,
      videoRequests: 3, referenceRequests: 0, maximumVisualReviewRequests: 3, maximumStartFrameReviews: 0,
      maximumCostCents: SEEDANCE_CANARY_MAX_CENTS, recipe: SEEDANCE_RECIPE_VERSION,
      invoiceCreated: false, customerPaymentCreated: false } };
}

export function seedanceCanaryIdentity(email) {
  requireValue(typeof email === 'string' && email === email.trim().toLowerCase() && email.length <= 254
    && /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email), 'CANARY_OWNER_EMAIL_REQUIRED');
  const seed = digest(`${email}:${RUN_KEY}`);
  return { ownerHash: digest(email), id: `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}` };
}

export function verifySeedanceCanaryGrant(grant, { email, ownerHash, id, now = Date.now() } = {}) {
  let expected;
  try { expected = seedanceCanaryIdentity(email); } catch { requireValue(false, 'CANARY_GRANT_REQUIRED'); }
  const approvedAt = Date.parse(grant?.approvedAt), expiresAt = Date.parse(grant?.expiresAt);
  requireValue(expected.ownerHash === ownerHash && expected.id === id
    && grant?.version === 1 && grant.kind === SEEDANCE_CANARY_KIND && grant.ownerHash === ownerHash && grant.preparedId === id
    && grant.manifestHash === SEEDANCE_CANARY_MANIFEST_HASH && grant.recipe === SEEDANCE_RECIPE_VERSION
    && grant.funding === 'existing-merchant-provider-credit' && grant.fictionalOnly === true
    && grant.characterBindingVersion === undefined && grant.maximumCostCents === SEEDANCE_CANARY_MAX_CENTS
    && grant.maximumVideoRequests === 3 && grant.maximumReferenceRequests === 0
    && grant.maximumVisualReviewRequests === 3 && grant.maximumStartFrameReviews === 0
    && grant.videoMicroUsdPerSecond === RATE && grant.referenceMicroUsd === 0 && grant.quotedCostCents === SEEDANCE_CANARY_MAX_CENTS
    && grant.quoteReference === digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${SEEDANCE_CANARY_MANIFEST_HASH}:${RATE}:0`)
    && Number.isFinite(now) && Number.isFinite(approvedAt) && approvedAt <= now && Number.isFinite(expiresAt)
    && expiresAt > now && expiresAt > approvedAt && expiresAt - approvedAt <= 24 * 3600_000,
  'CANARY_GRANT_REQUIRED');
  return grant;
}
