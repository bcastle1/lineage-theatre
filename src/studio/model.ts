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
  status:
    | "submitting"
    | "queued"
    | "processing"
    | "completed"
    | "failed"
    | "uncertain";
  videoUrl?: string;
  message?: string;
}
export interface Scene {
  id: string;
  title: string;
  narration: string;
  visual: string;
  sourceIds: string[];
  shot?: Shot;
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
  style: "Documentary",
  duration: 60,
  providerId: "archive",
  sources: [],
  themes: [],
  selectedThemes: [],
  scenes: [],
  logline: "",
  updatedAt: new Date().toISOString(),
  music: true,
});
export function normalizeFilm(raw: Partial<Film>): Film {
  const duration =
    raw.duration ??
    { trailer: 60, short: 300, featurette: 600, feature: 600 }[
      raw.runtime || ""
    ] ??
    60;
  return {
    ...newFilm(),
    ...raw,
    duration,
    style: raw.style || "Documentary",
    providerId:
      raw.providerId === "lineage" ? "archive" : raw.providerId || "archive",
    sources: Array.isArray(raw.sources) ? raw.sources : [],
  };
}
export const steps = [
  "Family archive",
  "Story direction",
  "The cutting room",
  "Create & watch",
];
export const studios = [
  {
    id: "archive",
    name: "Archive film",
    tag: "Create here",
    description:
      "A finished film from your photographs, captions, motion, and optional narration. No generation credits.",
    detail: "1080p · 15 seconds to 10 minutes · MP4 or WebM",
    url: "",
  },
  {
    id: "runway",
    name: "Runway",
    tag: "Generate here",
    description:
      "Photorealistic reenactments and image-to-video shots, assembled with your family archive.",
    detail: "5-second shots · provider credits · 12 shots per day",
    url: "https://runwayml.com/",
  },
  {
    id: "imagineart",
    name: "ImagineArt",
    tag: "Connection required",
    description:
      "Alternative cinematic generation. Available in app when the administrator connects its API.",
    detail: "Provider credits · connection checked in this app",
    url: "https://www.imagine.art/",
  },
  {
    id: "magiclight",
    name: "MagicLight",
    tag: "External studio",
    description:
      "A complete script-to-video workflow for longer stories and consistent characters.",
    detail: "Export your brief, then create in MagicLight",
    url: "https://magiclight.ai/",
  },
  {
    id: "flow",
    name: "Google Flow",
    tag: "External studio",
    description:
      "Veo-powered filmmaking for scene exploration, atmospheric shots, and visual storytelling.",
    detail: "Export your brief, then create in Flow",
    url: "https://labs.google/fx/tools/flow",
  },
  {
    id: "heygen",
    name: "HeyGen",
    tag: "External studio",
    description:
      "Presenter-led family stories and narrated documentary segments.",
    detail: "Export your brief, then create in HeyGen",
    url: "https://www.heygen.com/",
  },
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
  const payload = await res
    .json()
    .catch(() => ({
      message: "The service returned an unreadable response. Please try again.",
    }));
  if (!res.ok)
    throw new Error(payload.message || "The action could not be completed.");
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
  const evidence = [
    film.script,
    ...film.sources.map((s) => s.text || s.note || ""),
  ]
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
  return `LINEAGE THEATRE — PRODUCTION BRIEF\n${f.title}\nAncestor: ${f.ancestor}\nPeriod: ${f.era || "Not specified"}\nStyle: ${f.style}\nDuration: ${f.duration} seconds\n\n${f.logline}\n\nThemes:\n${f.selectedThemes.map((t) => `${t.title}\nPlot: ${t.plot}\nClimax: ${t.climax}`).join("\n\n")}\n\nScenes:\n${f.scenes.map((s, i) => `${i + 1}. ${s.title}\nNarration: ${s.narration}\nVisual: ${s.visual}\nSources: ${s.sourceIds.map((id) => f.sources.find((x) => x.id === id)?.name || id).join(", ")}`).join("\n\n")}\n\nFamily evidence:\n${f.script}\n${f.sources.map((s) => `${s.name}: ${s.text || s.note || "Attached source file; transfer separately."}`).join("\n")}\n\nHonor verified facts. Identify dramatization and uncertain family lore. Do not invent quotations or relationships. Source files must be uploaded separately to an external studio.`;
}
export const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
