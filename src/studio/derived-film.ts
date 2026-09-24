import { newFilm, productionInputHash, type Film } from "./model";
import { normalizeLibraryEntry, type LibraryDetail } from "./film-library";

const MAX_SOURCE_CHARACTERS = 1_000_000;
const MAX_METADATA_CHARACTERS = 100_000;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const invalid = () => new Error("This saved screenplay could not be copied safely. Refresh its saved plan and try again; the original film is unchanged.");
function text(value: unknown, maximum = 1_500_000): string {
  if (typeof value !== "string" || value.length > maximum) throw invalid();
  return value;
}
function rows(value: unknown, maximum: number, minimum = 0): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || !value.every(object)) throw invalid();
  return value;
}
function references(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid();
  return value.map(item => text(item, 2000));
}

// This is a new browser draft, never a paid-plan migration. Only an exact saved
// manifest can supply the source; original uploads and narrative are absent.
export async function createDerivedFilmDraft(detail: LibraryDetail): Promise<Film> {
  // Take a snapshot before hashing so an asynchronous caller cannot replace it.
  const entry = normalizeLibraryEntry(detail.entry);
  if (entry.kind !== "plan" || !object(detail.manifest)) throw invalid();
  const serialized = JSON.stringify(detail.manifest);
  const manifest: Record<string, unknown> = JSON.parse(serialized);
  if (await productionInputHash(serialized) !== entry.manifestHash || manifest.version !== 1
    || manifest.filmId !== entry.filmId || !uuid(manifest.filmId) || manifest.title !== entry.title
    || manifest.targetDurationSeconds !== entry.durationSeconds || !Number.isSafeInteger(manifest.targetDurationSeconds)
    || Number(manifest.targetDurationSeconds) < 15 || Number(manifest.targetDurationSeconds) > 600
    || !["Documentary", "Cinematic"].includes(String(manifest.style))
    || !["documentary", "based-on-a-true-story"].includes(String(manifest.factuality))
    || !object(manifest.screenplay) || !object(manifest.sound) || typeof manifest.sound.musicRequested !== "boolean"
    || typeof manifest.narrativeEvidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.narrativeEvidenceHash)) throw invalid();
  const screenplay = manifest.screenplay;
  if (new TextEncoder().encode(JSON.stringify(screenplay)).byteLength > 1_500_000) throw invalid();
  const title = text(manifest.title, 200);
  const ancestor = text(manifest.ancestor);
  if (!title.trim() || !ancestor.trim()) throw invalid();
  const sourceId = crypto.randomUUID();
  const sourceRefs = (value: unknown) => references(value, 201).length ? [sourceId] : [];
  const themes = rows(screenplay.selectedThemes, 3).map(theme => ({ id: crypto.randomUUID(), title: text(theme.title),
    plot: text(theme.plot), climax: text(theme.climax), reason: text(theme.reason) }));
  const characters = rows(screenplay.characters, 16).map(character => {
    if (!["documented", "inferred", "invented"].includes(String(character.basis))) throw invalid();
    return { id: text(character.id), name: text(character.name), role: text(character.role), description: text(character.description),
      basis: character.basis as Film["characters"][number]["basis"], sourceIds: sourceRefs(character.sourceIds) };
  });
  const characterIds = new Set(characters.map(character => character.id));
  if (characterIds.size !== characters.length || characters.some(character => !character.id.trim())) throw invalid();
  const scenes = rows(screenplay.scenes, 30, 1).map(scene => {
    const refs = references(scene.characterIds, 200);
    if (refs.some(id => !characterIds.has(id))) throw invalid();
    return { id: crypto.randomUUID(), title: text(scene.title), narration: text(scene.narration), visual: text(scene.visual),
      dialogue: text(scene.dialogue), dramatization: text(scene.dramatization), sourceIds: sourceRefs(scene.sourceIds), characterIds: refs };
  });
  const assumptions = rows(screenplay.assumptions, 40).map(assumption => ({ id: crypto.randomUUID(),
    description: text(assumption.description), reason: text(assumption.reason) }));
  const originalSources = rows(manifest.sources, 200).map(source => {
    if (typeof source.evidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(source.evidenceHash) || typeof source.hasReadableText !== "boolean") throw invalid();
    return { id: text(source.id), name: text(source.name), type: text(source.type), evidenceHash: source.evidenceHash, hasReadableText: source.hasReadableText };
  });
  const provenance = {
    kind: "derived-saved-screenplay", version: 1,
    description: "Derived from a saved screenplay, not original historical documents. Original uploads, extracted document text, photographs, and the family narrative were not copied. Saved source references and hashes below are provenance only, not evidence that original files were read or verified. Cast basis and dramatization labels are copied claims requiring review against the originals.",
    originalPlan: { preparedId: entry.id, manifestHash: entry.manifestHash, filmId: manifest.filmId, title,
      targetDurationSeconds: manifest.targetDurationSeconds, narrativeEvidenceHash: manifest.narrativeEvidenceHash },
    originalSourceReferences: originalSources,
    screenplay,
  };
  // Compact JSON retains every saved field and reference without repeating the
  // manifest's per-shot copy of each scene or manufacturing missing source text.
  const sourceText = JSON.stringify(provenance);
  if (sourceText.length > MAX_SOURCE_CHARACTERS) throw new Error("This saved screenplay exceeds the one-million-character limit for a new source. Export the saved plan and divide it into smaller drafts. Nothing was copied or truncated.");
  const draft: Film = {
    ...newFilm(), title: title.length + " — new version".length <= 200 ? `${title} — new version` : title,
    ancestor, era: text(manifest.era), style: manifest.style as Film["style"], duration: Number(manifest.targetDurationSeconds),
    factuality: manifest.factuality as Film["factuality"], music: manifest.sound.musicRequested,
    logline: text(screenplay.logline), themes: structuredClone(themes), selectedThemes: themes, characters, scenes, assumptions,
    sources: [{ id: sourceId, name: "Saved screenplay (derived source)", type: "text/plain", size: new TextEncoder().encode(sourceText).byteLength,
      text: sourceText, extraction: "Saved screenplay copied as a derived text source. Original uploads and family narrative were not copied; review their evidence before regenerating." }],
  };
  // Match story preparation's metadata boundary before writing a draft that
  // would immediately fail to regenerate. No source is silently shortened.
  const metadata = { title: draft.title, ancestor: draft.ancestor, era: draft.era, script: "", duration: draft.duration,
    factuality: draft.factuality, selectedThemes: draft.selectedThemes.map(({ title, plot, climax }) => ({ title, plot, climax })),
    sources: draft.sources.map(({ id, name, type, extraction }) => ({ id, name, type, extraction })), excludedTitles: [] };
  if (JSON.stringify(metadata).length > MAX_METADATA_CHARACTERS) throw new Error("This saved screenplay has too much film metadata for a new draft. Export its saved plan to shorten those details first. Nothing was copied or truncated.");
  return draft;
}

export function persistCreatedDraft(storage: Pick<Storage, "getItem" | "setItem">, storageKey: string, current: Film[], draft: Film): Film[] {
  if (!uuid(draft.id) || current.some(film => film.id === draft.id) || draft.paymentReference || draft.productionPreparation
    || draft.job || draft.outputId || draft.outputType || draft.outputAt || draft.audioId || draft.archivedAt || draft.trashedAt
    || draft.scenes.some(scene => scene.shot)) throw invalid();
  const next = [draft, ...current];
  const serialized = JSON.stringify(next);
  try {
    storage.setItem(storageKey, serialized);
    if (storage.getItem(storageKey) !== serialized) throw new Error();
  } catch {
    throw new Error("The new version could not be confirmed in browser storage. Your original film is unchanged. Make space or reload your library before trying again.");
  }
  return next;
}
