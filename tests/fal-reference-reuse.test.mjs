// Offline only: no private live receipt, image, credentials or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { FAL_MODELS, falRequestPath } from '../api/_lib/fal-client.mjs';
import { characterReferenceInput } from '../api/_lib/fal-production.mjs';
import { candidateCanaryProfile, candidateOperationBounds } from '../scripts/test-kling-cast-continuity.mjs';
import { candidateCanaryProfile as oldProfile } from '../scripts/test-kling-element-contract.mjs';
import { createReferenceReuse, verifyTopUpRejectedReplacement } from '../api/_lib/fal-reference-reuse.mjs';
import { REFERENCE_RECOVERY as S, REFERENCE_REUSE as R, referenceRecoveryHash as hash,
  referenceRecoveryIdentity as originalIdentity, referenceReplacementIdentity as childIdentity,
  referenceRecoveryId, referenceRecoveryPath, referenceChoicePath, referenceGrantPath, referenceJobPath,
  referenceReusePath, referenceReuseSourceJobPath, resolveReferenceChoice } from '../api/_lib/fal-reference-choice.mjs';

const AT = Date.parse('2026-11-05T22:00:00Z'), iso = value => new Date(value).toISOString();
const unverified = { code: 'REFERENCE_RECOVERY_UNVERIFIED' };
const normalized = 'data:image/jpeg;base64,c3ludGhldGljLW9mZmxpbmUtZml4dHVyZQ==';
function fixture(options = {}) {
  let serial = 0, clock = AT, verifications = 0, validations = 0;
  const records = new Map(), writes = [];
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `record-${++serial}` });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (options.failWrite?.(path)) throw Error('offline write failure');
    assert.equal(records.get(path)?.etag, etag, 'create only; never overwrite another record');
    writes.push(path); seed(path, value); options.onWrite?.(path, h);
    if (options.lostReply?.(path)) throw Error('offline lost reply');
  };
  const { manifest, plan } = candidateCanaryProfile();
  const grant = { version: 1, kind: 'fictional-kling-quality-canary-v1', runKey: S.runKey, characterBindingVersion: 3,
    ownerHash: S.ownerHash, preparedId: S.id, manifestHash: S.manifestHash, recipe: S.recipe, maximumCostCents: 450,
    maximumVideoRequests: 3, maximumReferenceRequests: 7, videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000,
    quotedCostCents: 450, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    quoteReference: digest(`${S.recipe}:kling:${S.manifestHash}:150000:300000`), approvedAt: iso(AT - 3600000), expiresAt: iso(AT + 600000) };
  const job = { id: S.id, ownerHash: S.ownerHash, mode: 'operator-test', status: 'uncertain', manifest, manifestHash: S.manifestHash,
    provider: { id: 'fal', model: 'kling', recipe: S.recipe },
    authorization: { environment: 'production', budgetCents: 450, manifestHash: S.manifestHash, quoteReference: grant.quoteReference },
    shots: manifest.shots.map((shot, index) => { const requestKey = digest(`${S.id}:${S.manifestHash}:${shot.id}`);
      return { id: shot.id, requestKey, status: index === 1 ? 'uncertain' : 'prepared',
        ...(index < 2 ? { providerJobId: `fal-${digest(`${S.recipe}:kling:${requestKey}`)}` } : {}) }; }) };
  const original = { identity: originalIdentity, endpoint: FAL_MODELS.reference, inputHash: R.inputHash,
    requestId: S.originalRequestId, state: 'queued' };
  const child = { identity: childIdentity, endpoint: FAL_MODELS.reference, inputHash: R.inputHash,
    requestId: R.failedReplacementRequestId, state: 'queued',
    statusUrl: `https://queue.fal.run/${FAL_MODELS.reference}/requests/${R.failedReplacementRequestId}/status`,
    responseUrl: `https://queue.fal.run/${FAL_MODELS.reference}/requests/${R.failedReplacementRequestId}` };
  const old = oldProfile();
  const sourceJob = { id: R.sourceProductionId, ownerHash: S.ownerHash, mode: 'operator-test', status: 'awaiting-assembly',
    manifestHash: R.sourceManifestHash, manifest: old.manifest, provider: { id: 'fal', model: 'kling', recipe: S.recipe },
    finishingFailure: { stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH' } };
  const source = { identity: R.sourceIdentity, endpoint: FAL_MODELS.reference, inputHash: R.inputHash,
    state: 'completed', requestId: R.sourceRequestId, result: { images: [{ url: 'https://v3.fal.media/offline-reuse-alice.jpg' }] } };
  const rejection = () => ({ version: 1, requestId: R.failedReplacementRequestId, status: 'COMPLETED', httpStatus: 403,
    detail: 'User is locked. Reason: TOP_UP.', statusSha256: digest('offline status'), resultSha256: digest('offline result'), observedAt: iso(clock) });
  const claim = { version: 1, kind: 'funded-reference-recovery-v1', recoveryId: referenceRecoveryId, ownerHash: S.ownerHash,
    approvedBy: S.email, productionId: S.id, manifestHash: S.manifestHash, originalIdentity, originalRequestId: S.originalRequestId,
    replacementIdentity: childIdentity, endpoint: FAL_MODELS.reference, inputHash: R.inputHash,
    originalReceiptHash: hash(original), grantHash: hash(grant), maximumReplacementCostCents: 30,
    maximumTotalCostCents: 480, maximumPhysicalReferenceAttempts: 8, maximumVideoRequests: 3,
    budgetMode: 'separate-30-cent-approval', createdAt: iso(AT - 1200000),
    additionalApproval: { version: 1, kind: 'additional-reference-approval', email: S.email, preparedId: S.id,
      manifestHash: S.manifestHash, originalRequestId: S.originalRequestId, maximumReplacementRequests: 1,
      maximumPhysicalReferenceAttempts: 8, maximumAdditionalCostCents: 30, maximumTotalCostCents: 480,
      evidenceSha256: digest('offline extra approval'), approvedAt: iso(AT - 1800000), expiresAt: iso(AT + 600000) },
    rejection: { ...rejection(), requestId: S.originalRequestId, observedAt: iso(AT - 1200000) } };
  const approval = { version: 1, kind: 'existing-reference-reuse-approval', email: S.email, productionId: S.id,
    manifestHash: S.manifestHash, sourceRequestId: R.sourceRequestId, maximumAdditionalCostCents: 0,
    maximumNewPortraitRequests: 0, maximumTotalCostCents: 480, evidenceSha256: digest('offline reuse approval'),
    approvedAt: iso(AT - 1000), expiresAt: iso(AT + 300000) };
  seed(userPath(S.email), { role: 'owner', email: S.email }); seed(referenceJobPath, job); seed(referenceGrantPath, grant);
  seed(referenceRecoveryPath, claim); seed(falRequestPath(originalIdentity), original); seed(falRequestPath(childIdentity), child);
  seed(referenceReuseSourceJobPath, sourceJob); seed(falRequestPath(R.sourceIdentity), source);
  const ada = plan.characters.find(character => character.id === 'ada');
  const adaIdentity = digest(`${S.recipe}:cast:${S.id}:${S.manifestHash}:ada`);
  seed(falRequestPath(adaIdentity), { identity: adaIdentity, endpoint: FAL_MODELS.reference, requestId: S.adaRequestId,
    inputHash: hash(characterReferenceInput(manifest, ada)), state: 'completed', result: { images: [{ url: 'https://v3.fal.media/offline-ada.jpg' }] } });
  // Only the exact synthetic source maps to the production fingerprint; any
  // mutation still fails. Production callers never supply either seam.
  const sourceHash = hash(source), sourceReceiptFingerprint = receipt => hash(receipt) === sourceHash ? R.sourceReceiptHash : hash(receipt);
  const h = { records, writes, seed, read, write, source, sourceJob, job, grant, original, child, claim, approval,
    sourceReceiptFingerprint, rejection, advance: value => { clock += value; }, now: () => clock,
    verifications: () => verifications, validations: () => validations };
  h.options = { read, write, now: h.now, sourceReceiptFingerprint, imageFingerprint: data => data === normalized ? R.normalizedImageHash : digest(data),
    verifyRejected: async receipt => { assert.deepEqual(receipt, h.child); verifications++; options.onVerify?.(h);
      return options.rejection ? options.rejection(h) : rejection(); },
    validateOutput: async receipt => { assert.deepEqual(receipt, h.source); validations++; options.onValidate?.(h);
      return options.image ?? normalized; } };
  h.service = createReferenceReuse(h.options);
  h.resolve = () => resolveReferenceChoice({ ownerHash: S.ownerHash, productionId: S.id, manifestHash: S.manifestHash,
    identity: originalIdentity }, { read, sourceReceiptFingerprint });
  return h;
}

test('fixed old and current Alice payloads match the exact audited input hash', () => {
  const current = candidateCanaryProfile(), old = oldProfile();
  for (const profile of [current, old]) assert.equal(hash(characterReferenceInput(profile.manifest,
    profile.plan.characters.find(character => character.id === 'alice'))), R.inputHash);
  assert.equal(digest(`${S.recipe}:cast:${R.sourceProductionId}:${R.sourceManifestHash}:alice`), R.sourceIdentity);
});

test('read-only plan verifies the failed child and image without creating any record', async () => {
  const h = fixture(), before = structuredClone(h.records);
  const result = await h.service.reuse(h.approval);
  assert.equal(result.status, 'ready-for-reference-reuse'); assert.equal(result.generationSubmitted, false);
  assert.equal(result.additionalPortraitRequests, 0); assert.equal(result.maximumTotalCostCents, 480);
  assert.equal(h.verifications(), 1); assert.equal(h.validations(), 1);
  assert.deepEqual(h.records, before); assert.deepEqual(h.writes, []);
});

test('selection appends two records and returns the actual old receipt without changing any history', async () => {
  const h = fixture(), before = structuredClone(h.records);
  const result = await h.service.reuse(h.approval, { execute: true });
  assert.equal(result.status, 'reference-choice-ready'); assert.equal(result.generationSubmitted, false);
  assert.deepEqual(h.writes, [referenceReusePath, referenceChoicePath]);
  for (const [path, record] of before) assert.deepEqual(h.records.get(path), record, path);
  const selected = await h.resolve(); assert.deepEqual(selected.receipt, h.source);
  assert.equal(selected.proof.replacementIdentity, R.sourceIdentity); assert.notEqual(selected.proof.replacementIdentity, childIdentity);
  assert.equal(selected.proof.sourceReceiptHash, R.sourceReceiptHash); assert.equal(selected.proof.validatedImageHash, R.normalizedImageHash);
  assert.equal(selected.proof.choiceHash, result.choiceHash);
  assert.equal(h.records.get(referenceReuseSourceJobPath).value.finishingFailure.reason, 'VISUAL_CONTINUITY_MISMATCH');
});

test('default production fingerprints reject synthetic source receipts and altered normalized bytes', async () => {
  const h = fixture();
  await assert.rejects(createReferenceReuse({ ...h.options, sourceReceiptFingerprint: undefined }).reuse(h.approval), unverified);
  assert.equal(h.verifications(), 0);
  await assert.rejects(createReferenceReuse({ ...h.options, imageFingerprint: undefined }).reuse(h.approval), unverified);
  assert.deepEqual(h.writes, []);
  await h.service.reuse(h.approval, { execute: true });
  await assert.rejects(resolveReferenceChoice({ ownerHash: S.ownerHash, productionId: S.id,
    manifestHash: S.manifestHash, identity: originalIdentity }, { read: h.read }), unverified);
});

test('approval cannot change owner, job, source, spend, attempt count, evidence or validity window', async () => {
  for (const change of [a => a.email = 'other@example.invalid', a => a.productionId = R.sourceProductionId,
    a => a.manifestHash = R.sourceManifestHash, a => a.sourceRequestId = S.originalRequestId,
    a => a.maximumAdditionalCostCents = 1, a => a.maximumNewPortraitRequests = 1,
    a => a.maximumTotalCostCents = 481, a => delete a.evidenceSha256,
    a => a.expiresAt = iso(AT), a => a.expiresAt = iso(AT + 600001), a => a.approvedAt = iso(AT + 1),
    a => a.approvedAt = iso(AT - 3600001), a => a.kind = 'additional-reference-approval']) {
    const h = fixture(); change(h.approval);
    await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.deepEqual(h.writes, []);
  }
});

test('wrong source owner, manifest, character, input, result or receipt cannot be selected', async () => {
  for (const [kind, change] of [['job', j => j.ownerHash = digest('other')], ['job', j => j.id = S.id],
    ['job', j => j.manifestHash = S.manifestHash], ['job', j => j.manifest.screenplay.characters[1].name = 'Changed'],
    ['job', j => j.provider.recipe = 'changed'], ['source', r => r.inputHash = digest('changed')],
    ['source', r => r.requestId = R.failedReplacementRequestId], ['source', r => r.identity = childIdentity],
    ['source', r => r.state = 'queued'], ['source', r => r.result.images.push(r.result.images[0])],
    ['source', r => r.result.images[0].url = 'https://v3.fal.media/other.jpg'], ['source', r => r.changed = true]]) {
    const h = fixture(), value = structuredClone(kind === 'job' ? h.sourceJob : h.source); change(value);
    h.seed(kind === 'job' ? referenceReuseSourceJobPath : falRequestPath(R.sourceIdentity), value);
    await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.deepEqual(h.writes, []);
  }
});

test('failed child, original, original grant and immutable recovery claim remain exactly bound', async () => {
  for (const [path, change] of [[falRequestPath(childIdentity), r => r.requestId = S.originalRequestId],
    [falRequestPath(childIdentity), r => r.inputHash = digest('changed')],
    [falRequestPath(childIdentity), r => r.state = 'uncertain'], [falRequestPath(childIdentity), r => r.state = 'submitting'],
    [falRequestPath(childIdentity), r => r.result = { images: [] }],
    [falRequestPath(originalIdentity), r => r.state = 'failed'], [referenceRecoveryPath, r => r.maximumTotalCostCents = 481],
    [referenceGrantPath, r => r.maximumCostCents = 480], [referenceJobPath, r => r.authorization.budgetCents = 480],
    [userPath(S.email), r => r.status = 'suspended']]) {
    const h = fixture(), value = structuredClone(h.records.get(path).value); change(value); h.seed(path, value);
    await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.deepEqual(h.writes, []);
  }
});

test('any downstream receipt, output, active lease or final media prevents a new selection', async () => {
  const downstream = [...candidateOperationBounds(S.id)].filter(([, bound]) => bound.kind !== 'reference-front');
  for (const [identity] of downstream) {
    const h = fixture(); h.seed(falRequestPath(identity), { identity, state: 'uncertain' });
    await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.deepEqual(h.writes, []);
  }
  for (const change of [j => j.status = 'processing', j => j.media = { sha256: digest('video') },
    j => j.shots[0].output = { url: 'https://v3.fal.media/video.mp4' }, j => j.lease = { expiresAt: AT + 90000 }]) {
    const h = fixture(), job = structuredClone(h.job); change(job); h.seed(referenceJobPath, job);
    await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.deepEqual(h.writes, []);
  }
});

test('unknown, nonterminal, unrelated and stale replacement results do not permit selection', async () => {
  for (const change of [r => r.requestId = S.originalRequestId, r => r.status = 'IN_PROGRESS', r => r.httpStatus = 200,
    r => r.httpStatus = 429, r => r.detail = 'Unknown', r => delete r.resultSha256,
    r => r.observedAt = iso(AT - 60001), r => r.observedAt = iso(AT + 1)]) {
    const h = fixture({ rejection: f => { const r = f.rejection(); change(r); return r; } });
    await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.deepEqual(h.writes, []);
  }
  for (const image of ['https://v3.fal.media/unvalidated.jpg', normalized + 'changed']) {
    const h = fixture({ image }); await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified);
    assert.deepEqual(h.writes, []);
  }
});

test('changes or approval expiry during image verification stop all writes', async () => {
  for (const onValidate of [h => h.advance(300001), h => h.seed(userPath(S.email), { email: S.email, role: 'owner', status: 'suspended' }),
    h => h.seed(referenceJobPath, { ...h.job, lease: { expiresAt: AT + 90000 } }),
    h => h.seed(falRequestPath(childIdentity), { ...h.child, checkedAt: iso(AT) }),
    h => h.seed(referenceGrantPath, { ...h.grant, expiresAt: iso(AT + 500000) })]) {
    const h = fixture({ onValidate });
    await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.deepEqual(h.writes, []);
  }
});

test('interrupted immutable writes are recoverable without a generation request or history rewrite', async () => {
  const denied = fixture({ failWrite: path => path === referenceReusePath });
  await assert.rejects(denied.service.reuse(denied.approval, { execute: true }), unverified);
  assert.equal(denied.records.has(referenceChoicePath), false);
  for (const path of [referenceReusePath, referenceChoicePath]) {
    const h = fixture({ lostReply: value => value === path });
    assert.equal((await h.service.reuse(h.approval, { execute: true })).status, 'reference-choice-ready');
    const before = structuredClone(h.records);
    assert.equal((await h.service.reuse(h.approval, { execute: true })).status, 'reference-choice-ready');
    assert.deepEqual(h.records, before); assert.equal(h.verifications(), 1); assert.equal(h.validations(), 1);
  }
});

test('concurrent selection creates one claim and one choice with exact immutable readback', async () => {
  const h = fixture(); const results = await Promise.all([h.service.reuse(h.approval, { execute: true }), h.service.reuse(h.approval, { execute: true })]);
  assert.ok(results.every(r => r.status === 'reference-choice-ready'));
  assert.deepEqual(h.writes, [referenceReusePath, referenceChoicePath]);
});

test('work beginning after the claim prevents the choice and never triggers a paid retry', async () => {
  const [downstream] = [...candidateOperationBounds(S.id)].find(([, bound]) => bound.kind === 'start-frame');
  const h = fixture({ onWrite: (path, f) => { if (path === referenceReusePath) f.seed(falRequestPath(downstream), { state: 'submitting' }); } });
  await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified);
  assert.deepEqual(h.writes, [referenceReusePath]); assert.equal(h.records.has(referenceChoicePath), false);
  await assert.rejects(h.service.reuse(h.approval, { execute: true }), unverified); assert.equal(h.writes.length, 1);
});

test('completed choice remains readable after expiry and unrelated source status changes; new writes still require valid approval', async () => {
  const h = fixture(); await h.service.reuse(h.approval, { execute: true }); h.advance(3600000);
  h.seed(referenceReuseSourceJobPath, { ...h.sourceJob, status: 'failed', checkedAt: iso(h.now()) });
  h.seed(referenceJobPath, { ...h.job, status: 'processing', shots: h.job.shots.map(s => ({ ...s, status: 'processing' })) });
  assert.deepEqual((await h.resolve()).receipt, h.source);
  assert.equal((await h.service.reuse(h.approval, { execute: true })).status, 'reference-choice-ready');
  assert.equal(h.verifications(), 1); assert.equal(h.validations(), 1);
  const expired = fixture(); expired.advance(3600000);
  await assert.rejects(expired.service.reuse(expired.approval, { execute: true }), unverified); assert.deepEqual(expired.writes, []);
});

test('completed choice rejects changed provenance, source bytes, owner and same-ID wrong-owner reads', async () => {
  for (const path of [falRequestPath(R.sourceIdentity), falRequestPath(childIdentity), falRequestPath(originalIdentity),
    referenceRecoveryPath, referenceReusePath, referenceChoicePath, referenceGrantPath]) {
    const h = fixture(); await h.service.reuse(h.approval, { execute: true });
    const value = structuredClone(h.records.get(path).value);
    if (path === referenceChoicePath) value.reuseClaimHash = digest('changed');
    else value.tampered = true;
    h.seed(path, value); await assert.rejects(h.resolve(), unverified);
  }
  const h = fixture(); await h.service.reuse(h.approval, { execute: true });
  const reads = [];
  await assert.rejects(resolveReferenceChoice({ ownerHash: digest('other'), productionId: S.id,
    manifestHash: S.manifestHash, identity: originalIdentity }, { read: async path => { reads.push(path); return h.read(path); },
    sourceReceiptFingerprint: h.sourceReceiptFingerprint }), unverified);
  assert.deepEqual(reads, [referenceChoicePath]);
  h.seed(userPath(S.email), { role: 'owner', email: S.email, status: 'suspended' });
  await assert.rejects(h.resolve(), unverified);
});

test('replacement verifier uses only two bound GETs, never POST, redirect or receipt mutation', async () => {
  const h = fixture(), calls = [], child = structuredClone(h.child);
  const result = await verifyTopUpRejectedReplacement(child, { key: 'offline-only', now: () => AT,
    fetchImpl: async (url, init) => { calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
      return url.endsWith('/status') ? Response.json({ status: 'COMPLETED', request_id: R.failedReplacementRequestId })
        : Response.json({ detail: 'User is locked. Reason: TOP_UP.' }, { status: 403 }); } });
  assert.equal(calls.length, 2); assert.equal(result.requestId, R.failedReplacementRequestId); assert.deepEqual(child, h.child);
  for (const field of ['statusUrl', 'responseUrl']) {
    let fetches = 0;
    await assert.rejects(verifyTopUpRejectedReplacement({ ...child, [field]: 'https://example.invalid/steal' }, {
      key: 'offline-only', fetchImpl: async () => { fetches++; throw Error('must not fetch'); } }), { code: 'FAL_RECEIPT_INVALID' });
    assert.equal(fetches, 0);
  }
});

test('replacement verifier rejects successful, unknown, malformed and oversized stored results without exposing private response text', async () => {
  const h = fixture();
  for (const result of [Response.json({ images: [] }), Response.json({ detail: 'Unknown' }, { status: 403 }),
    Response.json({ detail: 'User is locked. Reason: TOP_UP.', extra: true }, { status: 403 }),
    new Response('{"detail": PRIVATE_ECHO}', { status: 403 }), new Response('x'.repeat(16385), { status: 403 })]) {
    await assert.rejects(verifyTopUpRejectedReplacement(h.child, { key: 'offline-only', now: () => AT,
      fetchImpl: async url => url.endsWith('/status') ? Response.json({ status: 'COMPLETED', request_id: R.failedReplacementRequestId }) : result }),
    error => error.code === unverified.code && !String(error.stack).includes('PRIVATE_ECHO'));
  }
});
