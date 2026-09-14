export interface User {
  email: string;
  name: string;
  mustChangePassword: boolean;
}
export interface Source {
  id: string;
  name: string;
  type: string;
  size: number;
  text?: string;
  note?: string;
  extraction?: string;
}
export interface Theme {
  id: string;
  title: string;
  plot: string;
  climax: string;
  reason: string;
}
export interface Shot {
  id: string;
  provider: string;
  status: "submitting" | "queued" | "processing" | "completed" | "failed" | "uncertain";
  videoUrl?: string;
  message?: string;
}
export interface Scene {
  id: string;
  title: string;
  narration: string;
  visual: string;
  sourceIds: string[];
  characterIds: string[];
  dialogue: string;
  dramatization: string;
  shot?: Shot;
}
export interface Character {
  id: string;
  name: string;
  role: string;
  description: string;
  basis: "documented" | "inferred" | "invented";
  sourceIds: string[];
}
export interface Assumption {
  id: string;
  description: string;
  reason: string;
}
export interface SourceCoverage {
  totalSources: number;
  readSources: number;
  textCharacters: number;
  photoSources: number;
  photosRead: number;
  notesOnlySources: number;
  warnings: string[];
}
export interface Film {
  id: string;
  title: string;
  ancestor: string;
  script: string;
  era: string;
  style: "Documentary" | "Cinematic";
  duration: number;
  runtime?: string;
  providerId: string;
  sources: Source[];
  themes: Theme[];
  selectedThemes: Theme[];
  scenes: Scene[];
  characters: Character[];
  assumptions: Assumption[];
  factuality: "based-on-a-true-story" | "documentary";
  quality: "highest";
  sourceCoverage?: SourceCoverage;
  job?: Shot;
  logline: string;
  generatedBy?: string;
  updatedAt: string;
  archivedAt?: string | null;
  outputId?: string;
  outputType?: string;
  outputAt?: string;
  audioId?: string;
  music: boolean;
}
export const newFilm = (): Film => ({
  id: crypto.randomUUID(),
  title: "",
  ancestor: "",
  script: "",
  era: "",
  style: "Cinematic",
  duration: 120,
  providerId: "magiclight",
  sources: [],
  themes: [],
  selectedThemes: [],
  scenes: [],
  characters: [],
  assumptions: [],
  factuality: "based-on-a-true-story",
  quality: "highest",
  logline: "",
  updatedAt: new Date().toISOString(),
  music: true,
});
export function normalizeFilm(raw: Partial<Film>): Film {
  const duration =
    raw.duration ??
    { trailer: 60, short: 300, featurette: 600, feature: 600 }[raw.runtime || ""] ??
    120;
  return {
    ...newFilm(),
    ...raw,
    duration,
    style: raw.style || "Cinematic",
    providerId: "magiclight",
    quality: "highest",
    factuality:
      raw.factuality ||
      (raw.style === "Documentary" ? "documentary" : "based-on-a-true-story"),
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    themes: Array.isArray(raw.themes) ? raw.themes : [],
    selectedThemes: Array.isArray(raw.selectedThemes) ? raw.selectedThemes : [],
    characters: Array.isArray(raw.characters) ? raw.characters : [],
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions : [],
    scenes: Array.isArray(raw.scenes)
      ? raw.scenes.map((scene) => ({
          ...scene,
          sourceIds: scene.sourceIds || [],
          characterIds: scene.characterIds || [],
          dialogue: scene.dialogue || "",
          dramatization: scene.dramatization || "",
        }))
      : [],
  };
}
export const steps = [
  "Add your story",
  "Develop the film",
  "Review script & cast",
  "Create & watch",
];
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const payload = await res.json().catch(() => ({
    message: "The service returned an unreadable response. Please try again.",
  }));
  if (!res.ok) throw new Error(payload.message || "The action could not be completed.");
  return payload as T;
}
export function editorialThemes(film: Film, page = 0): Theme[] {
  const topics = [
    [
      "Across the water",
      "Follow a documented journey away from home.",
      "The first moment of belonging in a new place.",
    ],
    [
      "The promise we kept",
      "Trace a promise through the family memories that preserve it.",
      "The moment a later generation understands that promise.",
    ],
    [
      "A place called home",
      "Let homes and landscapes carry the family story.",
      "A return to the place that holds the strongest memory.",
    ],
    [
      "Ordinary days, extraordinary lives",
      "Build an intimate portrait from everyday work and relationships.",
      "A small act whose meaning grows across generations.",
    ],
    [
      "The letter that survived",
      "Use a surviving document as the thread through a life.",
      "Reading its meaning anew in the present day.",
    ],
    [
      "Against the current",
      "Explore a documented obstacle and the choices made in response.",
      "The turning point supported by the family record.",
    ],
    [
      "What the photographs remember",
      "Move chronologically through the faces and places in the archive.",
      "The photograph that connects past and present.",
    ],
    [
      "A legacy of service",
      "Follow the ways one life contributed to family or community.",
      "A witness or descendant reflects on what endured.",
    ],
    [
      "Two worlds, one family",
      "Explore the meeting of cultures, places, or generations.",
      "A shared tradition brings those worlds together.",
    ],
    [
      "The roots beneath us",
      "Trace how a family value appears across generations.",
      "The present-day choice that carries that value forward.",
    ],
    [
      "The unfinished chapter",
      "Frame gaps in the archive as questions to investigate.",
      "A newly understood source brings the story into focus.",
    ],
    [
      "The hands that built a life",
      "Tell the story through work, craft, and the objects left behind.",
      "An heirloom reveals the care invested in a family.",
    ],
    [
      "Songs of home",
      "Follow music, language, and traditions kept alive in family memory.",
      "A familiar tradition is passed to a new generation.",
    ],
    [
      "The road back",
      "Revisit meaningful places through records and recollections.",
      "A reunion with the family’s origins.",
    ],
    [
      "Through a child’s eyes",
      "Use a descendant’s questions to introduce the archive.",
      "A younger family member finds a personal connection.",
    ],
    [
      "The women who carried us",
      "Explore the documented contributions of women in the family.",
      "Their influence becomes visible across the generations.",
    ],
    [
      "An atlas of belonging",
      "Structure the story around verified places and movements.",
      "Separate places come together as one family history.",
    ],
    [
      "The quiet turning point",
      "Focus on one documented decision and its consequences.",
      "The audience sees how that choice shaped later lives.",
    ],
    [
      "Names worth remembering",
      "Restore personal context to the names in a family tree.",
      "A name becomes a person the audience feels they know.",
    ],
    [
      "An inheritance of hope",
      "Connect evidence of endurance with present family memories.",
      "A descendant describes what they hope to carry forward.",
    ],
  ];
  return topics
    .slice((page % 2) * 10, (page % 2) * 10 + 10)
    .map(([title, plot, climax], i) => ({
      id: `editorial-${page}-${i}`,
      title,
      plot,
      climax,
      reason: `An editorial direction to explore for ${film.ancestor || "your family"}; confirm that the sources support it.`,
    }));
}
export function editorialPlan(film: Film): Scene[] {
  const evidence = [film.script, ...film.sources.map((s) => s.text || s.note || "")]
    .join("\n\n")
    .trim();
  const sentences = evidence
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((x) => x.trim())
    .filter(Boolean) || [evidence];
  const count = Math.min(6, Math.max(3, Math.ceil(film.duration / 20)));
  const group = Math.max(1, Math.ceil(sentences.length / count));
  const names = [
    "The world before",
    "A life takes shape",
    "The turning point",
    "What endured",
    "Across generations",
    "The legacy today",
  ];
  return Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    title: names[Math.round((i * 5) / (count - 1))],
    narration: sentences.slice(i * group, (i + 1) * group).join(" "),
    characterIds: [],
    dialogue: "",
    dramatization:
      film.factuality === "documentary"
        ? ""
        : "Reconstruction to review; no additional facts have been established.",
    visual:
      film.style === "Documentary"
        ? "A slow, restrained move across the original family photograph. Preserve the photograph and its context."
        : `A respectful, photorealistic reenactment inspired by the supplied family material. Natural light, subtle camera movement. Period: ${film.era || "use only confirmed period details"}.`,
    sourceIds: film.sources[i % Math.max(1, film.sources.length)]
      ? [film.sources[i % film.sources.length].id]
      : [],
  }));
}
export function productionBrief(f: Film) {
  const sourceName = (id: string) =>
    id === "@family-narrative"
      ? "Family narrative"
      : f.sources.find((s) => s.id === id)?.name || id;
  return `LINEAGE THEATRE — PRODUCTION BRIEF\n${f.title}\nAncestor: ${f.ancestor}\nPeriod: ${f.era || "Not specified"}\nStyle: ${f.style}\nDuration: ${f.duration} seconds\nProduction: MagicLight within Lineage Theatre\nQuality preference: highest available animation and final film quality; subject to verified account availability\nTreatment: ${f.factuality === "documentary" ? "Documentary; verified evidence only" : "Based on a true story; some scenes and dialogue are dramatized"}\n\n${f.logline}\n\nThemes:\n${f.selectedThemes.map((t) => `${t.title}\nPlot: ${t.plot}\nClimax: ${t.climax}`).join("\n\n")}\n\nCast:\n${f.characters.map((c) => `${c.name} — ${c.role} [${c.basis}]\n${c.description}\nSources: ${c.sourceIds.map(sourceName).join(", ")}`).join("\n\n")}\n\nAssumptions for review:\n${f.assumptions.map((a) => `${a.description}\nReason: ${a.reason}`).join("\n\n")}\n\nScenes:\n${f.scenes.map((s, i) => `${i + 1}. ${s.title}\nNarration: ${s.narration}\nDialogue: ${s.dialogue}\nVisual: ${s.visual}\nCast: ${s.characterIds.map((id) => f.characters.find((c) => c.id === id)?.name || id).join(", ")}\nDramatization: ${s.dramatization || "None identified; review required"}\nSources: ${s.sourceIds.map(sourceName).join(", ")}`).join("\n\n")}\n\nFamily evidence:\n${f.script}\n${f.sources.map((s) => `${s.name}: ${s.text || s.note || "Attached source file; add context if its content has not been read."}`).join("\n")}\n\nCelebrate the ancestor with warmth and dignity. Preserve documented facts and distinguish inference and invention. Dramatic dialogue is not a verified quotation. Review the full ensemble and source coverage before production.`;
}
export const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
