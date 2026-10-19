import { digest, readRecord, userPath } from './auth.mjs';
import { isOwner, accessStatusForUser } from './access.mjs';
import { ProductionMediaError, streamProductionMedia } from './production-media.mjs';
import { MAX_FILM_BYTES } from './archive.mjs';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => new ProductionMediaError('This private soundtrack preview is unavailable.', 404);

// This review-only record cannot make the paid film ready. Every request still
// passes the normal captured-payment check and private range-stream checks.
export function streamSoundtrackRepairPreview({ actor, artifactSha256, read = readRecord, now = Date.now, ...options }) {
  return streamProductionMedia({ ...options, actor, read, now,
    resolveStoredMedia: async (job, email) => {
      const current = (await read(userPath(email)))?.value;
      const ownerHash = digest(email);
      if (!isOwner(actor) || actor.email !== email || actor.mustChangePassword
        || !isOwner(current) || current.email !== email || current.mustChangePassword
        || accessStatusForUser(current) !== 'approved' || !UUID.test(job?.id || '')
        || job.ownerHash !== ownerHash || job.mode !== 'customer'
        || !['awaiting-assembly', 'completed'].includes(job.status) || !HASH.test(artifactSha256 || '')) throw unavailable();
      const preview = (await read(`production/repair-previews/${ownerHash}/${job.id}/current.json`))?.value;
      if (preview?.version !== 1 || preview.kind !== 'soundtrack-repair-preview-v1' || preview.preview !== true
        || preview.ownerHash !== ownerHash || preview.preparedId !== job.id || preview.filmId !== job.filmId
        || preview.manifestHash !== job.manifestHash || !HASH.test(preview.orderId || '')
        || preview.sha256 !== artifactSha256 || preview.contentType !== 'video/mp4'
        || preview.pathname !== `production/repair-previews/${ownerHash}/${job.id}/${artifactSha256}.mp4`
        || !Number.isSafeInteger(preview.sizeBytes) || preview.sizeBytes < 16 || preview.sizeBytes > MAX_FILM_BYTES
        || !Number.isFinite(preview.durationSeconds) || Math.abs(preview.durationSeconds - job.manifest.targetDurationSeconds) > 1
        || !Number.isFinite(Date.parse(preview.createdAt)) || Date.parse(preview.createdAt) > now()
        || now() - Date.parse(preview.createdAt) > 48 * 3600_000) throw unavailable();
      const order = (await read(`payments/orders/${preview.orderId}.json`))?.value;
      if (order?.id !== preview.orderId || order.customerEmail !== email || order.preparedId !== job.id
        || order.manifestHash !== job.manifestHash || order.status !== 'captured') throw unavailable();
      return Object.fromEntries(['pathname', 'sha256', 'contentType', 'sizeBytes', 'durationSeconds'].map(key => [key, preview[key]]));
    },
  });
}
