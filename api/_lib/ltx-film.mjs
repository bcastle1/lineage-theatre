import voices from "../../shared/ltx-voices.json" with { type: "json" };
const voiceIds = new Set(voices.map(voice => voice.id));
const validSpeed = speed => typeof speed === "number" && Number.isFinite(speed) && speed >= 0.8 && speed <= 1.2;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const imageTypes = ["image/jpeg", "image/png", "image/webp"];
export const audioTypes = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg"];

export function ltxFilmInput(input, fail) {
  const text = (value, limit, label, required = false) => {
    if (typeof value !== "string" || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || required && !value.trim()) fail(`Check ${label}.`);
    return value.trim();
  };
  if (!UUID.test(input.filmId || "") || !UUID.test(input.requestId || "") || input.consent !== true) fail("Confirm local film rendering and choose a saved film.");
  if (!Array.isArray(input.characters) || input.characters.length > 30 || !Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 30) fail("Use 1–30 scenes and up to 30 characters.");
  if (!voiceIds.has(input.voice)) fail("Choose an available narrator.");
  if (input.speed !== undefined && !validSpeed(input.speed)) fail("Choose a speaking pace between 0.8 and 1.2.");
  const ids = new Set();
  const characters = input.characters.map(character => {
    if (!ID.test(character?.id || "") || ids.has(character.id)) fail("Each character needs a unique reference.");
    ids.add(character.id);
    if (character.photoId && !UUID.test(character.photoId)) fail("Choose a saved character photo.");
    return { id: character.id, name: text(character.name, 200, "the character name", true), description: text(character.description || "", 1000, "the character description"),
      ...(character.photoId ? { photoId: character.photoId } : {}) };
  });
  const sceneIds = new Set();
  const scenes = input.scenes.map(scene => {
    if (!ID.test(scene?.id || "") || sceneIds.has(scene.id)) fail("Each scene needs a unique reference.");
    sceneIds.add(scene.id);
    if (!Number.isInteger(scene.duration) || scene.duration < 2 || scene.duration > 60) fail("Choose 2–60 seconds per scene.");
    if (!Array.isArray(scene.characterIds) || scene.characterIds.length > 30 || new Set(scene.characterIds).size !== scene.characterIds.length || scene.characterIds.some(id => !ids.has(id))) fail("Choose characters from this film's cast.");
    const reference = scene.referenceCharacterId ? characters.find(character => character.id === scene.referenceCharacterId) : null;
    if (scene.referenceCharacterId && (!reference?.photoId || !scene.characterIds.includes(reference.id))) fail("The scene's reference character needs a photo and must be in its cast.");
    if (!["tts", "recording", "silent"].includes(scene.audioMode)) fail("Choose narration, a recording, or silence for each scene.");
    if (scene.voice !== undefined && !voiceIds.has(scene.voice)) fail("Choose an available scene narrator.");
    if (scene.audioMode === "recording" && !UUID.test(scene.audioId || "")) fail("Choose an uploaded recording for the scene.");
    const narration = text(scene.narration || "", 1200, "the scene narration", scene.audioMode === "tts");
    if (characters.filter(character => scene.characterIds.includes(character.id)).reduce((n, character) => n + character.name.length + character.description.length, 0) > 8000)
      fail("Shorten the cast descriptions for this scene to 8,000 characters.");
    return { id: scene.id, title: text(scene.title, 200, "the scene title", true), visual: text(scene.visual, 1800, "the scene direction", true),
      narration, duration: scene.duration, characterIds: [...scene.characterIds], audioMode: scene.audioMode,
      ...(scene.audioMode === "tts" && scene.voice ? { voice: scene.voice } : {}),
      ...(scene.audioMode === "recording" ? { audioId: scene.audioId } : {}),
      ...(reference ? { referenceCharacterId: reference.id, photoId: reference.photoId } : {}) };
  });
  const photoIds = new Set(scenes.map(scene => scene.photoId).filter(Boolean));
  if (scenes.some(scene => scene.audioId && photoIds.has(scene.audioId))) fail("Use separate image and audio sources.");
  const duration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (duration > 600 || scenes.reduce((sum, scene) => sum + scene.narration.length, 0) > 12000) fail("Keep the film within 10 minutes and 12,000 narration characters. Longer recordings may require shorter scenes.");
  return { mode: "film", filmId: input.filmId, title: text(input.title, 200, "the film title", true),
    era: text(input.era || "", 500, "the setting"), style: text(input.style || "Cinematic", 100, "the visual style"), voice: input.voice,
    ...(input.speed !== undefined ? { speed: input.speed } : {}), duration, characters, scenes };
}

export function filmSources(plan) {
  return [...new Map(plan.scenes.flatMap(scene => [
    ...(scene.photoId ? [[scene.photoId, "image"]] : []), ...(scene.audioId ? [[scene.audioId, "audio"]] : []),
  ])).entries()];
}

export function checkedTimeline(report, job, fail) {
  if (!Array.isArray(report.timeline) || report.timeline.length !== job.scenes.length) fail("The film's scene report is incomplete.", 409);
  let end = 0;
  const timeline = report.timeline.map((item, i) => {
    const scene = job.scenes[i];
    const voice = scene.voice || job.voice, speed = job.speed ?? 1;
    if (scene.audioMode === "tts" && (item?.voice !== undefined || scene.voice || job.speed !== undefined || !["david", "zira"].includes(voice))
      && (item?.voice !== voice || item?.speed !== speed)) fail("The rendered narration does not match the approved voice and pace.", 409);
    if (item?.id !== scene.id || !Number.isFinite(item.start) || Math.abs(item.start - end) > 0.08
      || !Number.isFinite(item.duration) || item.duration < scene.duration - 0.08 || item.duration > 60.1
      || !Number.isInteger(item.shots) || item.shots < 1 || item.shots > 12
      || item.referenceApplied !== Boolean(scene.photoId) || item.audioMode !== scene.audioMode)
      fail("The rendered scenes do not match the approved film plan.", 409);
    end = item.start + item.duration;
    return { id: scene.id, title: scene.title, start: item.start, duration: item.duration, shots: item.shots,
      referenceApplied: item.referenceApplied, audioMode: scene.audioMode,
      ...(scene.audioMode === "tts" ? { voice, speed } : {}) };
  });
  if (Math.abs(end - report.durationSeconds) > 0.15) fail("The film's runtime does not match its scenes.", 409);
  return timeline;
}
