import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constructionFiles, standardFilmVoices } from "../scripts/automatic-film-soundtrack.mjs";
import { soundtrackPlan } from "../scripts/rebuild-film-soundtrack.mjs";
import { buildFilmManifest, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import { intendedSpeechTokens, speechEdit, reviewFilmSpeech } from "../scripts/review-film-speech.mjs";
import { planKlingShots } from "../api/_lib/kling-film-plan.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

function fixture({ silent = false } = {}) {
  const { manifest } = buildFilmManifest(fictionalOperatorProject());
  manifest.targetDurationSeconds = 600;
  manifest.sound.musicRequested = true;
  manifest.shots = Array.from({ length: 200 }, (_, index) => ({
    ...manifest.shots[0], id: `shot-${index + 1}`, startMs: index * 3000, targetDurationMs: 3000,
    narration: silent ? "" : "Here.", dialogue: silent ? "" : "ada: Hello.\nalice: Yes.",
  }));
  const manifestHash = hash(JSON.stringify(manifest)), voices = standardFilmVoices(manifest, manifestHash);
  const plan = soundtrackPlan({ manifest, manifestHash, ...voices });
  let count = 0;
  const file = extension => ({ file: `fixture-${++count}.${extension}`, sha256: "b".repeat(64), sizeBytes: 32 });
  const provenance = {
    manifestHash, recipe: plan.recipe, status: "constructed-needs-review", engine: "kokoro-82m-v1.0-cpu",
    sourceTextRewritten: false, speed: 1, providerGenerationCalls: 0, durationMs: plan.durationMs,
    musicRequested: plan.musicRequested, narratorVoice: plan.narratorVoice, characterVoices: plan.characterVoices,
    score: { midi: file("mid"), audio: file("wav") },
    scenes: plan.scenes.map(scene => ({
      shotId: scene.shotId, durationMs: scene.durationMs, narrationSha256: scene.narrationSha256,
      dialogueSha256: scene.dialogueSha256, originalProviderAudioIncluded: false,
      mix: file("wav"), speech: file("wav"),
      turns: scene.turns.map((turn, index) => ({
        turnIndex: turn.turnIndex, textSha256: turn.textSha256, synthesisTextSha256: turn.textSha256,
        source: turn.source, speakerId: turn.speakerId, voice: turn.voice, speed: 1,
        phonemesSha256: "c".repeat(64), startSeconds: .1 + index * .7, endSeconds: .5 + index * .7,
        audio: file("wav"),
      })),
    })),
  };
  return { plan, provenance };
}

test("fallback cache supports all 200 cuts, 600 spoken turns and two score files", () => {
  const { plan, provenance } = fixture();
  assert.equal(plan.scenes.length, 200);
  assert.equal(plan.scenes.reduce((sum, scene) => sum + scene.turns.length, 0), 600);
  assert.equal(constructionFiles(provenance, plan).length, 1002);
});

test("fallback cache supports 200 intentionally silent cuts without inventing spoken turns", () => {
  const { plan, provenance } = fixture({ silent: true });
  assert.ok(plan.scenes.every(scene => scene.turns.length === 0));
  assert.equal(constructionFiles(provenance, plan).length, 402);
});

test("expanded file count preserves per-file and total byte limits and exact provenance binding", () => {
  const { plan, provenance } = fixture();
  const tooLarge = structuredClone(provenance);
  tooLarge.scenes[0].mix.sizeBytes = 250 * 1024 * 1024 + 1;
  assert.throws(() => constructionFiles(tooLarge, plan));
  const tooMuch = structuredClone(provenance);
  for (const scene of tooMuch.scenes.slice(0, 3)) scene.mix.sizeBytes = 250 * 1024 * 1024;
  assert.throws(() => constructionFiles(tooMuch, plan));
  const changed = structuredClone(provenance);
  changed.scenes[199].turns[2].textSha256 = "d".repeat(64);
  assert.throws(() => constructionFiles(changed, plan));
});

test("speech review recognizes saved speaker labels in mixed case and preserves the exact spoken words", async () => {
  const project = fictionalOperatorProject(), { manifest } = buildFilmManifest(project);
  const shot = { ...manifest.shots[0], targetDurationMs: 5000, narration: "They met.", dialogue: "  Ada: Hello Alice.\nFICTIONAL ALICE: Welcome.\nNarrator: They smiled." };
  manifest.shots = [shot];
  const expected = ["they", "met", "hello", "alice", "welcome", "they", "smiled"];
  const transcript = { duration: 5, words: expected.map((word, index) => ({ word, start: .1 + index * .3, end: .3 + index * .3 })) };
  assert.deepEqual(intendedSpeechTokens(shot, { manifest }), expected);
  assert.equal(speechEdit(shot, transcript, { manifest }), null);
  const reviewed = await reviewFilmSpeech({ manifest, clips: [{ shotId: shot.id, path: "fixture-only.mp4" }],
    transcribe: async () => transcript });
  assert.equal(reviewed.passed, true);
  assert.throws(() => speechEdit(shot, { ...transcript, words: transcript.words.slice(1) }, { manifest }),
    { code: "FILM_SPEECH_REVIEW_REQUIRED" });
});

test("speaker normalization preserves unknown, ambiguous and off-scene labels and colon-bearing prose", () => {
  const manifest = { screenplay: { characters: [
    { id: "ada-one", name: "Ada Winter" }, { id: "ada-two", name: "Ada Summer" }, { id: "alice", name: "Alice Example" },
  ] } };
  const shot = { characterIds: ["ada-one"], narration: "Remember: all words matter.",
    dialogue: "Ada: Keep this.\nAlice: Also keep this.\nWARNING: Do not erase.\nAda Winter: Hello." };
  assert.deepEqual(intendedSpeechTokens(shot, { manifest }),
    ["remember", "all", "words", "matter", "ada", "keep", "this", "alice", "also", "keep", "this", "warning", "do", "not", "erase", "hello"]);
  assert.deepEqual(intendedSpeechTokens({ ...shot, narration: "", dialogue: "Speaker: Hello." },
    { manifest, speakerAliases: { Speaker: "ada-one" } }), ["hello"]);
  assert.deepEqual(intendedSpeechTokens({ ...shot, narration: "", dialogue: "Speaker: Hello." },
    { manifest, speakerAliases: { Speaker: "missing-cast" } }), ["speaker", "hello"]);
});

test("split Kling dialogue and the authored soundtrack use the same intended spoken tokens", () => {
  const project = fictionalOperatorProject();
  project.duration = 60;
  project.scenes = [{ ...project.scenes[0], narration: "They waited together.",
    dialogue: "Ada: One two three four five six seven eight.\nNine ten eleven twelve.\nAlice: We returned home together." }];
  const { manifest } = buildFilmManifest(project), planned = planKlingShots(manifest);
  const manifestHash = hash(JSON.stringify(planned)), voices = standardFilmVoices(planned, manifestHash);
  const plan = soundtrackPlan({ manifest: planned, manifestHash, ...voices });
  for (const [index, shot] of planned.shots.entries()) {
    const spoken = plan.scenes[index].turns.flatMap(turn => turn.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/));
    assert.deepEqual(intendedSpeechTokens(shot, { manifest: planned, speakerAliases: voices.speakerAliases }), spoken);
  }
});

test("intentionally silent cuts accept no spoken words and still reject unexpected speech", () => {
  const shot = { narration: "", dialogue: "", characterIds: [], targetDurationMs: 3000 };
  assert.equal(speechEdit(shot, { duration: 3, words: [] }), null);
  assert.throws(() => speechEdit(shot, { duration: 3, words: [{ word: "extra", start: .1, end: .3 }] }),
    { code: "FILM_SPEECH_REVIEW_REQUIRED" });
});
