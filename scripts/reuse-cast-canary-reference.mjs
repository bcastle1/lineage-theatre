// Select an already generated, exact-input portrait for the dated canary.
// Selection cannot submit generation. The normal guarded canary owns all
// remaining work after the existing job has been reconciled once.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../api/_lib/auth.mjs';
import { REFERENCE_RECOVERY as S } from '../api/_lib/fal-reference-choice.mjs';
import { createReferenceReuse } from '../api/_lib/fal-reference-reuse.mjs';
import { resumeSelectedReference } from './recover-cast-canary-reference.mjs';
import { runDatedCanary, EXECUTE_FLAG as CANARY_FLAG } from './test-kling-cast-continuity.mjs';

export const REUSE_FLAG = '--execute-approved-existing-reference-reuse-20261105';
const sourceRequestId = '01a1ad45-4fcd-7483-aa6c-03596e2f039d';
const requireValue = (value, code = 'REFERENCE_REUSE_USAGE') => {
  if (!value) throw Object.assign(new Error(code), { code });
};

export function parseReuseArguments(args) {
  const [action, evidencePath, evidenceSha256, confirmation] = args;
  requireValue(['plan', 'select', 'run'].includes(action)
    && args.length === (action === 'plan' ? 3 : 4)
    && typeof evidencePath === 'string' && evidencePath.length > 0
    && /^[a-f0-9]{64}$/.test(evidenceSha256 || '')
    && (action === 'plan' || confirmation === REUSE_FLAG));
  return { action, evidencePath, evidenceSha256 };
}

export function parseReuseEvidence(bytes, expectedHash) {
  requireValue(bytes?.length > 0 && bytes.length <= 65536 && digest(bytes) === expectedHash,
    'REFERENCE_REUSE_EVIDENCE_REQUIRED');
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { requireValue(false, 'REFERENCE_REUSE_EVIDENCE_REQUIRED'); }
  requireValue(input?.version === 1 && input.kind === 'existing-reference-reuse-approval'
    && input.email === S.email && input.productionId === S.id && input.manifestHash === S.manifestHash
    && input.sourceRequestId === sourceRequestId && input.maximumAdditionalCostCents === 0
    && input.maximumNewPortraitRequests === 0 && input.maximumTotalCostCents === 480,
  'REFERENCE_REUSE_EVIDENCE_REQUIRED');
  return input;
}

export async function runReferenceReuse(args = process.argv.slice(2), env = process.env, {
  loadEvidence = path => readFile(path), reuse = (input, options) => createReferenceReuse().reuse(input, options),
  resume = resumeSelectedReference, continueCanary = () => runDatedCanary(['run', CANARY_FLAG]), emit = () => {},
} = {}) {
  const parsed = parseReuseArguments(args);
  requireValue(env.LINEAGE_CANARY_OWNER_EMAIL === S.email && env.BLOB_READ_WRITE_TOKEN && env.FAL_KLING_KEY
    && env.LINEAGE_WORKER_SECRET, 'REFERENCE_REUSE_CONFIGURATION_REQUIRED');
  const input = parseReuseEvidence(await loadEvidence(parsed.evidencePath), parsed.evidenceSha256);
  emit({ status: 'reference-reuse-started', action: parsed.action,
    generationSubmitted: false, maximumTotalCostCents: input.maximumTotalCostCents });
  const selected = await reuse(input, { execute: parsed.action !== 'plan' });
  emit(selected);
  if (parsed.action !== 'run') return selected;
  requireValue(selected.status === 'reference-choice-ready' && selected.generationSubmitted === false
    && selected.additionalPortraitRequests === 0, 'REFERENCE_REUSE_NOT_READY');
  emit(await resume());
  return continueCanary();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emit = result => process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), ...result }) + '\n');
  runReferenceReuse(process.argv.slice(2), process.env, { emit }).then(emit).catch(error => {
    emit({ status: 'stopped', code: /^REFERENCE_(?:REUSE|RECOVERY)_[A-Z_]+$/.test(error?.code || '')
      ? error.code : 'REFERENCE_REUSE_STOPPED', automaticPaidRetry: false });
    process.exitCode = 1;
  });
}
