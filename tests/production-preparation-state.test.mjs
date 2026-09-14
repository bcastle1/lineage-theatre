import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { newFilm, normalizeFilm, customerProjectBackup, normalizeProductionPreparation, productionInputHash, productionPreparationInput } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const prepared = () => ({ id: "00000000-0000-4000-8000-000000000001", requestId: "00000000-0000-4000-8000-000000000002",
  manifestHash: "a".repeat(64), inputHash: "b".repeat(64), status: "prepared", sceneCount: 3, shotCount: 3, durationSeconds: 120,
  createdAt: "2026-09-14T12:00:00.000Z", issues: ["Review the cast's appearance and voices."] });
const copy = value => JSON.parse(JSON.stringify(value));

test("saved preparation references survive the normal film storage and backup reload paths", () => {
  const film = { ...newFilm(), productionPreparation: prepared() };
  assert.deepEqual(normalizeFilm(copy(film)).productionPreparation, prepared());
  assert.deepEqual(normalizeFilm(copy(customerProjectBackup(film))).productionPreparation, prepared());
});

test("restored preparation metadata excludes provider internals and rejects invalid references", () => {
  const metadata = { ...prepared(), provider: "private-provider", token: "private-credential", providerCostCents: 100, url: "https://untrusted.invalid" };
  const film = { ...newFilm(), productionPreparation: metadata };
  assert.deepEqual(normalizeFilm(copy(film)).productionPreparation, prepared());
  assert.deepEqual(customerProjectBackup(film).productionPreparation, prepared());
  assert.equal(normalizeProductionPreparation({ ...metadata, id: "../other-account" }), undefined);
  assert.equal(normalizeFilm({ ...film, productionPreparation: { ...metadata, manifestHash: "invalid" } }).productionPreparation, undefined);
});

test("current screenplay fingerprint ignores save timestamps and prior preparation but detects source and script edits", async () => {
  const film = { ...newFilm(), title: "Fictional garden", script: "A fictional shared garden.",
    sources: [{ id: "source-1", name: "Fictional note", type: "text/plain", text: "Fictional Ada grows vegetables.", size: 30 }],
    scenes: [{ id: "scene-1", title: "Opening", narration: "A fictional opening.", visual: "A shared garden", dialogue: "", dramatization: "Fictional example", sourceIds: ["source-1"], characterIds: [] }] };
  const fingerprint = value => productionInputHash(JSON.stringify(productionPreparationInput(value)));
  const original = await fingerprint(film);
  assert.equal(original, await fingerprint({ ...film, updatedAt: "2099-01-01T00:00:00Z", productionPreparation: prepared(), providerId: "hidden-provider", generatedBy: "private-model" }));
  assert.notEqual(original, await fingerprint({ ...film, scenes: [{ ...film.scenes[0], narration: "A revised opening." }] }));
  assert.notEqual(original, await fingerprint({ ...film, sources: [{ ...film.sources[0], text: "Changed family material." }] }));
  assert.doesNotMatch(JSON.stringify(productionPreparationInput({ ...film, productionPreparation: prepared(), providerId: "hidden-provider", generatedBy: "private-model" })), /hidden-provider|private-model|productionPreparation|manifestHash/);
});
