// Read-only plan by default. Applying a reviewed historical status correction
// requires an explicit flag; this command never submits provider work.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { isOwner } from '../api/_lib/access.mjs';
import { createFilmProductionService, productionJobPath } from '../api/_lib/film-production.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { visualReceiptPath, verifiedVisualDecision } from '../api/_lib/film-visual-review.mjs';
import { storedFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';

const HEX = /^[a-f0-9]{64}$/;
const requireValue = (value, code = 'FINISHING_RECONCILIATION_REQUIRED') => {
  if (!value) throw Object.assign(Error(code), { code });
};
const fixedFailure = { stage: 'visual-review', reason: 'VISUAL_CONTINUITY_MISMATCH' };
export const APPLY_FLAG = '--apply-reviewed-finishing-attention';

export function createOperatorFinishingReconciler({ read = readRecord, write = writeRecord, now = Date.now,
  uuid = randomUUID, film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now }) } = {}) {
  async function context({ email, id, manifestHash, bindingHash }) {
    requireValue(typeof email === 'string' && email === email.toLowerCase().trim() && HEX.test(manifestHash || '') && HEX.test(bindingHash || ''));
    const path = productionJobPath(email, id), job = (await read(path))?.value, actor = (await read(userPath(email)))?.value;
    requireValue(isOwner(actor) && actor.email === email && !actor.mustChangePassword
      && job?.id === id && job.ownerHash === digest(email) && job.mode === 'operator-test'
      && job.status === 'awaiting-assembly' && !job.media && job.manifestHash === manifestHash
      && job.provider?.id === 'fal' && job.provider.model === 'kling' && job.provider.recipe === FAL_RECIPE_VERSION);
    // A stored test flag cannot exempt arbitrary family material. Reconstruct
    // this exact historical fixed fictional plan using its saved version.
    await requireFinishedFilmPayment({ job, email, actor, read, now });
    const receiptPath = visualReceiptPath(job.ownerHash, id, bindingHash), receipt = (await read(receiptPath))?.value;
    const binding = receipt?.binding, index = job.manifest.shots.findIndex(shot => shot.id === binding?.shotId);
    const shot = job.manifest.shots[index], saved = job.shots[index];
    const previous = index > 0 && job.manifest.shots[index - 1].sceneIndex === shot?.sceneIndex ? job.shots[index - 1] : null;
    requireValue(receipt?.version === 1 && receipt.state === 'reviewed' && receipt.model === STORY_MODEL
      && receipt.bindingHash === bindingHash && binding?.version === 1 && digest(JSON.stringify(binding)) === bindingHash
      && binding.manifestHash === manifestHash && shot && saved?.id === shot.id && saved.status === 'completed' && saved.output
      && binding.outputHash === digest(JSON.stringify(saved.output))
      && binding.precedingOutputHash === (previous ? digest(JSON.stringify(previous.output)) : null)
      && Array.isArray(binding.frameHashes) && binding.frameHashes.length === (previous ? 4 : 3) && binding.frameHashes.every(value => HEX.test(value))
      && typeof receipt.reviewedAt === 'string' && Number.isFinite(Date.parse(receipt.reviewedAt)) && Date.parse(receipt.reviewedAt) <= now()
      && verifiedVisualDecision(receipt.decision).passed === false);
    const leasePath = `production/operator-canaries/${job.ownerHash}/${id}/finishing-lease.json`, lease = await read(leasePath);
    return { job, receiptHash: digest(JSON.stringify(receipt)), lease, leasePath };
  }
  return async (input, { apply = false } = {}) => {
    const initial = await context(input), { email, id, manifestHash, bindingHash } = input;
    const alreadyRecorded = storedFinishingFailure(initial.job)?.state === 'attention';
    const busy = Boolean(initial.lease?.value.token && initial.lease.value.expiresAt > now());
    const summary = { version: 1, preparedId: id, manifestHash, bindingHash, failure: fixedFailure,
      providerSubmissions: 0, customerPaymentCreated: false, invoiceCreated: false };
    if (!apply) return { ...summary, status: 'planned', canApply: !busy && !alreadyRecorded, alreadyRecorded, activeFinishingClaim: busy };
    if (alreadyRecorded) return { ...summary, status: 'attention-recorded', changed: false };
    requireValue(!busy, 'FINISHING_RECONCILIATION_BUSY');
    const token = uuid();
    await write(initial.leasePath, { token, manifestHash, expiresAt: now() + 60_000 }, initial.lease?.etag);
    try {
      const stillOwned = async () => {
        try {
          const current = await context(input), lock = current.lease?.value;
          return lock?.token === token && lock.manifestHash === manifestHash && lock.expiresAt > now()
            && current.receiptHash === initial.receiptHash;
        } catch { return false; }
      };
      const changed = await film.recordFinishingFailure({ email, id, manifestHash, failure: fixedFailure, needsAttention: true, stillOwned });
      requireValue(changed, 'FINISHING_RECONCILIATION_CHANGED');
      return { ...summary, status: 'attention-recorded', changed: true };
    } finally {
      const current = await read(initial.leasePath);
      if (current?.value.token === token) await write(initial.leasePath, { ...current.value, token: null, expiresAt: 0 }, current.etag);
    }
  };
}

export async function runReconciliation(args = process.argv.slice(2), env = process.env) {
  const [action, id, manifestHash, bindingHash, flag] = args;
  requireValue(['plan', 'apply'].includes(action) && args.length === (action === 'apply' ? 5 : 4)
    && (action !== 'apply' || flag === APPLY_FLAG), 'FINISHING_RECONCILIATION_USAGE');
  const email = String(env.LINEAGE_CANARY_OWNER_EMAIL || '').trim().toLowerCase();
  requireValue(Boolean(env.BLOB_READ_WRITE_TOKEN) && email, 'FINISHING_RECONCILIATION_CONFIGURATION_REQUIRED');
  return createOperatorFinishingReconciler()({ email, id, manifestHash, bindingHash }, { apply: action === 'apply' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReconciliation().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'stopped', code: /^FINISHING_RECONCILIATION_[A-Z_]+$/.test(error?.code || '')
      ? error.code : 'FINISHING_RECONCILIATION_REQUIRED', providerSubmissions: 0 }) + '\n');
    process.exitCode = 1;
  });
}
