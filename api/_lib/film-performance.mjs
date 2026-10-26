import { createHash } from 'node:crypto';
import voices from '../../shared/kling-voices.json' with { type: 'json' };

export const KLING_VOICES = Object.freeze(voices.map(voice => Object.freeze(voice)));
export const DEFAULT_NARRATOR_VOICE_ID = KLING_VOICES[0].id;
export const FILM_PERFORMANCE_RECIPE = 'kling-elements-stock-voice-lipsync-v1';
const HASH = /^[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const normalized = text => text.trim().replace(/\s+/g, ' ');
export const isKlingVoice = value => KLING_VOICES.some(voice => voice.id === value);
export class FilmPerformanceError extends Error {
  constructor(message = 'The saved speaking plan needs review. Prepare the film again before requesting a price.', code = 'FILM_PERFORMANCE_INVALID') {
    super(message); this.code = code; this.status = 422;
  }
}
const requireValue = value => { if (!value) throw new FilmPerformanceError(); };

// Parse only approved cast names/IDs. Never guess who speaks an unlabeled line.
export function performanceTurns(scene, characters) {
  const turns = [];
  if (scene.narration?.trim()) turns.push({ mode: 'narration', speakerId: null, text: normalized(scene.narration) });
  const cast = characters.filter(character => scene.characterIds.includes(character.id));
  const aliases = new Map();
  for (const character of cast) for (const alias of [character.id, character.name]) {
    const key = alias.trim().toLowerCase();
    if (aliases.has(key) && aliases.get(key) !== character.id) aliases.set(key, null);
    else if (!aliases.has(key)) aliases.set(key, character.id);
  }
  let current;
  for (const line of (scene.dialogue || '').split(/\r?\n/).filter(line => line.trim())) {
    const match = line.match(/^([^:\n]{1,200}):\s*(.*)$/);
    if (match) {
      const speakerId = aliases.get(match[1].trim().toLowerCase());
      if (!speakerId) throw new FilmPerformanceError('Start each dialogue turn with the exact name of a character in that scene, followed by a colon.');
      current = { mode: 'dialogue', speakerId, text: normalized(match[2]) }; turns.push(current);
    } else {
      if (!current) throw new FilmPerformanceError('Label each dialogue turn with its character name before preparing production.');
      current.text = normalized(`${current.text} ${line}`);
    }
  }
  if (turns.some(turn => !turn.text)) throw new FilmPerformanceError('Give every dialogue turn its spoken words, or remove the empty turn.');
  return turns;
}

const collapse = turns => turns.reduce((out, turn) => {
  if (turn.mode === 'silent') return out;
  const last = out.at(-1);
  if (last?.mode === turn.mode && last.speakerId === turn.speakerId) last.text += ` ${normalized(turn.text)}`;
  else out.push({ mode: turn.mode, speakerId: turn.speakerId, text: normalized(turn.text) });
  return out;
}, []);

export function validateFilmPerformance(manifest) {
  const contract = manifest?.performance;
  if (contract === undefined) {
    requireValue(manifest?.productionPlan?.performanceVersion === undefined && !(manifest?.shots || []).some(shot => shot.performance !== undefined));
    return false;
  }
  requireValue(contract?.version === 1 && contract.recipe === FILM_PERFORMANCE_RECIPE && isKlingVoice(contract.narratorVoiceId)
    && manifest.productionPlan?.performanceVersion === 1 && Array.isArray(manifest.screenplay?.characters)
    && Array.isArray(manifest.screenplay.scenes) && Array.isArray(manifest.shots) && manifest.shots.length > 0 && manifest.shots.length <= 200);
  const characters = manifest.screenplay.characters;
  requireValue(new Set(characters.map(character => character.id)).size === characters.length);
  for (const character of characters) requireValue(isKlingVoice(character.voiceId) && typeof character.wardrobe === 'string' && character.wardrobe.length <= 1000);
  let position = 0, previousScene = -1;
  for (const [index, shot] of manifest.shots.entries()) {
    const p = shot.performance, source = manifest.screenplay.scenes[shot.sceneIndex];
    requireValue(source && shot.id === `shot-${String(index + 1).padStart(3, '0')}` && Number.isSafeInteger(shot.sceneIndex) && shot.sceneIndex >= previousScene
      && p && ['dialogue', 'narration', 'silent'].includes(p.mode) && typeof p.text === 'string'
      && p.text.length <= 120 && p.text === normalized(p.text) && p.text.split(/\s+/).filter(Boolean).length <= 18
      && Number.isSafeInteger(shot.targetDurationMs) && shot.targetDurationMs >= 3000 && shot.targetDurationMs <= 10000
      && shot.targetDurationMs % 1000 === 0 && shot.startMs === position && Array.isArray(shot.characterIds)
      && shot.characterIds.every(id => source.characterIds.includes(id)));
    position += shot.targetDurationMs;
    previousScene = shot.sceneIndex;
    if (p.mode === 'dialogue') {
      const speaker = characters.find(character => character.id === p.speakerId);
      requireValue(speaker && p.voiceId === speaker.voiceId && p.text && shot.characterIds.length === 1 && shot.characterIds[0] === speaker.id
        && shot.narration === '' && shot.dialogue === `${speaker.name}: ${p.text}`);
    } else if (p.mode === 'narration') {
      requireValue(p.speakerId === null && p.voiceId === contract.narratorVoiceId && p.text && shot.narration === p.text && shot.dialogue === '');
    } else requireValue(p.speakerId === null && p.voiceId === null && p.text === '' && shot.narration === '' && shot.dialogue === '');
  }
  requireValue(position === manifest.targetDurationSeconds * 1000);
  for (const [index, scene] of manifest.screenplay.scenes.entries()) {
    const cuts = manifest.shots.filter(shot => shot.sceneIndex === index);
    requireValue(cuts.length && JSON.stringify(collapse(cuts.map(shot => shot.performance))) === JSON.stringify(collapse(performanceTurns(scene, characters))));
  }
  return true;
}

export function validatePerformanceReceiptShape(receipt) {
  if (!receipt || receipt.version !== 1 || receipt.recipe !== FILM_PERFORMANCE_RECIPE
    || !['dialogue', 'narration', 'silent'].includes(receipt.mode)
    || ![receipt.textSha256, receipt.videoOperationId, receipt.sourceVideoUrlSha256, receipt.outputVideoUrlSha256].every(value => HASH.test(value || ''))
    || !(receipt.speakerId === null || typeof receipt.speakerId === 'string' && receipt.speakerId.length <= 2000)
    || !(receipt.voiceId === null || isKlingVoice(receipt.voiceId))
    || !(receipt.speechOperationId === null || HASH.test(receipt.speechOperationId || ''))
    || !(receipt.audioUrlSha256 === null || HASH.test(receipt.audioUrlSha256 || ''))) {
    throw new FilmPerformanceError('The final voice and video provenance needs review.', 'PERFORMANCE_PROVENANCE_INVALID');
  }
  return Object.fromEntries(['version', 'recipe', 'mode', 'speakerId', 'voiceId', 'textSha256', 'videoOperationId', 'speechOperationId',
    'sourceVideoUrlSha256', 'outputVideoUrlSha256', 'audioUrlSha256'].map(key => [key, receipt[key]]));
}

export function validatePerformanceOutput(manifest, shot, output) {
  if (!validateFilmPerformance(manifest)) {
    if (output?.performance !== undefined) throw new FilmPerformanceError('This output belongs to a different speaking plan.', 'PERFORMANCE_PROVENANCE_INVALID');
    return false;
  }
  const receipt = validatePerformanceReceiptShape(output?.performance), p = shot.performance;
  const matches = p && ['mode', 'speakerId', 'voiceId'].every(key => receipt[key] === p[key]) && receipt.textSha256 === sha(p.text)
    && receipt.outputVideoUrlSha256 === sha(output.url)
    && (p.mode === 'narration' ? output.audio && receipt.audioUrlSha256 === sha(output.audio.url) && receipt.speechOperationId !== null
      : output.audio === undefined && receipt.audioUrlSha256 === null && (p.mode === 'dialogue' ? receipt.speechOperationId !== null : receipt.speechOperationId === null));
  if (!matches) throw new FilmPerformanceError('The selected voice, script, and final video do not match.', 'PERFORMANCE_PROVENANCE_INVALID');
  return receipt;
}
