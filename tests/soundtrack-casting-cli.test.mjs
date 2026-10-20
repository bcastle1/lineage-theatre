import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { digest } from '../api/_lib/auth.mjs';
import { approveSavedFilmSoundtrackCasting, parseSoundtrackCastingArgs, runSoundtrackCastingCli } from '../scripts/approve-film-soundtrack-casting.mjs';

const email = 'owner@example.invalid', preparedId = '11111111-1111-4111-8111-111111111111';
const manifestHash = 'a'.repeat(64), approvalSha256 = 'b'.repeat(64);
const input = { email, preparedId, manifestHash, priorBindingHash: 'c'.repeat(64), priorReceiptSha256: 'd'.repeat(64),
  voices: { narratorVoice: 'am_michael', characterVoices: { fictional_character: 'am_fenrir' } },
  fitReport: { fits: true }, reason: 'Owner reviewed this exact natural-speed stock casting.', confirmed: true };
function fixture() {
  const calls = [], reads = [], defaults = { narratorVoice: 'am_michael', characterVoices: { fictional_character: 'af_heart' }, speakerAliases: {} };
  return { calls, reads, defaults, deps: {
    read: async path => { reads.push(path); return { etag: 'exact-job', value: { id: preparedId, ownerHash: digest(email), manifestHash,
      manifest: { screenplay: { characters: [{ id: 'fictional_character' }] } } } }; },
    defaultVoicesFor: () => defaults,
    approve: async (request, options) => { calls.push({ request, options }); return { prepared: true, approved: options.execute,
      approvalSha256, priorAttempts: 1, remainingAttempts: 1, providerGenerationCalls: 0, privateText: 'DO_NOT_PRINT' }; },
  } };
}

test('casting CLI prepares by default and executes only with the exact explicit flag', () => {
  assert.equal(parseSoundtrackCastingArgs(['--input', 'approval.json']).execute, false);
  assert.equal(parseSoundtrackCastingArgs(['--input', 'approval.json', '--execute']).execute, true);
  assert.deepEqual(parseSoundtrackCastingArgs(['--help']), { help: true });
  for (const args of [[], ['--execute'], ['--input', ''], ['--input', 'x', '--force'], ['--execute', '--input', 'x'],
    ['--input', 'x', '--execute', '--execute'], ['--help', '--execute']]) assert.throws(() => parseSoundtrackCastingArgs(args));
});

test('exact request and original default voices reach the backend while output stays sanitized', async () => {
  for (const execute of [false, true]) {
    const f = fixture(), result = await approveSavedFilmSoundtrackCasting(input, { execute }, f.deps);
    assert.deepEqual(f.calls, [{ request: input, options: { execute, defaultVoices: f.defaults } }]);
    assert.deepEqual(result, { prepared: true, approved: execute, approvalSha256, priorAttempts: 1, remainingAttempts: 1, providerGenerationCalls: 0 });
    assert.ok(!JSON.stringify(result).includes('DO_NOT_PRINT'));
  }
});

test('malformed approval, incomplete voices and changed job binding cannot call the approval service', async () => {
  for (const change of [v => { v.confirmed = false; }, v => { v.extra = true; }, v => { v.reason = 'short'; },
    v => { v.priorReceiptSha256 = 'changed'; }, v => { v.voices.characterVoices = {}; },
    v => { v.voices.characterVoices.fictional_character = v.voices.narratorVoice; }, v => { v.manifestHash = 'e'.repeat(64); }]) {
    const f = fixture(), value = structuredClone(input); change(value);
    await assert.rejects(approveSavedFilmSoundtrackCasting(value, {}, f.deps)); assert.equal(f.calls.length, 0);
  }
});

test('private report file resolves beside the input and help does not read records', async () => {
  const f = fixture(), path = resolve('private', 'approval.json'), { fitReport, ...fileInput } = input;
  const files = new Map([[path, Buffer.from(JSON.stringify({ ...fileInput, fitReportFile: 'fit.json' }))],
    [resolve(dirname(path), 'fit.json'), Buffer.from(JSON.stringify(fitReport))]]);
  const deps = { ...f.deps, readFile: async filename => { assert.ok(files.has(filename)); return files.get(filename); } };
  assert.match((await runSoundtrackCastingCli(['--help'], deps)).help, /prepare and verify only/i);
  assert.equal(f.reads.length, 0);
  assert.equal((await runSoundtrackCastingCli(['--input', path], deps)).approved, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.execute, false);
  files.set(path, Buffer.alloc(16001)); await assert.rejects(runSoundtrackCastingCli(['--input', path, '--execute'], deps));
  assert.equal(f.calls.length, 1);
});

test('unconfirmed execution and malformed approval responses fail closed', async () => {
  for (const result of [{ prepared: true, approved: false, approvalSha256, priorAttempts: 1, remainingAttempts: 1, providerGenerationCalls: 0 },
    { prepared: true, approved: true, approvalSha256, priorAttempts: 0, remainingAttempts: 2, providerGenerationCalls: 0 }]) {
    const f = fixture(); f.deps.approve = async () => result;
    await assert.rejects(approveSavedFilmSoundtrackCasting(input, { execute: true }, f.deps));
  }
});
