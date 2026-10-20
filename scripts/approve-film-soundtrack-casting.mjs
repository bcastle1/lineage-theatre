// Prepare only by default. --execute stores one exact casting approval and
// fences the interrupted receipt; it never synthesizes or resumes the queue.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord } from '../api/_lib/auth.mjs';
import { productionJobPath } from '../api/_lib/film-production.mjs';
import { standardFilmVoices } from './automatic-film-soundtrack.mjs';
import { createSoundtrackCastingApproval } from './authored-soundtrack-casting.mjs';

const HASH = /^[a-f0-9]{64}$/, VOICE = /^(?:af|am|bf|bm)_[a-z]{2,24}$/;
const fields = ['email', 'preparedId', 'manifestHash', 'priorBindingHash', 'priorReceiptSha256', 'voices', 'fitReport', 'reason', 'confirmed'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => Object.assign(new Error('The exact authored casting approval could not be confirmed.'), { code: 'SOUNDTRACK_CASTING_UNVERIFIED' });
const check = value => { if (!value) throw fail(); };
const usage = 'Usage: node scripts/approve-film-soundtrack-casting.mjs --input <private-approval.json> [--execute]\n'
  + 'Default: prepare and verify only. --execute stores one exact approval and fences the interrupted construction receipt.\n'
  + 'Input: email, preparedId, manifestHash, priorBindingHash, priorReceiptSha256, voices {narratorVoice,characterVoices}, fitReportFile, reason, confirmed:true.\n'
  + 'Input is limited to 16000 bytes; the fit report is limited to 250000 bytes. A relative fitReportFile is resolved beside the input file.\n'
  + 'Requires an all-fit report for the exact full voice map, an attention queue without a live lease, and one interrupted construction attempt.\n'
  + 'No synthesis, provider generation, invoice/payment changes, retry-budget reset, or queue resume. Output contains fixed status and record hashes only.\n';

export function parseSoundtrackCastingArgs(args) {
  check(Array.isArray(args) && args.every(argument => typeof argument === 'string'));
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  check(args[0] === '--input' && args[1]?.trim() && [2, 3].includes(args.length)
    && (args.length === 2 || args[2] === '--execute'));
  return { inputPath: resolve(args[1]), execute: args.length === 3 };
}

export async function approveSavedFilmSoundtrackCasting(value, { execute = false } = {}, {
  read = readRecord, approve = createSoundtrackCastingApproval(), defaultVoicesFor = standardFilmVoices,
} = {}) {
  check(typeof execute === 'boolean' && plain(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',')
    && typeof value.email === 'string' && value.email.length <= 254 && value.email === value.email.trim().toLowerCase()
    && /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(value.email)
    && ['manifestHash', 'priorBindingHash', 'priorReceiptSha256'].every(key => HASH.test(value[key] || ''))
    && plain(value.voices) && Object.keys(value.voices).sort().join(',') === 'characterVoices,narratorVoice'
    && VOICE.test(value.voices.narratorVoice || '') && plain(value.voices.characterVoices)
    && Object.keys(value.voices.characterVoices).length <= 16
    && Object.entries(value.voices.characterVoices).every(([id, voice]) => /^[A-Za-z0-9_-]{1,100}$/.test(id) && typeof voice === 'string' && VOICE.test(voice))
    && new Set([value.voices.narratorVoice, ...Object.values(value.voices.characterVoices)]).size === Object.keys(value.voices.characterVoices).length + 1
    && plain(value.fitReport) && Buffer.byteLength(JSON.stringify(value.fitReport)) <= 250_000
    && typeof value.reason === 'string' && value.reason.trim().length >= 10 && value.reason.length <= 500
    && !/[<>\x00-\x1f\x7f]/.test(value.reason) && value.confirmed === true);
  const request = structuredClone(value), path = productionJobPath(request.email, request.preparedId);
  const record = await read(path), job = record?.value;
  check(record?.etag && job?.id === request.preparedId && job.ownerHash === digest(request.email)
    && job.manifestHash === request.manifestHash && plain(job.manifest)
    && JSON.stringify(Object.keys(request.voices.characterVoices).sort()) === JSON.stringify(job.manifest.screenplay?.characters?.map(character => character.id).sort()));
  const defaultVoices = defaultVoicesFor(job.manifest, job.manifestHash);
  const result = await approve(request, { execute, defaultVoices });
  check(result?.prepared === true && typeof result.approved === 'boolean' && (!execute || result.approved)
    && HASH.test(result.approvalSha256 || '') && result.priorAttempts === 1 && result.remainingAttempts === 1 && result.providerGenerationCalls === 0);
  return { prepared: true, approved: result.approved, approvalSha256: result.approvalSha256,
    priorAttempts: result.priorAttempts, remainingAttempts: result.remainingAttempts, providerGenerationCalls: 0 };
}

export async function runSoundtrackCastingCli(args, dependencies = {}) {
  const parsed = parseSoundtrackCastingArgs(args);
  if (parsed.help) return { help: usage };
  const readLocal = dependencies.readFile || readFile;
  const bytes = await readLocal(parsed.inputPath); check(bytes.length <= 16000);
  const input = JSON.parse(bytes.toString('utf8'));
  const expected = fields.map(key => key === 'fitReport' ? 'fitReportFile' : key);
  check(plain(input) && Object.keys(input).sort().join(',') === expected.sort().join(',')
    && typeof input.fitReportFile === 'string' && input.fitReportFile.trim().length > 0 && input.fitReportFile.length <= 4096
    && !/[\x00-\x1f]/.test(input.fitReportFile));
  const reportBytes = await readLocal(resolve(dirname(parsed.inputPath), input.fitReportFile)); check(reportBytes.length <= 250_000);
  const { fitReportFile, ...request } = input;
  return approveSavedFilmSoundtrackCasting({ ...request, fitReport: JSON.parse(reportBytes.toString('utf8')) },
    { execute: parsed.execute }, dependencies);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSoundtrackCastingCli(process.argv.slice(2)).then(result => {
    process.stdout.write(result.help || `${JSON.stringify(result)}\n`);
  }).catch(() => {
    process.stdout.write(`${JSON.stringify({ approved: false, code: 'SOUNDTRACK_CASTING_UNVERIFIED', providerGenerationCalls: 0 })}\n`);
    process.exitCode = 1;
  });
}
