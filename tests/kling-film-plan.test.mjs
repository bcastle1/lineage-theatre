import test from "node:test";
import assert from "node:assert/strict";
import { planKlingShots } from "../api/_lib/kling-film-plan.mjs";
import { buildFilmManifest, fictionalOperatorProject, createFilmProductionService } from "../api/_lib/film-production.mjs";

test("Kling plans supported cuts for films through 600 seconds while preserving the screenplay and timeline", () => {
  for (const duration of [15, 30, 60, 120, 300, 600]) {
    const project = { ...fictionalOperatorProject(), duration };
    const { manifest } = buildFilmManifest(project), before = structuredClone(manifest);
    const planned = planKlingShots(manifest);
    assert.deepEqual(manifest, before);
    assert.deepEqual(planned.screenplay, manifest.screenplay);
    let position = 0;
    for (const shot of planned.shots) {
      assert.ok(shot.targetDurationMs >= 3000 && shot.targetDurationMs <= 15000);
      assert.equal(shot.startMs, position);
      position += shot.targetDurationMs;
    }
    assert.equal(position, duration * 1000);
    assert.ok(planned.shots.length <= 200);
    assert.equal(new Set(planned.shots.map(s => s.id)).size, planned.shots.length);
    for (const original of manifest.shots) {
      const cuts = planned.shots.filter(s => s.sceneIndex === original.sceneIndex);
      assert.equal(cuts.map(s => s.narration).join(" ").trim().replace(/\s+/g, " "), original.narration.trim().replace(/\s+/g, " "));
    }
  }
});

test("splitting dialogue preserves every spoken word in order and carries the speaker across cuts", () => {
  const p = fictionalOperatorProject();
  p.duration = 60; p.scenes = [p.scenes[0]];
  p.scenes[0].narration = "A short opening.";
  p.scenes[0].dialogue = "Ada: One two three four five six seven eight nine ten.\nEleven twelve thirteen fourteen.\nAlice: Fifteen sixteen seventeen eighteen nineteen twenty.";
  const { manifest } = buildFilmManifest(p), planned = planKlingShots(manifest);
  const spoken = text => text.split(/\r?\n/).map(line => line.replace(/^[^:\n]{1,100}:\s*/, "")).join(" ").trim().replace(/\s+/g, " ");
  assert.equal(spoken(planned.shots.map(s => s.dialogue).join("\n")), spoken(p.scenes[0].dialogue));
  assert.ok(planned.shots.flatMap(s => s.dialogue.split("\n")).filter(Boolean).every(line => /^(Ada|Alice):/.test(line)));
});

test("unsupported short scenes fail before a production plan is saved", () => {
  const { manifest } = buildFilmManifest(fictionalOperatorProject());
  manifest.shots[0].targetDurationMs = 2999;
  assert.throws(() => planKlingShots(manifest), /three seconds/);
});

test("new Kling preparation binds its provider plan before hashing and pricing", async () => {
  const records = new Map();
  const service = createFilmProductionService({
    adapter: { id: "fal", model: "kling" },
    readRecordImpl: async path => records.get(path),
    writeRecordImpl: async (path, value) => records.set(path, { value, etag: "one" }),
  });
  const project = { ...fictionalOperatorProject(), duration: 120 };
  const result = await service.prepare({ email: "fixture@example.invalid", project,
    idempotencyKey: "kling-plan-test-001", preparationConsent: true });
  const saved = await service.getPrepared({ email: "fixture@example.invalid", id: result.id });
  assert.deepEqual(saved.manifest.productionPlan, { provider: "kling", version: 1 });
  assert.ok(saved.manifest.shots.length > project.scenes.length);
  assert.equal(saved.provider, undefined);
});
