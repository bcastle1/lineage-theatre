import { digest, readRecord } from './auth.mjs';
import { falPlan, falShotInput, SEEDANCE_RECIPE_VERSION } from './fal-production.mjs';
import { FAL_MODELS, falRequestPath, falMediaUrl } from './fal-client.mjs';
import { validateVisualContinuity } from './film-visual-continuity.mjs';

export const PARTIAL_CORRECTION_KIND = 'seedance-single-scene-correction-v1';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => digest(JSON.stringify(value));
const fail = () => Object.assign(new Error('The approved scene correction could not be verified.'), { code: 'PARTIAL_CORRECTION_UNVERIFIED' });
const check = value => { if (!value) throw fail(); };
const same = (a, b) => hash(a) === hash(b);
const jobPath = (email, id) => `production/jobs/${digest(email)}/${id}.json`;
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// A new version, not an edit to the source job. Preserve every creative field
// except the explicitly approved visual direction and its derived contract.
export function buildPartialCorrectionManifest(source, { shotId, visual } = {}) {
  check(typeof visual === 'string' && visual.trim() && visual.length <= 10_000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(visual));
  check(source?.productionPlan?.provider === 'seedance' && source.shots?.length === 4 && source.screenplay?.scenes?.length === 4);
  const plan = falPlan(source, 'seedance');
  check(plan.shots.length === 4 && plan.shots.every(shot => shot.endpoint === FAL_MODELS.seedanceText));
  const index = source.shots.findIndex(shot => shot.id === shotId), shot = source.shots[index];
  check(shot && source.shots.filter(row => row.sceneIndex === shot.sceneIndex).length === 1
    && source.screenplay.scenes[shot.sceneIndex]?.visual === shot.visual && visual !== shot.visual);
  const manifest = structuredClone(source);
  manifest.shots[index].visual = visual;
  manifest.screenplay.scenes[shot.sceneIndex].visual = visual;
  const continuity = manifest.visualContinuity.scenes.find(row => row.sceneId === shot.continuity.sourceSceneId);
  check(continuity?.direction === shot.visual); continuity.direction = visual;
  validateVisualContinuity(manifest); falPlan(manifest, 'seedance');
  return { manifest, manifestHash: hash(manifest) };
}
export function partialCorrectionPreparedId(email, sourcePreparedId, manifestHash) {
  check(typeof email === 'string' && UUID.test(sourcePreparedId || '') && HASH.test(manifestHash || ''));
  const value = digest(`seedance-partial-correction-v1:${email}:${sourcePreparedId}:${manifestHash}`).slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export const partialBillingEvidencePath = evidenceHash => {
  check(HASH.test(evidenceHash || '')); return `production/correction-billing-evidence/${evidenceHash}.json`;
};

async function selectedSource(source, shotId, read) {
  const shot = source.shots.find(row => row.id === shotId);
  check(shot?.requestKey === digest(`${source.id}:${source.manifestHash}:${shotId}`));
  const originalIdentity = digest(`${SEEDANCE_RECIPE_VERSION}:seedance:${shot.requestKey}`);
  const original = await read(falRequestPath(originalIdentity));
  check(original?.etag && original.value.identity === originalIdentity && original.value.endpoint === FAL_MODELS.seedanceText);
  const choicePath = `production/fal/choices/${originalIdentity}.json`, choice = await read(choicePath);
  let record = original, identity = originalIdentity;
  if (choice) {
    const c = choice.value;
    check(c.version === 1 && c.originalIdentity === originalIdentity && c.productionId === source.id
      && c.manifestHash === source.manifestHash && c.model === 'seedance' && c.promptVersion === SEEDANCE_RECIPE_VERSION
      && c.approvedBy === source.email && HASH.test(c.replacementIdentity || ''));
    identity = c.replacementIdentity; record = await read(falRequestPath(identity));
    check(record?.value.requestId === c.requestId);
  }
  check(record?.etag && record.value.identity === identity && record.value.endpoint === FAL_MODELS.seedanceText);
  return { originalIdentity, original, identity, record, choice, choicePath };
}

// The owner reviews the complete provider attempt history against a private
// billing export. This attestation never proves customer payment or permits a
// refund. Its raw evidence hash and every exact provider record are retained.
async function billingProof(value, { email, source, order, account, read, now }) {
  check(exact(value, ['version', 'kind', 'account', 'originalOrderId', 'sourceManifestHash', 'observedAt',
    'approvedBy', 'completeAttemptHistory', 'evidenceSha256', 'attempts'])
    && value.version === 1 && value.kind === 'owner-reviewed-provider-billing-v1' && value.account === account
    && typeof account === 'string' && /^[\w.-]{1,100}$/.test(account)
    && value.originalOrderId === order.id && value.sourceManifestHash === source.manifestHash
    && value.approvedBy === email && value.completeAttemptHistory === true && HASH.test(value.evidenceSha256 || '')
    && Number.isFinite(Date.parse(value.observedAt)) && Date.parse(value.observedAt) <= now()
    && Array.isArray(value.attempts) && value.attempts.length >= 4 && value.attempts.length <= 20);
  const rows = new Map(), requestIds = new Set();
  for (const row of value.attempts) {
    check(exact(row, ['operationIdentity', 'requestId', 'recordHash', 'costNanoUsd']) && HASH.test(row.operationIdentity || '')
      && HASH.test(row.recordHash || '') && !rows.has(row.operationIdentity)
      && Number.isSafeInteger(row.costNanoUsd) && row.costNanoUsd >= 0);
    const saved = await read(falRequestPath(row.operationIdentity)), operation = saved?.value;
    check(saved?.etag && hash(operation) === row.recordHash && operation.identity === row.operationIdentity
      && operation.endpoint === FAL_MODELS.seedanceText && (operation.requestId || null) === row.requestId
      && (row.requestId === null || typeof row.requestId === 'string' && !requestIds.has(row.requestId)));
    if (!['completed', 'failed'].includes(operation.state)) {
      // A zero-dollar observation cannot classify an accepted request. The
      // sole nonterminal exception is a reviewed rejection before acceptance.
      const rejection = (await read(`production/fal/scope-rejections/${row.operationIdentity}.json`))?.value;
      check(operation.state === 'uncertain' && operation.failureCode === 'FAL_HTTP_403' && !operation.requestId
        && !operation.statusUrl && !operation.responseUrl && row.requestId === null && row.costNanoUsd === 0
        && rejection?.version === 1 && rejection.kind === 'paid-seedance-confirmed-text-scope-repair-v1'
        && rejection.ownerHash === digest(email) && rejection.preparedId === source.id && rejection.manifestHash === source.manifestHash
        && rejection.orderId === order.id && rejection.originalIdentity === operation.identity
        && rejection.originalClaimHash === hash(operation) && rejection.providerHistoryChecked === true
        && rejection.acceptedRequestObserved === false);
    }
    check(operation.state === 'completed' || row.costNanoUsd === 0);
    if (row.requestId) requestIds.add(row.requestId);
    rows.set(row.operationIdentity, { row, operation });
  }
  return rows;
}

export async function buildPartialCorrectionPlan({ email, source, target, order, shotId, visual,
  maximumNewCostCents, reuseEvidence, billingEvidence, account, read = readRecord, now = Date.now }) {
  check(source?.id === order.preparedId && source.ownerHash === digest(email) && source.mode === 'customer'
    && source.status === 'failed' && !(source.lease?.expiresAt > now())
    && source.manifestHash === order.manifestHash && hash(source.manifest) === source.manifestHash
    && source.provider?.id === 'fal' && source.provider.model === 'seedance' && source.provider.recipe === SEEDANCE_RECIPE_VERSION);
  const expected = buildPartialCorrectionManifest(source.manifest, { shotId, visual });
  check(target?.id === partialCorrectionPreparedId(email, source.id, expected.manifestHash)
    && target.ownerHash === source.ownerHash && target.mode === 'customer' && target.manifestHash === expected.manifestHash
    && same(target.manifest, expected.manifest) && target.filmId === source.filmId
    && target.shots?.length === 4 && target.shots.every((shot, i) => shot.id === target.manifest.shots[i].id
      && shot.requestKey === digest(`${target.id}:${target.manifestHash}:${shot.id}`))
    && Number.isSafeInteger(maximumNewCostCents) && maximumNewCostCents > 0 && maximumNewCostCents <= 1980);
  check(Array.isArray(reuseEvidence) && reuseEvidence.length === 3 && new Set(reuseEvidence.map(row => row.shotId)).size === 3);
  const rows = await billingProof(billingEvidence, { email, source, order, account, read, now });
  const sourceWithEmail = { ...source, email }, plan = falPlan(target.manifest, 'seedance'), reused = [];
  const requiredAttempts = new Set();
  for (const shot of plan.shots) {
    const selected = await selectedSource(sourceWithEmail, shot.id, read);
    requiredAttempts.add(selected.originalIdentity); requiredAttempts.add(selected.identity);
    for (const prefix of ['scope-rejections', 'terminal-failure-repairs']) {
      const repair = (await read(`production/fal/${prefix}/${selected.originalIdentity}.json`))?.value;
      if (repair) {
        check(repair.originalIdentity === selected.originalIdentity && repair.ownerHash === digest(email)
          && repair.preparedId === source.id && repair.manifestHash === source.manifestHash && repair.orderId === order.id
          && HASH.test(repair.replacementIdentity || ''));
        if (await read(falRequestPath(repair.replacementIdentity))) requiredAttempts.add(repair.replacementIdentity);
      }
    }
    const inputHash = hash(falShotInput(target.manifest, shot, 'seedance', {}));
    if (shot.id === shotId) {
      check(!reuseEvidence.some(row => row.shotId === shot.id));
      // The changed scene must have no successful source rendition. All of
      // its previous attempts are explicitly accounted for at zero cost.
      const oldInput = hash(falShotInput(source.manifest, shot, 'seedance', {}));
      check([...rows.values()].some(row => row.operation.inputHash === oldInput && row.operation.state === 'failed')
        && [...rows.values()].filter(row => row.operation.inputHash === oldInput)
          .every(row => row.operation.state !== 'completed' && row.row.costNanoUsd === 0));
      continue;
    }
    const evidence = reuseEvidence.find(row => row.shotId === shot.id), operation = selected.record.value, video = operation.result?.video;
    check(exact(evidence, ['shotId', 'operationIdentity', 'requestId', 'inputHash', 'sourceRecordHash', 'mediaSha256', 'sizeBytes'])
      && evidence.operationIdentity === selected.identity && evidence.requestId === operation.requestId
      && operation.state === 'completed' && operation.inputHash === inputHash && evidence.inputHash === inputHash
      && evidence.sourceRecordHash === hash(operation) && HASH.test(evidence.mediaSha256 || '')
      && Number.isSafeInteger(evidence.sizeBytes) && evidence.sizeBytes > 0 && evidence.sizeBytes <= 250 * 1024 * 1024
      && video && (video.file_size === undefined || video.file_size === evidence.sizeBytes)
      && (video.content_type === undefined || video.content_type === 'video/mp4'));
    const url = falMediaUrl(video.url);
    reused.push({ ...evidence, originalIdentity: selected.originalIdentity, sourceChoiceHash: selected.choice ? hash(selected.choice.value) : null,
      sourceUrlHash: digest(url), generatedSeconds: shot.seconds });
  }
  check([...requiredAttempts].every(id => rows.has(id)));
  const sourceInputs = source.manifest.shots.map(shot => hash(falShotInput(source.manifest, shot, 'seedance', {})));
  check([...rows.values()].every(row => sourceInputs.includes(row.operation.inputHash)));
  const positive = [...rows.values()].filter(row => row.row.costNanoUsd > 0);
  check(positive.every(row => reused.some(item => item.operationIdentity === row.operation.identity)));
  const changed = plan.shots.find(shot => shot.id === shotId);
  const queue = (await read(`production/queue/${digest(email)}/${source.id}.json`))?.value;
  check(queue?.state === 'attention' && queue.email === email && queue.id === source.id && queue.orderId === order.id
    && queue.manifestHash === source.manifestHash && !(queue.lease?.expiresAt > now()));
  return { version: 1, kind: PARTIAL_CORRECTION_KIND, fundingKind: 'original-reservation', billingAccount: account, shotId,
    visual, sourcePreparedId: source.id, sourceManifestHash: source.manifestHash,
    manifestHash: target.manifestHash, newInputHash: hash(falShotInput(target.manifest, changed, 'seedance', {})),
    generatedSeconds: changed.seconds, maximumNewCostCents, reused, billingEvidenceHash: hash(billingEvidence),
    priorCostNanoUsd: [...rows.values()].reduce((sum, row) => sum + row.row.costNanoUsd, 0),
    originalReservation: { orderId: order.id, ownerHash: source.ownerHash, preparedId: source.id, manifestHash: source.manifestHash,
      quoteId: order.quoteId, maximumCostCents: order.providerCostCents } };
}

export async function validatePartialCorrection({ grant, source, target, order, read = readRecord, now = Date.now }) {
  if (!grant.partial) return null;
  const p = grant.partial, evidence = (await read(partialBillingEvidencePath(p.billingEvidenceHash)))?.value;
  check(evidence && hash(evidence) === p.billingEvidenceHash && target.partialCorrection?.version === 1
    && target.partialCorrection.correctionId === grant.id && target.partialCorrection.planHash === hash(p));
  const rebuilt = await buildPartialCorrectionPlan({ email: grant.customerEmail, source, target, order, shotId: p.shotId, visual: p.visual,
    maximumNewCostCents: p.maximumNewCostCents, reuseEvidence: p.reused.map(({ shotId, operationIdentity, requestId, inputHash, sourceRecordHash, mediaSha256, sizeBytes }) =>
      ({ shotId, operationIdentity, requestId, inputHash, sourceRecordHash, mediaSha256, sizeBytes })),
    billingEvidence: evidence, account: p.billingAccount, read, now });
  check(same(rebuilt, p) && grant.maximumCostCents === order.providerCostCents && grant.quote.maximumCostCents <= grant.maximumCostCents
    && grant.quote.providerCostCents <= p.maximumNewCostCents && grant.quote.partialPlanHash === hash(p));
  return p;
}

// Used by the renderer before handling any partial-correction shot. The
// persisted grant and original paid sale are authoritative, never client data.
export async function partialCorrectionExecution({ email, productionId, manifestHash, correctionId, read = readRecord, now = Date.now }) {
  const { readPaidFilmCorrection } = await import('./paid-film-correction.mjs');
  const job = (await read(jobPath(email, productionId)))?.value;
  if (!job?.partialCorrection) {
    const index = (await read(`production/correction-targets/${digest(email)}/${productionId}.json`))?.value;
    const grant = index && (await read(`production/corrections/${index.correctionId}.json`))?.value;
    check(!grant?.partial); return null;
  }
  check(job.partialCorrection.version === 1 && job.partialCorrection.correctionId === correctionId && job.manifestHash === manifestHash);
  const context = await readPaidFilmCorrection({ email, job, correctionId, read, now });
  check(context?.grant.partial && job.partialCorrection.planHash === hash(context.grant.partial));
  return { ...context, partial: context.grant.partial };
}
