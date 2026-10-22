// Bounded automatic stock casting and owner-approved interrupted-film recovery.
// No video provider submissions, payment mutations, or construction-budget reset.
import { randomUUID } from 'node:crypto';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { accessStatusForUser, isOwner } from '../api/_lib/access.mjs';
import { productionJobPath } from '../api/_lib/film-production.mjs';
import { productionQueuePath } from '../api/_lib/production-queue.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { soundtrackPlan } from './rebuild-film-soundtrack.mjs';

const HASH = /^[a-f0-9]{64}$/, RECIPE = 'automatic-stock-soundtrack-v1', KIND = 'authored-soundtrack-casting-v1';
const hash = value => digest(JSON.stringify(value));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => Object.assign(new Error('The exact authored casting approval could not be confirmed.'), { code: 'SOUNDTRACK_CASTING_UNVERIFIED' });
const check = value => { if (!value) throw fail(); };
const stock = new Set(['am_michael', 'af_heart', 'am_fenrir', 'af_bella', 'am_adam', 'af_nicole', 'am_echo',
  'af_sarah', 'am_liam', 'af_nova', 'am_onyx', 'af_jessica', 'am_puck', 'af_kore', 'am_santa', 'af_aoede', 'am_eric']);
const outputsHash = job => hash(job.shots.map(shot => ({ id: shot.id, output: shot.output })));
const rootPath = job => `production/soundtracks/${job.ownerHash}/${job.id}`;
export const soundtrackCastingPath = job => `${rootPath(job)}/casting.json`;
const priorPath = (job, bindingHash) => `${rootPath(job)}/${bindingHash}/construction.json`;
const AUTOMATIC_KIND = 'automatic-authored-soundtrack-casting-v1';
export const automaticSoundtrackCastingPath = job => `${rootPath(job)}/automatic-casting.json`;

function validJob(job) {
  check(job?.mode === 'customer' && job.status === 'awaiting-assembly' && !job.lease && HASH.test(job.ownerHash || '')
    && HASH.test(job.manifestHash || '') && hash(job.manifest) === job.manifestHash && job.provider?.id === 'fal'
    && Array.isArray(job.shots) && job.shots.length === job.manifest.shots.length
    && job.shots.every((shot, i) => shot.status === 'completed' && shot.id === job.manifest.shots[i].id));
}

function approvedVoices(job, defaults, selected) {
  check(plain(selected) && Object.keys(selected).sort().join(',') === 'characterVoices,narratorVoice'
    && stock.has(selected.narratorVoice) && plain(selected.characterVoices)
    && JSON.stringify(Object.keys(selected.characterVoices).sort()) === JSON.stringify(job.manifest.screenplay.characters.map(c => c.id).sort())
    && Object.values(selected.characterVoices).every(voice => stock.has(voice)));
  const voices = { narratorVoice: selected.narratorVoice, characterVoices: Object.fromEntries(job.manifest.screenplay.characters
    .map(character => [character.id, selected.characterVoices[character.id]])), speakerAliases: { ...defaults.speakerAliases } };
  soundtrackPlan({ manifest: job.manifest, manifestHash: job.manifestHash, ...voices });
  return voices;
}

function checkFit(report, job, voices) {
  const plan = soundtrackPlan({ manifest: job.manifest, manifestHash: job.manifestHash, ...voices });
  check(report?.version === 1 && report.kind === 'soundtrack-fit-inspection-v1' && report.manifestHash === job.manifestHash
    && report.durationMs === plan.durationMs && report.speed === 1 && report.providerGenerationCalls === 0 && report.fits === true
    && report.requestedNarratorVoice === voices.narratorVoice && report.requestedCharacterVoicesSha256 === hash(Object.entries(voices.characterVoices).sort(([a], [b]) => a.localeCompare(b)))
    && Array.isArray(report.scenes) && report.scenes.length === plan.scenes.length && Buffer.byteLength(JSON.stringify(report)) <= 250_000);
  for (const [i, scene] of report.scenes.entries()) {
    check(scene.sceneIndex === i + 1 && scene.durationMs === plan.scenes[i].durationMs && scene.fits === true
      && Array.isArray(scene.turns) && scene.turns.length === plan.scenes[i].turns.length);
    for (const [t, turn] of scene.turns.entries()) check(turn.turnIndex === t + 1 && turn.fits === true && turn.overrunMs === 0
      && ['generatedMs', 'retainedMs', 'trimStartMs', 'trimEndMs', 'availableMs', 'overrunMs'].every(key => Number.isSafeInteger(turn[key]) && turn[key] >= 0 && turn[key] <= 120_000)
      && turn.retainedMs > 0 && turn.retainedMs <= turn.availableMs);
  }
}

function checkPrior(job, prior, defaults) {
  check(prior?.kind === RECIPE && ['building', 'failed'].includes(prior.state) && prior.attempts === 1
    && HASH.test(prior.bindingHash || '') && hash(prior.binding) === prior.bindingHash
    && prior.binding.version === 1 && prior.binding.recipe === RECIPE && prior.binding.ownerHash === job.ownerHash
    && prior.binding.id === job.id && prior.binding.manifestHash === job.manifestHash && prior.binding.sourceOutputsSha256 === outputsHash(job)
    && hash(prior.binding.voices) === hash(defaults) && !prior.binding.castingApproval
    && Array.isArray(prior.binding.sources) && prior.binding.sources.length === job.shots.length
    && prior.binding.sources.every((source, i) => source.shotId === job.shots[i].id && HASH.test(source.sha256 || '')
      && Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 16 && source.sizeBytes <= 250 * 1024 * 1024));
}

function validateApproval(value, job, defaults) {
  check(value?.version === 1 && value.kind === KIND && value.ownerHash === job.ownerHash && value.id === job.id
    && value.manifestHash === job.manifestHash && value.jobSha256 === hash(job) && value.sourceOutputsSha256 === outputsHash(job)
    && HASH.test(value.priorReceiptSha256 || '') && hash(value.priorReceipt) === value.priorReceiptSha256
    && typeof value.reason === 'string' && value.reason.length >= 10 && value.reason.length <= 500
    && Number.isFinite(Date.parse(value.approvedAt)));
  checkPrior(job, value.priorReceipt, defaults);
  const voices = approvedVoices(job, defaults, { narratorVoice: value.voices?.narratorVoice, characterVoices: value.voices?.characterVoices });
  check(hash(voices) === hash(value.voices)); checkFit(value.fitReport, job, voices);
  return { voices, approvalSha256: hash(value), priorBindingHash: value.priorReceipt.bindingHash,
    priorReceiptSha256: value.priorReceiptSha256, priorAttempts: value.priorReceipt.attempts, sources: value.priorReceipt.binding.sources };
}

// Pending approval fails closed until the original receipt has been CAS-fenced.
export async function readSoundtrackCasting({ job, defaultVoices, read = readRecord }) {
  const saved = await read(soundtrackCastingPath(job));
  if (!saved) return null;
  validJob(job);
  const result = validateApproval(saved.value, job, defaultVoices);
  const prior = await read(priorPath(job, result.priorBindingHash));
  const expected = { ...saved.value.priorReceipt, state: 'superseded', castingApprovalSha256: result.approvalSha256 };
  check(prior?.etag && hash(prior.value) === hash(expected));
  return result;
}

function automaticFit(report, job, voices) {
  const plan = soundtrackPlan({ manifest: job.manifest, manifestHash: job.manifestHash, ...voices });
  check(report?.version === 1 && report.kind === 'soundtrack-fit-inspection-v1'
    && report.manifestHash === job.manifestHash && report.durationMs === plan.durationMs && report.speed === 1
    && report.providerGenerationCalls === 0 && typeof report.fits === 'boolean'
    && Array.isArray(report.scenes) && report.scenes.length === plan.scenes.length
    && Buffer.byteLength(JSON.stringify(report)) <= 250_000);
  for (const [i, scene] of report.scenes.entries()) {
    check(scene.sceneIndex === i + 1 && scene.durationMs === plan.scenes[i].durationMs
      && Array.isArray(scene.turns) && scene.turns.length === plan.scenes[i].turns.length
      && scene.fits === scene.turns.every(turn => turn.fits === true));
    for (const [t, turn] of scene.turns.entries()) check(turn.turnIndex === t + 1 && typeof turn.fits === 'boolean'
      && ['generatedMs', 'retainedMs', 'trimStartMs', 'trimEndMs', 'availableMs', 'overrunMs']
        .every(key => Number.isSafeInteger(turn[key]) && turn[key] >= 0 && turn[key] <= 120_000)
      && turn.retainedMs > 0 && (!turn.fits || turn.overrunMs === 0 && turn.retainedMs <= turn.availableMs));
  }
  check(report.fits === report.scenes.every(scene => scene.fits));
  return report;
}

function automaticBinding(job, sources, defaultVoices, candidates) {
  validJob(job);
  check(Array.isArray(sources) && sources.length === job.shots.length && sources.every((source, i) => source.shotId === job.shots[i].id
    && HASH.test(source.sha256 || '') && Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 16 && source.sizeBytes <= 250 * 1024 * 1024)
    && Array.isArray(candidates) && candidates.length === 2);
  for (const voices of candidates) {
    approvedVoices(job, defaultVoices, { narratorVoice: voices.narratorVoice, characterVoices: voices.characterVoices });
    check(hash(Object.entries(voices.speakerAliases || {}).sort()) === hash(Object.entries(defaultVoices.speakerAliases || {}).sort()));
  }
  return { version: 1, kind: AUTOMATIC_KIND, ownerHash: job.ownerHash, id: job.id, manifestHash: job.manifestHash,
    authorizationSha256: hash(job.authorization ?? null), sourceOutputsSha256: outputsHash(job), sources,
    defaultVoicesSha256: hash(defaultVoices), candidateVoicesSha256: candidates.map(hash) };
}

export async function readAutomaticSoundtrackCasting({ job, binding, candidates, read = readRecord }) {
  const saved = await read(automaticSoundtrackCastingPath(job));
  if (!saved) return null;
  validJob(job);
  const value = saved.value;
  check(saved.etag && value?.version === 1 && value.kind === AUTOMATIC_KIND && hash(value.binding) === hash(binding)
    && binding.manifestHash === job.manifestHash && binding.ownerHash === job.ownerHash && binding.id === job.id
    && binding.authorizationSha256 === hash(job.authorization ?? null) && binding.sourceOutputsSha256 === outputsHash(job)
    && Number.isSafeInteger(value.selectedCandidate) && value.selectedCandidate >= 0 && value.selectedCandidate < 2
    && Array.isArray(candidates) && candidates.length === 2 && hash(value.voices) === hash(candidates[value.selectedCandidate])
    && hash(candidates.map(hash)) === hash(binding.candidateVoicesSha256)
    && value.fitReportSha256 === hash(value.fitReport) && value.fitReport?.fits === true && Number.isFinite(Date.parse(value.selectedAt)));
  automaticFit(value.fitReport, job, value.voices);
  const inspected = await read(`${rootPath(job)}/casting-fit/${hash(binding)}/${value.selectedCandidate}.json`);
  check(inspected?.etag && inspected.value?.kind === 'automatic-casting-fit-v1' && inspected.value.state === 'inspected'
    && inspected.value.bindingHash === hash(binding) && inspected.value.candidateIndex === value.selectedCandidate
    && inspected.value.voiceAssignmentsSha256 === hash(value.voices)
    && inspected.value.fitReportSha256 === value.fitReportSha256 && hash(inspected.value.fitReport) === value.fitReportSha256);
  return { voices: value.voices, receiptSha256: hash(value), binding, candidates };
}

// First-construction casting is bounded to two offline natural-speed readings.
// Each claimed inspection and its result are durable. A partial inspection
// cannot silently rerun on a later worker pass or reset the construction cap.
// Existing construction and explicit owner approvals are handled by the caller.
export async function selectAutomaticSoundtrackCasting({ job, sources, defaultVoices, candidates,
  read = readRecord, write = writeRecord, guard, inspectFit, now = Date.now }) {
  check(typeof guard === 'function' && typeof inspectFit === 'function');
  const binding = automaticBinding(job, sources, defaultVoices, candidates), bindingHash = hash(binding);
  const existing = await readAutomaticSoundtrackCasting({ job, binding, candidates, read });
  if (existing) return existing;
  for (const [index, voices] of candidates.entries()) {
    const path = `${rootPath(job)}/casting-fit/${bindingHash}/${index}.json`;
    let inspected = await read(path);
    if (!inspected) {
      const claim = { version: 1, kind: 'automatic-casting-fit-v1', bindingHash, candidateIndex: index,
        voiceAssignmentsSha256: hash(voices), state: 'inspecting', claimId: randomUUID(), startedAt: new Date(now()).toISOString() };
      await guard();
      try { await write(path, claim); } catch { /* Exact readback fences offline synthesis. */ }
      inspected = await read(path);
      check(inspected?.etag && hash(inspected.value) === hash(claim));
      await guard();
      const fitReport = automaticFit(await inspectFit({ manifest: job.manifest, manifestHash: job.manifestHash, ...voices }), job, voices);
      await guard();
      const complete = { ...claim, state: 'inspected', fitReport, fitReportSha256: hash(fitReport) };
      try { await write(path, complete, inspected.etag); } catch { /* Exact readback recovers a lost response. */ }
      inspected = await read(path);
      check(inspected?.etag && hash(inspected.value) === hash(complete));
    }
    check(inspected?.etag && inspected.value?.kind === 'automatic-casting-fit-v1' && inspected.value.state === 'inspected'
      && inspected.value.bindingHash === bindingHash && inspected.value.candidateIndex === index
      && inspected.value.voiceAssignmentsSha256 === hash(voices)
      && inspected.value.fitReportSha256 === hash(inspected.value.fitReport));
    const fitReport = automaticFit(inspected.value.fitReport, job, voices);
    if (!fitReport.fits) continue;
    const value = { version: 1, kind: AUTOMATIC_KIND, binding, selectedCandidate: index, voices, fitReport,
      fitReportSha256: hash(fitReport), selectedAt: new Date(now()).toISOString() };
    await guard();
    try { await write(automaticSoundtrackCastingPath(job), value); } catch { /* The immutable winner must match. */ }
    const selected = await readAutomaticSoundtrackCasting({ job, binding, candidates, read });
    check(selected?.receiptSha256 === hash(value));
    await guard();
    return selected;
  }
  throw fail();
}

export function createSoundtrackCastingApproval({ read = readRecord, write = writeRecord, now = Date.now,
  requirePayment = requireFinishedFilmPayment } = {}) {
  return async ({ email, preparedId, manifestHash, priorBindingHash, priorReceiptSha256, voices: requestedVoices, fitReport, reason, confirmed },
    { execute = false, defaultVoices } = {}) => {
    check(typeof email === 'string' && email === email.trim().toLowerCase() && HASH.test(manifestHash || '')
      && HASH.test(priorBindingHash || '') && HASH.test(priorReceiptSha256 || '') && confirmed === true
      && typeof reason === 'string' && reason.length >= 10 && reason.length <= 500 && plain(defaultVoices));
    const jobPath = productionJobPath(email, preparedId), queuePath = productionQueuePath(email, preparedId);
    const jobRecord = await read(jobPath), job = jobRecord?.value;
    validJob(job); check(job.id === preparedId && job.manifestHash === manifestHash && job.ownerHash === digest(email));
    const current = async () => {
      const account = (await read(userPath(email)))?.value, latest = await read(jobPath), queue = await read(queuePath);
      check(account?.email === email && isOwner(account) && !account.mustChangePassword && accessStatusForUser(account) === 'approved'
        && latest?.etag === jobRecord.etag && hash(latest.value) === hash(job) && queue?.value.email === email
        && queue.value.id === preparedId && queue.value.manifestHash === manifestHash && queue.value.state === 'attention'
        && (!queue.value.lease || queue.value.lease.expiresAt <= now()));
      await requirePayment({ job, email, actor: account, read, now });
    };
    await current();
    const path = soundtrackCastingPath(job), existing = await read(path), prior = await read(priorPath(job, priorBindingHash));
    const original = existing?.value.priorReceipt || prior?.value;
    checkPrior(job, original, defaultVoices);
    check(original.bindingHash === priorBindingHash && hash(original) === priorReceiptSha256);
    const voices = approvedVoices(job, defaultVoices, requestedVoices); checkFit(fitReport, job, voices);
    const value = { version: 1, kind: KIND, ownerHash: job.ownerHash, id: job.id, manifestHash,
      jobSha256: hash(job), sourceOutputsSha256: outputsHash(job), priorReceiptSha256, priorReceipt: original,
      voices, fitReport, reason, approvedAt: existing?.value.approvedAt || new Date(now()).toISOString() };
    validateApproval(value, job, defaultVoices);
    if (existing) check(hash(existing.value) === hash(value));
    const approvalSha256 = hash(value), fenced = { ...original, state: 'superseded', castingApprovalSha256: approvalSha256 };
    check(prior?.etag && [hash(original), hash(fenced)].includes(hash(prior.value)));
    if (!execute) return { prepared: true, approved: hash(prior.value) === hash(fenced), approvalSha256, priorAttempts: original.attempts,
      remainingAttempts: 2 - original.attempts, providerGenerationCalls: 0 };
    // An immutable intent blocks a newly starting worker before the original
    // receipt fence. Lost responses resume the exact same intent and CAS only.
    await current();
    try { if (!existing) await write(path, value); } catch { /* Exact readback only. */ }
    check(hash((await read(path))?.value) === approvalSha256);
    await current();
    const old = await read(priorPath(job, priorBindingHash));
    if (hash(old?.value) !== hash(fenced)) {
      check(old?.etag === prior.etag && hash(old.value) === hash(original));
      try { await write(priorPath(job, priorBindingHash), fenced, old.etag); } catch { /* Exact readback only. */ }
    }
    const active = await readSoundtrackCasting({ job, defaultVoices, read });
    check(active?.approvalSha256 === approvalSha256);
    return { prepared: true, approved: true, approvalSha256, priorAttempts: active.priorAttempts,
      remainingAttempts: 2 - active.priorAttempts, providerGenerationCalls: 0 };
  };
}
