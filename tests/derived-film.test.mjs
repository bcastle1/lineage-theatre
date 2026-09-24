import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { buildFilmManifest } from "../api/_lib/film-production.mjs";
import { prepareStory } from "../api/_lib/story.mjs";

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const modelUrl = moduleUrl(compile(await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8")));
const libraryUrl = moduleUrl(compile(await readFile(new URL("../src/studio/film-library.ts", import.meta.url), "utf8")));
const derivedSource = compile(await readFile(new URL("../src/studio/derived-film.ts", import.meta.url), "utf8"))
  .replaceAll('from "./model"', `from "${modelUrl}"`).replaceAll('from "./film-library"', `from "${libraryUrl}"`);
const { createDerivedFilmDraft, persistCreatedDraft } = await import(moduleUrl(derivedSource));
const { verifyLibraryDetail } = await import(libraryUrl);
const { newFilm, normalizeFilm } = await import(modelUrl);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(patch = {}) {
  const project = { ...newFilm(), title: "A family orchard", ancestor: "A fictional orchard family", era: "1910", duration: 30,
    script: "Original private family narrative, deliberately absent from the saved manifest.",
    sources: [{ id: "letter-1", name: "Family letter.txt", type: "text/plain", size: 38, text: "Original letter text is not recoverable here." },
      { id: "photo-2", name: "Orchard photo.png", type: "image/png", size: 500, note: "Supplied names in a context note." }],
    themes: [], selectedThemes: [{ id: "theme-a", title: "A harvest", plot: "A family reunites.", climax: "A shared meal.", reason: "Their enduring connection." }],
    characters: [{ id: "person-a", name: "Mira", role: "Grower", description: "Work clothes and a straw hat.", basis: "documented", sourceIds: ["letter-1", "@family-narrative"] },
      { id: "person-b", name: "Neighbor", role: "Helper", description: "A fictional neighbor.", basis: "invented", sourceIds: [] }],
    assumptions: [{ id: "assumption-a", description: "The neighbor is invented.", reason: "A dramatized interaction." }],
    logline: "A family gathers for the harvest.",
    scenes: [{ id: "scene-a", title: "Morning", narration: "Mira returns to the orchard.", visual: "A cart approaches the trees.",
      sourceIds: ["letter-1", "photo-2"], characterIds: ["person-a"], dialogue: "", dramatization: "Visual reconstruction." },
    { id: "scene-b", title: "Harvest", narration: "The neighbors share the harvest.", visual: "People gather at a table.",
      sourceIds: [], characterIds: ["person-a", "person-b"], dialogue: "Welcome home.", dramatization: "Invented dialogue and neighbor." }], ...patch };
  const { manifest, manifestHash } = buildFilmManifest(project);
  return { project, detail: { entry: { kind: "plan", id: "11111111-1111-4111-8111-111111111111", filmId: project.id,
    title: manifest.title, durationSeconds: project.duration, createdAt: "2026-09-24T06:00:00.000Z", updatedAt: "2026-09-24T06:00:00.000Z",
    libraryState: "active", revision: 0, production: { status: "completed", completedShots: 2, shotCount: 2, mediaReady: false, needsAttention: false },
    payments: [{ id: "a".repeat(64), status: "captured", amountCents: 330, refundedCents: 0, currency: "USD", sandbox: false, requiresReview: false, receiptAvailable: true }], manifestHash }, manifest } };
}

test("new version preserves complete saved screenplay and provenance without manufacturing original uploads", async () => {
  const { project, detail } = fixture();
  const before = JSON.stringify(detail);
  const draft = await createDerivedFilmDraft(detail);
  assert.notEqual(draft.id, project.id);
  assert.match(draft.id, /^[a-f0-9-]{36}$/);
  assert.equal(draft.title, project.title + " — new version");
  for (const field of ["ancestor", "era", "style", "factuality", "music", "duration", "logline"]) assert.equal(draft[field], project[field]);
  assert.equal(draft.script, "");
  assert.equal(draft.sources.length, 1);
  const source = draft.sources[0], derived = JSON.parse(source.text);
  assert.match(source.name, /derived source/);
  assert.match(source.extraction, /Original uploads and family narrative were not copied/);
  assert.equal(source.type, "text/plain");
  assert.equal(source.size, Buffer.byteLength(source.text));
  assert.deepEqual(derived.screenplay, detail.manifest.screenplay);
  assert.deepEqual(derived.originalSourceReferences, detail.manifest.sources);
  assert.equal(derived.originalPlan.preparedId, detail.entry.id);
  assert.equal(derived.originalPlan.manifestHash, detail.entry.manifestHash);
  assert.equal(derived.originalPlan.filmId, project.id);
  assert.equal(derived.originalPlan.narrativeEvidenceHash, detail.manifest.narrativeEvidenceHash);
  assert.equal(derived.originalPlan.title, project.title);
  assert.equal(derived.originalPlan.targetDurationSeconds, 30);
  assert.doesNotMatch(source.text, /Original private family narrative|Original letter text is not recoverable here/);
  assert.deepEqual(draft.scenes[0].sourceIds, [source.id]);
  assert.deepEqual(draft.scenes[1].sourceIds, []);
  assert.deepEqual(draft.characters[0].sourceIds, [source.id]);
  assert.deepEqual(draft.characters[1].sourceIds, []);
  assert.deepEqual(draft.scenes.map(scene => scene.characterIds), project.scenes.map(scene => scene.characterIds));
  assert.notEqual(draft.scenes[0].id, project.scenes[0].id);
  assert.notEqual(draft.selectedThemes[0].id, project.selectedThemes[0].id);
  assert.equal(JSON.stringify(detail), before);
  const prepared = prepareStory({ project: draft });
  assert.equal(prepared.images.length, 0);
  assert.equal(prepared.family.narrativeSourceId, null);
  assert.deepEqual(prepared.family.readableSourceIds, [source.id]);
  assert.equal(prepared.sourceCoverage.photoSources, 0);
});

test("duration can change on a fresh draft without rebinding the original paid manifest or retaining state", async () => {
  const { detail } = fixture();
  const original = JSON.stringify(detail);
  const draft = await createDerivedFilmDraft(detail);
  for (const field of ["paymentReference", "productionPreparation", "job", "outputId", "outputType", "outputAt", "audioId", "archivedAt", "trashedAt", "sourceCoverage", "generatedBy", "runtime"]) assert.equal(draft[field], undefined);
  assert.ok(draft.scenes.every(scene => !scene.shot));
  assert.equal(draft.quality, "highest"); // Preference only; no quality-review flag exists.
  draft.duration = 60;
  const next = buildFilmManifest(draft);
  assert.notEqual(next.manifestHash, detail.entry.manifestHash);
  assert.equal(next.manifest.targetDurationSeconds, 60);
  assert.equal(next.manifest.filmId, draft.id);
  assert.equal(next.manifest.qualityVerified, false);
  assert.equal(next.manifest.review.screenplay, "required");
  assert.equal(JSON.stringify(detail), original);
  assert.deepEqual(normalizeFilm(JSON.parse(JSON.stringify(draft))).sources, draft.sources);
});

test("copies are independent and repeated creations never reuse the film or source identity", async () => {
  const { detail } = fixture();
  const one = await createDerivedFilmDraft(detail), two = await createDerivedFilmDraft(detail);
  assert.notEqual(one.id, two.id); assert.notEqual(one.sources[0].id, two.sources[0].id);
  one.scenes[0].narration = "An edit";
  one.selectedThemes[0].title = "Another theme";
  assert.notEqual(one.scenes[0].narration, two.scenes[0].narration);
  assert.notEqual(one.selectedThemes[0].title, one.themes[0].title);
  assert.equal(JSON.parse(one.sources[0].text).screenplay.scenes[0].narration, detail.manifest.screenplay.scenes[0].narration);
});

test("exact manifest integrity and entry identity are required before copying", async () => {
  const { detail } = fixture();
  for (const mutate of [d => { d.manifest.screenplay.scenes[0].narration = "Changed"; },
    d => { d.entry.filmId = "22222222-2222-4222-8222-222222222222"; }, d => { d.entry.durationSeconds = 60; },
    d => { d.entry.title = "Wrong title"; }, d => { d.entry.kind = "upload"; }, d => { delete d.manifest; }]) {
    const changed = structuredClone(detail); mutate(changed);
    await assert.rejects(createDerivedFilmDraft(changed));
  }
  const pending = createDerivedFilmDraft(detail);
  detail.manifest.title = "Mutated during asynchronous hash";
  detail.entry.title = "Changed entry";
  const draft = await pending;
  assert.equal(draft.title, "A family orchard — new version");
});

test("malformed cast, missing references, provenance, and unsupported versions fail explicitly", async () => {
  for (const mutate of [m => { m.version = 2; }, m => { m.screenplay.characters[0].basis = "verified"; },
    m => { m.screenplay.characters[1].id = m.screenplay.characters[0].id; },
    m => { m.screenplay.scenes[0].characterIds = ["missing"]; }, m => { m.sources[0].evidenceHash = "invalid"; },
    m => { m.screenplay.scenes = []; }, m => { m.sound.musicRequested = "true"; }]) {
    const { detail } = fixture(); mutate(detail.manifest); detail.entry.manifestHash = hash(detail.manifest);
    await assert.rejects(createDerivedFilmDraft(detail), /could not be copied safely/);
  }
});

test("valid large saved screenplay copies without a whole-manifest byte limit or silent truncation", async () => {
  const { project } = fixture();
  project.scenes[0].visual = "v".repeat(805_000);
  const { detail } = fixture(project);
  assert.ok(Buffer.byteLength(JSON.stringify(detail.manifest)) > 1_500_000);
  const verified = await verifyLibraryDetail({ entry: detail.entry, manifest: { id: detail.entry.id, manifestHash: detail.entry.manifestHash, manifest: detail.manifest } }, detail.entry);
  assert.deepEqual(verified.sourceNames, project.sources.map(source => source.name));
  const draft = await createDerivedFilmDraft(verified);
  assert.equal(draft.scenes[0].visual.length, 805_000);
  assert.deepEqual(JSON.parse(draft.sources[0].text).screenplay, detail.manifest.screenplay);
  assert.doesNotThrow(() => prepareStory({ project: draft }));
});

test("source and metadata limits reject full input instead of producing a truncated or unusable draft", async () => {
  const { project } = fixture();
  project.scenes[0].visual = "v".repeat(1_005_000);
  const tooMuchSource = fixture(project).detail;
  await assert.rejects(createDerivedFilmDraft(tooMuchSource), /one-million-character/);
  const { detail } = fixture();
  detail.manifest.screenplay.selectedThemes[0].plot = "p".repeat(101_000);
  detail.entry.manifestHash = hash(detail.manifest);
  await assert.rejects(createDerivedFilmDraft(detail), /too much film metadata/);
  const longTitle = fixture({ title: "t".repeat(200) }).detail;
  assert.equal((await createDerivedFilmDraft(longTitle)).title, longTitle.entry.title);
});

test("persistence confirms the full list before returning and preserves existing draft/payment objects", async () => {
  const { detail } = fixture(), original = { ...newFilm(), title: "Existing draft", paymentReference: { orderId: "a".repeat(64) }, outputId: "original-media" };
  const draft = await createDerivedFilmDraft(detail);
  const values = new Map([["other-account", "unchanged"]]);
  const storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null };
  const current = [original];
  const next = persistCreatedDraft(storage, "current-account", current, draft);
  assert.equal(next[0], draft); assert.equal(next[1], original); assert.deepEqual(current, [original]);
  assert.equal(values.get("current-account"), JSON.stringify(next));
  assert.equal(values.get("other-account"), "unchanged");
  for (const broken of [{ setItem() { throw new Error("quota"); }, getItem() { return null; } },
    { setItem() {}, getItem() { return "unexpected readback"; } }]) {
    assert.throws(() => persistCreatedDraft(broken, "current-account", current, draft), /could not be confirmed/);
  }
  assert.throws(() => persistCreatedDraft(storage, "current-account", next, draft));
  for (const patch of [{ paymentReference: { orderId: "old" } }, { productionPreparation: { id: "old" } },
    { job: { id: "old" } }, { outputId: "old" }, { scenes: [{ ...draft.scenes[0], shot: { id: "old" } }] }]) {
    assert.throws(() => persistCreatedDraft(storage, "current-account", current, { ...draft, ...patch }));
  }
});
