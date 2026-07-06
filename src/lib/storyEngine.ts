import type {
  AdminSettings,
  CharacterSuggestion,
  MovieProject,
  RuntimeId,
  StoryRecommendation,
  StoryScene,
} from "../types";
import { createId, nowIso, runtimeOptions } from "./runtime";

function pick(value: string, fallback: string) {
  return value.trim() || fallback;
}

function sourceSummary(project: MovieProject) {
  const counts = project.sources.reduce<Record<string, number>>((acc, source) => {
    acc[source.kind] = (acc[source.kind] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([kind, count]) => `${count} ${kind}${count > 1 ? "s" : ""}`)
    .join(", ");
}

function runtimeArc(runtime: RuntimeId) {
  if (runtime === "trailer") return ["Origins", "Trial", "Legacy"];
  if (runtime === "short") return ["Origins", "Departure", "Trial", "Turning Point", "Legacy"];
  if (runtime === "featurette") {
    return ["Origins", "Family Bonds", "Departure", "Trial", "Turning Point", "Homecoming", "Legacy"];
  }
  return [
    "Origins",
    "Childhood Light",
    "First Calling",
    "Departure",
    "Trial",
    "Hidden Sacrifice",
    "Turning Point",
    "Homecoming",
    "Legacy",
  ];
}

export function buildStoryRecommendation(project: MovieProject): StoryRecommendation {
  const ancestor = project.ancestor;
  const name = pick(ancestor.name, "the ancestor");
  const homeland = pick(ancestor.homeland, pick(ancestor.birthPlace, "the old home"));
  const values = pick(ancestor.values, "courage, family, faith, and resilience");
  const sourceLine = sourceSummary(project) || "the uploaded family records";
  const style =
    project.preferences.style === "Documentary"
      ? "guided by interviews, archival narration, maps, and verified dates"
      : "told as a cinematic family film with intimate scenes and a heroic emotional arc";

  const scenes: StoryScene[] = runtimeArc(project.preferences.runtime).map((title, index) => ({
    id: createId("scene"),
    title,
    timecode: `${String(Math.floor(index * 2.5)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}`,
    purpose:
      title === "Turning Point"
        ? `Reveal the brave decision that makes ${name}'s legacy feel earned.`
        : `Connect ${title.toLowerCase()} to the family evidence and emotional truth.`,
    visual:
      title === "Legacy"
        ? "Intercut ancestor-era scenes with present-day descendants discovering the meaning of the story."
        : `Use period-accurate settings, maps, portraits, and source-inspired moments from ${homeland}.`,
    music:
      title === "Turning Point"
        ? "Turning Point"
        : title === "Legacy"
          ? "Legacy"
          : index < 2
            ? "Heritage Theme"
            : "Quiet Courage",
  }));

  const characters: CharacterSuggestion[] = [
    {
      id: createId("character"),
      name,
      role: "Ancestor hero",
      traits: pick(ancestor.definingTraits, "resilient, warm, capable, honorable"),
      appearance: `Best-light portrayal: ${pick(
        [ancestor.height, ancestor.build].filter(Boolean).join(", "),
        "healthy, strong, dignified, historically believable"
      )}. Final look should be adjusted from uploaded photos when available.`,
      approved: true,
    },
    {
      id: createId("character"),
      name: "Family witness",
      role: "Composite supporting character",
      traits: "Empathetic viewpoint character who helps younger viewers understand the stakes.",
      appearance: "Period-correct clothing and age chosen from uploaded family context.",
      approved: false,
    },
  ];

  return {
    logline: `${name} rises from ${homeland} with ${values}, leaving descendants a story of courage they can finally see.`,
    plot: `Built from ${sourceLine}, this ${project.preferences.rating}-rated ${project.preferences.style.toLowerCase()} film is ${style}. It starts with roots, deepens through conflict, and closes by showing why ${name}'s choices still matter.`,
    climax: `The recommended climax is a family-safe moment of decisive sacrifice: ${name} chooses duty and hope when the future of the family is uncertain.`,
    emotionalPromise:
      "The movie honors the ancestor without pretending every dramatized detail is verified. It should feel moving, credible, and worthy of a family screening.",
    scenes,
    characters,
    musicDirection:
      "Create an original orchestral score with warm strings, piano, restrained brass, and percussion. It should feel cinematic and emotionally sweeping without copying any living composer's identifiable style.",
    contentNotes: [
      "Mark invented scene connective tissue as dramatized.",
      "Keep violence, romance, and language within G/PG boundaries.",
      "Use uploaded records to resolve dates, clothing, accents, and geography before rendering.",
    ],
    generatedAt: nowIso(),
  };
}

export function estimateProjectFee(project: MovieProject, settings: AdminSettings) {
  if (!settings.chargeFees) return 0;
  return settings.pricing[project.preferences.runtime];
}

export function runtimeLabel(runtime: RuntimeId) {
  return runtimeOptions.find((option) => option.id === runtime)?.label ?? runtime;
}

export function statusCopy(status: MovieProject["status"]) {
  const map: Record<MovieProject["status"], string> = {
    draft: "Draft",
    "trailer-ready": "Trailer ready",
    "payment-pending": "Payment pending",
    submitted: "Submitted",
    "in-review": "In review",
    "changes-requested": "Changes requested",
    approved: "Approved",
    "full-movie-ready": "Full movie ready",
    published: "Published",
  };
  return map[status];
}
