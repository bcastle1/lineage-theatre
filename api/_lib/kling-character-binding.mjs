export const KLING_CHARACTER_BINDING_VERSION = 3;

export class KlingCharacterBindingError extends Error {
  constructor() {
    super('This film has an unsupported character binding plan. Prepare a new plan before production.');
    this.code = 'FILM_CHARACTER_BINDING_INVALID'; this.status = 422;
  }
}
const requireValue = value => { if (!value) throw new KlingCharacterBindingError(); };

// Absence is the historical @Image recipe. Never upgrade a saved manifest.
export function klingCharacterBindingVersion(manifest) {
  const plan = manifest?.productionPlan, version = plan?.characterBindingVersion;
  if (version === undefined) return undefined;
  requireValue([1, 2, KLING_CHARACTER_BINDING_VERSION].includes(version) && plan.provider === 'kling' && plan.version === 1
    && plan.visualContinuityVersion === 1 && manifest.visualContinuity?.version === 1);
  return version;
}
export const hasKlingCharacterBinding = manifest => klingCharacterBindingVersion(manifest) !== undefined;

// Version 1 omitted the frontal image required by the provider's image-element
// contract. Keep its bytes and operation identities readable, but never spend
// on another request with that contract. Existing requests may still reconcile.
export function requireActiveKlingCharacterBinding(manifest) {
  if (klingCharacterBindingVersion(manifest) === 1) {
    const error = new Error('Film character binding is being corrected. This saved plan cannot start new provider requests.');
    error.code = 'FILM_CHARACTER_BINDING_RETIRED'; error.status = 409;
    throw error;
  }
}

export function savedKlingPlanningOptions(manifest) {
  const version = klingCharacterBindingVersion(manifest);
  return { visualContinuity: Boolean(manifest.visualContinuity), characterBinding: version !== undefined,
    ...(version === undefined ? {} : { characterBindingVersion: version }) };
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

// fal's image-element mode requires both a main view and 1-3 additional views.
// These plans use image inputs only, never the alternative video-element mode.
export function validateKlingImageElement(element) {
  requireValue(typeof element?.frontal_image_url === 'string' && element.frontal_image_url.length > 0
    && Array.isArray(element.reference_image_urls) && element.reference_image_urls.length >= 1
    && element.reference_image_urls.length <= 3
    && element.reference_image_urls.every(url => typeof url === 'string' && url.length > 0)
    && new Set([element.frontal_image_url, ...element.reference_image_urls]).size === element.reference_image_urls.length + 1);
  return element;
}

// Shared by initial rendering and the separately authorized failed-shot repair.
// An empty cast has no reference field; historical images retain their order.
export async function normalizeKlingInputReferences(manifest, input, normalize) {
  if (!hasKlingCharacterBinding(manifest)) return { ...input, image_urls: await Promise.all(input.image_urls.map(normalize)) };
  if (klingCharacterBindingVersion(manifest) === 3) {
    requireValue(typeof input.start_image_url === 'string' && input.start_image_url.length > 0);
    input = { ...input, start_image_url: await normalize(input.start_image_url) };
  }
  if (!input.elements) return input;
  if (klingCharacterBindingVersion(manifest) >= 2) return { ...input, elements: await Promise.all(input.elements.map(async element => {
    validateKlingImageElement(element);
    const [frontal, ...references] = await Promise.all([element.frontal_image_url, ...element.reference_image_urls].map(normalize));
    // Different URLs may still return identical bytes. Normalization produces
    // data URLs, so reject a duplicate image before any video submission too.
    return validateKlingImageElement({ frontal_image_url: frontal, reference_image_urls: references });
  })) };
  return { ...input, elements: await Promise.all(input.elements.map(async element => ({
    reference_image_urls: await Promise.all(element.reference_image_urls.map(normalize)),
  }))) };
}
