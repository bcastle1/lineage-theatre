import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildFilmManifest, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import { buildFilmClipPlan, FilmClipPlanError, MAX_FILM_CLIPS, MAX_FILM_DURATION_MS } from "../api/_lib/film-clip-plan.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policy = (maximumClipDurationMs = 6000) => ({ version: 1, evidenceHash: "a".repeat(64), maximumClipDurationMs });
const input = (project = fictionalOperatorProject(), capabilityPolicy = policy()) => ({ ...buildFilmManifest(project), capabilityPolicy });
function oneScene(duration = 15) {
  const project = fictionalOperatorProject();
  project.duration = duration;
  project.scenes = project.scenes.slice(0, 1);
  return project;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function rejects(value, code) {
  assert.throws(() => buildFilmClipPlan(value), error => {
    assert.ok(error instanceof FilmClipPlanError);
    assert.equal(error.code, code);
    return true;
  });
}
function alteredManifest(change) {
  const value = input();
  change(value.manifest);
  value.manifestHash = hash(value.manifest);
  return value;
}

test("clip planning is synchronous, deterministic and preserves recursively frozen reviewed inputs", () => {
  const value = input(), before = structuredClone(value);
  const first = buildFilmClipPlan(freeze(value));
  assert.equal(typeof first?.then, "undefined");
  assert.deepEqual(buildFilmClipPlan(value), first);
  assert.deepEqual(buildFilmClipPlan(structuredClone(value)), first);
  assert.deepEqual(value, before);
  assert.deepEqual(Object.keys(first).sort(), ["plan", "planHash"]);
  assert.match(first.planHash, /^[a-f0-9]{64}$/);
  assert.equal(first.planHash, hash(first.plan));
  assert.equal(first.plan.manifestHash, before.manifestHash);
  assert.equal(first.plan.filmId, before.manifest.filmId);
  assert.equal(first.plan.targetDurationMs, 15000);
  assert.equal(first.plan.version, 1);
  assert.deepEqual(Object.keys(first.plan).sort(), ["capabilityPolicy", "capabilityPolicyHash", "clips", "filmId", "manifestHash", "targetDurationMs", "version"]);
});

test("policy object key order cannot create a different capability binding or clip identity", () => {
  const value = input(), first = buildFilmClipPlan(value);
  const reordered = { maximumClipDurationMs: 6000, evidenceHash: value.capabilityPolicy.evidenceHash, version: 1 };
  const second = buildFilmClipPlan({ ...value, capabilityPolicy: reordered });
  assert.deepEqual(second, first);
  assert.deepEqual(first.plan.capabilityPolicy, policy());
  assert.equal(first.plan.capabilityPolicyHash, hash(policy()));
});

test("a long scene becomes bounded parts with exact remainder coverage and no repeated screenplay text", () => {
  const value = input(oneScene()), { plan } = buildFilmClipPlan(value);
  assert.deepEqual(plan.clips.map(({ startMs, sceneOffsetMs, targetDurationMs, partIndex, partCount }) =>
    ({ startMs, sceneOffsetMs, targetDurationMs, partIndex, partCount })), [
    { startMs: 0, sceneOffsetMs: 0, targetDurationMs: 6000, partIndex: 0, partCount: 3 },
    { startMs: 6000, sceneOffsetMs: 6000, targetDurationMs: 6000, partIndex: 1, partCount: 3 },
    { startMs: 12000, sceneOffsetMs: 12000, targetDurationMs: 3000, partIndex: 2, partCount: 3 },
  ]);
  assert.equal(new Set(plan.clips.map(clip => clip.id)).size, 3);
  for (const clip of plan.clips) {
    assert.match(clip.id, /^[a-f0-9]{64}$/);
    assert.equal(clip.shotId, value.manifest.shots[0].id);
    assert.equal(clip.sceneIndex, 0);
    assert.deepEqual(Object.keys(clip).sort(), ["id", "partCount", "partIndex", "sceneIndex", "sceneOffsetMs", "shotId", "startMs", "targetDurationMs"]);
  }
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(value.manifest.screenplay.scenes[0].narration), false);
  assert.equal(serialized.includes(value.manifest.screenplay.scenes[0].visual), false);
  assert.doesNotMatch(serialized, /"narration"|"dialogue"|"providerJobId"|"requestKey"/);
});

test("exact duration multiples have no empty trailing part and larger limits keep a scene whole", () => {
  for (const [maximum, durations] of [[5000, [5000, 5000, 5000]], [15000, [15000]], [600000, [15000]]]) {
    const { plan } = buildFilmClipPlan(input(oneScene(), policy(maximum)));
    assert.deepEqual(plan.clips.map(clip => clip.targetDurationMs), durations);
    assert.equal(plan.clips.at(-1).startMs + plan.clips.at(-1).targetDurationMs, 15000);
    assert.ok(plan.clips.every(clip => clip.partCount === durations.length));
  }
});

test("unequal reviewed scenes retain distinct mappings and exact contiguous film timing", () => {
  const value = input(fictionalOperatorProject(), policy(3000));
  const { plan } = buildFilmClipPlan(value);
  assert.deepEqual(value.manifest.shots.map(shot => shot.targetDurationMs), [5500, 5000, 4500]);
  assert.deepEqual(plan.clips.map(clip => clip.targetDurationMs), [3000, 2500, 3000, 2000, 3000, 1500]);
  let end = 0;
  for (const [sceneIndex, shot] of value.manifest.shots.entries()) {
    const clips = plan.clips.filter(clip => clip.sceneIndex === sceneIndex);
    assert.equal(clips[0].startMs, shot.startMs);
    assert.equal(clips[0].sceneOffsetMs, 0);
    assert.equal(clips.reduce((total, clip) => total + clip.targetDurationMs, 0), shot.targetDurationMs);
    for (const [partIndex, clip] of clips.entries()) {
      assert.equal(clip.shotId, shot.id);
      assert.equal(clip.partIndex, partIndex);
      assert.equal(clip.partCount, clips.length);
      assert.equal(clip.startMs, end);
      assert.equal(clip.startMs, shot.startMs + clip.sceneOffsetMs);
      assert.ok(Number.isSafeInteger(clip.targetDurationMs) && clip.targetDurationMs > 0 && clip.targetDurationMs <= 3000);
      end += clip.targetDurationMs;
    }
  }
  assert.equal(end, plan.targetDurationMs);
  assert.equal(new Set(plan.clips.map(clip => clip.id)).size, plan.clips.length);
});

test("a reviewed-content change or capability-policy change invalidates every prior clip identity", () => {
  const value = input(), original = buildFilmClipPlan(value);
  const edited = fictionalOperatorProject();
  edited.scenes[0].visual += " A different fictional garden view.";
  const cases = [input(edited), { ...value, capabilityPolicy: { ...policy(), evidenceHash: "b".repeat(64) } },
    { ...value, capabilityPolicy: policy(7000) }];
  const originalIds = new Set(original.plan.clips.map(clip => clip.id));
  for (const changed of cases) {
    const result = buildFilmClipPlan(changed);
    assert.notEqual(result.planHash, original.planHash);
    assert.ok(result.plan.clips.every(clip => !originalIds.has(clip.id)));
  }
  assert.equal(buildFilmClipPlan(cases[0]).plan.capabilityPolicyHash, original.plan.capabilityPolicyHash);
  assert.notEqual(buildFilmClipPlan(cases[1]).plan.capabilityPolicyHash, original.plan.capabilityPolicyHash);
});

test("the maximum film and exactly 600 clips are accepted, while an additional clip is rejected", () => {
  assert.equal(MAX_FILM_CLIPS, 600);
  assert.equal(MAX_FILM_DURATION_MS, 600000);
  const value = input(oneScene(600), policy(1000));
  const { plan } = buildFilmClipPlan(value);
  assert.equal(plan.clips.length, 600);
  assert.equal(plan.targetDurationMs, 600000);
  assert.equal(plan.clips.at(-1).startMs, 599000);
  assert.equal(plan.clips.at(-1).targetDurationMs, 1000);
  assert.equal(new Set(plan.clips.map(clip => clip.id)).size, 600);
  rejects({ ...value, capabilityPolicy: policy(999) }, "CLIP_PLAN_LIMIT_EXCEEDED");
  rejects({ ...value, capabilityPolicy: policy(1) }, "CLIP_PLAN_LIMIT_EXCEEDED");
});

test("unknown or missing top-level inputs cannot inject a provider setting or bypass validation", () => {
  for (const value of [undefined, null, [], "film", {}, { ...input(), providerJobId: "synthetic-job" }])
    rejects(value, "INVALID_CLIP_PLAN_INPUT");
  for (const field of ["manifest", "manifestHash", "capabilityPolicy"]) {
    const value = input(); delete value[field];
    rejects(value, "INVALID_CLIP_PLAN_INPUT");
  }
});

test("capability policy requires only its fixed version, lowercase evidence hash and bounded integer duration", () => {
  for (const capabilityPolicy of [null, undefined, [], {}, { ...policy(), version: 2 }, { ...policy(), version: "1" },
    ...[undefined, "", "A".repeat(64), "a".repeat(63), "g".repeat(64), 42, new String("a".repeat(64))].map(evidenceHash => ({ ...policy(), evidenceHash })),
    ...[undefined, 0, -0, -1, 0.5, 6000.5, "6000", NaN, Infinity, -Infinity, 600001, Number.MAX_SAFE_INTEGER + 1].map(maximumClipDurationMs => ({ ...policy(), maximumClipDurationMs })),
    { ...policy(), endpoint: "https://provider.example.invalid" }, { ...policy(), generationEnabled: true }]) {
    rejects({ ...input(), capabilityPolicy }, "INVALID_CLIP_CAPABILITY_POLICY");
  }
  for (const field of ["version", "evidenceHash", "maximumClipDurationMs"]) {
    const capabilityPolicy = policy(); delete capabilityPolicy[field];
    rejects({ ...input(), capabilityPolicy }, "INVALID_CLIP_CAPABILITY_POLICY");
  }
});

test("a missing or changed manifest hash cannot produce a plan", () => {
  for (const manifestHash of [undefined, null, "", "0".repeat(64), input().manifestHash.toUpperCase(), "a".repeat(63), new String(input().manifestHash)])
    rejects({ ...input(), manifestHash }, "INVALID_CLIP_PLAN_MANIFEST");
  const changed = input(); changed.manifest.title += " changed after preparation";
  rejects(changed, "INVALID_CLIP_PLAN_MANIFEST");
});

test("manifest identifiers and evidence hashes must be strings even when objects serialize or coerce identically", () => {
  for (const change of [
    manifest => { manifest.filmId = new String(manifest.filmId); },
    manifest => { manifest.narrativeEvidenceHash = new String(manifest.narrativeEvidenceHash); },
    manifest => { manifest.sources[0].evidenceHash = new String(manifest.sources[0].evidenceHash); },
    manifest => { manifest.narrativeEvidenceHash = { toString: () => "a".repeat(64) }; },
    manifest => { manifest.sources[0].evidenceHash = { toString: () => "a".repeat(64) }; },
  ]) rejects(alteredManifest(change), "INVALID_CLIP_PLAN_MANIFEST");
});

test("recomputing a hash cannot legitimize invalid, gapped, overlapping or incomplete shot timing", () => {
  for (const change of [
    manifest => { manifest.shots[0].startMs = -1; },
    manifest => { manifest.shots[1].startMs += 1; },
    manifest => { manifest.shots[1].startMs -= 1; },
    manifest => { manifest.shots[0].targetDurationMs = 0; },
    manifest => { manifest.shots[0].targetDurationMs += 0.5; },
    manifest => { manifest.shots[0].targetDurationMs = Number.MAX_SAFE_INTEGER + 1; },
    manifest => { manifest.shots.at(-1).targetDurationMs += 1; },
    manifest => { manifest.targetDurationSeconds = 14; },
    manifest => { manifest.targetDurationSeconds = 15.5; },
    manifest => { manifest.targetDurationSeconds = 601; },
    manifest => { manifest.shots.pop(); },
    manifest => { manifest.shots = []; },
    manifest => { manifest.shots.reverse(); },
  ]) rejects(alteredManifest(change), "INVALID_CLIP_PLAN_MANIFEST");
});

test("rehashed shots must match their reviewed scene, reference arrays and continuity mapping", () => {
  for (const change of [
    manifest => { manifest.shots[0].sceneIndex = 1; },
    manifest => { manifest.shots[0].sceneIndex = 0.5; },
    manifest => { manifest.shots[1].id = manifest.shots[0].id; },
    manifest => { manifest.shots[0].id = "shot-999"; },
    manifest => { manifest.shots[0].title += " unreviewed"; },
    manifest => { manifest.shots[0].narration += " unreviewed"; },
    manifest => { manifest.shots[0].dialogue = "Invented words."; },
    manifest => { manifest.shots[0].visual += " unreviewed"; },
    manifest => { manifest.shots[0].sourceIds = ["unreviewed-source"]; },
    manifest => { manifest.shots[0].characterIds = ["unreviewed-character"]; },
    manifest => { manifest.shots[0].continuity.characterIds = ["unreviewed-character"]; },
    manifest => { manifest.shots[1].continuity.precedingShotId = null; },
    manifest => { manifest.screenplay.scenes.pop(); },
  ]) rejects(alteredManifest(change), "INVALID_CLIP_PLAN_MANIFEST");
});

test("a valid large saved screenplay remains supported when duplicated manifest scene text exceeds 1.5 MB", () => {
  const project = fictionalOperatorProject();
  project.scenes[0].visual = "SAMPLE ONLY - FICTIONAL DATA. " + "v".repeat(800000);
  const value = input(project), before = hash(value.manifest);
  assert.ok(Buffer.byteLength(JSON.stringify(value.manifest.screenplay)) < 1500000);
  assert.ok(Buffer.byteLength(JSON.stringify(value.manifest)) > 1500000);
  const result = buildFilmClipPlan(freeze(value));
  assert.equal(result.plan.manifestHash, before);
  assert.equal(hash(value.manifest), before);
  assert.equal(result.plan.targetDurationMs, 15000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10000);
});
