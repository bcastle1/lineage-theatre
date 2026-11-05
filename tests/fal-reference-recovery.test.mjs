// Offline only. Private storage, pricing, and all provider HTTP are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { createFalClient, FAL_MODELS, falRequestPath } from '../api/_lib/fal-client.mjs';
import { characterReferenceInput } from '../api/_lib/fal-production.mjs';
import { candidateCanaryProfile, candidateOperationBounds } from '../scripts/test-kling-cast-continuity.mjs';
import { createReferenceRecovery, verifyTopUpRejectedReference } from '../api/_lib/fal-reference-recovery.mjs';
import { REFERENCE_RECOVERY as S, referenceRecoveryHash as hash, referenceRecoveryIdentity,
  referenceReplacementIdentity, referenceRecoveryPath, referenceChoicePath, referenceGrantPath,
  referenceJobPath, resolveReferenceChoice, verifyReferenceRecoveryEvidence,
  verifyReferenceRecoveryRejection } from '../api/_lib/fal-reference-choice.mjs';

const AT = Date.parse('2026-11-05T21:00:00Z');
const iso = at => new Date(at).toISOString();
const rates = { videoMicroUsdPerSecond: 150000, referenceMicroUsd: 300000 };
const normalizedImage = 'data:image/jpeg;base64,b2ZmbGluZS1maXh0dXJl';
const unverified = { code: 'REFERENCE_RECOVERY_UNVERIFIED' };
function zeroEvidence() {
  return { version: 1, kind: 'fal-request-zero-charge', requestId: S.originalRequestId,
    endpoint: FAL_MODELS.reference, amountCents: 0, quantity: 0, source: 'fal-billing-export',
    sourceSha256: digest('synthetic explicit zero billing'), observedAt: iso(AT - 1000) };
}
function extraApproval() {
  return { version: 1, kind: 'additional-reference-approval', email: S.email, preparedId: S.id,
    manifestHash: S.manifestHash, originalRequestId: S.originalRequestId,
    maximumReplacementRequests: 1, maximumPhysicalReferenceAttempts: 8,
    maximumAdditionalCostCents: 30, maximumTotalCostCents: 480,
    evidenceSha256: digest('synthetic separate approval'), approvedAt: iso(AT - 1000), expiresAt: iso(AT + 600000) };
}
function replacementApproval() {
  return { ...extraApproval(), kind: 'zero-charge-reference-replacement-approval',
    maximumAdditionalCostCents: 0, maximumTotalCostCents: 450 };
}
function rejection() {
  return { version: 1, requestId: S.originalRequestId, status: 'COMPLETED', httpStatus: 403,
    detail: 'User is locked. Reason: TOP_UP.', statusSha256: digest('synthetic status'),
    resultSha256: digest('synthetic result'), observedAt: iso(AT) };
}
function fixture(options = {}) {
  let serial = 0, clock = AT, complete = false, pricingCalls = 0;
  const records = new Map(), writes = [], posts = [], gets = [], validations = [];
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `fixture-${++serial}` });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (options.failWrite?.(path, value)) throw Error('synthetic storage failure');
    const existing = records.get(path);
    if (existing ? existing.etag !== etag : etag !== undefined) throw Error('synthetic CAS conflict');
    writes.push(path); seed(path, value);
    if (options.lostWriteReply?.(path, value)) throw Error('synthetic lost write reply');
  };
  const profile = candidateCanaryProfile(), alice = profile.plan.characters.find(c => c.id === S.characterId);
  const exactInput = characterReferenceInput(profile.manifest, alice);
  const grant = { version: 1, kind: 'fictional-kling-quality-canary-v1', runKey: S.runKey,
    characterBindingVersion: 3, ownerHash: S.ownerHash, preparedId: S.id, manifestHash: S.manifestHash,
    recipe: S.recipe, maximumCostCents: 450, maximumVideoRequests: 3, maximumReferenceRequests: 7,
    ...rates, quotedCostCents: 450, funding: 'existing-merchant-provider-credit', fictionalOnly: true,
    quoteReference: digest(`${S.recipe}:kling:${S.manifestHash}:${rates.videoMicroUsdPerSecond}:${rates.referenceMicroUsd}`),
    approvedAt: iso(AT - 1000), expiresAt: iso(AT + 600000) };
  const job = { id: S.id, ownerHash: S.ownerHash, mode: 'operator-test', status: 'uncertain',
    manifest: profile.manifest, manifestHash: S.manifestHash,
    provider: { id: 'fal', model: 'kling', recipe: S.recipe },
    authorization: { manifestHash: S.manifestHash, environment: 'production', budgetCents: 450, quoteReference: grant.quoteReference },
    shots: profile.manifest.shots.map((s, index) => { const requestKey = digest(`${S.id}:${S.manifestHash}:${s.id}`);
      return { id: s.id, requestKey, status: index === 1 ? 'uncertain' : index === 0 ? 'queued' : 'prepared',
        ...(index < 2 ? { providerJobId: `fal-${digest(`${S.recipe}:kling:${requestKey}`)}` } : {}) }; }) };
  const original = { version: 1, identity: referenceRecoveryIdentity, endpoint: FAL_MODELS.reference,
    inputHash: hash(exactInput), state: 'queued', requestId: S.originalRequestId,
    statusUrl: `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${S.originalRequestId}/status`,
    responseUrl: `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${S.originalRequestId}`, createdAt: iso(AT - 60000) };
  const adaIdentity = [...candidateOperationBounds(S.id)].find(([, b]) => b.kind === 'reference-front' && b.character.id === 'ada')[0];
  const ada = { version: 1, identity: adaIdentity, endpoint: FAL_MODELS.reference,
    inputHash: hash(characterReferenceInput(profile.manifest, profile.plan.characters.find(c => c.id === 'ada'))),
    state: 'completed', requestId: S.adaRequestId, result: { images: [{ url: 'https://v3.fal.media/synthetic-ada.jpg' }] } };
  seed(userPath(S.email), { email: S.email, role: 'owner' }); seed(referenceJobPath, job); seed(referenceGrantPath, grant);
  seed(falRequestPath(referenceRecoveryIdentity), original); seed(falRequestPath(adaIdentity), ada);
  seed('production/worker-health.json', { ready: true, model: 'kling', recipe: S.recipe, characterBindingVersion: 3,
    visualChecksVersion: 1, deliveryChecksVersion: 1, checkedAt: iso(AT) });
  const input = { email: S.email, productionId: S.id, manifestHash: S.manifestHash,
    originalRequestId: S.originalRequestId, budgetMode: 'verified-zero-charge',
    billingEvidence: zeroEvidence(), replacementApproval: replacementApproval() };
  const client = createFalClient({ key: 'synthetic-offline-key', read, write, now: () => clock,
    fetchImpl: async (url, request) => {
      if (request.method === 'POST') {
        assert.equal(url, `https://queue.fal.run/${FAL_MODELS.reference}`);
        const body = JSON.parse(request.body); assert.deepEqual(body, exactInput); posts.push(body);
        if (options.uncertain) throw Error('synthetic lost provider reply');
        return Response.json({ request_id: 'synthetic-child-reference',
          status_url: 'https://queue.fal.run/fal-ai/nano-banana-pro/requests/synthetic-child-reference/status',
          response_url: 'https://queue.fal.run/fal-ai/nano-banana-pro/requests/synthetic-child-reference' });
      }
      assert.equal(request.method, 'GET'); gets.push(url);
      if (url.endsWith('/status')) return Response.json({ status: complete ? 'COMPLETED' : 'IN_QUEUE', request_id: 'synthetic-child-reference' });
      assert.equal(url, 'https://queue.fal.run/fal-ai/nano-banana-pro/requests/synthetic-child-reference');
      return Response.json({ images: [{ url: 'https://v3.fal.media/synthetic-alice-replacement.jpg' }] });
    } });
  const service = createReferenceRecovery({ read, write, now: () => clock, client,
    pricing: async () => { options.onPricing?.({ call: ++pricingCalls, seed, records, advance: ms => { clock += ms; } });
      return options.rates || { ...rates, expiresAt: iso(clock + 60000) }; },
    verifyRejected: async receipt => { assert.deepEqual(receipt, original); return options.rejection || { ...rejection(), observedAt: iso(clock) }; },
    validateOutput: async receipt => { validations.push(receipt); if (options.invalidOutput) throw Error('synthetic invalid image'); return normalizedImage; } });
  return { service, input, records, read, seed, writes, posts, gets, validations, original, ada, adaIdentity, grant, job,
    profile, exactInput, client, now: () => clock, advance: ms => { clock += ms; }, complete: () => { complete = true; } };
}

test('zero-charge mode requires explicit fresh provider billing evidence, never absence or the TOP_UP error alone', () => {
  const input = { budgetMode: 'verified-zero-charge', replacementApproval: replacementApproval() };
  assert.equal(verifyReferenceRecoveryEvidence({ ...input, billingEvidence: zeroEvidence() }, AT), 450);
  for (const change of [e => delete e.amountCents, e => delete e.quantity, e => e.amountCents = 1, e => e.quantity = 1,
    e => e.amountCents = '0', e => e.requestId = S.adaRequestId, e => e.endpoint = FAL_MODELS.kling,
    e => e.source = 'request-absent-from-dashboard', e => e.sourceSha256 = '',
    e => e.observedAt = iso(AT + 1), e => e.observedAt = iso(AT - 86400001)]) {
    const billingEvidence = zeroEvidence(); change(billingEvidence);
    assert.throws(() => verifyReferenceRecoveryEvidence({ ...input, billingEvidence }, AT), unverified);
  }
  for (const billingEvidence of [undefined, null, rejection()])
    assert.throws(() => verifyReferenceRecoveryEvidence({ ...input, billingEvidence }, AT), unverified);
});

test('480 cents requires exact separate 30-cent approval and cannot expand the existing 450-cent grant', () => {
  const input = { budgetMode: 'separate-30-cent-approval', additionalApproval: extraApproval() };
  assert.equal(verifyReferenceRecoveryEvidence(input, AT), 480);
  for (const change of [a => a.maximumTotalCostCents = 481, a => a.maximumAdditionalCostCents = 31,
    a => a.maximumReplacementRequests = 2, a => a.maximumPhysicalReferenceAttempts = 9,
    a => a.preparedId = 'another-film', a => a.originalRequestId = S.adaRequestId, a => a.manifestHash = digest('changed'),
    a => a.email = 'another@example.invalid', a => a.evidenceSha256 = '', a => a.expiresAt = iso(AT), a => a.approvedAt = iso(AT + 1)]) {
    const additionalApproval = extraApproval(); change(additionalApproval);
    assert.throws(() => verifyReferenceRecoveryEvidence({ ...input, additionalApproval }, AT), unverified);
  }
  for (const value of [{}, { budgetMode: 'separate-30-cent-approval' }, { ...input, billingEvidence: zeroEvidence() },
    { budgetMode: 'verified-zero-charge', billingEvidence: zeroEvidence(), additionalApproval: extraApproval() }])
    assert.throws(() => verifyReferenceRecoveryEvidence(value, AT), unverified);
});

test('only a fresh confirmed TOP_UP result for this failed portrait permits recovery', () => {
  assert.equal(verifyReferenceRecoveryRejection(rejection(), AT), undefined);
  for (const change of [e => e.status = 'IN_PROGRESS', e => e.httpStatus = 429, e => e.httpStatus = 500,
    e => e.detail = 'Unknown error', e => e.requestId = S.adaRequestId, e => e.resultSha256 = '',
    e => e.observedAt = iso(AT - 60001), e => e.observedAt = iso(AT + 1)]) {
    const evidence = rejection(); change(evidence); assert.throws(() => verifyReferenceRecoveryRejection(evidence, AT), unverified);
  }
});

test('planning verifies both budget modes without writes, generation, image validation, or child polling', async () => {
  for (const additional of [false, true]) {
    const h = fixture();
    if (additional) { h.input.budgetMode = 'separate-30-cent-approval'; h.input.additionalApproval = extraApproval();
      delete h.input.billingEvidence; delete h.input.replacementApproval; }
    const result = await h.service.recover(h.input);
    assert.equal(result.status, 'ready-for-reference-recovery'); assert.equal(result.generationSubmitted, false);
    assert.equal(result.maximumReplacementCostCents, 30); assert.equal(result.maximumPhysicalReferenceAttempts, 8);
    assert.equal(result.maximumTotalCostCents, additional ? 480 : 450);
    assert.deepEqual(h.writes, []); assert.deepEqual(h.posts, []); assert.deepEqual(h.gets, []); assert.deepEqual(h.validations, []);
  }
});

test('one exact child portrait is appended and selected; original receipt, Ada, job, and 450-cent grant are byte-for-byte unchanged', async () => {
  const h = fixture(), preservedPaths = [falRequestPath(referenceRecoveryIdentity), falRequestPath(h.adaIdentity), referenceJobPath, referenceGrantPath];
  const before = preservedPaths.map(path => JSON.stringify(h.records.get(path)));
  const first = await h.service.recover(h.input, { execute: true });
  assert.equal(first.status, 'replacement-pending'); assert.equal(first.generationSubmitted, true);
  assert.equal(first.maximumTotalCostCents, 450); assert.deepEqual(h.posts, [h.exactInput]);
  h.complete();
  const second = await h.service.recover(h.input, { execute: true });
  assert.equal(second.status, 'reference-choice-ready'); assert.equal(second.generationSubmitted, false);
  const selected = await resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash, identity: referenceRecoveryIdentity, ownerHash: S.ownerHash }, { read: h.read });
  assert.equal(selected.receipt.identity, referenceReplacementIdentity);
  assert.equal(selected.receipt.state, 'completed'); assert.equal(h.validations.length, 1);
  assert.equal(h.records.get(referenceChoicePath).value.validatedImageHash, digest(normalizedImage));
  assert.deepEqual(preservedPaths.map(path => JSON.stringify(h.records.get(path))), before);
  assert.deepEqual(new Set(h.writes), new Set([referenceRecoveryPath, falRequestPath(referenceReplacementIdentity), referenceChoicePath]));
  assert.deepEqual(await h.client.get(referenceRecoveryIdentity), h.original);
  await h.service.recover(h.input, { execute: true }); assert.equal(h.posts.length, 1); assert.equal(h.validations.length, 1);
});

test('missing approval, ambiguous billing, and unapproved expanded original grants cannot create a child claim', async () => {
  for (const change of [h => delete h.input.replacementApproval, h => delete h.input.billingEvidence,
    h => { h.input.budgetMode = 'separate-30-cent-approval'; delete h.input.replacementApproval; delete h.input.billingEvidence; },
    h => { h.input.billingEvidence.quantity = null; }, h => { h.input.billingEvidence.amountCents = null; },
    h => h.seed(referenceGrantPath, { ...h.grant, maximumCostCents: 480, maximumReferenceRequests: 8 })]) {
    const h = fixture(); change(h);
    await assert.rejects(h.service.recover(h.input, { execute: true }), unverified);
    assert.equal(h.posts.length, 0); assert.equal(h.records.has(referenceRecoveryPath), false);
  }
});

test('separate 30-cent approval records a 480-cent ceiling while preserving the original 450-cent grant', async () => {
  const h = fixture(), originalGrant = JSON.stringify(h.records.get(referenceGrantPath));
  h.input.budgetMode = 'separate-30-cent-approval'; h.input.additionalApproval = extraApproval();
  delete h.input.billingEvidence; delete h.input.replacementApproval;
  const result = await h.service.recover(h.input, { execute: true });
  assert.equal(result.maximumTotalCostCents, 480); assert.equal(h.posts.length, 1);
  const claim = h.records.get(referenceRecoveryPath).value;
  assert.equal(claim.maximumReplacementCostCents, 30); assert.equal(claim.maximumTotalCostCents, 480);
  assert.equal(claim.maximumPhysicalReferenceAttempts, 8); assert.equal(claim.maximumVideoRequests, 3);
  assert.equal(JSON.stringify(h.records.get(referenceGrantPath)), originalGrant);
});

test('changed owner, job, original receipt, health, downstream work, or prices block new generation', async () => {
  const changes = [h => { h.input.email = 'other@example.invalid'; }, h => { h.input.originalRequestId = S.adaRequestId; },
    h => h.seed(userPath(S.email), { email: S.email, role: 'owner', status: 'suspended' }),
    h => h.seed(referenceJobPath, { ...h.job, status: 'completed' }),
    h => h.seed(referenceJobPath, { ...h.job, lease: { token: 'other-worker', expiresAt: AT + 90000 } }),
    h => h.seed(referenceJobPath, { ...h.job, manifest: { ...h.job.manifest, title: 'changed' } }),
    h => h.seed(falRequestPath(referenceRecoveryIdentity), { ...h.original, state: 'uncertain' }),
    h => h.seed(falRequestPath(referenceRecoveryIdentity), { ...h.original, result: { images: [] } }),
    h => h.seed(falRequestPath(referenceRecoveryIdentity), { ...h.original, inputHash: digest('changed') }),
    h => h.seed('production/worker-health.json', { ...h.records.get('production/worker-health.json').value, checkedAt: iso(AT - 180001) }),
    h => h.seed('production/worker-health.json', { ...h.records.get('production/worker-health.json').value, characterBindingVersion: 2 }),
    h => { const identity = [...candidateOperationBounds(S.id)].find(([, b]) => b.kind === 'start-frame')[0];
      h.seed(falRequestPath(identity), { identity, state: 'uncertain' }); }];
  for (const change of changes) {
    const h = fixture(); change(h); await assert.rejects(h.service.recover(h.input, { execute: true }), unverified); assert.equal(h.posts.length, 0);
  }
  for (const changed of [{ referenceMicroUsd: 300001 }, { videoMicroUsdPerSecond: 150001 }, { referenceMicroUsd: 0 },
    { referenceMicroUsd: NaN }, { expiresAt: iso(AT) }]) {
    const h = fixture({ rates: { ...rates, expiresAt: iso(AT + 60000), ...changed } });
    await assert.rejects(h.service.recover(h.input, { execute: true }), unverified); assert.equal(h.posts.length, 0);
  }
});

test('the job must retain its original production authorization before replacement submission', async () => {
  const original = fixture().job.authorization;
  for (const authorization of [undefined, { ...original, budgetCents: 480 },
    { ...original, environment: 'test' }, { ...original, manifestHash: digest('another manifest') },
    { ...original, quoteReference: 'another-quote' }]) {
    const h = fixture(); h.seed(referenceJobPath, { ...h.job, authorization });
    await assert.rejects(h.service.recover(h.input, { execute: true }), unverified);
    assert.equal(h.posts.length, 0); assert.equal(h.records.has(referenceRecoveryPath), false);
  }
});

test('authorization and source changes during the final price read prevent the POST', async () => {
  for (const mutate of [c => c.seed(referenceGrantPath, { ...c.records.get(referenceGrantPath).value, expiresAt: iso(AT + 500000) }),
    c => c.seed(referenceJobPath, { ...c.records.get(referenceJobPath).value, lease: { token: 'new-worker', expiresAt: AT + 90000 } }),
    c => c.seed(falRequestPath(referenceRecoveryIdentity), { ...c.records.get(falRequestPath(referenceRecoveryIdentity)).value, checkedAt: iso(AT) }),
    c => c.seed(userPath(S.email), { email: S.email, role: 'owner', status: 'suspended' }), c => c.advance(600001)]) {
    const h = fixture({ onPricing: context => { if (context.call === 2) mutate(context); } });
    await assert.rejects(h.service.recover(h.input, { execute: true }), unverified);
    assert.equal(h.posts.length, 0);
  }
});

test('failed or ambiguous immutable-claim writes never produce duplicate child submissions', async () => {
  const denied = fixture({ failWrite: path => path === referenceRecoveryPath });
  await assert.rejects(denied.service.recover(denied.input, { execute: true }), unverified); assert.equal(denied.posts.length, 0);
  const lost = fixture({ lostWriteReply: path => path === referenceRecoveryPath });
  await lost.service.recover(lost.input, { execute: true }); await lost.service.recover(lost.input, { execute: true });
  assert.equal(lost.posts.length, 1); assert.equal(lost.records.get(referenceRecoveryPath).value.maximumTotalCostCents, 450);
});

test('uncertain child POST outcome is retained and never resubmitted, including after approval expiry', async () => {
  const h = fixture({ uncertain: true });
  const first = await h.service.recover(h.input, { execute: true }); assert.equal(first.state, 'uncertain');
  h.advance(700000);
  for (let i = 0; i < 3; i++) {
    const result = await h.service.recover(h.input, { execute: true });
    assert.equal(result.status, 'replacement-needs-attention'); assert.equal(result.state, 'uncertain'); assert.equal(result.generationSubmitted, false);
  }
  assert.equal(h.posts.length, 1); assert.equal(h.gets.length, 0); assert.equal(h.records.has(referenceChoicePath), false);
});

test('lost child receipt writes preserve the original submit claim without another POST', async () => {
  const h = fixture({ failWrite: (path, value) => path === falRequestPath(referenceReplacementIdentity) && value.state === 'queued' });
  await assert.rejects(h.service.recover(h.input, { execute: true }), { code: 'FAL_RECEIPT_UNCONFIRMED' });
  assert.equal(h.posts.length, 1); assert.equal(h.records.get(falRequestPath(referenceReplacementIdentity)).value.state, 'submitting');
  const next = await h.service.recover(h.input, { execute: true });
  assert.equal(next.state, 'submitting'); assert.equal(next.status, 'replacement-needs-attention');
  assert.equal(next.generationSubmitted, false); assert.equal(h.posts.length, 1);
});

test('an approved recovery claim without a child cannot authorize submission after approval expiry', async () => {
  const h = fixture({ failWrite: path => path === falRequestPath(referenceReplacementIdentity) });
  await assert.rejects(h.service.recover(h.input, { execute: true }), { code: 'FAL_CLAIM_UNCONFIRMED' });
  assert.ok(h.records.has(referenceRecoveryPath)); assert.equal(h.posts.length, 0); h.advance(700000);
  await assert.rejects(h.service.recover(h.input, { execute: true }), unverified); assert.equal(h.posts.length, 0);
});

test('concurrent recovery calls share one durable child operation', async () => {
  const h = fixture();
  const outcomes = await Promise.allSettled([h.service.recover(h.input, { execute: true }), h.service.recover(h.input, { execute: true })]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled')); assert.equal(h.posts.length, 1);
  assert.equal(h.records.get(falRequestPath(referenceReplacementIdentity)).value.requestId, 'synthetic-child-reference');
});

test('a completed child still requires output validation before it becomes a usable choice', async () => {
  const h = fixture({ invalidOutput: true }); await h.service.recover(h.input, { execute: true }); h.complete();
  await assert.rejects(h.service.recover(h.input, { execute: true }), /synthetic invalid image/);
  assert.equal(h.posts.length, 1); assert.equal(h.records.has(referenceChoicePath), false);
  assert.equal(await resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash, identity: referenceRecoveryIdentity, ownerHash: S.ownerHash }, { read: h.read }), null);
});

test('completed choices survive grant expiry and downstream progress; fresh submissions still require current approval', async () => {
  const h = fixture(); await h.service.recover(h.input, { execute: true }); h.complete(); h.advance(700000);
  assert.equal((await h.service.recover(h.input, { execute: true })).status, 'reference-choice-ready');
  h.seed(referenceJobPath, { ...h.job, status: 'processing' });
  const selected = await resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash, identity: referenceRecoveryIdentity, ownerHash: S.ownerHash }, { read: h.read });
  assert.equal(selected.receipt.identity, referenceReplacementIdentity); assert.equal(h.posts.length, 1);
  const fresh = fixture(); fresh.advance(700000);
  await assert.rejects(fresh.service.recover(fresh.input, { execute: true }), unverified); assert.equal(fresh.posts.length, 0);
});

test('durable choices reject mutated claims, receipts, manifests, or grant history instead of silently falling back', async () => {
  for (const mutate of [h => h.seed(referenceGrantPath, { ...h.grant, maximumCostCents: 480 }),
    h => h.seed(referenceChoicePath, { ...h.records.get(referenceChoicePath).value, resultHash: digest('different result') }),
    h => h.seed(falRequestPath(referenceReplacementIdentity), { ...h.records.get(falRequestPath(referenceReplacementIdentity)).value, requestId: 'changed-child' }),
    h => h.seed(referenceRecoveryPath, { ...h.records.get(referenceRecoveryPath).value, maximumReplacementCostCents: 31 }),
    h => h.seed(referenceJobPath, { ...h.job, manifestHash: digest('another film') })]) {
    const h = fixture(); await h.service.recover(h.input, { execute: true }); h.complete();
    await h.service.recover(h.input, { execute: true }); mutate(h);
    await assert.rejects(resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash, identity: referenceRecoveryIdentity, ownerHash: S.ownerHash }, { read: h.read }), unverified);
    assert.equal(h.posts.length, 1);
  }
  let reads = 0;
  assert.equal(await resolveReferenceChoice({ productionId: S.id, manifestHash: S.manifestHash, identity: digest('unrelated portrait'), ownerHash: S.ownerHash },
    { read: async () => { reads++; throw Error('unexpected storage read'); } }), null);
  assert.equal(reads, 0);
});

test('an existing choice rejects a missing or wrong caller owner even with the exact production and manifest identities', async () => {
  const h = fixture(); await h.service.recover(h.input, { execute: true }); h.complete();
  await h.service.recover(h.input, { execute: true });
  const context = { productionId: S.id, manifestHash: S.manifestHash, identity: referenceRecoveryIdentity };
  for (const ownerHash of [undefined, digest('other-owner@example.invalid')]) {
    const reads = [];
    await assert.rejects(resolveReferenceChoice({ ...context, ownerHash }, { read: async path => {
      reads.push(path); return h.read(path);
    } }), unverified);
    assert.deepEqual(reads, [referenceChoicePath], 'Reject before reading the owner job, grant, claim, or media receipt');
  }
  assert.equal((await resolveReferenceChoice({ ...context, ownerHash: S.ownerHash }, { read: h.read })).receipt.identity, referenceReplacementIdentity);
  assert.equal(h.posts.length, 1);
});

test('TOP_UP verifier makes only bounded authenticated GETs to the exact saved request', async () => {
  const h = fixture(), seen = [];
  const status = { status: 'COMPLETED', request_id: S.originalRequestId };
  const result = { detail: 'User is locked. Reason: TOP_UP.' };
  const proof = await verifyTopUpRejectedReference(h.original, { key: 'synthetic-offline-key', now: () => AT,
    fetchImpl: async (url, request) => {
      seen.push(url); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
      assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'no-store'); assert.equal(request.body, undefined);
      assert.ok(request.signal instanceof AbortSignal); assert.equal(request.headers.Authorization, 'Key synthetic-offline-key');
      return Response.json(url.endsWith('/status') ? status : result, { status: url.endsWith('/status') ? 200 : 403 });
    } });
  assert.deepEqual(seen, [h.original.statusUrl, h.original.responseUrl]);
  assert.equal(proof.statusSha256, hash(status)); assert.equal(proof.resultSha256, hash(result));
  verifyReferenceRecoveryRejection(proof, AT);
  for (const url of ['https://attacker.example.invalid/requests/anything/status',
    h.original.statusUrl.replace(S.originalRequestId, S.adaRequestId), `${h.original.statusUrl}?redirect=anything`]) {
    let calls = 0;
    await assert.rejects(verifyTopUpRejectedReference({ ...h.original, statusUrl: url }, { key: 'synthetic-offline-key',
      fetchImpl: async () => { calls++; throw Error('must not send credentials'); } }), { code: 'FAL_RECEIPT_INVALID' });
    assert.equal(calls, 0);
  }
});

test('TOP_UP verifier rejects unrelated terminal responses and cancels oversized status or error streams', async () => {
  const h = fixture();
  for (const options of [{ status: 'IN_PROGRESS' }, { request_id: S.adaRequestId }, { resultStatus: 200 },
    { resultStatus: 500 }, { result: { detail: 'Other error' } }, { result: { detail: 'User is locked. Reason: TOP_UP.', extra: 'not-reviewed' } }]) {
    await assert.rejects(verifyTopUpRejectedReference(h.original, { key: 'synthetic-offline-key', now: () => AT,
      fetchImpl: async url => url.endsWith('/status')
        ? Response.json({ status: options.status || 'COMPLETED', request_id: options.request_id || S.originalRequestId })
        : Response.json(options.result || { detail: 'User is locked. Reason: TOP_UP.' }, { status: options.resultStatus || 403 }) }), unverified);
  }
  for (const oversizedStatus of [false, true]) {
    let canceled = false, calls = 0;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16385)); },
      cancel() { canceled = true; } }, { highWaterMark: 0 });
    await assert.rejects(verifyTopUpRejectedReference(h.original, { key: 'synthetic-offline-key', now: () => AT,
      fetchImpl: async url => { calls++;
        if (url.endsWith('/status') && !oversizedStatus) return Response.json({ status: 'COMPLETED', request_id: S.originalRequestId });
        return new Response(body, { status: oversizedStatus ? 200 : 403 }); } }), unverified);
    assert.equal(canceled, true); assert.equal(calls, oversizedStatus ? 1 : 2);
  }
});

test('malformed provider JSON cannot put echoed private text into verification errors', async () => {
  const h = fixture(), marker = 'SYNTHETIC_PRIVATE_ECHO';
  await assert.rejects(verifyTopUpRejectedReference(h.original, { key: 'synthetic-offline-key', now: () => AT,
    fetchImpl: async url => url.endsWith('/status') ? Response.json({ status: 'COMPLETED', request_id: S.originalRequestId })
      : new Response(`{"detail": ${marker}}`, { status: 403 }) }),
  error => error.code === 'REFERENCE_RECOVERY_UNVERIFIED' && !String(error.stack).includes(marker));
});
