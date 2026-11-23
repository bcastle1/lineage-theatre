import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { digest } from '../api/_lib/auth.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { planSeedanceShots } from '../api/_lib/kling-film-plan.mjs';
import { SEEDANCE_RECIPE_VERSION, falShotInput } from '../api/_lib/fal-production.mjs';
import { createFilmVisualReviewService, visualReviewBinding, visualReceiptPath, visualSampleTimes,
  VISUAL_REVIEW_MODEL, stageVisualSceneContext, verifiedStageVisualDecision, verifyFilmVisualReceipts } from '../api/_lib/film-visual-review.mjs';
import { visualReviewRecoveryPath } from '../api/_lib/film-visual-review-recovery.mjs';

const hash = value => digest(JSON.stringify(value));
const dimensions = ['appearance', 'wardrobe', 'sceneAction', 'imageIntegrity', 'cast'];
const consistent = () => ({ ...Object.fromEntries(dimensions.map(key => [key, 'consistent'])), findings: [] });
const decision = () => ({ ...consistent(), observations: dimensions.map((dimension, index) => ({
  dimension, sampleIndex: index % 3, visibleEvidence: `Synthetic visible evidence for ${dimension}.` })) });
const response = value => Response.json({ status: 'completed', model: VISUAL_REVIEW_MODEL,
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

// Fictional manifests, actual JPEG encoding and production validators; every
// provider/model transport and every record remains in memory.
async function fixture() {
  const email = 'stage-review@example.invalid', id = '11111111-1111-4111-8111-111111111111';
  const project = fictionalOperatorProject(); project.duration = 30;
  project.scenes = ['Plant', 'Water', 'Rest', 'Share'].map(title => ({ ...project.scenes[0], title,
    visual: 'Two fictional adult sisters tend flowers beside a garden path.',
    narration: 'The fictional sisters quietly tend their garden together.', dialogue: '' }));
  project.scenes[0].visual += ' Title over action: "A Fictional Garden". Smaller caption: "Spring 1900". Unsupported label: keep this direction.';
  project.scenes[3].visual += ' End card: "Ada Example".';
  const manifest = planSeedanceShots(buildFilmManifest(project).manifest), manifestHash = hash(manifest);
  const job = { version: 1, id, ownerHash: digest(email), mode: 'customer', status: 'awaiting-assembly', manifest, manifestHash,
    provider: { id: 'fal', model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION },
    shots: manifest.shots.map(shot => ({ id: shot.id, status: 'completed', output: {
      url: `https://v3.fal.media/fictional-${shot.id}.mp4`, contentType: 'video/mp4', sizeBytes: 1024,
      sha256: digest(`fictional-bytes-${shot.id}`), durationSeconds: Math.ceil(shot.targetDurationMs / 1000) } })) };
  const dataUrl = `data:image/jpeg;base64,${(await sharp({ create: { width: 96, height: 96, channels: 3, background: '#446688' } }).jpeg().toBuffer()).toString('base64')}`;
  const input = (index = 0) => {
    const shot = manifest.shots[index], previous = manifest.shots[index - 1];
    const frames = visualSampleTimes(shot).map(atMs => ({ shotId: shot.id, atMs, dataUrl }));
    if (previous?.sceneIndex === shot.sceneIndex) frames.push({ shotId: previous.id, atMs: visualSampleTimes(previous)[2], dataUrl });
    return { email, id, job, shotId: shot.id, frames };
  };
  const { binding, bindingHash } = visualReviewBinding(job, manifest.shots[0].id, input().frames);
  const prior = { version: 1, state: 'reviewed', binding, bindingHash, model: VISUAL_REVIEW_MODEL, attempts: 1,
    createdAt: '2026-11-01T12:00:00Z', reviewedAt: '2026-11-01T12:00:01Z',
    decision: { ...consistent(), sceneAction: 'mismatch', findings: ['wrong-action-or-setting'] } };
  const priorFailure = { version: 1, manifestHash, state: 'attention', stage: 'visual-review',
    reason: 'VISUAL_CONTINUITY_MISMATCH', recordedAt: '2026-11-01T12:00:02Z' };
  job.visualReviewRecovery = { version: 1, policy: 'pre-assembly-overlays-v2', ownerHash: job.ownerHash,
    preparedId: id, sourceManifestHash: manifestHash, shotId: manifest.shots[0].id,
    priorBindingHash: bindingHash, priorReceiptHash: hash(prior), sourceOutputHash: binding.outputHash,
    sourceFrameHashes: binding.frameHashes, shots: job.shots.map(shot => ({ shotId: shot.id, outputHash: hash(shot.output) })),
    approvedAt: '2026-11-01T12:00:03Z', approvedBy: email, priorFailure };
  job.finishingFailure = { ...priorFailure, state: 'retrying' };
  const records = new Map(), writes = [], requests = []; let serial = 0;
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: `stage-${++serial}` });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, expected) => {
    if (records.get(path)?.etag !== expected) throw Error('precondition failed');
    seed(path, value); writes.push(path);
  };
  const jobPath = `production/jobs/${job.ownerHash}/${id}.json`, grantPath = visualReviewRecoveryPath(job);
  const priorPath = visualReceiptPath(job.ownerHash, id, bindingHash);
  seed(jobPath, job); seed(grantPath, job.visualReviewRecovery); seed(priorPath, prior);
  const options = { read, write, key: 'offline-only', authorize: async () => true,
    fetchImpl: async (url, init) => { assert.equal(url, 'https://api.openai.com/v1/responses'); requests.push(JSON.parse(init.body)); return response(decision()); } };
  return { email, id, job, jobPath, grantPath, priorPath, prior, input, options, records, writes, requests, seed, read, write };
}

test('stage-aware reviews preserve the original rejection and all clips while separating only recognized assembly text', async () => {
  const f = await fixture(), original = await f.read(f.priorPath), manifest = structuredClone(f.job.manifest), outputs = structuredClone(f.job.shots);
  const inputs = f.job.manifest.shots.map(shot => falShotInput(f.job.manifest, shot, 'seedance', {}));
  const service = createFilmVisualReviewService(f.options), proofs = [];
  for (let i = 0; i < f.job.shots.length; i++) proofs.push(await service(f.input(i)));
  assert.equal(f.requests.length, 4); assert.ok(proofs.every(proof => proof.passed && proof.reviewVersion === 2));
  const request = f.requests[0], context = JSON.parse(request.input[0].content[0].text);
  assert.equal(request.model, 'gpt-6.2-astra'); assert.equal(request.store, false); assert.equal(request.text.format.strict, true);
  assert.equal(context.scene.reviewStage, 'raw-clip-before-assembly-overlays');
  assert.match(context.scene.visual, /sisters tend flowers/); assert.match(context.scene.visual, /Unsupported label: keep this direction/);
  assert.doesNotMatch(context.scene.visual, /A Fictional Garden|Spring 1900/);
  assert.deepEqual(context.scene.assemblyOverlays, [{ text: 'A Fictional Garden', style: 'Title' }, { text: 'Spring 1900', style: 'Location' }]);
  assert.match(request.instructions, /mismatch only for a visible contradiction/);
  assert.equal(request.input[0].content.filter(part => part.type === 'input_text' && /^Sample [0-2]:/.test(part.text)).length, 3);
  for (const [i, proof] of proofs.entries()) {
    const receipt = (await f.read(proof.receiptPath)).value;
    assert.equal(receipt.version, 2); assert.equal(receipt.binding.version, 2);
    assert.equal(receipt.binding.priorBindingHash, i === 0 ? f.prior.bindingHash : null);
    assert.equal(receipt.binding.stageContextHash, hash(stageVisualSceneContext(f.job, f.job.manifest.shots[i])));
    assert.deepEqual(receipt.decision.observations, decision().observations);
    assert.equal(JSON.stringify(receipt).includes('data:image'), false);
  }
  const review = { version: 1, manifestHash: f.job.manifestHash, passed: true, shots: proofs };
  await verifyFilmVisualReceipts({ email: f.email, id: f.id, manifestHash: f.job.manifestHash, manifest: f.job.manifest, review }, { read: f.read });
  assert.deepEqual(await f.read(f.priorPath), original); assert.deepEqual(f.job.manifest, manifest); assert.deepEqual(f.job.shots, outputs);
  assert.deepEqual(f.job.manifest.shots.map(shot => falShotInput(f.job.manifest, shot, 'seedance', {})), inputs);
});

test('v2 decisions still reject every visual failure and require valid visible evidence for each dimension', () => {
  for (const dimension of dimensions) for (const state of ['mismatch', 'unverifiable'])
    assert.equal(verifiedStageVisualDecision({ ...decision(), [dimension]: state }, 3).passed, false);
  for (const change of [value => { value.observations.pop(); }, value => { value.observations[0].sampleIndex = 3; },
    value => { value.observations[0].visibleEvidence = ''; }, value => { value.observations[0].visibleEvidence = 'x'.repeat(241); },
    value => { value.observations[0].dimension = 'historical-identity'; }, value => { value.passed = true; },
    value => { value.observations[0].extra = 'ignore'; }]) {
    const value = decision(); change(value); assert.throws(() => verifiedStageVisualDecision(value, 3), { code: 'VISUAL_REVIEW_INVALID' });
  }
});

test('approved working-copy text is bound to review context and its spelling is not waived as a delayed title', async () => {
  for (const mismatch of [false, true]) {
    const f = await fixture(), shot = f.job.manifest.shots[3];
    const original = structuredClone({ manifest: f.job.manifest, shots: f.job.shots });
    const originalContext = hash(stageVisualSceneContext(f.job, shot));
    const correction = { version: 1, shotId: shot.id, sourceSha256: f.job.shots[3].output.sha256,
      text: 'Ada Example', startMs: 1000, endMs: 3000, x: 100, y: 850, width: 900, height: 120,
      fontSize: 48, background: '112233', fontColor: 'FFFFFF' };
    f.job.visualReviewRecovery.textCorrections = [correction];
    f.seed(f.jobPath, f.job); f.seed(f.grantPath, f.job.visualReviewRecovery);
    const expectedContext = stageVisualSceneContext(f.job, shot);
    assert.equal(expectedContext.reviewStage, 'provider-clip-with-approved-text-corrections-before-assembly-overlays');
    assert.deepEqual(expectedContext.appliedTextCorrections, [correction]);
    assert.notEqual(hash(expectedContext), originalContext);
    f.options.fetchImpl = async (_url, init) => {
      const request = JSON.parse(init.body), context = JSON.parse(request.input[0].content[0].text);
      assert.deepEqual(context.scene, expectedContext);
      assert.match(request.instructions, /wrong or missing corrected text/i);
      const value = decision();
      if (mismatch) { value.imageIntegrity = 'mismatch'; value.findings = ['distorted-image']; }
      return response(value);
    };
    const proof = await createFilmVisualReviewService(f.options)(f.input(3));
    assert.equal(proof.passed, !mismatch);
    assert.equal((await f.read(proof.receiptPath)).value.binding.stageContextHash, hash(expectedContext));
    assert.deepEqual({ manifest: f.job.manifest, shots: f.job.shots }, original);
    f.records.get(f.grantPath).value.textCorrections[0].x++;
    await assert.rejects(createFilmVisualReviewService(f.options)(f.input(3)), { code: 'VISUAL_REVIEW_INVALID' });
  }
});

test('one v2 attempt remains held after rate limiting, unknown execution, malformed observations or a review mismatch', async () => {
  for (const outcome of ['rate-limit', 'lost-response', 'bad-observation', 'mismatch']) {
    const f = await fixture(); let calls = 0;
    f.options.fetchImpl = async () => {
      calls++;
      if (outcome === 'rate-limit') return new Response('{}', { status: 429 });
      if (outcome === 'lost-response') throw Error('Synthetic unknown inference result');
      const value = decision();
      if (outcome === 'bad-observation') value.observations[0].sampleIndex = 9;
      if (outcome === 'mismatch') { value.sceneAction = 'mismatch'; value.findings = ['wrong-action-or-setting']; }
      return response(value);
    };
    const service = createFilmVisualReviewService(f.options);
    if (outcome === 'mismatch') {
      const first = await service(f.input()); assert.equal(first.passed, false); assert.deepEqual(await service(f.input()), first);
    } else {
      await assert.rejects(service(f.input()));
      await assert.rejects(createFilmVisualReviewService({ ...f.options, now: () => Date.now() + 86400000 })(f.input()));
    }
    assert.equal(calls, 1); assert.deepEqual((await f.read(f.priorPath)).value, f.prior);
  }
});

test('an old passing v1 review cannot stand in for the approved corrected-text v2 review', async () => {
  const f = await fixture(), shot = f.job.manifest.shots[3], originalJob = structuredClone(f.job);
  delete originalJob.visualReviewRecovery;
  const { binding, bindingHash } = visualReviewBinding(originalJob, shot.id, f.input(3).frames);
  const path = visualReceiptPath(f.job.ownerHash, f.id, bindingHash);
  const originalReceipt = { ...f.prior, binding, bindingHash, decision: consistent() };
  f.seed(path, originalReceipt);
  f.job.visualReviewRecovery.textCorrections = [{ version: 1, shotId: shot.id,
    sourceSha256: f.job.shots[3].output.sha256, text: 'Ada Example', startMs: 1000, endMs: 3000,
    x: 100, y: 850, width: 900, height: 120, fontSize: 48, background: '112233', fontColor: 'FFFFFF' }];
  f.seed(f.jobPath, f.job); f.seed(f.grantPath, f.job.visualReviewRecovery);
  const service = createFilmVisualReviewService(f.options), shots = [];
  for (let index = 0; index < 4; index++) shots.push(await service(f.input(index)));
  assert.equal(f.requests.length, 4); assert.equal(shots[3].reviewVersion, 2);
  assert.deepEqual((await f.read(path)).value, originalReceipt);
  const review = { version: 1, manifestHash: f.job.manifestHash, passed: true, shots };
  const input = { email: f.email, id: f.id, manifestHash: f.job.manifestHash, manifest: f.job.manifest, review };
  await verifyFilmVisualReceipts(input, { read: f.read });
  review.shots[3] = { version: 1, bindingHash, manifestHash: f.job.manifestHash,
    shotId: shot.id, passed: true, receiptPath: path };
  await assert.rejects(verifyFilmVisualReceipts(input, { read: f.read }), { code: 'VISUAL_REVIEW_INVALID' });
});

test('concurrent v2 calls and a lost completed-receipt reply use one inference and exact readback', async () => {
  const f = await fixture(); let lost = false;
  f.options.write = async (path, value, etag) => {
    await f.write(path, value, etag);
    if (!lost && value.version === 2 && value.state === 'reviewed') { lost = true; throw Error('Synthetic lost immutable review reply'); }
  };
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => createFilmVisualReviewService(f.options)(f.input())));
  assert.equal(f.requests.length, 1); assert.equal(lost, true);
  const winner = results.find(result => result.status === 'fulfilled'); assert.ok(winner);
  assert.deepEqual(await createFilmVisualReviewService({ ...f.options, key: null,
    fetchImpl: () => assert.fail('No repeat inference') })(f.input()), winner.value);
});

test('changed pinned frames, clips, grant or prior receipt cannot obtain a v2 review', async () => {
  for (const change of [
    (f, input) => { input.frames[0].atMs++; },
    (f, input) => { input.frames.reverse(); },
    f => { f.job.shots[1].output.sizeBytes++; },
    f => { f.records.delete(f.grantPath); },
    f => { f.records.get(f.priorPath).value.decision.sceneAction = 'consistent'; },
    f => { f.records.get(f.jobPath).value.visualReviewRecovery.policy = 'other-policy'; },
  ]) {
    const f = await fixture(), input = f.input(); change(f, input);
    await assert.rejects(createFilmVisualReviewService(f.options)(input)); assert.equal(f.requests.length, 0);
  }
});

test('a different shot with an existing rejected or uncertain v1 receipt is not silently re-reviewed', async () => {
  for (const state of ['reviewed', 'submitting']) {
    const f = await fixture(), originalJob = structuredClone(f.job); delete originalJob.visualReviewRecovery;
    const input = f.input(1), { binding, bindingHash } = visualReviewBinding(originalJob, input.shotId, input.frames);
    f.seed(visualReceiptPath(f.job.ownerHash, f.id, bindingHash), { ...f.prior, state, binding, bindingHash });
    await assert.rejects(createFilmVisualReviewService(f.options)(input)); assert.equal(f.requests.length, 0);
  }
  const f = await fixture(), originalJob = structuredClone(f.job); delete originalJob.visualReviewRecovery;
  const input = f.input(1), { binding, bindingHash } = visualReviewBinding(originalJob, input.shotId, input.frames);
  f.seed(visualReceiptPath(f.job.ownerHash, f.id, bindingHash), { ...f.prior, binding, bindingHash, decision: consistent() });
  const proof = await createFilmVisualReviewService(f.options)(input);
  assert.equal(proof.passed, true); assert.equal(proof.reviewVersion, undefined); assert.equal(f.requests.length, 0);
});

test('delivery rejects changed v2 contract, missing recovery grant and a forged pass over a saved mismatch', async () => {
  for (const kind of ['contract', 'missing-grant', 'mismatch', 'extra-attempt']) {
    const f = await fixture(), service = createFilmVisualReviewService(f.options), shots = [];
    for (let i = 0; i < f.job.shots.length; i++) shots.push(await service(f.input(i)));
    if (kind === 'missing-grant') f.records.delete(f.grantPath);
    else {
      const receipt = f.records.get(shots[0].receiptPath).value;
      if (kind === 'mismatch') receipt.decision.sceneAction = 'mismatch';
      else if (kind === 'extra-attempt') receipt.attempts = 2;
      else receipt.binding.stageContextHash = digest('different-review-contract');
    }
    await assert.rejects(verifyFilmVisualReceipts({ email: f.email, id: f.id, manifestHash: f.job.manifestHash,
      manifest: f.job.manifest, review: { version: 1, manifestHash: f.job.manifestHash, passed: true, shots } }, { read: f.read }));
  }
});

test('revoking the immutable recovery during inference prevents a reviewed receipt and never authorizes replay', async () => {
  const f = await fixture(), saved = await f.read(f.grantPath); let calls = 0;
  f.options.fetchImpl = async () => { calls++; f.records.delete(f.grantPath); return response(decision()); };
  await assert.rejects(createFilmVisualReviewService(f.options)(f.input()));
  f.records.set(f.grantPath, saved);
  await assert.rejects(createFilmVisualReviewService(f.options)(f.input()), { code: 'VISUAL_REVIEW_UNCERTAIN' });
  assert.equal(calls, 1);
  assert.equal([...f.records.values()].filter(row => row.value.version === 2 && row.value.state === 'reviewed').length, 0);
});

test('a stale snapshot without recovery cannot reopen the old v1 path after its stored job gained a recovery marker', async () => {
  const f = await fixture(); delete f.job.visualReviewRecovery;
  await assert.rejects(createFilmVisualReviewService(f.options)(f.input(1)), { code: 'VISUAL_REVIEW_INVALID' });
  assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
});

test('a different valid JPEG encoding cannot spend another v2 review allowance on an unreviewed-source shot', async () => {
  const alternate = `data:image/jpeg;base64,${(await sharp({ create: { width: 96, height: 96, channels: 3,
    background: '#aa7755' } }).jpeg().toBuffer()).toString('base64')}`;
  for (const lost of [false, true]) {
    const f = await fixture(); let calls = 0;
    f.options.fetchImpl = async () => { calls++; if (lost) throw Error('Synthetic lost result'); return response(decision()); };
    const service = createFilmVisualReviewService(f.options);
    if (lost) await assert.rejects(service(f.input(1))); else await service(f.input(1));
    const changed = f.input(1); changed.frames[0].dataUrl = alternate;
    await assert.rejects(service(changed), { code: 'VISUAL_REVIEW_INVALID' });
    assert.equal(calls, 1);
    assert.equal([...f.records.keys()].filter(path => path.startsWith('production/visual-review-bindings/')).length, 1);
  }
  const f = await fixture(), changed = f.input(1); changed.frames[0].dataUrl = alternate;
  const results = await Promise.allSettled([createFilmVisualReviewService(f.options)(f.input(1)), createFilmVisualReviewService(f.options)(changed)]);
  assert.equal(f.requests.length, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});
