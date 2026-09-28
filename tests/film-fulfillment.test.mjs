import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const load = async name => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(await readFile(new URL(`../src/studio/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);
const { filmReadyToWatch, filmFulfillmentProgress, generationTimeEstimate } = await load("film-fulfillment");
const { normalizeGenerationAttempt, generationStatusLabel, generationAttemptExplanation, generationDiagnosticExplanation, generationReplacementRequest } = await load("generation-attempt");
const identity = { preparedId: "00000000-0000-4000-8000-000000000001", filmId: "paid-film", manifestHash: "a".repeat(64), orderId: "b".repeat(64) };
const paid = { status: "captured", charged: true, receiptAvailable: true, requiresReview: false, refundedCents: 0, sandbox: false };
const finished = { kind: "plan", id: identity.preparedId, filmId: identity.filmId, manifestHash: identity.manifestHash,
  production: { status: "completed", mediaReady: true }, mediaUrl: `/api/studio?action=productionMedia&id=${identity.preparedId}`,
  downloadUrl: `/api/studio?action=productionMedia&id=${identity.preparedId}&download=1` };
test("payment confirmation and a raw completed job never imply a watchable film", () => {
  for (const production of [null, { status: "prepared" }, { status: "processing" }, { status: "completed", mediaReady: true }]) {
    const view = filmFulfillmentProgress(paid, production, false, false);
    assert.equal(view.payment, "Payment received"); assert.equal(view.ready, false); assert.equal(view.watch, "Not ready yet");
  }
  assert.equal(filmFulfillmentProgress(paid, { status: "prepared" }, false, false).production, "Not started");
  assert.equal(filmFulfillmentProgress(paid, { status: "processing" }, true, false).production, "Creating your film");
});
test("watch links require the exact paid plan and verified private media", () => {
  assert.equal(filmReadyToWatch(finished, identity, identity.filmId), true);
  for (const change of [{ id: "other" }, { filmId: "other" }, { manifestHash: "c".repeat(64) }, { kind: "upload" },
    { production: { status: "prepared", mediaReady: true } }, { production: { status: "completed", mediaReady: false } },
    { mediaUrl: "https://example.com/video.mp4" }, { downloadUrl: finished.mediaUrl }]) {
    assert.equal(filmReadyToWatch({ ...finished, ...change }, identity, identity.filmId), false);
  }
  assert.equal(filmReadyToWatch(null, identity, identity.filmId), false);
  assert.equal(filmFulfillmentProgress(paid, { status: "completed" }, false, true).watch, "Ready to watch");
  for (const change of [{ charged: false }, { requiresReview: true }, { refundedCents: 1 }, { receiptAvailable: false }, { status: "awaiting-payment" }])
    assert.equal(filmFulfillmentProgress({ ...paid, ...change }, null, true, true).ready, false);
});
test("unverified timing and provider completion do not become a finished film claim", () => {
  assert.match(generationTimeEstimate(false, false), /Unavailable/);
  assert.match(generationTimeEstimate(false, true), /Not yet available/);
  const value = { ...identity, status: "verifying", submittedAt: "2026-09-27T23:00:00Z", elapsedSeconds: 42, estimateAvailable: false, taskId: "private", outputUrl: "private" };
  const safe = normalizeGenerationAttempt(value, identity);
  assert.equal(safe.taskId, undefined); assert.equal(safe.outputUrl, undefined);
  assert.equal(generationStatusLabel(safe), "Checking generated video");
  for (const change of [{ preparedId: "other" }, { orderId: "other" }, { manifestHash: "other" }, { filmId: "other" }, { status: "completed" }, { estimateAvailable: true }, { elapsedSeconds: -1 }])
    assert.throws(() => normalizeGenerationAttempt({ ...value, ...change }, identity), /could not be verified/);
});
test("owner diagnostics keep only fixed codes and numerical evidence, without enabling another request", () => {
  const value = { ...identity, status: "uncertain", submittedAt: "2026-09-27T23:00:00Z", elapsedSeconds: 3600, estimateAvailable: false,
    diagnostic: { code: "MAGICLIGHT_PROVIDER_REJECTED", providerCode: 10002, httpStatus: 200, stage: "provider", message: "private response", taskId: "private" },
    recovery: { kind: "provider-review-required", canRetry: false, taskId: "private" } };
  const safe = normalizeGenerationAttempt(value, identity);
  assert.deepEqual(safe.diagnostic, { code: "MAGICLIGHT_PROVIDER_REJECTED", providerCode: 10002, httpStatus: 200, stage: "provider" });
  assert.deepEqual(safe.recovery, { kind: "provider-review-required", canRetry: false });
  assert.doesNotMatch(JSON.stringify(safe), /private/);
  assert.match(generationDiagnosticExplanation(safe), /does not confirm acceptance/);
  assert.match(generationAttemptExplanation(safe), /time since the request does not indicate production progress/);
  for (const diagnostic of [{ code: "private response" }, { code: "MAGICLIGHT_TIMEOUT", httpStatus: 999 },
    { code: "MAGICLIGHT_TIMEOUT", httpStatus: "500" }, { code: "MAGICLIGHT_TIMEOUT", providerCode: "private" }, { code: "MAGICLIGHT_TIMEOUT", stage: "private" }])
    assert.throws(() => normalizeGenerationAttempt({ ...value, diagnostic }, identity), /could not be verified/);
  for (const recovery of [{ kind: "provider-review-required", canRetry: true }, { kind: "retry", canRetry: false }, []])
    assert.throws(() => normalizeGenerationAttempt({ ...value, recovery }, identity), /could not be verified/);
});
test("one replacement needs explicit duplicate consent and the exact server recovery revision", () => {
  const change = "00000000-0000-4000-8000-000000000009";
  const value = { ...identity, status: "uncertain", submittedAt: "2026-09-27T23:00:00Z", elapsedSeconds: 3600, estimateAvailable: false,
    recovery: { kind: "replacement-available", canRetry: true, expectedChangeId: change } };
  const safe = normalizeGenerationAttempt(value, identity);
  assert.deepEqual(safe.recovery, value.recovery);
  assert.equal(generationReplacementRequest(safe, identity, false), null);
  assert.deepEqual(generationReplacementRequest(safe, identity, true), { action: "replaceFilmGeneration", preparedId: identity.preparedId,
    orderId: identity.orderId, expectedChangeId: change, consent: true, acknowledgePossibleDuplicate: true });
  for (const status of ["processing", "submitting", "verifying", "failed"])
    assert.throws(() => normalizeGenerationAttempt({ ...value, status }, identity), /could not be verified/);
  for (const recovery of [{ kind: "replacement-available", canRetry: false, expectedChangeId: change },
    { kind: "replacement-available", canRetry: true }, { kind: "replacement-available", canRetry: true, expectedChangeId: "private" }])
    assert.throws(() => normalizeGenerationAttempt({ ...value, recovery }, identity), /could not be verified/);
  for (const key of Object.keys(identity)) assert.equal(generationReplacementRequest(safe, { ...identity, [key]: "different" }, true), null);
  assert.equal(generationReplacementRequest({ ...safe, recovery: { kind: "provider-review-required", canRetry: false } }, identity, true), null);
  assert.equal(generationReplacementRequest({ ...safe, recovery: undefined }, identity, true), null);
});
test("legacy unconfirmed requests explain the missing response and never imply active rendering", () => {
  const value = { ...identity, status: "uncertain", submittedAt: "2026-09-27T23:00:00Z", elapsedSeconds: 3600, estimateAvailable: false,
    recovery: { kind: "provider-review-required", canRetry: false } };
  const legacy = normalizeGenerationAttempt(value, identity);
  assert.match(generationDiagnosticExplanation(legacy), /detailed response was not saved/);
  assert.match(generationAttemptExplanation(legacy), /Generation has not been confirmed/);
  const undisclosed = { ...legacy, status: "submitting" };
  assert.equal(generationStatusLabel(undisclosed), "Generation request needs review");
  assert.match(generationAttemptExplanation(undisclosed), /Generation has not been confirmed/);
  for (const code of ["MAGICLIGHT_TIMEOUT", "MAGICLIGHT_TRANSPORT_FAILED"]) {
    assert.match(generationDiagnosticExplanation({ ...legacy, diagnostic: { code } }), /may have been accepted/);
  }
  assert.match(generationDiagnosticExplanation({ ...legacy, diagnostic: { code: "MAGICLIGHT_HTTP_REJECTED" } }), /does not confirm whether a job was created/);
  const processing = { ...legacy, status: "processing", recovery: undefined, diagnostic: undefined };
  assert.equal(generationDiagnosticExplanation(processing), null);
  assert.match(generationAttemptExplanation(processing), /accepted the saved request/);
  assert.match(generationAttemptExplanation({ ...processing, status: "submitting" }), /Acceptance has not yet been confirmed/);
  assert.equal(generationDiagnosticExplanation({ ...processing, status: "failed" }), null);
});
