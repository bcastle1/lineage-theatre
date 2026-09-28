import type { Film } from "./model";
export type LtxScene = { id: string; title: string; visual: string; narration: string; duration: number; characterIds: string[];
  referenceCharacterId?: string; photoId?: string; audioMode: "tts" | "recording" | "silent"; audioId?: string };
export type LtxCharacter = { id: string; name: string; description: string; photoId?: string };
export type LtxDraft = { voice?: "david" | "zira"; photos?: Record<string, string>; scenes?: Record<string, Partial<LtxScene>>; order?: string[] };
export type LtxPlan = { characters: LtxCharacter[]; scenes: LtxScene[]; voice: "david" | "zira"; era: string; style: string };
export type LtxJob = { id: string; filmId: string; mode?: string; title: string; status: string; progress: number; message?: string; mediaUrl?: string;
  mediaSha256?: string; durationSeconds?: number; createdAt: string; plan: LtxPlan;
  review?: { decision: string; notes: string; at: string; checks: Record<string, boolean> } | null;
  timeline: { id: string; title: string; start: number; duration: number; shots: number; referenceApplied: boolean; audioMode: string }[] };
export const ltxEndpoint = "/api/studio?local=ltx";
export const ltxStatus = (job: LtxJob) => ({ queued: "Queued", rendering: `Rendering · ${job.progress}%`, review: "Needs review", completed: "Approved", changes_requested: "Changes requested", failed: "Render failed" }[job.status] || job.status);

export function filmPlan(film: Film): LtxPlan {
  const draft = film.ltxFilmDraft || {};
  const characters = film.characters.map(({ id, name, description }) => ({ id, name, description, ...(draft.photos?.[id] ? { photoId: draft.photos[id] } : {}) }));
  const known = new Set(characters.map(character => character.id));
  const order = [...new Set([...(draft.order || []), ...film.scenes.map(scene => scene.id)])];
  const scenes = order.flatMap(id => {
    const scene = film.scenes.find(item => item.id === id);
    if (!scene) return [];
    const edits = draft.scenes?.[id] || {};
    const narration = edits.narration ?? [scene.narration, scene.dialogue].filter(Boolean).join("\n");
    const candidate = edits.referenceCharacterId ?? characters.find(character => scene.characterIds.includes(character.id) && character.photoId)?.id;
    const primary = characters.some(character => character.id === candidate && character.photoId) ? candidate : undefined;
    return [{ id, title: scene.title, visual: edits.visual ?? scene.visual, narration,
      duration: edits.duration ?? Math.max(2, Math.min(60, Math.round(film.duration / Math.max(1, film.scenes.length)))),
      characterIds: [...new Set([...scene.characterIds.filter(key => known.has(key)), ...(primary ? [primary] : [])])],
      referenceCharacterId: primary || undefined, audioMode: edits.audioMode ?? (narration.trim() ? "tts" : "silent"), audioId: edits.audioId } as LtxScene];
  });
  return { characters, scenes, voice: draft.voice || "zira", era: film.era, style: film.style };
}
