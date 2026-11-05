import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { digest } from '../api/_lib/auth.mjs';
import { FAL_MODELS, falRequestPath } from '../api/_lib/fal-client.mjs';
import { createFalProductionAdapter, characterReferenceInput, characterViewIdentity, startFrameIdentity } from '../api/_lib/fal-production.mjs';
import { createStartFrameReviewService, startFrameReviewContext, verifyStartFrameReceipt } from '../api/_lib/film-start-frame-review.mjs';
import { visualReferenceImages } from '../api/_lib/film-visual-review.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
import { candidateCanaryProfile, createGuardedCandidateClient } from '../scripts/test-kling-cast-continuity.mjs';
import { REFERENCE_RECOVERY as S, referenceRecoveryHash as hash, referenceRecoveryIdentity as originalIdentity,
  referenceReplacementIdentity as replacementIdentity, referenceRecoveryId as recoveryId, referenceRecoveryPath,
  referenceChoicePath, referenceGrantPath, referenceJobPath } from '../api/_lib/fal-reference-choice.mjs';

const AT = Date.parse('2026-11-05T21:00:00Z'), iso = time => new Date(time).toISOString();
const rates = { videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000 };
const pass = { cast: 'consistent', appearance: 'consistent', wardrobe: 'consistent', sceneAction: 'consistent', imageIntegrity: 'consistent', findings: [] };
async function fixture(decision = pass) {
  const { manifest, plan } = candidateCanaryProfile(), records = new Map(), images = new Map(), submissions = [], referenceReads = [];
  let serial = 0, inferenceCalls = 0;
  const save = (path, value) => records.set(path, { value: structuredClone(value), etag: String(++serial) });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => { const previous = records.get(path);
    assert.equal(previous?.etag, etag); save(path, value); };
  const jpeg = async color => 'data:image/jpeg;base64,' + (await sharp({ create: { width: 320, height: 320, channels: 3, background: color } }).jpeg().toBuffer()).toString('base64');
  for (const [name, color] of [['ada', '#9c6543'], ['child-alice', '#234b97'], ['ada-view', '#a16543'], ['alice-view', '#284b97'], ['start', '#187525']])
    images.set(`https://v3.fal.media/${name}.jpg`, await jpeg(color));
  const job = { id: S.id, ownerHash: S.ownerHash, mode: 'operator-test', status: 'uncertain', manifest, manifestHash: S.manifestHash,
    provider: { id: 'fal', model: 'kling', recipe: S.recipe },
    shots: manifest.shots.map(shot => ({ id: shot.id, requestKey: digest(`${S.id}:${S.manifestHash}:${shot.id}`), status: 'prepared' })) };
  const grant = { version: 1, kind: 'fictional-kling-quality-canary-v1', runKey: S.runKey, characterBindingVersion: 3,
    ownerHash: S.ownerHash, preparedId: S.id, manifestHash: S.manifestHash, recipe: S.recipe, maximumCostCents: 450,
    maximumVideoRequests: 3, maximumReferenceRequests: 7, ...rates, quotedCostCents: 450,
    funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    quoteReference: digest(`${S.recipe}:kling:${S.manifestHash}:${rates.videoMicroUsdPerSecond}:${rates.referenceMicroUsd}`),
    approvedAt: iso(AT - 1000), expiresAt: iso(AT + 600000) };
  const original = { identity: originalIdentity, state: 'failed', requestId: S.originalRequestId,
    endpoint: FAL_MODELS.reference, inputHash: hash(characterReferenceInput(manifest, plan.characters.find(c => c.id === 'alice'))) };
  const child = { identity: replacementIdentity, state: 'completed', requestId: 'offline-child-request', endpoint: FAL_MODELS.reference,
    inputHash: original.inputHash, result: { images: [{ url: 'https://v3.fal.media/child-alice.jpg' }] } };
  const claim = { version: 1, kind: 'funded-reference-recovery-v1', recoveryId, ownerHash: S.ownerHash, approvedBy: S.email,
    productionId: S.id, manifestHash: S.manifestHash, originalIdentity, originalRequestId: S.originalRequestId,
    replacementIdentity, endpoint: FAL_MODELS.reference, inputHash: original.inputHash, originalReceiptHash: hash(original),
    grantHash: hash(grant), maximumReplacementCostCents: 30, maximumTotalCostCents: 480, maximumPhysicalReferenceAttempts: 8,
    maximumVideoRequests: 3, budgetMode: 'separate-30-cent-approval', createdAt: iso(AT),
    additionalApproval: { version: 1, kind: 'additional-reference-approval', email: S.email, preparedId: S.id,
      manifestHash: S.manifestHash, originalRequestId: S.originalRequestId, maximumReplacementRequests: 1,
      maximumPhysicalReferenceAttempts: 8, maximumAdditionalCostCents: 30, maximumTotalCostCents: 480,
      evidenceSha256: digest('synthetic approval'), approvedAt: iso(AT - 1000), expiresAt: iso(AT + 600000) },
    rejection: { version: 1, requestId: S.originalRequestId, status: 'COMPLETED', httpStatus: 403,
      detail: 'User is locked. Reason: TOP_UP.', statusSha256: digest('status'), resultSha256: digest('result'), observedAt: iso(AT) } };
  const choice = { version: 1, kind: 'funded-reference-choice-v1', recoveryId, originalIdentity, replacementIdentity,
    productionId: S.id, manifestHash: S.manifestHash, claimHash: hash(claim), requestId: child.requestId,
    resultHash: hash(child.result), validatedImageHash: digest(images.get(child.result.images[0].url)) };
  save(referenceJobPath, job); save(referenceGrantPath, grant); save(referenceRecoveryPath, claim); save(referenceChoicePath, choice);
  save(falRequestPath(originalIdentity), original); save(falRequestPath(replacementIdentity), child);
  const adaIdentity = digest(`${S.recipe}:cast:${S.id}:${S.manifestHash}:ada`);
  save(falRequestPath(adaIdentity), { identity: adaIdentity, state: 'completed', endpoint: FAL_MODELS.reference,
    result: { images: [{ url: 'https://v3.fal.media/ada.jpg' }] } });
  save('production/worker-health.json', { ready: true, model: 'kling', recipe: S.recipe, characterBindingVersion: 3,
    visualChecksVersion: 1, deliveryChecksVersion: 1, checkedAt: iso(AT) });
  const raw = { get: async identity => (await read(falRequestPath(identity)))?.value,
    poll: async identity => { assert.notEqual(identity, originalIdentity, 'Do not poll the stored failed original'); return raw.get(identity); },
    submit: async request => { assert.notEqual(request.identity, originalIdentity); assert.notEqual(request.identity, replacementIdentity);
      submissions.push(request); const receipt = { identity: request.identity, endpoint: request.endpoint, state: 'queued', requestId: request.identity };
      save(falRequestPath(request.identity), receipt); return receipt; } };
  const normalized = async url => { assert.ok(images.has(url), url); return images.get(url); };
  const client = createGuardedCandidateClient({ id: S.id, ownerHash: S.ownerHash, read, now: () => AT, client: raw,
    grantContext: async () => ({ job, grant }), pricing: async () => rates, normalizeReference: normalized });
  const review = createStartFrameReviewService({ read, write, now: () => AT, key: 'offline-only', authorize: async () => true,
    generatedPhoto: async url => { referenceReads.push(url); return normalized(url); }, normalizeStartImage: normalized,
    fetchImpl: async (_url, options) => { inferenceCalls++; const body = JSON.parse(options.body);
      assert.equal(body.input[0].content.filter(item => item.type === 'input_image').length, 3);
      return Response.json({ status: 'completed', model: STORY_MODEL,
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] }); } });
  const adapter = createFalProductionAdapter({ key: 'offline-only', read, client, now: () => AT,
    normalizeKlingReference: normalized, validateStartFrame: input => review({ ...input, productionId: input.preparedId }),
    verifyStartFrame: input => verifyStartFrameReceipt(input, { read }) });
  const shot = manifest.shots[1], frameIdentity = startFrameIdentity(S.id, S.manifestHash, shot.id);
  const input = { email: S.email, productionId: S.id, manifest, manifestHash: S.manifestHash,
    shot, idempotencyKey: job.shots[1].requestKey, authorizeSpend: async () => true };
  const completeDependencies = () => {
    for (const character of plan.characters) {
      const identity = characterViewIdentity(S.id, S.manifestHash, character.id);
      save(falRequestPath(identity), { identity, state: 'completed', endpoint: FAL_MODELS.reference,
        result: { images: [{ url: `https://v3.fal.media/${character.id}-view.jpg` }] } });
    }
    save(falRequestPath(frameIdentity), { identity: frameIdentity, state: 'completed', endpoint: FAL_MODELS.reference,
      result: { images: [{ url: 'https://v3.fal.media/start.jpg' }] } });
  };
  return { records, save, read, job, original, child, input, shot, frameIdentity, adapter, client,
    submissions, referenceReads, completeDependencies, inferenceCalls: () => inferenceCalls, normalized };
}

test('adapter and exact-payload guard share the explicit child for views, composition, video, and server preflight', async () => {
  const f = await fixture(), original = JSON.stringify(await f.read(falRequestPath(originalIdentity)));
  assert.equal((await f.adapter.reconcileShot(f.input)).status, 'processing');
  assert.equal(f.submissions.length, 3);
  const view = f.submissions.find(request => request.identity === characterViewIdentity(S.id, S.manifestHash, 'alice'));
  assert.equal(view.input.context[0].image_url, f.child.result.images[0].url);
  const frame = f.submissions.find(request => request.identity === f.frameIdentity);
  assert.equal(frame.input.context[1].image_url, f.child.result.images[0].url);
  f.completeDependencies();
  assert.equal((await f.adapter.reconcileShot(f.input)).status, 'queued');
  assert.equal(f.submissions.length, 4); assert.equal(f.submissions[3].endpoint, FAL_MODELS.kling);
  assert.equal(f.submissions[3].input.elements[1].frontal_image_url, await f.normalized(f.child.result.images[0].url));
  assert.equal(f.inferenceCalls(), 1); assert.ok(f.referenceReads.includes(f.child.result.images[0].url));
  const context = await startFrameReviewContext({ ...f.input, shotId: f.shot.id, referenceIdentity: f.frameIdentity }, { read: f.read });
  assert.equal(context.binding.originals[1].identity, originalIdentity);
  assert.equal(context.binding.originals[1].replacement.replacementIdentity, replacementIdentity);
  assert.equal(context.binding.originals[1].replacement.resultHash, hash(f.child.result));
  assert.equal(JSON.stringify(await f.read(falRequestPath(originalIdentity))), original);
  await assert.rejects(f.client.submit({ identity: replacementIdentity, endpoint: FAL_MODELS.reference, input: {} }),
    { code: 'CANARY_OPERATION_OUTSIDE_BUDGET' });
});

test('a recovered portrait does not bypass a normal failed preflight or permit a video POST', async () => {
  const f = await fixture({ ...pass, cast: 'mismatch', findings: ['duplicate-or-extra-person'] }); f.completeDependencies();
  const result = await f.adapter.reconcileShot(f.input);
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'CAST_START_FRAME_MISMATCH');
  assert.equal(f.submissions.length, 0); assert.equal(f.inferenceCalls(), 1);
});

test('final visual reference loading uses the same child and changed receipt invalidates preflight binding', async () => {
  const f = await fixture(); f.completeDependencies();
  const seen = [];
  const references = await visualReferenceImages(f.job, f.shot, { read: f.read,
    generatedPhoto: async url => { seen.push(url); return f.normalized(url); } });
  assert.equal(references.length, 2); assert.deepEqual(seen, ['https://v3.fal.media/ada.jpg', f.child.result.images[0].url]);
  await f.adapter.reconcileShot(f.input);
  const changed = structuredClone(f.child); changed.result.images[0].url = 'https://v3.fal.media/different.jpg';
  f.save(falRequestPath(replacementIdentity), changed);
  await assert.rejects(startFrameReviewContext({ ...f.input, shotId: f.shot.id, referenceIdentity: f.frameIdentity }, { read: f.read }),
    { code: 'REFERENCE_RECOVERY_UNVERIFIED' });
  await assert.rejects(visualReferenceImages(f.job, f.shot, { read: f.read, generatedPhoto: f.normalized }),
    { code: 'REFERENCE_RECOVERY_UNVERIFIED' });
});
