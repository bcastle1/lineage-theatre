export const KLING_CHARACTER_BINDING_VERSION = 1;

export class KlingCharacterBindingError extends Error {
  constructor() {
    super('This film has an unsupported character binding plan. Prepare a new plan before production.');
    this.code = 'FILM_CHARACTER_BINDING_INVALID'; this.status = 422;
  }
}
const requireValue = value => { if (!value) throw new KlingCharacterBindingError(); };

// Absence is the historical @Image recipe. Never upgrade a saved manifest.
export function hasKlingCharacterBinding(manifest) {
  const plan = manifest?.productionPlan, version = plan?.characterBindingVersion;
  if (version === undefined) return false;
  requireValue(version === KLING_CHARACTER_BINDING_VERSION && plan.provider === 'kling' && plan.version === 1
    && plan.visualContinuityVersion === 1 && manifest.visualContinuity?.version === 1);
  return true;
}

// One ordering supplies both the @Element names and their corresponding images.
// A scene can include offscreen speakers; binding does not invent their actions.
export function klingCharacterBindings(shot, characters) {
  requireValue(Array.isArray(shot?.characterIds) && shot.characterIds.length <= 4
    && new Set(shot.characterIds).size === shot.characterIds.length && Array.isArray(characters));
  return shot.characterIds.map((id, index) => {
    const matches = characters.filter(character => character.id === id);
    requireValue(matches.length === 1 && typeof matches[0].name === 'string' && typeof matches[0].description === 'string');
    return { character: matches[0], token: `@Element${index + 1}` };
  });
}

export const KLING_CAST_BINDING_DIRECTION = 'Each element is one distinct cast identity. Never swap, merge or clone identities, faces or outfits between elements. Keep each named character bound to that element throughout this cut. Follow the scripted presence and actions; offscreen characters may remain offscreen.';

// Shared by initial rendering and the separately authorized failed-shot repair.
// An empty cast has no reference field; historical images retain their order.
export async function normalizeKlingInputReferences(manifest, input, normalize) {
  if (!hasKlingCharacterBinding(manifest)) return { ...input, image_urls: await Promise.all(input.image_urls.map(normalize)) };
  if (!input.elements) return input;
  return { ...input, elements: await Promise.all(input.elements.map(async element => ({
    reference_image_urls: await Promise.all(element.reference_image_urls.map(normalize)),
  }))) };
}
