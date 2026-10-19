import { get } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { digest, readRecord, writeRecord, userPath } from './auth.mjs';
import { OWNER_EMAIL, isOwner, accessStatusForUser } from './access.mjs';
import { productionJobPath } from './film-production.mjs';
import { requireFinishedFilmPayment } from './production-media.mjs';
import { hostedCheckout } from './hosted-checkout.mjs';
import { verifiedMediaProfile } from './media-profile.mjs';
import { FAL_MODELS } from './fal-client.mjs';

const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw new Error('The reviewed film, owner, payment or private media needs confirmation.'); };
// An editorial delivery is deliberately separate from qualifying an unattended
// provider. It publishes only a verified, specifically reviewed whole film;
// it never submits generation, invents per-shot completion, or changes a price.
export function createFalReviewedDelivery({ read = readRecord, write = writeRecord, getBlob = get,
  checkPayment = (actor, input) => hostedCheckout.check(actor, input), now = Date.now } = {}) {
  async function binding(orderId, artifactSha256, previousArtifactSha256, model) {
    if (!['seedance', 'wan'].includes(model) || !HASH.test(orderId || '') || !HASH.test(artifactSha256 || '')
      || (previousArtifactSha256 !== undefined && (!HASH.test(previousArtifactSha256) || previousArtifactSha256 === artifactSha256))) fail();
    const actor = (await read(userPath(OWNER_EMAIL)))?.value;
    if (!isOwner(actor) || actor.mustChangePassword || accessStatusForUser(actor) !== 'approved') fail();
    const comparison = (await read(`production/fal/comparisons/${orderId}.json`))?.value;
    const candidateRecord = await read(`production/fal/candidates/${orderId}/${model}.json`);
    const candidate = candidateRecord?.value, artifact = candidate?.artifact;
    if (!comparison || comparison.approvedBy !== actor.email || comparison.customerEmail !== actor.email
      || candidate?.version !== 1 || candidate.orderId !== orderId || candidate.model !== model
      || candidate.manifestHash !== comparison.manifestHash || candidate.review?.approvedBy !== actor.email
      || candidate.review?.artifactSha256 !== artifactSha256 || candidate.review?.visual !== true
      || candidate.review?.speech !== true || candidate.review?.privatePlayback !== true
      || !Number.isFinite(Date.parse(candidate.review.reviewedAt)) || Date.parse(candidate.review.reviewedAt) > now()
      || now() - Date.parse(candidate.review.reviewedAt) > 7 * 86400_000) fail();
    const jobRecord = await read(productionJobPath(actor.email, comparison.preparedId)), job = jobRecord?.value;
    if (!jobRecord?.etag || job?.id !== comparison.preparedId || job.ownerHash !== digest(actor.email) || job.mode !== 'customer'
      || job.manifestHash !== comparison.manifestHash || digest(JSON.stringify(job.manifest)) !== job.manifestHash
      || job.filmId !== job.manifest.filmId || artifact?.sha256 !== artifactSha256
      || artifact.manifestHash !== job.manifestHash || artifact.pathname !== `production/media/${job.ownerHash}/${job.id}/${artifactSha256}.mp4`
      || artifact.playable !== true || artifact.hasAudio !== true || artifact.technicalSample !== false
      || artifact.verification !== 'full-video-and-audio-decode' || artifact.contentType !== 'video/mp4'
      || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 16 || artifact.sizeBytes > 250 * 1024 * 1024
      || !Number.isFinite(artifact.durationSeconds) || artifact.durationSeconds <= 0
      || Math.abs(artifact.durationSeconds - job.manifest.targetDurationSeconds) > 1) fail();
    verifiedMediaProfile(artifact);
    if (!Array.isArray(candidate.sources) || candidate.sources.length !== job.manifest.shots.length) fail();
    for (const [index, source] of candidate.sources.entries()) {
      if (source.shotId !== job.manifest.shots[index].id || !HASH.test(source.identity || '') || !['seedance', 'wan'].includes(source.model)) fail();
      const request = (await read(`production/fal/requests/${source.identity}.json`))?.value;
      if (request?.state !== 'completed' || request.requestId !== source.requestId || request.endpoint !== FAL_MODELS[source.model]) fail();
    }
    const authorization = { environment: 'production', manifestHash: job.manifestHash, kind: 'owner-reviewed-fal-edit', orderId,
      artifactSha256, authorizedAt: candidate.review.reviewedAt };
    await requireFinishedFilmPayment({ job: { ...job, authorization }, email: actor.email, actor, read, now });
    const order = (await read(`payments/orders/${orderId}.json`))?.value;
    if (order?.customerEmail !== actor.email || order.preparedId !== job.id || order.amountCents !== comparison.customerAmountCents) fail();
    const completed = job.status === 'completed' && job.media?.sha256 === artifactSha256
      && job.authorization?.kind === authorization.kind && job.authorization?.orderId === orderId;
    const replacement = candidate.replacement;
    const replacing = previousArtifactSha256 !== undefined;
    if (replacing) {
      if (replacement?.previousArtifactSha256 !== previousArtifactSha256 || replacement.approvedBy !== actor.email
        || replacement.reason !== 'user-requested-photorealism' || !Number.isFinite(Date.parse(replacement.requestedAt))
        || Date.parse(replacement.requestedAt) > Date.parse(candidate.review.reviewedAt)
        || job.status !== 'completed' || job.authorization?.kind !== authorization.kind || job.authorization?.orderId !== orderId
        || (!completed && job.media?.sha256 !== previousArtifactSha256)
        || (completed && !job.editorialHistory?.some(entry => entry.media?.sha256 === previousArtifactSha256
          && entry.replacedBy === artifactSha256 && entry.authorization?.orderId === orderId))) fail();
    } else if (replacement || (!completed && (job.status !== 'prepared' || !job.shots.every(shot => shot.status === 'prepared')))) fail();
    return { actor, comparison, candidateRecord, candidate, artifact, jobRecord, job, authorization, order, completed, replacing };
  }
  async function deliver({ orderId, artifactSha256, previousArtifactSha256, model = 'seedance' }) {
    const before = await binding(orderId, artifactSha256, previousArtifactSha256, model);
    const checked = await checkPayment(before.actor, { orderId });
    if (checked?.id !== orderId || checked.preparedId !== before.job.id || checked.filmId !== before.job.filmId
      || checked.status !== 'captured' || checked.sandbox !== false || checked.refundedCents !== 0 || checked.requiresReview !== false
      || checked.checkoutMethod !== 'quickbooks-hosted-invoice' || checked.confirmationSource !== 'quickbooks-accounting'
      || checked.currency !== 'USD' || checked.receiptAvailable !== true || checked.amountCents !== before.order.amountCents) fail();
    const artifact = before.artifact;
    const blob = await getBlob(artifact.pathname, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(45_000) });
    try {
      if (!blob?.stream || blob.blob.pathname !== artifact.pathname || blob.blob.size !== artifact.sizeBytes || blob.blob.contentType !== artifact.contentType) fail();
      let size = 0; const hash = createHash('sha256');
      for await (const chunk of blob.stream) { size += chunk.byteLength; if (size > artifact.sizeBytes) fail(); hash.update(chunk); }
      if (size !== artifact.sizeBytes || hash.digest('hex') !== artifactSha256) fail();
    } finally { if (!blob?.stream?.locked) await blob?.stream?.cancel().catch(() => {}); }
    const current = await binding(orderId, artifactSha256, previousArtifactSha256, model);
    if (current.candidateRecord.etag !== before.candidateRecord.etag || current.jobRecord.etag !== before.jobRecord.etag) fail();
    if (!current.completed) {
      const timestamp = new Date(now()).toISOString();
      const media = Object.fromEntries(['pathname', 'sha256', 'sizeBytes', 'contentType', 'durationSeconds', 'width', 'height', 'frameRate'].map(key => [key, artifact[key]]));
      const next = { ...current.job, status: 'completed', media, authorization: current.authorization, timingDisrupted: true,
        updatedAt: timestamp, completedAt: timestamp, revision: (current.job.revision || 0) + 1,
        editorialReview: { ...current.candidate.review, sources: current.candidate.sources, edits: current.candidate.edits || [], orderId },
        ...(current.replacing ? { editorialHistory: [...(current.job.editorialHistory || []), {
          media: current.job.media, authorization: current.job.authorization, completedAt: current.job.completedAt,
          editorialReview: current.job.editorialReview, replacedAt: timestamp, replacedBy: artifactSha256,
          replacement: current.candidate.replacement,
        }] } : {}) };
      try { await write(productionJobPath(current.actor.email, current.job.id), next, current.jobRecord.etag); }
      catch { /* Confirm an identical write whose response was lost. */ }
    }
    const saved = await binding(orderId, artifactSha256, previousArtifactSha256, model);
    if (!saved.completed) fail();
    return { status: 'completed', preparedId: saved.job.id, artifactSha256, customerAmountCents: saved.order.amountCents };
  }
  return { deliver };
}
export const falReviewedDelivery = createFalReviewedDelivery();
