import test from "node:test";
import assert from "node:assert/strict";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { FAL_MODELS } from "../api/_lib/fal-client.mjs";
import { falAdapterForSavedProvider, falPlan, FAL_RECIPE_VERSION, FAL_LEGACY_RECIPE_VERSION } from "../api/_lib/fal-production.mjs";
import { buildFilmManifest, createFilmProductionService, fictionalOperatorProject, FilmProductionError, productionJobPath } from "../api/_lib/film-production.mjs";
import { planKlingShots } from "../api/_lib/kling-film-plan.mjs";
import { createProductionQueue, productionQueuePath } from "../api/_lib/production-queue.mjs";

const email = "migration-fixture@example.invalid";
const actor = { email, role: "customer", status: "active", approvedBy: "owner@example.invalid", approvedAt: "2026-10-20T00:00:00Z" };
const orderId = "a".repeat(64);
const at = Date.parse("2026-10-20T12:00:00Z");

test("long Kling preparations report reviewed scenes separately from generated cuts", async () => {
  const data = storage();
  const service = createFilmProductionService({ ...data, now: () => at, adapter: klingAdapter() });
  const project = { ...fictionalOperatorProject(), duration: 600 };
  const prepared = await service.prepare({ email, project, preparationConsent: true, idempotencyKey: "long-kling-scenes" });
  assert.equal(prepared.sceneCount, project.scenes.length);
  assert.ok(prepared.sceneCount <= 30);
  assert.ok(prepared.shotCount > 30);
  const saved = (await data.read(productionJobPath(email, prepared.id))).value;
  assert.equal(prepared.shotCount, saved.manifest.shots.length);
  assert.equal(prepared.durationSeconds, 600);
});

function storage() {
  const records = new Map();
  let revision = 0;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw new Error("precondition failed");
    const record = { value: structuredClone(value), etag: `fixture-${++revision}` };
    records.set(path, record);
    return structuredClone(record);
  };
  return { records, read, write, readRecordImpl: read, writeRecordImpl: write };
}

// All requests, authorizations, media and clocks in this file are local
// fixtures. No provider, payment, production readiness or quality is claimed.
function klingAdapter(overrides = {}) {
  return {
    id: "fal", model: "kling", modelVersion: FAL_RECIPE_VERSION, environment: "production",
    available: true, maxConcurrentShots: 4, outputHosts: ["current.example.invalid"],
    evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true },
    validateManifest: async () => ({ ready: true, maximumCostCents: 300 }),
    quote: async () => assert.fail("Unexpected pricing operation"),
    submitShot: async () => assert.fail("Unexpected new production"),
    pollShot: async () => assert.fail("Unexpected Kling polling"),
    reconcileShot: async () => assert.fail("Unexpected Kling reconciliation"),
    ...overrides,
  };
}

async function legacyFixture({ model = "wan", states = ["queued", "queued", "queued"], missing = false, savedProvider } = {}) {
  const data = storage(), calls = { submitted: 0, polled: [], authorized: 0, selected: [] };
  const old = createFilmProductionService({ ...data, now: () => at, adapter: { id: "fal", model } });
  const prepared = await old.prepare({ email, project: fictionalOperatorProject(), preparationConsent: true, idempotencyKey: "migration-legacy-fixture" });
  const path = productionJobPath(email, prepared.id), record = await data.read(path), original = structuredClone(record.value);
  const operations = new Map();
  const provider = savedProvider || { id: "fal", model, recipe: FAL_LEGACY_RECIPE_VERSION };
  const job = { ...record.value, provider, status: "processing" };
  job.shots.forEach((shot, index) => {
    shot.status = states[index];
    if (shot.status === "prepared") return;
    const identity = digest(`${FAL_LEGACY_RECIPE_VERSION}:${model}:${shot.requestKey}`);
    if (shot.status !== "submitting") shot.providerJobId = `fal-${identity}`;
    shot.submittedAt = new Date(at - (states.length - index) * 1000).toISOString();
    if (!missing) operations.set(identity, { identity, endpoint: FAL_MODELS[model], state: "queued", requestId: `saved-request-${index}` });
  });
  await data.write(path, job, record.etag);
  const client = {
    get: async identity => structuredClone(operations.get(identity) || null),
    submit: async () => { calls.submitted++; throw new Error("No new legacy submission is permitted"); },
    poll: async identity => {
      calls.polled.push(identity);
      const operation = operations.get(identity);
      assert.ok(operation);
      const completed = { ...operation, state: "completed", result: { video: { url: "https://v3.fal.media/legacy-fixture.mp4" } } };
      operations.set(identity, completed);
      return structuredClone(completed);
    },
  };
  const service = createFilmProductionService({
    ...data, now: () => at,
    // Saved operations remain pollable even while new Kling production is unavailable.
    adapter: klingAdapter({ available: false }),
    authorize: async () => { calls.authorized++; throw new Error("No fresh spending grant for legacy polling"); },
    adapterForSavedProvider: binding => {
      calls.selected.push(structuredClone(binding));
      return falAdapterForSavedProvider(binding, { client, read: data.read, key: () => "",
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://v3.fal.media/legacy-fixture.mp4");
          assert.equal(init.method, "HEAD");
          return new Response(null, { headers: { "content-type": "video/mp4", "content-length": "100" } });
        } });
    },
  });
  return { ...data, calls, service, prepared, path, original, provider, operations };
}

test("the film service completes saved Wan and Seedance requests using their original bindings without new production", async () => {
  for (const model of ["wan", "seedance"]) {
    const f = await legacyFixture({ model });
    for (let i = 0; i < 3; i++) await f.service.advance({ email, id: f.prepared.id, actor, authorizationReference: orderId });
    const saved = (await f.read(f.path)).value;
    assert.equal(saved.status, "awaiting-assembly");
    assert.deepEqual(saved.provider, f.provider);
    assert.deepEqual(saved.manifest, f.original.manifest);
    assert.equal(saved.manifestHash, f.original.manifestHash);
    assert.equal(digest(JSON.stringify(saved.manifest)), saved.manifestHash);
    assert.deepEqual(saved.shots.map(shot => shot.requestKey), f.original.shots.map(shot => shot.requestKey));
    assert.ok(saved.shots.every(shot => shot.status === "completed" && shot.output.url.startsWith("https://v3.fal.media/")));
    assert.equal(new Set(f.calls.polled).size, 3);
    assert.ok(f.calls.selected.every(binding => JSON.stringify(binding) === JSON.stringify(f.provider)));
    assert.equal(f.calls.submitted, 0);
    assert.equal(f.calls.authorized, 0);
  }
});

test("every saved in-flight legacy state is reconciled before unstarted scenes require review", async () => {
  for (const state of ["queued", "processing", "submitting", "uncertain"]) {
    const f = await legacyFixture({ states: ["prepared", state, "prepared"] });
    await f.service.advance({ email, id: f.prepared.id });
    const saved = (await f.read(f.path)).value;
    assert.deepEqual(saved.shots.map(shot => shot.status), ["prepared", "completed", "prepared"]);
    await assert.rejects(f.service.advance({ email, id: f.prepared.id }), error => error.code === "PRODUCTION_PROVIDER_MISMATCH");
    assert.equal(f.calls.polled.length, 1);
    assert.equal(f.calls.submitted, 0);
    assert.equal(f.calls.authorized, 0);
    assert.deepEqual((await f.read(f.path)).value.manifest, f.original.manifest);
  }
});

test("a missing legacy operation remains uncertain and is never recreated as a legacy or Kling render", async () => {
  const f = await legacyFixture({ states: ["uncertain", "prepared", "prepared"], missing: true });
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.service.advance({ email, id: f.prepared.id })).status, "uncertain");
  }
  assert.equal(f.calls.polled.length, 0);
  assert.equal(f.calls.submitted, 0);
  assert.equal(f.calls.authorized, 0);
  assert.deepEqual((await f.read(f.path)).value.shots.map(shot => shot.status), ["uncertain", "prepared", "prepared"]);
});

test("unsupported saved provider and recipe bindings stop before any provider operation", async () => {
  for (const savedProvider of [
    { id: "other", model: "wan", recipe: FAL_LEGACY_RECIPE_VERSION },
    { id: "fal", model: "wan", recipe: FAL_RECIPE_VERSION },
    { id: "fal", model: "seedance", recipe: "unrecognized-recipe" },
    { id: "fal", model: "kling", recipe: FAL_LEGACY_RECIPE_VERSION },
  ]) {
    const f = await legacyFixture({ savedProvider });
    await assert.rejects(f.service.advance({ email, id: f.prepared.id }), error => error.code === "PRODUCTION_PROVIDER_MISMATCH");
    assert.equal(f.calls.polled.length, 0);
    assert.equal(f.calls.submitted, 0);
    assert.equal(f.calls.authorized, 0);
    assert.deepEqual((await f.read(f.path)).value.manifest, f.original.manifest);
  }
});

async function queueFixture() {
  const data = storage();
  let time = at, failure = null, advances = 0;
  const film = createFilmProductionService({ ...data, adapter: klingAdapter(), now: () => time });
  await data.write(userPath(email), actor);
  const prepared = await film.prepare({ email, project: fictionalOperatorProject(), preparationConsent: true, idempotencyKey: "migration-queue-fixture" });
  const queue = createProductionQueue({ read: data.read, write: data.write, now: () => time,
    setIntervalImpl: () => 1, clearIntervalImpl: () => {},
    film: { ...film, advance: async () => { advances++; if (failure) throw failure; } },
    paymentService: { authorizeProduction: async ({ manifestHash }) => ({ allowed: true, manifestHash }) } });
  await queue.enqueue({ actor, id: prepared.id, orderId });
  const path = productionQueuePath(email, prepared.id);
  return { ...data, queue, film, path, prepared,
    setFailure: value => { failure = value; },
    advances: () => advances,
    run: async () => { time = Math.max(time, (await data.read(path)).value.nextAttemptAt); return queue.runTicket(path); } };
}

test("temporary production errors retry with backoff and stop on the tenth consecutive failure", async () => {
  for (const code of ["PRODUCTION_UNAVAILABLE", "PRODUCTION_GRANT_EXPIRED", "ASSEMBLY_CLAIM_EXPIRED", null]) {
    const f = await queueFixture();
    f.setFailure(code ? new FilmProductionError("private-error-not-for-customer", 503, code) : new Error("private-error-not-for-customer"));
    let previousAttemptAt = at;
    for (let attempt = 1; attempt <= 10; attempt++) {
      assert.deepEqual(await f.run(), { state: attempt === 10 ? "attention" : "pending" });
      const ticket = (await f.read(f.path)).value;
      assert.equal(ticket.attempts, attempt);
      assert.equal(ticket.lastResult, attempt === 10 ? "REVIEW_REQUIRED" : "RETRYABLE_FAILURE");
      assert.equal(ticket.nextAttemptAt - previousAttemptAt, Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6)));
      previousAttemptAt = ticket.nextAttemptAt;
      assert.equal(ticket.lease, undefined);
      assert.doesNotMatch(JSON.stringify(ticket), /private-error-not-for-customer/);
    }
    assert.deepEqual(await f.run(), { state: "skipped" });
    assert.equal(f.advances(), 10);
  }
});

test("authorization, provider, output, plan and access failures require review immediately", async () => {
  for (const code of ["PRODUCTION_AUTHORIZATION_REQUIRED", "PRODUCTION_PROVIDER_MISMATCH", "PRODUCTION_CONFLICT",
    "PRODUCTION_ACCESS_REQUIRED", "OUTPUT_UNVERIFIED", "PRODUCTION_REVIEW_REQUIRED", "UNRECOGNIZED_PRODUCTION_ERROR"]) {
    const f = await queueFixture();
    f.setFailure(new FilmProductionError("private-error-not-for-customer", 403, code));
    assert.deepEqual(await f.run(), { state: "attention" });
    const ticket = (await f.read(f.path)).value;
    assert.equal(ticket.attempts, 1);
    assert.equal(ticket.lastResult, "REVIEW_REQUIRED");
    assert.deepEqual(await f.run(), { state: "skipped" });
    assert.equal(f.advances(), 1);
    assert.doesNotMatch(JSON.stringify(await f.queue.status({ email, id: f.prepared.id })), /private-error-not-for-customer|UNRECOGNIZED_PRODUCTION_ERROR/);
  }
});

test("a changed ticket manifest is an immediate conflict before any advancement", async () => {
  const f = await queueFixture(), ticket = await f.read(f.path);
  await f.write(f.path, { ...ticket.value, manifestHash: "b".repeat(64) }, ticket.etag);
  assert.deepEqual(await f.run(), { state: "attention" });
  assert.equal(f.advances(), 0);
  assert.equal((await f.read(f.path)).value.lastResult, "REVIEW_REQUIRED");
});

test("successful progress resets the consecutive-failure limit and explicit resume resets reviewed tickets", async () => {
  const f = await queueFixture();
  f.setFailure(new FilmProductionError("temporary", 503, "PRODUCTION_UNAVAILABLE"));
  for (let i = 0; i < 9; i++) await f.run();
  f.setFailure(null);
  assert.deepEqual(await f.run(), { state: "pending" });
  assert.equal((await f.read(f.path)).value.attempts, 0);
  assert.equal((await f.read(f.path)).value.lastResult, "PROGRESS");
  f.setFailure(new FilmProductionError("temporary", 409, "PRODUCTION_GRANT_EXPIRED"));
  assert.deepEqual(await f.run(), { state: "pending" });
  assert.equal((await f.read(f.path)).value.attempts, 1);
  f.setFailure(new FilmProductionError("review", 409, "PRODUCTION_PROVIDER_MISMATCH"));
  assert.deepEqual(await f.run(), { state: "attention" });
  const reviewed = await f.read(f.path);
  await f.write(f.path, { ...reviewed.value, lastFailure: { stage: "speech-review", reason: "SPEECH_SCRIPT_MISMATCH" } }, reviewed.etag);
  await f.queue.enqueue({ actor, id: f.prepared.id, orderId });
  const resumed = (await f.read(f.path)).value;
  assert.equal(resumed.state, "pending");
  assert.equal(resumed.attempts, 0);
  assert.equal(resumed.lastResult, "RESUMED");
  assert.equal(resumed.lastFailure, null);
});

const words = value => value.trim().split(/\s+/).filter(Boolean);
function dialogueTokens(value) {
  let speaker = "";
  return value.split(/\r?\n/).flatMap(line => {
    const label = line.match(/^([^:\n]{1,100}:)\s*(.*)$/);
    if (label) speaker = label[1];
    return words(label?.[2] ?? line).map(word => ({ speaker, word }));
  });
}

test("split cuts preserve exact narration, dialogue speakers, numerals and scene metadata through 600 seconds", () => {
  for (const duration of [31, 61, 121, 599, 600]) {
    const project = fictionalOperatorProject();
    project.duration = duration;
    project.scenes = project.scenes.slice(0, 2).map((scene, index) => ({ ...scene,
      narration: `In 1847, Ada carried keepsake-${index}. ${Array.from({ length: 16 }, (_, n) => `narration${index}word${n}`).join(" ")}.`,
      dialogue: `Ada: We kept 12 letters, ${Array.from({ length: 16 }, (_, n) => `ada${index}word${n}`).join(" ")}.\nThe family's story continues.\nAlice: ${Array.from({ length: 20 }, (_, n) => `alice${index}word${n}`).join(" ")}.`,
    }));
    const { manifest } = buildFilmManifest(project), original = structuredClone(manifest);
    const planned = planKlingShots(manifest);
    assert.deepEqual(manifest, original);
    assert.deepEqual(planned.screenplay, original.screenplay);
    assert.equal(planned.targetDurationSeconds, duration);
    let start = 0;
    for (const [index, cut] of planned.shots.entries()) {
      assert.equal(cut.startMs, start);
      assert.ok(cut.targetDurationMs >= 3000 && cut.targetDurationMs <= 15000);
      assert.equal(cut.continuity.precedingShotId, index ? planned.shots[index - 1].id : null);
      start += cut.targetDurationMs;
    }
    assert.equal(start, duration * 1000);
    for (const scene of original.shots) {
      const cuts = planned.shots.filter(cut => cut.sceneIndex === scene.sceneIndex);
      assert.deepEqual(cuts.flatMap(cut => words(cut.narration)), words(scene.narration));
      assert.deepEqual(cuts.flatMap(cut => dialogueTokens(cut.dialogue)), dialogueTokens(scene.dialogue));
      assert.equal(cuts.reduce((sum, cut) => sum + cut.targetDurationMs, 0), scene.targetDurationMs);
      for (const cut of cuts) {
        assert.equal(cut.visual, scene.visual);
        assert.equal(cut.dramatization, scene.dramatization);
        assert.deepEqual(cut.characterIds, scene.characterIds);
      }
    }
    // Long plans stay priceable under the actual adapter's shared plan rules.
    // The short duration deliberately has too many words and must fail, not truncate.
    if (duration >= 61) assert.equal(falPlan(planned, "kling").shots.length, planned.shots.length);
    else assert.throws(() => falPlan(planned, "kling"));
  }
});
