import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const modelUrl = moduleUrl(compile(await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8")));
const libraryUrl = moduleUrl(compile(await readFile(new URL("../src/studio/film-library.ts", import.meta.url), "utf8")));
const derivedSource = compile(await readFile(new URL("../src/studio/derived-film.ts", import.meta.url), "utf8"))
  .replaceAll('from "./model"', `from "${modelUrl}"`).replaceAll('from "./film-library"', `from "${libraryUrl}"`);
const { createCheckoutDraft, newFilm, normalizeFilm, productionInputHash, productionPreparationInput } = await import(modelUrl);
const { persistCreatedDraft } = await import(moduleUrl(derivedSource));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fulfillmentFields = ["paymentReference", "productionPreparation", "job", "outputId", "outputType", "outputAt", "audioId", "archivedAt", "trashedAt"];

function fixture() {
  const shot = { id: "old-shot", provider: "magiclight", status: "completed", videoUrl: "https://example.invalid/old-film.mp4" };
  const theme = { id: "theme-1", title: "A remembered life", plot: "A family examines a record.", climax: "The record connects generations.", reason: "A fictional regression fixture." };
  return {
    ...newFilm(), title: "The Story of Nathan Wood", ancestor: "Nathan Wood", era: "A fictional regression fixture", duration: 60,
    style: "Documentary", factuality: "documentary", music: false,
    script: "Current story text for a checkout regression; this is not the older paid screenplay.",
    logline: "The current story must receive its own price.",
    sources: [{ id: "source-letter", name: "Current source.txt", type: "text/plain", size: 52, text: "Keep the original current-source text.", note: "Keep its context.", extraction: "Text read" },
      { id: "source-photo", name: "Current photo.png", type: "image/png", size: 120, note: "The original upload is retained by source id." }],
    themes: [theme], selectedThemes: [theme],
    characters: [{ id: "person-1", name: "Nathan Wood", role: "Subject", description: "A regression fixture", basis: "documented", sourceIds: ["source-letter", "@family-narrative"] }],
    assumptions: [{ id: "assumption-1", description: "Fixture material requires review.", reason: "No historical claim is made." }],
    scenes: [{ id: "scene-1", title: "The current film", narration: "Preserve the new narration.", visual: "Show the current source.",
      sourceIds: ["source-letter", "source-photo"], characterIds: ["person-1"], dialogue: "Current dialogue", dramatization: "None", shot }],
    paymentReference: { preparedId: "11111111-1111-4111-8111-111111111111", manifestHash: "a".repeat(64), quoteId: "b".repeat(64), orderId: "c".repeat(64),
      checkoutKey: "original-checkout-reference", submittedAt: "2026-09-24T00:00:00.000Z", sandbox: false },
    productionPreparation: { id: "11111111-1111-4111-8111-111111111111", manifestHash: "a".repeat(64), inputHash: "d".repeat(64),
      requestId: "22222222-2222-4222-8222-222222222222", status: "completed", sceneCount: 1, shotCount: 1, durationSeconds: 60, createdAt: "2026-09-24T00:00:00.000Z", issues: [] },
    job: shot, outputId: "old-output", outputType: "video/mp4", outputAt: "2026-09-24T00:00:00.000Z", audioId: "old-audio",
    archivedAt: "2026-09-25T00:00:00.000Z", trashedAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

test("a new checkout preserves Nathan Wood's current story under a separate clean film identity", () => {
  const original = fixture(), before = structuredClone(original);
  const draft = createCheckoutDraft(original);
  assert.match(draft.id, uuid);
  assert.notEqual(draft.id, original.id);
  assert.notEqual(draft.updatedAt, original.updatedAt);
  for (const field of ["title", "ancestor", "era", "duration", "style", "factuality", "music", "script", "logline", "sources", "themes", "selectedThemes", "characters", "assumptions"]) {
    assert.deepEqual(draft[field], original[field], `preserve current ${field}`);
  }
  assert.deepEqual(draft.scenes, original.scenes.map(({ shot, ...scene }) => scene));
  for (const field of fulfillmentFields) assert.equal(Object.hasOwn(draft, field), false, `remove ${field}`);
  assert.equal(Object.hasOwn(draft.scenes[0], "shot"), false);
  assert.deepEqual(original, before);
});

test("checkout copies have detached story content while preserving source and cast references", () => {
  const original = fixture(), before = structuredClone(original), draft = createCheckoutDraft(original);
  const sourceIds = new Set(draft.sources.map(source => source.id));
  const characterIds = new Set(draft.characters.map(character => character.id));
  assert.ok(draft.scenes.every(scene => scene.sourceIds.every(id => sourceIds.has(id)) && scene.characterIds.every(id => characterIds.has(id))));
  assert.ok(draft.characters.every(character => character.sourceIds.every(id => id === "@family-narrative" || sourceIds.has(id))));
  draft.sources[0].text = "Edited only in the new film";
  draft.themes[0].title = "New direction";
  draft.selectedThemes[0].plot = "New plot";
  draft.characters[0].sourceIds.push("additional-source");
  draft.assumptions[0].description = "New assumption";
  draft.scenes[0].narration = "New narration";
  draft.scenes[0].characterIds.length = 0;
  draft.scenes[0].sourceIds.length = 0;
  assert.deepEqual(original, before);
});

test("new checkout identity changes preparation input even when story content is unchanged", async () => {
  const original = fixture(), draft = createCheckoutDraft(original), another = createCheckoutDraft(original);
  assert.notEqual(draft.id, another.id);
  const originalHash = await productionInputHash(JSON.stringify(productionPreparationInput(original)));
  const draftInput = productionPreparationInput(draft);
  assert.equal(draftInput.id, draft.id);
  assert.equal(draftInput.title, "The Story of Nathan Wood");
  assert.notEqual(await productionInputHash(JSON.stringify(draftInput)), originalHash);
  assert.equal(draft.paymentReference, undefined);
  assert.equal(draft.productionPreparation, undefined);
});

test("saving the new checkout retains the original order and survives a browser reload", () => {
  const original = fixture(), before = structuredClone(original), current = [original], draft = createCheckoutDraft(original);
  const values = new Map([["other-account", "unchanged"]]);
  const storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null };
  const next = persistCreatedDraft(storage, "current-account", current, draft);
  assert.equal(next[0], draft);
  assert.equal(next[1], original);
  assert.deepEqual(current, [before]);
  assert.equal(values.get("current-account"), JSON.stringify(next));
  assert.equal(values.get("other-account"), "unchanged");
  const restored = JSON.parse(values.get("current-account")).map(normalizeFilm);
  assert.equal(restored[0].id, draft.id);
  assert.equal(restored[0].title, original.title);
  for (const field of fulfillmentFields) assert.equal(restored[0][field], undefined);
  assert.deepEqual(restored[1].paymentReference, original.paymentReference);
  assert.deepEqual(restored[1].productionPreparation, original.productionPreparation);
  assert.deepEqual(restored[0].sources, original.sources);
});

test("quota and readback failures do not replace the current film or its payment", () => {
  for (const storage of [
    { setItem() { throw new Error("Quota exceeded"); }, getItem() { return null; } },
    { setItem() {}, getItem() { return "unexpected storage result"; } },
  ]) {
    const original = fixture(), before = structuredClone(original), current = [original], draft = createCheckoutDraft(original);
    assert.throws(() => persistCreatedDraft(storage, "current-account", current, draft), /could not be confirmed/);
    assert.deepEqual(current, [before]);
    assert.equal(current[0], original);
  }
});

test("fresh films have unique identities and no previous checkout state", () => {
  const first = newFilm(), second = newFilm();
  assert.match(first.id, uuid);
  assert.match(second.id, uuid);
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, "");
  assert.deepEqual(first.scenes, []);
  assert.deepEqual(first.sources, []);
  for (const field of fulfillmentFields) assert.equal(Object.hasOwn(first, field), false);
});
