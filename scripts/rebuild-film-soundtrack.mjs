// Isolated local soundtrack construction. No payment, Blob, provider, or job API.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const VOICE = /^(?:af|am|bf|bm)_[a-z]{2,24}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const error = reason => Object.assign(new Error('The local soundtrack needs review.'), { code: 'SOUNDTRACK_REBUILD_REQUIRED', reason });
const requireValue = (condition, reason) => { if (!condition) throw error(reason); };
const text = value => typeof value === 'string' && value.length <= 12_000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const reasonCodes = new Set(['INPUT_INVALID', 'MANIFEST_CHANGED', 'CAST_INVALID', 'VOICE_MAPPING_REQUIRED', 'DIALOGUE_LABEL_REQUIRED',
  'DIALOGUE_LABEL_AMBIGUOUS', 'SPEAKER_NOT_IN_SCENE', 'TOO_MANY_TURNS', 'OUTPUT_INVALID', 'OUTPUT_EXISTS', 'RUNTIME_FAILED',
  'TIME_LIMIT', 'MODEL_UNAVAILABLE', 'PRONUNCIATION_UNSUPPORTED', 'SPEECH_INVALID', 'SCENE_DURATION_EXCEEDED', 'SCORE_FAILED']);

export function soundtrackPlan({ manifest, manifestHash, narratorVoice = 'am_michael', characterVoices = {}, speakerAliases = {}, music }) {
  requireValue(plain(manifest) && HASH.test(manifestHash || '') && hash(JSON.stringify(manifest)) === manifestHash, 'MANIFEST_CHANGED');
  requireValue(manifest.version === 1 && Array.isArray(manifest.shots) && manifest.shots.length >= 1 && manifest.shots.length <= 30
    && Number.isSafeInteger(manifest.targetDurationSeconds) && manifest.targetDurationSeconds >= 15 && manifest.targetDurationSeconds <= 600
    && Array.isArray(manifest.screenplay?.characters) && manifest.screenplay.characters.length <= 16
    && plain(characterVoices) && plain(speakerAliases) && VOICE.test(narratorVoice)
    && (music === undefined || typeof music === 'boolean'), 'INPUT_INVALID');
  const cast = new Map(), labels = new Map([['narrator', null]]);
  const addLabel = (name, id) => {
    const key = label(name);
    requireValue(key && key.length <= 120 && !/[\r\n:]/.test(key), 'CAST_INVALID');
    requireValue(!labels.has(key) || labels.get(key) === id, 'DIALOGUE_LABEL_AMBIGUOUS');
    labels.set(key, id);
  };
  for (const character of manifest.screenplay.characters) {
    requireValue(plain(character) && ID.test(character.id || '') && text(character.name) && character.name.trim()
      && !cast.has(character.id), 'CAST_INVALID');
    cast.set(character.id, character);
    addLabel(character.id, character.id);
    addLabel(character.name, character.id);
  }
  for (const [name, id] of Object.entries(speakerAliases)) {
    requireValue(cast.has(id), 'CAST_INVALID');
    addLabel(name, id);
  }
  const voices = new Map([[null, narratorVoice]]), usedVoices = new Set([narratorVoice]);
  for (const [id, voice] of Object.entries(characterVoices)) {
    requireValue(cast.has(id) && VOICE.test(voice) && !usedVoices.has(voice), 'VOICE_MAPPING_REQUIRED');
    voices.set(id, voice); usedVoices.add(voice);
  }
  let position = 0, turnCount = 0, characterCount = 0;
  const seenShots = new Set();
  const scenes = manifest.shots.map((shot, sceneIndex) => {
    requireValue(plain(shot) && ID.test(shot.id || '') && !seenShots.has(shot.id) && text(shot.narration) && text(shot.dialogue)
      && Array.isArray(shot.characterIds) && shot.characterIds.every(id => cast.has(id))
      && Number.isSafeInteger(shot.targetDurationMs) && shot.targetDurationMs >= 1000 && shot.targetDurationMs <= 30_000
      && shot.startMs === position, 'INPUT_INVALID');
    seenShots.add(shot.id); position += shot.targetDurationMs;
    characterCount += shot.narration.length + shot.dialogue.length;
    const turns = [];
    const addTurn = (speaker, spoken, source) => {
      const exactText = spoken.trim();
      requireValue(exactText.length > 0 && exactText.length <= 1200, 'INPUT_INVALID');
      requireValue(speaker === null || shot.characterIds.includes(speaker), 'SPEAKER_NOT_IN_SCENE');
      requireValue(voices.has(speaker), 'VOICE_MAPPING_REQUIRED');
      turns.push({ turnIndex: turns.length + 1, speakerId: speaker, source, voice: voices.get(speaker), text: exactText, textSha256: hash(exactText) });
    };
    if (shot.narration.trim()) addTurn(null, shot.narration, 'narration');
    let current = null;
    for (const line of shot.dialogue.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^\s*([^:\r\n]{1,120}):\s*(.*)$/.exec(line);
      if (match) {
        if (current) addTurn(current.speaker, current.text, 'dialogue');
        const key = label(match[1]);
        requireValue(labels.has(key), 'DIALOGUE_LABEL_REQUIRED');
        current = { speaker: labels.get(key), text: match[2] };
      } else {
        requireValue(current !== null, 'DIALOGUE_LABEL_REQUIRED');
        current.text += `\n${line}`;
      }
    }
    if (current) addTurn(current.speaker, current.text, 'dialogue');
    // An inline second label is ambiguous. Require explicit lines, never speak it.
    for (const turn of turns.filter(turn => turn.source === 'dialogue')) {
      requireValue(!/(?:^|\s)[A-Z][A-Z _'-]{1,100}:/.test(turn.text), 'DIALOGUE_LABEL_AMBIGUOUS');
    }
    turnCount += turns.length;
    requireValue(turns.length <= 20 && turnCount <= 200, 'TOO_MANY_TURNS');
    return { shotId: shot.id, sceneIndex: sceneIndex + 1, startMs: shot.startMs, durationMs: shot.targetDurationMs,
      narrationSha256: hash(shot.narration), dialogueSha256: hash(shot.dialogue), turns };
  });
  requireValue(position === manifest.targetDurationSeconds * 1000 && characterCount <= 36_000, 'INPUT_INVALID');
  return { version: 1, recipe: 'local-authored-soundtrack-v1', manifestHash, durationMs: position,
    musicRequested: music ?? (manifest.sound?.musicRequested === true), originalMusicRequested: manifest.sound?.musicRequested === true,
    narratorVoice, characterVoices: { ...characterVoices }, speed: 1, scenes };
}

function buildLocal(plan, directory, { python, ffmpeg, fluidsynth, modelDirectory, soundfont }) {
  return new Promise((resolveBuild, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('./rebuild-film-soundtrack.py', import.meta.url))], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', TMPDIR: process.env.TMPDIR || '/tmp',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1',
        OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2' },
    });
    let size = 0, settled = false; const chunks = [];
    const stop = reason => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(error(reason));
    };
    const timer = setTimeout(() => stop('TIME_LIMIT'), 20 * 60_000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 200_000) stop('OUTPUT_INVALID'); else chunks.push(chunk); });
    child.once('error', () => stop('RUNTIME_FAILED'));
    child.stdin.on('error', () => stop('RUNTIME_FAILED'));
    child.once('close', code => {
      if (settled) return;
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0) { stop(reasonCodes.has(output?.reason) ? output.reason : 'RUNTIME_FAILED'); return; }
        requireValue(output?.status === 'constructed' && output.manifestHash === plan.manifestHash, 'OUTPUT_INVALID');
        settled = true; clearTimeout(timer); resolveBuild(output);
      } catch { stop('OUTPUT_INVALID'); }
    });
    child.stdin.end(JSON.stringify({ plan, directory, ffmpeg, fluidsynth, modelDirectory, soundfont }));
  });
}

export async function rebuildFilmSoundtrack({ manifest, manifestHash, clips, workDir,
  narratorVoice = 'am_michael', characterVoices = {}, speakerAliases = {}, music,
  python = process.env.LINEAGE_TTS_PYTHON || '/opt/soundtrack/bin/python', ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
  fluidsynth = process.env.FLUIDSYNTH_PATH || '/usr/bin/fluidsynth',
  modelDirectory = process.env.LINEAGE_TTS_MODEL_DIR || '/opt/soundtrack/models/kokoro',
  soundfont = process.env.LINEAGE_SOUNDFONT || '/usr/share/sounds/sf2/FluidR3_GM.sf2' } = {}) {
  const plan = soundtrackPlan({ manifest, manifestHash, narratorVoice, characterVoices, speakerAliases, music });
  requireValue(Array.isArray(clips) && clips.length === plan.scenes.length && typeof workDir === 'string'
    && new Set(clips.map(clip => clip?.shotId)).size === clips.length, 'INPUT_INVALID');
  for (const clip of clips) requireValue(plan.scenes.some(scene => scene.shotId === clip?.shotId) && typeof clip.path === 'string', 'INPUT_INVALID');
  const root = await realpath(resolve(workDir)), directory = join(root, 'soundtrack');
  requireValue((await stat(root)).isDirectory(), 'INPUT_INVALID');
  try { await mkdir(directory, { recursive: false, mode: 0o700 }); } catch { throw error('OUTPUT_EXISTS'); }
  const result = await buildLocal(plan, directory, { python, ffmpeg, fluidsynth, modelDirectory, soundfont });
  requireValue(Array.isArray(result.scenes) && result.scenes.length === plan.scenes.length
    && Boolean(result.score) === plan.musicRequested && result.durationMs === plan.durationMs, 'OUTPUT_INVALID');
  const verifyFile = async value => {
    requireValue(plain(value) && typeof value.file === 'string' && !isAbsolute(value.file) && HASH.test(value.sha256 || '')
      && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 16 && value.sizeBytes <= 250 * 1024 * 1024, 'OUTPUT_INVALID');
    const path = await realpath(join(directory, value.file)), within = relative(directory, path);
    requireValue(within && !within.startsWith('..') && !isAbsolute(within), 'OUTPUT_INVALID');
    const bytes = await readFile(path);
    requireValue(bytes.length === value.sizeBytes && hash(bytes) === value.sha256, 'OUTPUT_INVALID');
    return path;
  };
  const repaired = [];
  for (const [index, scene] of result.scenes.entries()) {
    const expected = plan.scenes[index];
    requireValue(scene.shotId === expected.shotId && scene.durationMs === expected.durationMs
      && Array.isArray(scene.turns) && scene.turns.length === expected.turns.length, 'OUTPUT_INVALID');
    const audioPath = await verifyFile(scene.mix); await verifyFile(scene.speech);
    let previousEnd = 0;
    for (const [turnIndex, turn] of scene.turns.entries()) {
      const intended = expected.turns[turnIndex];
      requireValue(turn.textSha256 === intended.textSha256 && turn.voice === intended.voice && turn.speakerId === intended.speakerId
        && Number.isFinite(turn.startSeconds) && Number.isFinite(turn.endSeconds) && turn.startSeconds >= previousEnd
        && turn.endSeconds > turn.startSeconds && turn.endSeconds <= expected.durationMs / 1000 - 0.19, 'OUTPUT_INVALID');
      await verifyFile(turn.audio);
      previousEnd = turn.endSeconds;
    }
    repaired.push({ ...clips.find(clip => clip.shotId === expected.shotId), audioPath });
  }
  if (result.score) { await verifyFile(result.score.midi); await verifyFile(result.score.audio); }
  const provenance = { ...result, status: 'constructed-needs-review', providerGenerationCalls: 0,
    narratorVoice: plan.narratorVoice, characterVoices: plan.characterVoices, playbackAndSpeechReviewRequired: true };
  await writeFile(join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2), { flag: 'wx', mode: 0o600 });
  return { clips: repaired, provenance };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, workDir] = process.argv.slice(2);
  (async () => {
    requireValue(input && workDir && process.argv.length === 4, 'INPUT_INVALID');
    const bytes = await readFile(resolve(input)); requireValue(bytes.length <= 300_000, 'INPUT_INVALID');
    const value = JSON.parse(bytes.toString('utf8'));
    const result = await rebuildFilmSoundtrack({ ...value, workDir });
    process.stdout.write(`${JSON.stringify({ status: 'constructed-needs-review', sceneCount: result.clips.length, providerGenerationCalls: 0 })}\n`);
  })().catch(failure => {
    process.stdout.write(`${JSON.stringify({ status: 'failed', reason: reasonCodes.has(failure?.reason) ? failure.reason : 'RUNTIME_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
