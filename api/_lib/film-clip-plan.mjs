import { createHash } from "node:crypto";

export const MAX_FILM_CLIPS = 600;
export const MAX_FILM_DURATION_MS = 600_000;
const MAX_SCREENPLAY_BYTES = 1_500_000;
const HASH = /^[a-f0-9]{64}$/;
const isHash = value => typeof value === "string" && HASH.test(value);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCENE_FIELDS = ["title", "narration", "visual", "sourceIds", "characterIds", "dialogue", "dramatization"];
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const string = (value, maximum) => typeof value === "string" && value.length <= maximum;
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class FilmClipPlanError extends Error {
  constructor(code) {
    super("The film clip plan could not be verified.");
    this.name = "FilmClipPlanError";
    this.code = code;
  }
}
const fail = code => { throw new FilmClipPlanError(code); };
const invalidManifest = () => fail("INVALID_CLIP_PLAN_MANIFEST");

function validateManifest(manifest, manifestHash) {
  if (!isHash(manifestHash) || !exact(manifest, ["version", "filmId", "title", "ancestor", "era", "style", "factuality",
    "targetDurationSeconds", "qualityPreference", "qualityVerified", "screenplay", "shots", "sources", "narrativeEvidenceHash", "sound", "continuity", "review"])
    || manifest.version !== 1 || typeof manifest.filmId !== "string" || !UUID.test(manifest.filmId) || !string(manifest.title, 200) || !manifest.title.trim()
    || !string(manifest.ancestor, 100_000) || !manifest.ancestor.trim() || !string(manifest.era, 100_000)
    || !["Cinematic", "Documentary"].includes(manifest.style) || !["documentary", "based-on-a-true-story"].includes(manifest.factuality)
    || !integer(manifest.targetDurationSeconds, 15, MAX_FILM_DURATION_MS / 1000)
    || manifest.qualityPreference !== "highest" || manifest.qualityVerified !== false || !isHash(manifest.narrativeEvidenceHash)) invalidManifest();

  const screenplay = manifest.screenplay;
  if (!exact(screenplay, ["logline", "selectedThemes", "characters", "assumptions", "scenes"])) invalidManifest();
  let textBytes = 0;
  function savedText(value, maximum = MAX_SCREENPLAY_BYTES) {
    if (!string(value, maximum) || (textBytes += Buffer.byteLength(value)) > MAX_SCREENPLAY_BYTES) invalidManifest();
  }
  function savedRows(value, maximum, fields, minimum = 0) {
    if (!Array.isArray(value) || !integer(value.length, minimum, maximum)) invalidManifest();
    for (const row of value) {
      if (!exact(row, fields)) invalidManifest();
      for (const field of fields) {
        if (field.endsWith("Ids")) {
          if (!Array.isArray(row[field]) || row[field].length > (field === "sourceIds" ? 201 : 200)) invalidManifest();
          for (const id of row[field]) savedText(id, 2000);
        } else savedText(row[field]);
      }
    }
  }
  savedText(screenplay.logline);
  savedRows(screenplay.selectedThemes, 3, ["title", "plot", "climax", "reason"]);
  savedRows(screenplay.characters, 16, ["id", "name", "role", "description", "basis", "sourceIds"]);
  savedRows(screenplay.assumptions, 40, ["id", "description", "reason"]);
  savedRows(screenplay.scenes, 30, SCENE_FIELDS, 1);
  // This is the existing screenplay cap, not a smaller whole-manifest cap:
  // saved v1 manifests legitimately repeat scene and continuity information.
  if (Buffer.byteLength(JSON.stringify(screenplay)) > MAX_SCREENPLAY_BYTES) invalidManifest();
  if (!Array.isArray(manifest.shots) || manifest.shots.length !== screenplay.scenes.length) invalidManifest();
  let position = 0;
  for (const [index, shot] of manifest.shots.entries()) {
    const scene = screenplay.scenes[index], id = `shot-${String(index + 1).padStart(3, "0")}`;
    if (!exact(shot, ["id", "sceneIndex", "startMs", "targetDurationMs", ...SCENE_FIELDS, "continuity"])
      || shot.id !== id || shot.sceneIndex !== index || shot.startMs !== position
      || !integer(shot.targetDurationMs, 1, MAX_FILM_DURATION_MS)
      || SCENE_FIELDS.some(field => !equal(shot[field], scene[field]))
      || !exact(shot.continuity, ["characterIds", "referenceStatus", "precedingShotId"])
      || !equal(shot.continuity.characterIds, scene.characterIds) || shot.continuity.referenceStatus !== "requires-verification"
      || shot.continuity.precedingShotId !== (index ? manifest.shots[index - 1].id : null)) invalidManifest();
    position += shot.targetDurationMs;
    if (position > MAX_FILM_DURATION_MS) invalidManifest();
  }
  if (position !== manifest.targetDurationSeconds * 1000) invalidManifest();
  if (!Array.isArray(manifest.sources) || manifest.sources.length > 200) invalidManifest();
  const sourceIds = new Set();
  let metadataCharacters = manifest.title.length + manifest.ancestor.length + manifest.era.length;
  for (const source of manifest.sources) {
    if (!exact(source, ["id", "name", "type", "evidenceHash", "hasReadableText"])
      || ![source.id, source.name, source.type].every(value => string(value, 100_000)) || !source.id.trim() || source.id !== source.id.trim()
      || source.id === "@family-narrative" || sourceIds.has(source.id) || !isHash(source.evidenceHash)
      || typeof source.hasReadableText !== "boolean") invalidManifest();
    sourceIds.add(source.id);
    metadataCharacters += source.id.length + source.name.length + source.type.length;
    if (metadataCharacters > 100_000) invalidManifest();
  }
  if (metadataCharacters > 100_000) invalidManifest();
  if (!Array.isArray(manifest.continuity) || manifest.continuity.length !== screenplay.characters.length) invalidManifest();
  for (const [index, continuity] of manifest.continuity.entries()) {
    const character = screenplay.characters[index];
    if (!exact(continuity, ["characterId", "appearance", "sourceIds", "referenceStatus", "voiceStatus"])
      || continuity.characterId !== character.id || continuity.appearance !== character.description || !equal(continuity.sourceIds, character.sourceIds)
      || continuity.referenceStatus !== "requires-verification" || continuity.voiceStatus !== "requires-verification") invalidManifest();
  }
  if (!exact(manifest.sound, ["musicRequested", "narration", "dialogue", "captions"]) || typeof manifest.sound.musicRequested !== "boolean"
    || manifest.sound.narration !== "requires-voice-and-timing-verification" || manifest.sound.dialogue !== "requires-voice-and-timing-verification"
    || manifest.sound.captions !== "derive-from-reviewed-spoken-script"
    || !exact(manifest.review, ["screenplay", "characterReferences", "audioAndTiming", "shotDurations"])
    || ["screenplay", "characterReferences", "audioAndTiming"].some(field => manifest.review[field] !== "required")
    || manifest.review.shotDurations !== "requires-capability-verification" || hash(manifest) !== manifestHash) invalidManifest();
}

// Pure server-side preparation only. A caller must load the exact saved manifest
// and a separately verified capability policy; a hash is identity, not proof of
// provider support. This module has no default policy, pricing, storage or client.
export function buildFilmClipPlan(input) {
  if (!exact(input, ["manifest", "manifestHash", "capabilityPolicy"])) fail("INVALID_CLIP_PLAN_INPUT");
  const { manifest, manifestHash, capabilityPolicy } = input;
  if (!exact(capabilityPolicy, ["version", "evidenceHash", "maximumClipDurationMs"]) || capabilityPolicy.version !== 1
    || !isHash(capabilityPolicy.evidenceHash)
    || !integer(capabilityPolicy.maximumClipDurationMs, 1, MAX_FILM_DURATION_MS)) fail("INVALID_CLIP_CAPABILITY_POLICY");
  try { validateManifest(manifest, manifestHash); }
  catch (error) { if (error instanceof FilmClipPlanError) throw error; invalidManifest(); }
  // Normalize policy property order so equivalent server records derive the same
  // plan. The paid manifest itself is hashed exactly as originally serialized.
  const policy = { version: 1, evidenceHash: capabilityPolicy.evidenceHash, maximumClipDurationMs: capabilityPolicy.maximumClipDurationMs };
  const capabilityPolicyHash = hash(policy), maximum = policy.maximumClipDurationMs;
  const count = manifest.shots.reduce((total, shot) => total + Math.ceil(shot.targetDurationMs / maximum), 0);
  if (count > MAX_FILM_CLIPS) fail("CLIP_PLAN_LIMIT_EXCEEDED");
  const clips = [];
  for (const shot of manifest.shots) {
    const partCount = Math.ceil(shot.targetDurationMs / maximum);
    for (let partIndex = 0, sceneOffsetMs = 0; partIndex < partCount; partIndex++) {
      const targetDurationMs = Math.min(maximum, shot.targetDurationMs - sceneOffsetMs);
      const segment = { shotId: shot.id, sceneIndex: shot.sceneIndex, partIndex, partCount,
        startMs: shot.startMs + sceneOffsetMs, sceneOffsetMs, targetDurationMs };
      clips.push({ id: hash({ version: 1, manifestHash, capabilityPolicyHash, ...segment }), ...segment });
      sceneOffsetMs += targetDurationMs;
    }
  }
  const plan = { version: 1, manifestHash, capabilityPolicy: policy, capabilityPolicyHash,
    filmId: manifest.filmId, targetDurationMs: manifest.targetDurationSeconds * 1000, clips };
  return { plan, planHash: hash(plan) };
}
