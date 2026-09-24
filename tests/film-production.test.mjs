import test from "node:test";
import assert from "node:assert/strict";
import { buildFilmManifest, createFilmProductionService, fictionalOperatorProject, productionJobPath, validateProviderOutput } from "../api/_lib/film-production.mjs";
import { userPath } from "../api/_lib/auth.mjs";

const email = "customer@example.invalid";
const owner = { email: "erik@brocotech.ai", role: "owner", status: "active" };
const idempotencyKey = "fictional-test-request-001";
const at = Date.parse("2026-09-14T12:00:00Z");
function store() {
  const records = new Map(); let revision = 0;
  return { records,
    readRecordImpl: async path => records.has(path) ? structuredClone(records.get(path)) : null,
    writeRecordImpl: async (path, value, etag) => {
      if (records.has(path) ? records.get(path).etag !== etag : etag !== undefined) throw new Error("precondition failed");
      records.set(path, { value: structuredClone(value), etag: `etag-${++revision}` });
    },
  };
}
function adapter(overrides = {}) {
  // In-memory mock of production branching only. These fabricated capabilities,
  // grants and outputs are not provider approval or production readiness evidence.
  return { id: "magiclight", environment: "production", available: true,
    evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true }, outputHosts: ["media.example.invalid"],
    validateManifest: async () => ({ ready: true, maximumCostCents: 300 }),
    quote: async ({ manifestHash }) => ({ manifestHash, quoteReference: "fixture-price-1", currency: "USD", providerCostCents: 300, expiresAt: new Date(at + 60_000).toISOString() }),
    submitShot: async ({ shot }) => ({ status: "queued", providerJobId: `fixture-job-${shot.id}` }),
    reconcileShot: async () => ({ status: "uncertain" }),
    pollShot: async ({ providerJobId }) => ({ status: "completed", providerJobId, output: { url: "https://media.example.invalid/fixture.mp4?token=private-test-token", contentType: "video/mp4", sizeBytes: 200, durationSeconds: 5 } }),
    ...overrides,
  };
}
const grant = async ({ manifestHash }) => ({ allowed: true, manifestHash, environment: "production", budgetCents: 300, expiresAt: new Date(at + 600_000).toISOString(), fictionalOnly: false });
const prepare = (service, overrides = {}) => service.prepare({ email, project: fictionalOperatorProject(), idempotencyKey, preparationConsent: true, ...overrides });

test("manifest preserves reviewed screenplay, hashes evidence, sets exact target timing and excludes client provider flags", () => {
  assert.equal(buildFilmManifest(fictionalOperatorProject()).manifestHash, "18e3e118024fbae9006336b9de74187777bcf8126ac83ee7929d74eee16ee46f", "previously prepared valid films keep their exact manifest hash");
  const project = fictionalOperatorProject(); project.apiVerified = true; project.providerKey = "must-not-save"; project.outputUrl = "https://untrusted.invalid";
  const result = buildFilmManifest(project);
  assert.equal(result.manifest.shots.reduce((sum, shot) => sum + shot.targetDurationMs, 0), 15000);
  assert.equal(result.manifest.shots.at(-1).startMs + result.manifest.shots.at(-1).targetDurationMs, 15000);
  assert.equal(result.manifest.continuity.length, 2); assert.equal(result.manifest.qualityVerified, false);
  assert.equal(result.manifestHash, buildFilmManifest(structuredClone(project)).manifestHash);
  project.scenes[0].narration = "A revised fictional opening.";
  assert.notEqual(result.manifestHash, buildFilmManifest(project).manifestHash);
  assert.doesNotMatch(JSON.stringify(result), /must-not-save|apiVerified|outputUrl|providerKey|"script"|"text"/);
});

test("malformed film fields, invalid source IDs, duration and oversized screenplay fail before persistence", async () => {
  const data = store(), service = createFilmProductionService(data);
  for (const change of [p => p.scenes[0].sourceIds = "invalid", p => p.scenes[0].characterIds.push({ id: "invalid" }),
    p => p.characters = {}, p => p.scenes = [], p => p.scenes[0].dialogue = 42, p => p.assumptions = null,
    p => p.selectedThemes[0].reason = { text: "invalid" }, p => p.scenes.push(...Array(30).fill(p.scenes[0])),
    p => p.sources.push(p.sources[0]), p => p.sources[0].id = "@family-narrative", p => p.sources[0].id = " ",
    p => p.duration = 0, p => p.scenes[0].narration = "x".repeat(1_600_000)]) {
    const project = fictionalOperatorProject(); change(project);
    await assert.rejects(prepare(service, { project }));
  }
  assert.equal(data.records.size, 0);
});

test("photo evidence and edited references do not require a screenplay review to prepare pricing", async () => {
  const project = fictionalOperatorProject(), before = structuredClone(project);
  project.sources[0] = { id: "fictional-source", name: "fictional-garden.png", type: "image/png", text: "", note: "" };
  project.characters[0].basis = "inferred";
  project.characters[0].sourceIds.push("earlier-source-reference");
  project.scenes[0].characterIds.push("earlier-cast-reference");
  project.scenes[0].dramatization = "";
  const original = structuredClone(project), data = store(), service = createFilmProductionService(data);
  const prepared = await prepare(service, { project });
  const { manifest } = await service.manifest({ email, id: prepared.id });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(manifest.screenplay.characters, project.characters);
  assert.deepEqual(manifest.screenplay.scenes, project.scenes);
  assert.equal(manifest.sources[0].hasReadableText, false);
  assert.equal(manifest.sources[0].name, "fictional-garden.png");
  assert.deepEqual(project, original);
  assert.equal(manifest.screenplay.scenes[0].narration, before.scenes[0].narration);
});

test("one or two saved scenes and absent optional story metadata remain priceable without invented content", () => {
  for (const count of [1, 2]) {
    const project = fictionalOperatorProject();
    project.scenes = project.scenes.slice(0, count).map(({ title, narration, visual }) => ({ title, narration, visual }));
    delete project.characters; delete project.assumptions; delete project.selectedThemes; delete project.logline;
    const original = structuredClone(project), { manifest } = buildFilmManifest(project);
    assert.equal(manifest.shots.length, count);
    assert.equal(manifest.shots.reduce((sum, shot) => sum + shot.targetDurationMs, 0), project.duration * 1000);
    assert.deepEqual(manifest.screenplay.characters, []);
    assert.deepEqual(manifest.screenplay.assumptions, []);
    assert.deepEqual(manifest.screenplay.selectedThemes, []);
    assert.equal(manifest.screenplay.logline, "");
    assert.deepEqual(manifest.screenplay.scenes.map(({ title, narration, visual }) => ({ title, narration, visual })), project.scenes);
    assert.ok(manifest.screenplay.scenes.every(scene => !scene.dramatization && !scene.dialogue && !scene.characterIds.length));
    assert.deepEqual(project, original);
  }
});

test("all 200 uploaded sources plus the family narrative can remain referenced", () => {
  const project = fictionalOperatorProject();
  project.sources = Array.from({ length: 200 }, (_, index) => ({ id: `source-${index}`, name: `Source ${index}`, type: "text/plain", text: "Fictional source." }));
  const ids = ["@family-narrative", ...project.sources.map(source => source.id)];
  project.characters[0].sourceIds = ids;
  project.scenes[0].sourceIds = ids;
  const { manifest } = buildFilmManifest(project);
  assert.deepEqual(manifest.screenplay.characters[0].sourceIds, ids);
  assert.deepEqual(manifest.screenplay.scenes[0].sourceIds, ids);
});

test("a very uneven script never creates zero-length or overlapping scene targets", () => {
  const project = fictionalOperatorProject();
  project.scenes[0].narration = "word ".repeat(100_000);
  project.scenes[1].narration = ""; project.scenes[2].narration = "";
  const { manifest } = buildFilmManifest(project);
  assert.equal(manifest.shots.reduce((sum, shot) => sum + shot.targetDurationMs, 0), 15_000);
  for (const [index, shot] of manifest.shots.entries()) {
    assert.ok(shot.targetDurationMs > 0);
    if (index) assert.equal(shot.startMs, manifest.shots[index - 1].startMs + manifest.shots[index - 1].targetDurationMs);
  }
});

test("preparation requires storage consent, remains private per account and is durable across service instances", async () => {
  const data = store(), service = createFilmProductionService(data);
  await assert.rejects(prepare(service, { preparationConsent: false }), /saved privately/);
  assert.equal(data.records.size, 0);
  const result = await prepare(service);
  assert.equal(result.status, "prepared"); assert.equal(result.preparationOnly, true);
  assert.equal((await createFilmProductionService(data).status({ email, id: result.id })).manifestHash, result.manifestHash);
  await assert.rejects(service.status({ email: "other@example.invalid", id: result.id }), e => e.status === 404);
  const downloaded = await service.manifest({ email, id: result.id }); downloaded.manifest.title = "Changed outside storage";
  assert.notEqual((await service.manifest({ email, id: result.id })).manifest.title, downloaded.manifest.title);
  assert.doesNotMatch(JSON.stringify(result), /magiclight|supplier|provider|media\.example/i);
});

test("concurrent and lost-response preparation retries reuse one immutable job; changed content conflicts", async () => {
  const data = store(), service = createFilmProductionService(data);
  const results = await Promise.all([prepare(service), prepare(service), prepare(service)]);
  assert.equal(new Set(results.map(r => r.id)).size, 1); assert.equal(data.records.size, 1);
  const project = fictionalOperatorProject(); project.title = "Changed title";
  await assert.rejects(prepare(service, { project }), e => e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await service.manifest({ email, id: results[0].id })).manifest.title, fictionalOperatorProject().title);
});

test("keys, environment flags and browser evidence never enable the default production adapter", async () => {
  const data = store(), service = createFilmProductionService(data);
  const project = { ...fictionalOperatorProject(), preparationConsent: true, apiVerified: true, qualityVerified: true, providerCostCents: 1 };
  await assert.rejects(service.quoteForPayment(project, { email }, { idempotencyKey }), e => e.code === "PRODUCTION_UNAVAILABLE");
  const job = await prepare(service);
  await assert.rejects(service.advance({ email, id: job.id, apiVerified: true, paid: true }), e => e.code === "PRODUCTION_UNAVAILABLE");
  assert.equal((await service.status({ email, id: job.id })).status, "prepared");
});

test("server quote is bound to validated immutable manifest and exact cost, never browser amounts", async () => {
  const data = store(), service = createFilmProductionService({ ...data, adapter: adapter(), now: () => at });
  const project = { ...fictionalOperatorProject(), preparationConsent: true, providerCostCents: 1, amountCents: 1 };
  const quote = await service.quoteForPayment(project, { email }, { idempotencyKey });
  assert.equal(quote.providerCostCents, 300); assert.equal(quote.manifestHash, buildFilmManifest(project).manifestHash);
  assert.equal(quote.amountCents, undefined); assert.equal(quote.environment, "production");
  const invalid = createFilmProductionService({ ...data, adapter: adapter({ quote: async () => ({ currency: "USD", providerCostCents: 1, manifestHash: "wrong" }) }), now: () => at });
  await assert.rejects(invalid.quoteForPayment(project, { email }, { idempotencyKey }), e => e.code === "PRODUCTION_UNAVAILABLE");
});

test("renewed quotes retain the owned prepared plan and use a separate stable provider retry key", async () => {
  const data = store(), calls = [];
  let time = at;
  const service = createFilmProductionService({ ...data, now: () => time, adapter: adapter({
    quote: async request => {
      calls.push(request);
      return { manifestHash: request.manifestHash, quoteReference: `fixture-price-${time}`, currency: "USD", providerCostCents: 300, expiresAt: new Date(time + 60_000).toISOString() };
    },
  }) });
  const prepared = await prepare(service), project = fictionalOperatorProject();
  const input = { preparedId: prepared.id, manifestHash: prepared.manifestHash, idempotencyKey: "first-price-request-001" };
  const first = await service.quoteForPayment(project, { email }, input);
  await service.quoteForPayment(project, { email }, input);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  time += 120_000;
  const renewed = await service.quoteForPayment(project, { email }, { ...input, idempotencyKey: "renew-price-request-002" });
  assert.equal(first.preparedId, prepared.id); assert.equal(renewed.preparedId, prepared.id);
  assert.equal(renewed.manifestHash, prepared.manifestHash);
  assert.notEqual(calls[0].idempotencyKey, calls[2].idempotencyKey);
  assert.notEqual(first.quoteReference, renewed.quoteReference);
  assert.equal(data.records.size, 1);
  assert.equal((await service.status({ email, id: prepared.id })).status, "prepared");
});

test("saved-plan pricing rejects changed content, foreign accounts and invalid references before provider calls", async () => {
  const data = store(); let providerCalls = 0;
  const service = createFilmProductionService({ ...data, now: () => at, adapter: adapter({
    validateManifest: async () => { providerCalls++; return { ready: true }; },
    quote: async () => { providerCalls++; },
  }) });
  const prepared = await prepare(service), project = fictionalOperatorProject();
  const input = { preparedId: prepared.id, manifestHash: prepared.manifestHash, idempotencyKey: "saved-price-request-001" };
  const changed = structuredClone(project); changed.scenes[0].narration = "A different opening scene.";
  await assert.rejects(service.quoteForPayment(changed, { email }, input), e => e.code === "PRODUCTION_PLAN_CHANGED");
  await assert.rejects(service.quoteForPayment(project, { email }, { ...input, manifestHash: "a".repeat(64) }), e => e.code === "PRODUCTION_PLAN_CHANGED");
  await assert.rejects(service.quoteForPayment(project, { email: "other@example.invalid" }, input), e => e.code === "PRODUCTION_NOT_FOUND");
  await assert.rejects(service.quoteForPayment(project, { email }, { ...input, preparedId: "../other" }), e => e.status === 400);
  await assert.rejects(service.quoteForPayment(project, { email }, { ...input, idempotencyKey: "short" }), e => e.status === 400);
  assert.equal(providerCalls, 0); assert.equal(data.records.size, 1);
});

test("a started plan cannot be priced again and owner test plans retain owner authorization", async () => {
  const data = store(); let priceCalls = 0;
  const service = createFilmProductionService({ ...data, now: () => at, authorize: grant, adapter: adapter({ quote: async () => { priceCalls++; } }) });
  const project = fictionalOperatorProject(), prepared = await prepare(service);
  await service.advance({ email, id: prepared.id });
  await assert.rejects(service.quoteForPayment(project, { email }, { preparedId: prepared.id, idempotencyKey }), e => e.code === "PRODUCTION_ALREADY_STARTED");
  await data.writeRecordImpl(userPath(owner.email), owner);
  const operatorPlan = await service.prepareOperatorTest({ actor: owner, idempotencyKey });
  await assert.rejects(service.quoteForPayment(project, { email: owner.email, role: "customer", status: "active" }, { preparedId: operatorPlan.id, idempotencyKey }), e => e.code === "OWNER_REQUIRED");
  assert.equal(priceCalls, 0);
});

test("no submit before trusted budget and matching environment authorization", async () => {
  let submissions = 0; const data = store();
  for (const authorize of [undefined, async args => ({ ...await grant(args), budgetCents: 299 }), async args => ({ ...await grant(args), environment: "sandbox" }), async args => ({ ...await grant(args), expiresAt: "invalid" }), async args => ({ ...await grant(args), fictionalOnly: true })]) {
    const service = createFilmProductionService({ ...data, adapter: adapter({ submitShot: async () => { submissions++; } }), now: () => at, authorize });
    const job = await prepare(service);
    await assert.rejects(service.advance({ email, id: job.id, paid: true, budgetCents: 999999 }));
  }
  assert.equal(submissions, 0);
});

test("uncertain submission never blindly resubmits; subsequent calls reconcile the same stable request key", async () => {
  let submitted = 0, reconciled = 0, requestKey;
  const data = store();
  const service = createFilmProductionService({ ...data, now: () => at, authorize: grant, adapter: adapter({
    submitShot: async request => { submitted++; requestKey = request.idempotencyKey; throw new Error("Timeout with private credential and provider output"); },
    reconcileShot: async request => { reconciled++; assert.equal(request.idempotencyKey, requestKey); return { status: "not-found" }; },
  }) });
  const job = await prepare(service);
  assert.equal((await service.advance({ email, id: job.id })).status, "uncertain");
  assert.equal((await service.advance({ email, id: job.id })).status, "uncertain");
  assert.equal(submitted, 1); assert.equal(reconciled, 1);
  assert.doesNotMatch(JSON.stringify(await service.status({ email, id: job.id })), /private credential|provider|Timeout/i);
});

test("concurrent advance obtains one durable lease and permits only one submit", async () => {
  let submitted = 0; const data = store();
  const service = createFilmProductionService({ ...data, now: () => at, authorize: grant, adapter: adapter({ submitShot: async () => { submitted++; return { status: "queued", providerJobId: "test-job" }; } }) });
  const job = await prepare(service);
  await Promise.all([service.advance({ email, id: job.id }), service.advance({ email, id: job.id })]);
  assert.equal(submitted, 1);
});

test("read-only reconciliation continues after the spending grant expires", async () => {
  let clock = at, checks = 0;
  const data = store();
  const service = createFilmProductionService({ ...data, now: () => clock, authorize: async args => { checks++; return grant(args); }, adapter: adapter({ submitShot: async () => { throw new Error("Ambiguous timeout"); } }) });
  const job = await prepare(service);
  await service.advance({ email, id: job.id });
  clock += 700_000;
  assert.equal((await service.advance({ email, id: job.id })).status, "uncertain");
  assert.equal(checks, 1);
});

test("a process crash after submit claim is reconciled after lease expiry, never resubmitted", async () => {
  let clock = at, submitted = 0, reconciled = 0; const data = store();
  const service = createFilmProductionService({ ...data, now: () => clock, authorize: grant, adapter: adapter({
    submitShot: async () => { submitted++; return { status: "queued", providerJobId: "test-job" }; },
    reconcileShot: async () => { reconciled++; return { status: "queued", providerJobId: "recovered-job" }; },
  }) });
  const job = await prepare(service); const path = productionJobPath(email, job.id), record = data.records.get(path);
  record.value.shots[0].status = "submitting"; record.value.status = "processing"; record.value.lease = { token: "interrupted-worker", expiresAt: at + 90_000 };
  await service.advance({ email, id: job.id }); assert.equal(reconciled, 0);
  clock += 90_001;
  await service.advance({ email, id: job.id }); assert.equal(reconciled, 1); assert.equal(submitted, 0);
});

test("provider output must be approved HTTPS media and cannot expose internal URLs to the customer", () => {
  const output = { url: "https://media.example.invalid/clip.mp4", contentType: "video/mp4", sizeBytes: 200, durationSeconds: 5 };
  assert.equal(validateProviderOutput(output, ["media.example.invalid"]).url, output.url);
  for (const url of ["http://media.example.invalid/a", "https://127.0.0.1/a", "https://media.example.invalid.evil.invalid/a", "https://user:pass@media.example.invalid/a", "https://media.example.invalid:444/a"]) {
    assert.throws(() => validateProviderOutput({ ...output, url }, ["media.example.invalid"]));
  }
  assert.throws(() => validateProviderOutput({ ...output, contentType: "text/html" }, ["media.example.invalid"]));
});

test("separate reviewed audio is validated, retained privately and never exposed in customer status", async () => {
  const audio = { url: "https://media.example.invalid/voice.m4a?token=private-audio", contentType: "audio/mp4", sizeBytes: 100, durationSeconds: 5 };
  const output = { url: "https://media.example.invalid/clip.mp4", contentType: "video/mp4", sizeBytes: 200, durationSeconds: 5, audio };
  assert.deepEqual(validateProviderOutput({ ...output, audio: { ...audio, apiKey: "do-not-retain", localPath: "private-file" } }, ["media.example.invalid"]), output);
  for (const invalidAudio of [null, { ...audio, url: "https://untrusted.invalid/voice.m4a" },
    { ...audio, url: "file:///voice.m4a" }, { ...audio, contentType: "text/html" },
    { ...audio, sizeBytes: 0 }, { ...audio, durationSeconds: Infinity }]) {
    assert.throws(() => validateProviderOutput({ ...output, audio: invalidAudio }, ["media.example.invalid"]));
  }
  const data = store();
  const service = createFilmProductionService({ ...data, now: () => at, authorize: grant, adapter: adapter({
    pollShot: async ({ providerJobId }) => ({ status: "completed", providerJobId, output }),
  }) });
  const job = await prepare(service);
  await service.advance({ email, id: job.id });
  const status = await service.advance({ email, id: job.id });
  assert.deepEqual((await service.getPrepared({ email, id: job.id })).shots[0].output.audio, audio);
  assert.doesNotMatch(JSON.stringify(status), /voice\.m4a|media\.example|private-audio/);
});

test("untrusted separate audio cannot move a completed provider result into assembly", async () => {
  const data = store();
  const service = createFilmProductionService({ ...data, now: () => at, authorize: grant, adapter: adapter({
    pollShot: async ({ providerJobId }) => ({ status: "completed", providerJobId, output: {
      url: "https://media.example.invalid/clip.mp4", contentType: "video/mp4", sizeBytes: 200, durationSeconds: 5,
      audio: { url: "https://other.invalid/voice.mp3", contentType: "audio/mpeg", sizeBytes: 100, durationSeconds: 5 },
    } }),
  }) });
  const job = await prepare(service);
  await service.advance({ email, id: job.id });
  assert.equal((await service.advance({ email, id: job.id })).status, "uncertain");
  assert.equal((await service.getPrepared({ email, id: job.id })).shots[0].output, undefined);
});

test("completed clips remain processing until actual private assembled media passes playback and duration verification", async () => {
  const data = store(); let verified = false;
  const service = createFilmProductionService({ ...data, now: () => at, authorize: grant, adapter: adapter(),
    verifyAssembledMedia: async ({ email, id, manifestHash }) => ({ playable: verified, manifestHash, pathname: productionJobPath(email, id).replace("jobs", "media").replace(".json", "/final.mp4"), sha256: "a".repeat(64), contentType: "video/mp4", sizeBytes: 2000, durationSeconds: 15, width: 1920, height: 1080, frameRate: 24 }),
  });
  const job = await prepare(service);
  for (let i = 0; i < 6; i++) await service.advance({ email, id: job.id });
  assert.equal((await service.status({ email, id: job.id })).status, "processing");
  assert.equal((await service.getPrepared({ email, id: job.id })).status, "awaiting-assembly");
  await assert.rejects(service.acceptAssembly({ email, id: job.id, manifestHash: job.manifestHash }), e => e.code === "OUTPUT_UNVERIFIED");
  verified = true;
  const result = await service.acceptAssembly({ email, id: job.id, manifestHash: job.manifestHash });
  assert.equal(result.status, "completed"); assert.equal(result.mediaReady, true);
  assert.equal((await service.getPrepared({ email, id: job.id })).media.height, 1080);
  assert.doesNotMatch(JSON.stringify(result), /private-test-token|media\.example|pathname|provider/);
});

test("owner test uses fixed fictional material and still requires a server budget; customer role cannot invoke it", async () => {
  const data = store(), service = createFilmProductionService({ ...data, now: () => at, adapter: adapter({ environment: "sandbox" }) });
  await assert.rejects(service.prepareOperatorTest({ actor: { email, role: "customer" }, idempotencyKey }), e => e.status === 403);
  await assert.rejects(service.prepareOperatorTest({ actor: owner, idempotencyKey }), e => e.code === "OWNER_REQUIRED");
  await data.writeRecordImpl(userPath(owner.email), owner);
  const job = await service.prepareOperatorTest({ actor: owner, idempotencyKey });
  assert.match((await service.manifest({ email: owner.email, id: job.id })).manifest.title, /SAMPLE ONLY - FICTIONAL DATA/);
  await assert.rejects(service.advance({ email: owner.email, id: job.id, actor: owner }), e => e.code === "PRODUCTION_AUTHORIZATION_REQUIRED");
  await assert.rejects(service.advance({ email: owner.email, id: job.id, actor: { email: owner.email, role: "customer" } }), e => e.status === 403);
});

test("a persisted legacy owner can prepare the fixed operator plan while unavailable rendering remains blocked", async () => {
  const legacy = { email: owner.email, role: "owner" };
  for (const [actor, current] of [[legacy, legacy], [owner, legacy], [legacy, owner]]) {
    const data = store();
    await data.writeRecordImpl(userPath(owner.email), current);
    const original = structuredClone(data.records.get(userPath(owner.email)));
    const service = createFilmProductionService({ ...data, now: () => at });
    const job = await service.prepareOperatorTest({ actor, idempotencyKey });
    assert.equal(job.status, "prepared");
    assert.equal(data.records.get(productionJobPath(owner.email, job.id)).value.mode, "operator-test");
    assert.equal(job.manifestHash, buildFilmManifest(fictionalOperatorProject()).manifestHash);
    assert.equal((await service.prepareOperatorTest({ actor, idempotencyKey })).id, job.id);
    await assert.rejects(service.advance({ email: owner.email, id: job.id, actor }), error => error.code === "PRODUCTION_UNAVAILABLE");
    assert.deepEqual(data.records.get(userPath(owner.email)), original);
    assert.equal(data.records.size, 2);
  }
});

test("operator preparation requires both current and session owner roles without suspension or password setup", async () => {
  const legacy = { email: owner.email, role: "owner" };
  for (const invalid of [null, { email: owner.email }, { ...owner, role: "customer" }, { ...owner, role: "admin" },
    { ...owner, email }, { ...owner, status: "suspended" }, { ...owner, mustChangePassword: true }]) {
    for (const [actor, current] of [[invalid, legacy], [legacy, invalid]]) {
      const data = store();
      await data.writeRecordImpl(userPath(owner.email), current);
      const before = structuredClone([...data.records]);
      const service = createFilmProductionService({ ...data, now: () => at });
      await assert.rejects(service.prepareOperatorTest({ actor, idempotencyKey }), error => error.code === "OWNER_REQUIRED");
      assert.deepEqual([...data.records], before);
    }
  }
});

test("sandbox refuses normal customer plans even for the owner and ignores a caller's fictional-only claim", async () => {
  const data = store(); let calls = 0;
  await data.writeRecordImpl(userPath(owner.email), owner);
  const service = createFilmProductionService({ ...data, now: () => at,
    adapter: adapter({ environment: "sandbox", validateManifest: async () => { calls++; return { ready: true, maximumCostCents: 300 }; },
      quote: async () => { calls++; }, submitShot: async () => { calls++; } }),
    authorize: async args => ({ ...await grant(args), environment: "sandbox", fictionalOnly: true }) });
  for (const actor of [{ email, role: "customer", status: "active" }, owner]) {
    const project = fictionalOperatorProject();
    const job = await prepare(service, { email: actor.email, project });
    await assert.rejects(service.quoteForPayment(project, actor, { preparedId: job.id, idempotencyKey }), e => e.code === "SANDBOX_OPERATOR_REQUIRED");
    await assert.rejects(service.advance({ email: actor.email, id: job.id, actor, fictionalOnly: true }), e => e.code === "SANDBOX_OPERATOR_REQUIRED");
  }
  assert.equal(calls, 0);
});

test("operator-test mode cannot authorize altered family material or a tampered saved sample", async () => {
  const mutations = [
    job => { job.manifest.title = "A real family story"; },
    job => { job.manifestHash = "f".repeat(64); },
    job => { job.shots[0].id = "arbitrary-shot"; },
  ];
  for (const mutate of mutations) {
    const data = store(); let calls = 0;
    await data.writeRecordImpl(userPath(owner.email), owner);
    const service = createFilmProductionService({ ...data, now: () => at,
      adapter: adapter({ environment: "sandbox", validateManifest: async () => { calls++; }, submitShot: async () => { calls++; } }),
      authorize: async args => ({ ...await grant(args), environment: "sandbox", fictionalOnly: true }) });
    const job = await service.prepareOperatorTest({ actor: owner, idempotencyKey });
    mutate(data.records.get(productionJobPath(owner.email, job.id)).value);
    await assert.rejects(service.advance({ email: owner.email, id: job.id, actor: owner }), e => e.code === "OPERATOR_PLAN_REQUIRED");
    await assert.rejects(service.quoteForPayment(fictionalOperatorProject(), owner, { preparedId: job.id, idempotencyKey }),
      e => ["OPERATOR_PLAN_REQUIRED", "PRODUCTION_PLAN_CHANGED"].includes(e.code));
    assert.equal(calls, 0);
  }
  const data = store(); await data.writeRecordImpl(userPath(owner.email), owner);
  const service = createFilmProductionService({ ...data, now: () => at, adapter: adapter({ environment: "sandbox" }) });
  const project = fictionalOperatorProject(); project.scenes[0].narration = "User-provided private family history.";
  const forged = await prepare(service, { email: owner.email, project, mode: "operator-test" });
  await assert.rejects(service.quoteForPayment(project, owner, { preparedId: forged.id, idempotencyKey }), e => e.code === "OPERATOR_PLAN_REQUIRED");
});

test("a fixed sandbox sample quotes and submits only for the persisted active owner and a fictional grant", async () => {
  const data = store(); let submits = 0, polls = 0;
  await data.writeRecordImpl(userPath(owner.email), owner);
  const service = createFilmProductionService({ ...data, now: () => at,
    adapter: adapter({ environment: "sandbox", submitShot: async () => { submits++; return { status: "queued", providerJobId: "fictional-job" }; },
      pollShot: async () => { polls++; return { status: "processing", providerJobId: "fictional-job" }; } }),
    authorize: async args => ({ ...await grant(args), environment: "sandbox", fictionalOnly: true }) });
  const job = await service.prepareOperatorTest({ actor: owner, idempotencyKey });
  assert.equal((await service.quoteForPayment(fictionalOperatorProject(), owner, { preparedId: job.id, idempotencyKey })).environment, "sandbox");
  for (const mutation of [{ role: "customer" }, { status: "suspended" }, { mustChangePassword: true }]) {
    data.records.get(userPath(owner.email)).value = { ...owner, ...mutation };
    await assert.rejects(service.advance({ email: owner.email, id: job.id, actor: owner }), e => e.code === "OWNER_REQUIRED");
    await assert.rejects(service.quoteForPayment(fictionalOperatorProject(), owner, { preparedId: job.id, idempotencyKey }), e => e.code === "OWNER_REQUIRED");
  }
  assert.equal(submits, 0);
  data.records.get(userPath(owner.email)).value = { ...owner };
  await service.advance({ email: owner.email, id: job.id, actor: owner }); assert.equal(submits, 1);
  data.records.get(userPath(owner.email)).value.status = "suspended";
  await assert.rejects(service.advance({ email: owner.email, id: job.id, actor: owner }), e => e.code === "OWNER_REQUIRED");
  assert.equal(polls, 0);
  data.records.get(userPath(owner.email)).value = { ...owner };
  await service.advance({ email: owner.email, id: job.id, actor: owner }); assert.equal(polls, 1);
  const unrestricted = createFilmProductionService({ ...data, now: () => at, adapter: adapter({ environment: "sandbox" }),
    authorize: async args => ({ ...await grant(args), environment: "sandbox", fictionalOnly: false }) });
  const next = await unrestricted.prepareOperatorTest({ actor: owner, idempotencyKey: "fictional-other-test-002" });
  await assert.rejects(unrestricted.advance({ email: owner.email, id: next.id, actor: owner }), e => e.code === "PRODUCTION_AUTHORIZATION_REQUIRED");
});
