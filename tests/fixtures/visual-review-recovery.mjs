import assert from 'node:assert/strict';
import { digest, userPath } from '../../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../../api/_lib/access.mjs';
import { buildFilmManifest, fictionalOperatorProject } from '../../api/_lib/film-production.mjs';
import { planSeedanceShots } from '../../api/_lib/kling-film-plan.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../../api/_lib/fal-production.mjs';
import { requireFinishedFilmPayment } from '../../api/_lib/production-media.mjs';
import { createVisualReviewRecovery, visualReviewRecoveryPath } from '../../api/_lib/film-visual-review-recovery.mjs';
const sha = value => digest(JSON.stringify(value));
const copy = value => structuredClone(value);

// Fictional paid-film state, conditional storage and permission transport only.
// No network, provider client, invoice, charge or inference is invoked.
export function fixture(options = {}) {
  let clock = Date.parse('2026-12-01T12:00:00Z'), serial = 0;
  const now = () => clock, records = new Map(), writes = [], authorizationCalls = [], paymentCalls = [];
  const email = OWNER_EMAIL, ownerHash = digest(email), id = '00000000-0000-4000-8000-000000000099';
  const project = fictionalOperatorProject(); project.duration = 24;
  project.scenes = ['Plant', 'Water', 'Rest', 'Share'].map(title => ({ ...project.scenes[0], title,
    narration: 'The fictional sisters tend their quiet garden together.',
    visual: 'Two adult sisters tend the flower garden together.' }));
  if (options.openingAction) project.scenes[0].visual += ` ${options.openingAction}`;
  if (options.finalAction) project.scenes[3].visual += ` ${options.finalAction}`;
  if (!options.noOverlay) project.scenes[0].visual += ' Title over action: The Fictional Garden. Smaller caption: An imaginary summer.';
  const manifest = planSeedanceShots(buildFilmManifest(project).manifest), manifestHash = sha(manifest);
  assert.equal(manifest.shots.length, 4);
  const job = { id, ownerHash, mode: 'customer', status: 'awaiting-assembly', filmId: manifest.filmId, manifest, manifestHash,
    provider: { id: 'fal', model: 'seedance', recipe: SEEDANCE_RECIPE_VERSION }, revision: 8,
    createdAt: new Date(clock - 60000).toISOString(), updatedAt: new Date(clock - 1000).toISOString(),
    authorization: { environment: 'production', manifestHash, budgetCents: 3000, quoteReference: digest('fictional quote') },
    shots: manifest.shots.map((shot, i) => ({ id: shot.id, status: 'completed', providerJobId: `fictional-clip-${i}`,
      requestKey: digest(`fictional-original-${i}`), output: { url: `https://v3.fal.media/fictional-garden-${i}.mp4`,
        contentType: 'video/mp4', sizeBytes: 128 + i, durationSeconds: Math.ceil(shot.targetDurationMs / 1000),
        sha256: digest(`fictional-video-bytes-${i}`) } })),
    finishingFailure: { version: 1, manifestHash, stage: 'visual-review', state: 'attention',
      reason: 'VISUAL_CONTINUITY_MISMATCH', recordedAt: new Date(clock - 1000).toISOString() } };
  assert.equal(job.version, undefined, 'production jobs have no top-level version');
  const orderId = digest(`${email}:production:${manifestHash}`), orderPath = `payments/orders/${orderId}.json`;
  const order = { id: orderId, customerEmail: email, preparedId: id, manifestHash, filmId: job.filmId,
    status: 'captured', currency: 'USD', amountCents: 4500, refundedCents: 0, provider: 'quickbooks',
    checkoutMethod: 'quickbooks-hosted-invoice', confirmationSource: 'quickbooks-accounting', invoiceId: '701',
    capturedAt: new Date(clock - 60000).toISOString(), accountingCheckedAt: new Date(clock - 1000).toISOString(),
    balanceCents: 0, accountingPayments: [{ id: '703', allocatedCents: 4500 }],
    merchantBinding: { environment: 'production', realmId: '704', grantId: digest('fictional merchant') } };
  const binding = { version: 1, manifestHash, shotId: job.shots[0].id, outputHash: sha(job.shots[0].output),
    precedingOutputHash: null, frameHashes: [0, 1, 2].map(i => digest(`fictional-frame-${i}`)) };
  const receipt = { version: 1, model: 'gpt-6.2-astra', state: 'reviewed', attempts: 1,
    binding, bindingHash: sha(binding), createdAt: new Date(clock - 2000).toISOString(), reviewedAt: new Date(clock - 1000).toISOString(),
    decision: { appearance: 'consistent', wardrobe: 'consistent', imageIntegrity: 'consistent', cast: 'consistent',
      sceneAction: 'mismatch', findings: ['wrong-action-or-setting'] } };
  const jobPath = `production/jobs/${ownerHash}/${id}.json`, queuePath = `production/queue/${ownerHash}/${id}.json`,
    receiptPath = `production/visual-reviews/${ownerHash}/${id}/${receipt.bindingHash}.json`, grantPath = visualReviewRecoveryPath(job);
  const hooks = {};
  const seed = (path, value) => records.set(path, { value: copy(value), etag: String(++serial) });
  const mutate = (path, change) => { const value = copy(records.get(path).value); change(value); seed(path, value); };
  const read = async path => { await hooks.beforeRead?.(path); return copy(records.get(path) || null); };
  const write = async (path, value, etag) => {
    await hooks.beforeWrite?.(path, value);
    if (records.get(path)?.etag !== etag) throw Object.assign(Error('Synthetic CAS conflict'), { code: 'BLOB_PRECONDITION_FAILED' });
    seed(path, value); writes.push({ path, value: copy(value), etag });
    await hooks.afterWrite?.(path, value);
  };
  seed(jobPath, job); seed(orderPath, order); seed(receiptPath, receipt);
  seed(userPath(email), { email, role: 'owner' });
  seed(queuePath, { version: 1, email, id, orderId, manifestHash, state: 'attention', attempts: 1,
    nextAttemptAt: clock - 1000, lastResult: 'NEEDS_ATTENTION', lastFailure: 'VISUAL_CONTINUITY_MISMATCH' });
  const input = { email, id, manifestHash, bindingHash: receipt.bindingHash, receiptHash: sha(receipt),
    shots: job.shots.map(shot => ({ shotId: shot.id, outputHash: sha(shot.output) })) };
  const service = createVisualReviewRecovery({ read, write, now,
    paymentCheck: async args => { paymentCalls.push(args.job.id); await hooks.beforePayment?.(args); return requireFinishedFilmPayment(args); },
    authorize: async args => {
      authorizationCalls.push(copy(args)); await hooks.beforeAuthorize?.(args);
      return options.permission ?? { allowed: true, manifestHash: args.manifestHash, environment: 'production',
        recoveryRequestHash: sha(args.recoveryPlan), expiresAt: new Date(clock + 60000).toISOString() };
    } });
  return { now, advance: ms => { clock += ms; }, records, writes, authorizationCalls, paymentCalls, job, order, receipt,
    jobPath, queuePath, orderPath, receiptPath, grantPath, input, email, read, write, seed, mutate, hooks, service,
    apply: () => service(input, { apply: true }), value: path => copy(records.get(path)?.value) };
}

export function correctionFor(h) {
  return { version: 1, shotId: h.job.shots[3].id, sourceSha256: h.job.shots[3].output.sha256,
    text: 'flower garden', startMs: 1000, endMs: 3000, x: 750, y: 700, width: 600, height: 120,
    fontSize: 40, background: '112233', fontColor: 'FFFFFF' };
}

