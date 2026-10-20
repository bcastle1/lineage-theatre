// Read-only operator preflight for the exact saved screenplay. Synthesis runs
// offline at natural speed; this does not publish audio, change production
// voices, write a soundtrack cache/attempt, or contact a provider/payment API.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 300_000, HASH = /^[a-f0-9]{64}$/;
const VOICE = /^(?:af|am|bf|bm)_[a-z]{2,24}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Object.assign(new Error('The saved soundtrack timing could not be inspected.'), { code: 'SOUNDTRACK_FIT_INSPECTION_FAILED' });
const requireValue = value => { if (!value) throw invalid(); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const usage = 'Usage: node scripts/inspect-film-soundtrack-fit.mjs --input <private-manifest.json> [--narrator <stock-voice>] [--character-voices <private-voice-map.json>]\n'
  + 'Input: exactly {manifest,manifestHash}, at most 300000 bytes. Run inside the offline soundtrack runtime.\n'
  + 'Output: timing metrics only. Exit 0 means every turn fits; exit 2 means a turn does not fit; exit 1 means inspection failed.\n'
  + 'Voice overrides change this inspection only. A character map must assign every saved cast ID exactly once.\n'
  + 'Saved production voices and natural playback speed stay unchanged.\n';

export async function inspectSavedFilmSoundtrackFit(value, options = {}) {
  requireValue(plain(options) && Object.keys(options).every(key => ['narratorVoice', 'characterVoices'].includes(key)));
  const { narratorVoice, characterVoices } = options;
  requireValue(plain(value) && Object.keys(value).sort().join(',') === 'manifest,manifestHash'
    && plain(value.manifest) && HASH.test(value.manifestHash || '')
    && (narratorVoice === undefined || typeof narratorVoice === 'string' && VOICE.test(narratorVoice)));
  const serialized = JSON.stringify(value);
  requireValue(Buffer.byteLength(serialized) <= MAX_INPUT_BYTES);
  const { manifest, manifestHash } = JSON.parse(serialized);
  requireValue(createHash('sha256').update(JSON.stringify(manifest)).digest('hex') === manifestHash);
  if (characterVoices !== undefined) {
    requireValue(plain(characterVoices) && Array.isArray(manifest.screenplay?.characters)
      && JSON.stringify(Object.keys(characterVoices).sort()) === JSON.stringify(manifest.screenplay.characters.map(character => character.id).sort())
      && Object.values(characterVoices).every(voice => typeof voice === 'string' && VOICE.test(voice)));
  }
  const { standardFilmVoices } = await import('./automatic-film-soundtrack.mjs');
  const { soundtrackPlan, inspectFilmSoundtrackFit } = await import('./rebuild-film-soundtrack.mjs');
  requireValue(typeof inspectFilmSoundtrackFit === 'function');
  const voices = { ...standardFilmVoices(manifest, manifestHash), ...(narratorVoice === undefined ? {} : { narratorVoice }),
    ...(characterVoices === undefined ? {} : { characterVoices: structuredClone(characterVoices) }) };
  const plan = soundtrackPlan({ manifest, manifestHash, ...voices });
  const report = await inspectFilmSoundtrackFit({ manifest, manifestHash, ...voices });
  requireValue(plain(report) && report.version === 1 && report.kind === 'soundtrack-fit-inspection-v1'
    && report.manifestHash === manifestHash && report.durationMs === plan.durationMs && report.speed === 1
    && report.providerGenerationCalls === 0 && typeof report.fits === 'boolean'
    && Array.isArray(report.scenes) && report.scenes.length === plan.scenes.length);
  const fields = ['generatedMs', 'retainedMs', 'trimStartMs', 'trimEndMs', 'availableMs', 'overrunMs'];
  const scenes = report.scenes.map((scene, index) => {
    requireValue(plain(scene) && scene.sceneIndex === index + 1 && scene.durationMs === plan.scenes[index].durationMs
      && typeof scene.fits === 'boolean' && Array.isArray(scene.turns) && scene.turns.length === plan.scenes[index].turns.length);
    const turns = scene.turns.map((turn, turnIndex) => {
      requireValue(plain(turn) && turn.turnIndex === turnIndex + 1 && fields.every(field => integer(turn[field]))
        && typeof turn.fits === 'boolean');
      return { turnIndex: turn.turnIndex, ...Object.fromEntries(fields.map(field => [field, turn[field]])), fits: turn.fits };
    });
    requireValue(scene.fits === turns.every(turn => turn.fits));
    return { sceneIndex: scene.sceneIndex, durationMs: scene.durationMs, fits: scene.fits, turns };
  });
  requireValue(report.fits === scenes.every(scene => scene.fits));
  return { version: 1, kind: 'soundtrack-fit-inspection-v1', manifestHash, durationMs: report.durationMs,
    speed: 1, providerGenerationCalls: 0, ...(narratorVoice === undefined ? {} : { requestedNarratorVoice: narratorVoice }),
    ...(characterVoices === undefined ? {} : { requestedCharacterVoicesSha256: createHash('sha256')
      .update(JSON.stringify(Object.entries(voices.characterVoices).sort(([a], [b]) => a.localeCompare(b)))).digest('hex') }),
    fits: report.fits, scenes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(usage); return; }
    requireValue(args[0] === '--input' && typeof args[1] === 'string' && args[1].length > 0
      && [2, 4, 6].includes(args.length));
    const options = {}, seen = new Set();
    for (let index = 2; index < args.length; index += 2) {
      const flag = args[index], argument = args[index + 1];
      requireValue(['--narrator', '--character-voices'].includes(flag) && !seen.has(flag) && typeof argument === 'string' && argument.length > 0);
      seen.add(flag);
      if (flag === '--narrator') { requireValue(VOICE.test(argument)); options.narratorVoice = argument; }
      else {
        const mapBytes = await readFile(resolve(argument)); requireValue(mapBytes.length <= 16000);
        options.characterVoices = JSON.parse(mapBytes.toString('utf8'));
      }
    }
    const bytes = await readFile(resolve(args[1])); requireValue(bytes.length <= MAX_INPUT_BYTES);
    const report = await inspectSavedFilmSoundtrackFit(JSON.parse(bytes.toString('utf8')), options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.fits) process.exitCode = 2;
  })().catch(() => {
    process.stdout.write(`${JSON.stringify({ status: 'failed', code: 'SOUNDTRACK_FIT_INSPECTION_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
