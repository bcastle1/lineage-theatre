// Read-only unless an exact recovery execution flag and separately reviewed
// evidence are supplied. The original canary and fal receipts are preserved.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord, userPath } from '../api/_lib/auth.mjs';
import { isOwner } from '../api/_lib/access.mjs';
import { createFalClient, falRequestPath } from '../api/_lib/fal-client.mjs';
import { createFalPricing } from '../api/_lib/fal-pricing.mjs';
import { createFalProductionAdapter } from '../api/_lib/fal-production.mjs';
import { createFilmProductionService } from '../api/_lib/film-production.mjs';
import { REFERENCE_RECOVERY as S, referenceGrantPath, referenceJobPath,
  referenceRecoveryIdentity, resolveReferenceChoice, referenceRecoveryHash } from '../api/_lib/fal-reference-choice.mjs';
import { createReferenceRecovery } from '../api/_lib/fal-reference-recovery.mjs';
import { createGuardedCandidateClient, verifyCandidateGrant, candidateOperationBounds, runDatedCanary, EXECUTE_FLAG } from './test-kling-cast-continuity.mjs';

export const ZERO_CHARGE_FLAG = '--execute-approved-zero-charge-reference-recovery-20261105';
export const ADDITIONAL_30_FLAG = '--execute-approved-additional-30-cent-reference-recovery-20261105';
const requireValue = (value, code = 'REFERENCE_RECOVERY_USAGE') => {
  if (!value) throw Object.assign(new Error(code), { code });
};

export function parseRecoveryArguments(args) {
  const [action, evidencePath, evidenceSha256, confirmation] = args;
  requireValue(['plan', 'recover', 'run'].includes(action)
    && args.length === (action === 'plan' ? 3 : 4)
    && typeof evidencePath === 'string' && evidencePath.length > 0
    && /^[a-f0-9]{64}$/.test(evidenceSha256 || '')
    && (action === 'plan' || [ZERO_CHARGE_FLAG, ADDITIONAL_30_FLAG].includes(confirmation)));
  return { action, evidencePath, evidenceSha256, confirmation };
}

export function parseRecoveryEvidence(bytes, expectedHash, confirmation) {
  requireValue(bytes?.length > 0 && bytes.length <= 65536 && digest(bytes) === expectedHash, 'REFERENCE_RECOVERY_EVIDENCE_REQUIRED');
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { requireValue(false, 'REFERENCE_RECOVERY_EVIDENCE_REQUIRED'); }
  requireValue(input && input.email === S.email && input.productionId === S.id && input.manifestHash === S.manifestHash
    && input.originalRequestId === S.originalRequestId
    && ['verified-zero-charge', 'separate-30-cent-approval'].includes(input.budgetMode), 'REFERENCE_RECOVERY_EVIDENCE_REQUIRED');
  if (confirmation) requireValue(confirmation === (input.budgetMode === 'verified-zero-charge' ? ZERO_CHARGE_FLAG : ADDITIONAL_30_FLAG),
    'REFERENCE_RECOVERY_APPROVAL_MISMATCH');
  return input;
}

// This is the only transition out of the stopped canary: a validated durable
// reference choice, followed by one ordinary film.advance under the unchanged
// original grant. Neither the job status nor the original receipt is reset.
export async function resumeSelectedReference({ read = readRecord, now = Date.now,
  client = createFalClient({ key: () => process.env.FAL_KLING_KEY }), pricing = createFalPricing({ key: () => process.env.FAL_KLING_KEY }),
  resolveChoice = resolveReferenceChoice, makeFilm = createFilmProductionService, makeAdapter = createFalProductionAdapter,
  makeGuard = createGuardedCandidateClient } = {}) {
  async function context() {
    const [actorRecord, jobRecord, grantRecord] = await Promise.all([read(userPath(S.email)), read(referenceJobPath), read(referenceGrantPath)]);
    const actor = actorRecord?.value, job = jobRecord?.value, grant = grantRecord?.value;
    requireValue(isOwner(actor) && actor.email === S.email && !actor.mustChangePassword, 'REFERENCE_RECOVERY_OWNER_REQUIRED');
    verifyCandidateGrant(grant, { ownerHash: S.ownerHash, id: S.id, now: now() });
    const choice = await resolveChoice({ ownerHash: S.ownerHash, productionId: S.id, manifestHash: S.manifestHash, identity: referenceRecoveryIdentity }, { read });
    requireValue(choice && job?.id === S.id && job.ownerHash === S.ownerHash && job.manifestHash === S.manifestHash
      && referenceRecoveryHash(job.manifest) === S.manifestHash && job.mode === 'operator-test'
      && job.authorization?.manifestHash === S.manifestHash && job.authorization.environment === 'production'
      && job.authorization.budgetCents === 450 && job.authorization.quoteReference === grant.quoteReference,
    'REFERENCE_RECOVERY_CHOICE_REQUIRED');
    return { actor, job, grant, choice };
  }
  const initial = await context();
  if (['processing', 'queued', 'awaiting-assembly', 'completed'].includes(initial.job.status))
    return { status: initial.job.status, advanceCalls: 0 };
  requireValue(initial.job.status === 'uncertain' && !initial.job.media && !(initial.job.lease?.expiresAt > now())
    && initial.job.shots?.length === 3 && initial.job.shots[1].status === 'uncertain'
    && initial.job.shots.every(shot => !shot.output && (!shot.providerJobId
      || shot.providerJobId === `fal-${digest(`${S.recipe}:kling:${shot.requestKey}`)}`)), 'REFERENCE_RECOVERY_STOPPED_STATE_CHANGED');
  // The adapter assigns its deterministic job ID while portraits are pending.
  // A real downstream receipt, rather than that synthetic ID, proves work has
  // already started and prevents this one-time stopped-job reconciliation.
  const downstream = [...candidateOperationBounds(S.id)].filter(([, bound]) => bound.kind !== 'reference-front');
  requireValue((await Promise.all(downstream.map(([identity]) => read(falRequestPath(identity))))).every(record => !record),
    'REFERENCE_RECOVERY_DOWNSTREAM_STARTED');
  const guarded = makeGuard({ id: S.id, ownerHash: S.ownerHash, grantContext: context, client, pricing, now, read });
  const adapter = makeAdapter({ model: 'kling', requireWorker: true, key: () => process.env.FAL_KLING_KEY, client: guarded, read });
  const film = makeFilm({ adapter, readRecordImpl: read, now, authorize: async input => {
    const current = await context();
    requireValue(input.email === S.email && input.id === S.id && input.manifestHash === S.manifestHash
      && input.mode === 'operator-test' && input.authorizationReference === referenceGrantPath
      && referenceRecoveryHash(current.grant) === referenceRecoveryHash(initial.grant)
      && current.choice.proof.choiceHash === initial.choice.proof.choiceHash, 'REFERENCE_RECOVERY_CONTEXT_CHANGED');
    return { allowed: true, fictionalOnly: true, manifestHash: S.manifestHash, environment: 'production', budgetCents: 450,
      quoteReference: current.grant.quoteReference, expiresAt: new Date(Math.min(Date.parse(current.grant.expiresAt), now() + 30000)).toISOString() };
  } });
  const latest = await context();
  requireValue(referenceRecoveryHash(latest.job) === referenceRecoveryHash(initial.job)
    && referenceRecoveryHash(latest.grant) === referenceRecoveryHash(initial.grant)
    && latest.choice.proof.choiceHash === initial.choice.proof.choiceHash, 'REFERENCE_RECOVERY_CONTEXT_CHANGED');
  const result = await film.advance({ email: S.email, id: S.id, actor: latest.actor, authorizationReference: referenceGrantPath });
  requireValue(['processing', 'queued', 'awaiting-assembly', 'completed'].includes(result.status), 'REFERENCE_RECOVERY_ADVANCE_STOPPED');
  return { status: result.status, advanceCalls: 1 };
}

export async function runReferenceRecovery(args = process.argv.slice(2), env = process.env, {
  loadEvidence = path => readFile(path), recover = (input, options) => createReferenceRecovery().recover(input, options),
  resume = resumeSelectedReference, continueCanary = () => runDatedCanary(['run', EXECUTE_FLAG]),
  pause = () => new Promise(resolve => setTimeout(resolve, 15000)), emit = () => {},
} = {}) {
  const parsed = parseRecoveryArguments(args);
  requireValue(env.LINEAGE_CANARY_OWNER_EMAIL === S.email && env.BLOB_READ_WRITE_TOKEN && env.FAL_KLING_KEY
    && env.LINEAGE_WORKER_SECRET, 'REFERENCE_RECOVERY_CONFIGURATION_REQUIRED');
  const input = parseRecoveryEvidence(await loadEvidence(parsed.evidencePath), parsed.evidenceSha256, parsed.confirmation);
  const execute = parsed.action !== 'plan';
  let result = await recover(input, { execute });
  emit(result);
  if (parsed.action !== 'run') return result;
  for (let checks = 0; result.status === 'replacement-pending' && checks < 60; checks++) {
    requireValue(!['failed', 'uncertain', 'submitting'].includes(result.state), 'REFERENCE_RECOVERY_NOT_READY');
    await pause(); result = await recover(input, { execute: true }); emit(result);
  }
  requireValue(result.status === 'reference-choice-ready', 'REFERENCE_RECOVERY_NOT_READY');
  emit(await resume());
  return continueCanary();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emit = result => process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), ...result }) + '\n');
  runReferenceRecovery(process.argv.slice(2), process.env, { emit }).then(emit).catch(error => {
    // Errors can occur after a durable claim; never assert zero submissions or
    // repeat a POST merely because an error was returned to this process.
    emit({ status: 'stopped', code: /^REFERENCE_RECOVERY_[A-Z_]+$/.test(error?.code || '') ? error.code : 'REFERENCE_RECOVERY_STOPPED',
      automaticPaidRetry: false }); process.exitCode = 1;
  });
}
