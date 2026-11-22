import { createVisualContinuity, validateVisualContinuity } from './film-visual-continuity.mjs';
import { hasKlingCharacterBinding, KLING_CHARACTER_BINDING_VERSION, KlingCharacterBindingError } from './kling-character-binding.mjs';

// Plan new films before pricing/payment. Never rewrite an already-paid manifest.
// The reviewed screenplay remains intact; these are consecutive production cuts.
// visualContinuity:false is only for reproducing historical immutable plans.
export function planKlingShots(manifest, { visualContinuity = true, characterBinding = visualContinuity,
  characterBindingVersion = KLING_CHARACTER_BINDING_VERSION } = {}) {
  return planShots(manifest, 'kling', { visualContinuity, characterBinding, characterBindingVersion });
}

export function planSeedanceShots(manifest) {
  return planShots(manifest, 'seedance', { visualContinuity: true, characterBinding: false });
}

function planShots(manifest, provider, { visualContinuity, characterBinding, characterBindingVersion }) {
  if (typeof visualContinuity !== 'boolean' || typeof characterBinding !== 'boolean') throw new KlingCharacterBindingError();
  // A prepared/paid plan is already an immutable contract. In particular, do
  // not upgrade a legacy plan or turn the cuts of one scene into new scenes.
  if (manifest.productionPlan) {
    if (manifest.productionPlan.provider !== provider || manifest.productionPlan.version !== 1
      || (provider === 'seedance' && (manifest.productionPlan.visualContinuityVersion !== 1 || manifest.productionPlan.characterBindingVersion !== undefined)))
      throw new Error('The saved production plan belongs to a different film recipe.');
    validateVisualContinuity(manifest);
    hasKlingCharacterBinding(manifest);
    return manifest;
  }
  if (characterBinding && !visualContinuity) throw new KlingCharacterBindingError();
  if (characterBinding && ![1, 2, KLING_CHARACTER_BINDING_VERSION].includes(characterBindingVersion)) throw new KlingCharacterBindingError();
  const contract = visualContinuity ? createVisualContinuity(manifest, provider) : null;
  const shots = [];
  for (const [scenePosition, original] of manifest.shots.entries()) {
    const scene = contract ? { ...original, continuity: { ...original.continuity,
      sourceSceneId: contract.scenes[scenePosition].sceneId } } : original;
    if (provider === 'kling' && scene.targetDurationMs < 3000) throw new Error("Each scene needs at least three seconds. Increase the film length or combine short scenes.");
    // Seedance renders at least four seconds. The paid plan bills that minimum
    // and the final assembly trims the edit handle to the screenplay timeline.
    if (provider === 'seedance' && scene.targetDurationMs < 1000) throw new Error("Each scene needs at least one second. Increase the film length or combine short scenes.");
    const count = Math.ceil(scene.targetDurationMs / (provider === 'seedance' ? 30000 : 15000));
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
  // Keep the existing production service's maximum number of cuts.
  if (shots.length > 200) throw new Error("This film has too many production cuts.");
  return { ...manifest, ...(contract ? { visualContinuity: contract } : {}),
    ...(provider === 'seedance' ? { sound: { ...manifest.sound, narration: 'provider-native-audio', dialogue: 'provider-native-audio' } } : {}),
    productionPlan: { provider, version: 1, ...(contract ? { visualContinuityVersion: 1 } : {}),
      ...(characterBinding ? { characterBindingVersion } : {}) },
    shots: shots.map((shot, index) => ({ ...shot, id: `shot-${String(index + 1).padStart(3, "0")}`,
      continuity: { ...shot.continuity, precedingShotId: index ? `shot-${String(index).padStart(3, "0")}` : null } })) };
}
