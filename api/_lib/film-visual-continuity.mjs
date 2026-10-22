// A production contract, saved before the manifest is priced or paid. It is
// derived only from the approved script and explicit reference selection; it
// never analyzes a photograph or invents demographic/biographical facts.
export const VISUAL_CONTINUITY_VERSION = 1;
export const VISUAL_CONTINUITY_POLICY = 'reference-appearance-scripted-wardrobe-v1';

export class VisualContinuityPlanError extends Error {
  constructor() {
    super('The saved appearance and wardrobe plan does not match this screenplay. Prepare the film again before requesting a price.');
    this.code = 'FILM_CONTINUITY_PLAN_INVALID'; this.status = 422;
  }
}
const requireValue = value => { if (!value) throw new VisualContinuityPlanError(); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const referenceFor = character => character.referencePhotoId === undefined
  ? { kind: 'generated-character', characterId: character.id }
  : { kind: 'selected-photo', sourceId: character.referencePhotoId };

export function createVisualContinuity(manifest) {
  const used = new Set(manifest.shots.flatMap(shot => shot.characterIds));
  return {
    version: VISUAL_CONTINUITY_VERSION,
    policy: VISUAL_CONTINUITY_POLICY,
    characters: manifest.screenplay.characters.filter(character => used.has(character.id)).map(character => ({
      characterId: character.id, appearance: character.description, reference: referenceFor(character),
    })),
    scenes: manifest.shots.map((shot, index) => ({
      sceneId: `scene-${String(index + 1).padStart(3, '0')}`, sceneIndex: shot.sceneIndex,
      era: manifest.era, direction: shot.visual, characterIds: [...shot.characterIds],
      wardrobeRule: 'script-overrides-reference',
    })),
  };
}

// Legacy paid manifests have no continuity contract and retain their original
// generation recipe. A partial new contract must never silently fall back.
export function validateVisualContinuity(manifest) {
  const contract = manifest.visualContinuity;
  if (contract === undefined) {
    requireValue(manifest.productionPlan?.visualContinuityVersion === undefined
      && !manifest.shots.some(shot => shot.continuity?.sourceSceneId !== undefined));
    return null;
  }
  requireValue(contract?.version === VISUAL_CONTINUITY_VERSION && contract.policy === VISUAL_CONTINUITY_POLICY
    && manifest.productionPlan?.visualContinuityVersion === VISUAL_CONTINUITY_VERSION
    && Array.isArray(contract.characters) && Array.isArray(contract.scenes));
  const used = new Set(manifest.shots.flatMap(shot => shot.characterIds));
  const expectedCharacters = manifest.screenplay.characters.filter(character => used.has(character.id)).map(character => ({
    characterId: character.id, appearance: character.description, reference: referenceFor(character),
  }));
  requireValue(same(contract.characters, expectedCharacters));
  const scenes = new Map();
  for (const scene of contract.scenes) {
    requireValue(scene && typeof scene.sceneId === 'string' && !scenes.has(scene.sceneId)
      && Number.isSafeInteger(scene.sceneIndex) && scene.sceneIndex >= 0
      && scene.era === manifest.era && typeof scene.direction === 'string'
      && Array.isArray(scene.characterIds) && scene.wardrobeRule === 'script-overrides-reference');
    scenes.set(scene.sceneId, scene);
  }
  const usedScenes = new Set();
  for (const shot of manifest.shots) {
    const scene = scenes.get(shot.continuity?.sourceSceneId);
    requireValue(scene && scene.sceneIndex === shot.sceneIndex && scene.direction === shot.visual
      && same(scene.characterIds, shot.characterIds));
    usedScenes.add(scene.sceneId);
  }
  requireValue(scenes.size === usedScenes.size);
  return contract;
}

// This rule is mandatory in every prompt form. A reference supplies the same
// visible person AND clothes, except for changes the approved scene describes.
// A scene may change period/age/costume; a production cut within it may not.
export const VISUAL_CONTINUITY_DIRECTION = 'Match each reference person\'s visible face, hair and clothing; never infer ethnicity or biography. Scripted age/wardrobe changes override only named details; keep all other garments, colors, patterns, layers and accessories identical. Every cut of this scene uses this same outfit. No unrequested tie, jacket or costume changes. Begin in the scene; never show references or duplicate people.';
