import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { customerProjectBackup, newFilm, normalizeFilm, productionStatusMessage } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const internalAttribution = /magiclight|gpt-6|astra|openai|quickbooks|legacy-vendor/i;
const persistedCopy = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  return {
    ...newFilm(),
    title: "Fictional Ada's garden",
    ancestor: "Fictional Ada",
    script: "A family note mentions MagicLight by name; user material must remain intact.",
    era: "A fictional summer",
    generatedBy: "GPT-6 Astra",
    sources: [{ id: "source-1", name: "Family letter", type: "text/plain", size: 32,
      text: "Fictional Ada tended a family garden.", note: "Preserve this note.", extraction: "Text read" }],
    themes: [{ id: "theme-1", title: "A shared harvest", plot: "A family plants together",
      climax: "A shared meal", reason: "The fictional letter" }],
    selectedThemes: [{ id: "theme-1", title: "A shared harvest", plot: "A family plants together",
      climax: "A shared meal", reason: "The fictional letter" }],
    characters: [{ id: "cast-1", name: "Fictional Ada", role: "Gardener",
      description: "Tends the family garden", basis: "documented", sourceIds: ["source-1"] }],
    assumptions: [{ id: "assumption-1", description: "The meal is reconstructed",
      reason: "No dialogue survives" }],
    scenes: [{ id: "scene-1", title: "The harvest", narration: "The family gathered.",
      visual: "The garden at dusk", dialogue: "A fictional line", dramatization: "Reconstructed meal",
      sourceIds: ["source-1"], characterIds: ["cast-1"],
      shot: { id: "shot-1", provider: "magiclight", status: "completed",
        message: "MagicLight render completed", videoUrl: "https://media.example.invalid/shot.mp4" } }],
    sourceCoverage: { totalSources: 1, readSources: 1, textCharacters: 32,
      photoSources: 0, photosRead: 0, notesOnlySources: 0, warnings: ["Review the reconstructed dialogue."] },
    job: { id: "production-1", provider: "magiclight", status: "queued",
      message: "MagicLight API is waiting for QuickBooks", videoUrl: "https://media.example.invalid/film.mp4" },
    logline: "A fictional family keeps its garden alive.",
    outputId: "saved-video-1", outputType: "video/mp4", outputAt: "2026-09-14T12:00:00.000Z",
    audioId: "saved-audio-1", archivedAt: "2026-09-14T13:00:00.000Z",
  };
}

function productionContent(shot) {
  if (!shot) return shot;
  const { provider, message, ...content } = shot;
  return content;
}

function draftContent(film) {
  const { providerId, generatedBy, job, scenes, ...content } = film;
  return {
    ...content,
    job: productionContent(job),
    scenes: scenes.map((scene) => ({
      ...scene,
      ...(scene.shot ? { shot: productionContent(scene.shot) } : {}),
    })),
  };
}

test("customer backup removes operational attribution without altering source or film content", () => {
  const original = fixture();
  const before = persistedCopy(original);
  const backup = persistedCopy(customerProjectBackup(original));
  assert.deepEqual(draftContent(backup), draftContent(before));
  assert.deepEqual(original, before);
  assert.match(backup.script, /MagicLight by name/);
  assert.equal(backup.providerId, "lineage-theatre");
  assert.equal(backup.generatedBy, "Lineage Theatre");
  for (const job of [backup.job, backup.scenes[0].shot]) {
    assert.equal(job.provider, "lineage-theatre");
    assert.equal(job.message, productionStatusMessage(job.status));
    assert.doesNotMatch(`${job.provider} ${job.message}`, internalAttribution);
  }
  assert.deepEqual(customerProjectBackup(backup), backup);
});

test("backup roundtrip restores current production aliases and preserves every draft reference", () => {
  const original = fixture();
  const restored = normalizeFilm(persistedCopy(customerProjectBackup(original)));
  assert.deepEqual(draftContent(restored), draftContent(original));
  assert.equal(restored.providerId, "magiclight");
  assert.equal(restored.job.provider, "magiclight");
  assert.equal(restored.job.id, original.job.id);
  assert.equal(restored.scenes[0].shot.provider, "magiclight");
  assert.equal(restored.scenes[0].shot.id, original.scenes[0].shot.id);
});

test("archived production aliases never become active current-provider jobs", () => {
  const original = fixture();
  original.job.provider = "legacy-vendor";
  original.scenes[0].shot.provider = "legacy-vendor";
  const backup = customerProjectBackup(original);
  const restored = normalizeFilm(persistedCopy(backup));
  assert.deepEqual(draftContent(restored), draftContent(original));
  for (const job of [backup.job, backup.scenes[0].shot, restored.job, restored.scenes[0].shot]) {
    assert.equal(job.provider, "archived-production");
    assert.doesNotMatch(`${job.provider} ${job.message}`, internalAttribution);
  }
});

test("normalizing existing drafts leaves their stored diagnostics and provider metadata intact", () => {
  for (const provider of ["magiclight", "legacy-vendor"]) {
    const original = fixture();
    original.job.provider = provider;
    original.scenes[0].shot.provider = provider;
    const before = persistedCopy(original);
    const normalized = normalizeFilm(original);
    assert.deepEqual(normalized, before);
    assert.deepEqual(original, before);
  }
});

test("manual attribution is explicit and a fresh backup adds no invented production", () => {
  for (const generatedBy of ["Manual outline from source text", "Manual outline with internal GPT-6 detail"]) {
    assert.equal(customerProjectBackup({ ...newFilm(), generatedBy }).generatedBy,
      "Manual outline from source text");
  }
  const blank = customerProjectBackup(newFilm());
  assert.equal(blank.generatedBy, "Lineage Theatre");
  assert.equal(Object.hasOwn(blank, "job"), false);
  assert.deepEqual(blank.scenes, []);
});

test("production status copy covers each recorded state without echoing diagnostic messages", () => {
  const statuses = ["submitting", "queued", "processing", "completed", "failed", "uncertain"];
  const messages = statuses.map(productionStatusMessage);
  assert.equal(new Set(messages).size, statuses.length);
  for (const message of [...messages, productionStatusMessage("unknown-state")]) {
    assert.ok(message.length > 10);
    assert.doesNotMatch(message, internalAttribution);
  }
  assert.match(productionStatusMessage("completed"), /ready to watch/);
  assert.match(productionStatusMessage("failed"), /could not finish/);
  assert.match(productionStatusMessage("uncertain"), /unconfirmed/);
});
