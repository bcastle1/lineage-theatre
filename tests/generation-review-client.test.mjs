import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const code = ts.transpileModule(await readFile(new URL("../src/studio/generation-review.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { normalizeGenerationReview } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const identity = { preparedId: "00000000-0000-4000-8000-000000000001", filmId: "00000000-0000-4000-8000-000000000002", manifestHash: "a".repeat(64), orderId: "b".repeat(64) };
const review = { ...identity, status: "awaiting-review", artifactSha256: "c".repeat(64), durationSeconds: 60, width: 1280, height: 720, hasAudio: true, previewReady: true, previewUrl: `/api/studio?action=reviewVideo&id=${identity.preparedId}&artifact=${"c".repeat(64)}` };
test("generated review exposes only the exact technically verified private artifact", () => {
  assert.equal(normalizeGenerationReview(null, identity), null);
  assert.deepEqual(normalizeGenerationReview({ ...review, privateUrl: "secret", taskId: "secret" }, identity), review);
  assert.equal(normalizeGenerationReview({ ...review, status: "approved" }, identity).status, "approved");
  assert.deepEqual(normalizeGenerationReview({ ...identity, status: "needs-attention", message: "untrusted", previewUrl: "private" }, identity), { ...identity, status: "needs-attention", message: "The returned video could not pass verification. Your payment and saved film remain recorded." });
  assert.throws(() => normalizeGenerationReview({ ...review, artifactSha256: "d".repeat(64) }, identity), /could not be verified/);
  for (const change of [{ preparedId: identity.filmId }, { filmId: identity.preparedId }, { manifestHash: "d".repeat(64) }, { orderId: "d".repeat(64) }, { artifactSha256: "bad" }, { status: "completed" }, { durationSeconds: 0 }, { width: 0 }, { height: 0 }, { hasAudio: false }, { previewReady: false }, { previewUrl: "https://example.com/video.mp4" }, { previewUrl: review.previewUrl + "&anything=1" }])
    assert.throws(() => normalizeGenerationReview({ ...review, ...change }, identity), /could not be verified/);
});
