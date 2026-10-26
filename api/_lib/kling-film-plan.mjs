import { createVisualContinuity, validateVisualContinuity } from './film-visual-continuity.mjs';
import { FilmPerformanceError, performanceTurns, validateFilmPerformance } from './film-performance.mjs';

function speakingChunks(text) {
  const chunks = []; let words = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > 120) throw new FilmPerformanceError('A spoken word is too long for the voice service. Review the script before preparing production.');
    if (words.length === 18 || [...words, word].join(' ').length > 120) { chunks.push(words.join(' ')); words = []; }
    words.push(word);
  }
  if (words.length) chunks.push(words.join(' '));
  return chunks;
}

function performancePlan(manifest, contract) {
  if (!contract) throw new FilmPerformanceError();
  const characters = manifest.screenplay.characters, cuts = [];
  for (const [index, scene] of manifest.shots.entries()) {
    const base = { ...scene, continuity: { ...scene.continuity, sourceSceneId: contract.scenes[index].sceneId } };
    const turns = performanceTurns(scene, characters);
    for (const turn of turns) for (const text of speakingChunks(turn.text)) {
      const speaker = characters.find(character => character.id === turn.speakerId);
      const seconds = Math.max(3, Math.ceil(Math.max(text.split(/\s+/).length / 2.2, text.length / 16) + .7));
      if (seconds > 10) throw new FilmPerformanceError('This dialogue needs a slower, shorter speaking turn. Split the line before preparing production.');
      cuts.push({ ...base, characterIds: speaker ? [speaker.id] : [...scene.characterIds],
        narration: turn.mode === 'narration' ? text : '', dialogue: speaker ? `${speaker.name}: ${text}` : '',
        targetDurationMs: seconds * 1000, performance: { mode: turn.mode, speakerId: turn.speakerId,
          voiceId: speaker ? speaker.voiceId : manifest.performance.narratorVoiceId, text } });
    }
    if (!turns.length) cuts.push({ ...base, narration: '', dialogue: '', targetDurationMs: 3000,
      performance: { mode: 'silent', speakerId: null, voiceId: null, text: '' } });
  }
  // Extra runtime belongs to silent action/reaction cuts, not repeated words or
  // stretched dialogue. Keep cuts adjacent to their approved source scene.
  let extraIndex = 0;
  while (cuts.length * 10 < manifest.targetDurationSeconds) {
    const sourceIndex = extraIndex++ % manifest.shots.length;
    const base = manifest.shots[sourceIndex];
    cuts.push({ ...base, narration: '', dialogue: '', targetDurationMs: 3000,
      continuity: { ...base.continuity, sourceSceneId: contract.scenes[sourceIndex].sceneId },
      performance: { mode: 'silent', speakerId: null, voiceId: null, text: '' } });
  }
  cuts.sort((a, b) => a.sceneIndex - b.sceneIndex);
  const minimumSeconds = cuts.reduce((sum, cut) => sum + cut.targetDurationMs / 1000, 0);
  if (minimumSeconds > manifest.targetDurationSeconds) throw new FilmPerformanceError(`The selected voices need at least ${minimumSeconds} seconds for this script. Increase the film length or shorten the dialogue before requesting a price.`);
  let remaining = manifest.targetDurationSeconds - minimumSeconds;
  while (remaining > 0) for (const cut of cuts) {
    if (remaining && cut.targetDurationMs < 10000) { cut.targetDurationMs += 1000; remaining--; }
  }
  if (cuts.length > 200) throw new FilmPerformanceError('This film has too many speaking and action cuts.');
  let startMs = 0;
  const shots = cuts.map((cut, index) => {
    const sceneCuts = cuts.filter(candidate => candidate.sceneIndex === cut.sceneIndex);
    const shot = { ...cut, id: `shot-${String(index + 1).padStart(3, '0')}`, startMs,
      scenePart: sceneCuts.indexOf(cut) + 1, sceneParts: sceneCuts.length,
      continuity: { ...cut.continuity, characterIds: [...cut.characterIds], precedingShotId: index ? `shot-${String(index).padStart(3, '0')}` : null } };
    startMs += cut.targetDurationMs; return shot;
  });
  const planned = { ...manifest, visualContinuity: contract, shots,
    productionPlan: { provider: 'kling', version: 1, visualContinuityVersion: 1, performanceVersion: 1 } };
  validateFilmPerformance(planned); validateVisualContinuity(planned); return planned;
}

// Plan new films before pricing/payment. Never rewrite an already-paid manifest.
// The reviewed screenplay remains intact; these are consecutive production cuts.
// visualContinuity:false is only for reproducing historical immutable plans.
export function planKlingShots(manifest, { visualContinuity = true } = {}) {
  // A prepared/paid plan is already an immutable contract. In particular, do
  // not upgrade a legacy plan or turn the cuts of one scene into new scenes.
  if (manifest.productionPlan?.provider === 'kling') {
    validateVisualContinuity(manifest);
    return manifest;
  }
  const contract = visualContinuity ? createVisualContinuity(manifest) : null;
  if (manifest.performance !== undefined) return performancePlan(manifest, contract);
  const shots = [];
  for (const [scenePosition, original] of manifest.shots.entries()) {
    const scene = contract ? { ...original, continuity: { ...original.continuity,
      sourceSceneId: contract.scenes[scenePosition].sceneId } } : original;
    if (scene.targetDurationMs < 3000) throw new Error("Each scene needs at least three seconds. Increase the film length or combine short scenes.");
    const count = Math.ceil(scene.targetDurationMs / 15000);
    if (count === 1) { shots.push({ ...scene }); continue; }
    let speaker = "";
    const blocks = [
      { kind: "narration", prefix: "", words: scene.narration.trim().split(/\s+/).filter(Boolean) },
      ...scene.dialogue.split(/\r?\n/).filter(line => line.trim()).map(line => {
        const match = line.match(/^([^:\n]{1,100}:)\s*(.*)$/);
        if (match) speaker = match[1];
        return { kind: "dialogue", prefix: speaker, words: (match?.[2] ?? line).trim().split(/\s+/).filter(Boolean) };
      }),
    ];
    const totalWords = blocks.reduce((sum, block) => sum + block.words.length, 0);
    let wordPosition = 0, elapsed = 0;
    for (let part = 0; part < count; part++) {
      const end = Math.round(scene.targetDurationMs * (part + 1) / count);
      const wordEnd = Math.round(totalWords * (part + 1) / count);
      let offset = 0;
      const narration = [], dialogue = [];
      for (const block of blocks) {
        const from = Math.max(0, wordPosition - offset), to = Math.min(block.words.length, wordEnd - offset);
        if (to > from) {
          const words = block.words.slice(from, to).join(" ");
          (block.kind === "narration" ? narration : dialogue).push(block.prefix ? `${block.prefix} ${words}` : words);
        }
        offset += block.words.length;
      }
      shots.push({ ...scene, startMs: scene.startMs + elapsed, targetDurationMs: end - elapsed,
        narration: narration.join(" "), dialogue: dialogue.join("\n"), scenePart: part + 1, sceneParts: count });
      elapsed = end; wordPosition = wordEnd;
    }
  }
  // A 600-second film can contain at most 200 three-second cuts.
  if (shots.length > 200) throw new Error("This film has too many production cuts.");
  return { ...manifest, ...(contract ? { visualContinuity: contract } : {}),
    productionPlan: { provider: "kling", version: 1, ...(contract ? { visualContinuityVersion: 1 } : {}) },
    shots: shots.map((shot, index) => ({ ...shot, id: `shot-${String(index + 1).padStart(3, "0")}`,
      continuity: { ...shot.continuity, precedingShotId: index ? `shot-${String(index).padStart(3, "0")}` : null } })) };
}
