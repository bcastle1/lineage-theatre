import { createHash, randomUUID } from "node:crypto";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { isOwner } from "./access.mjs";
import { prepareStory, validateStory } from "./story.mjs";
import { verifiedMediaProfile } from "./media-profile.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1_500_000;
export const FILM_PREPARATION_CONSENT = "Save this screenplay, cast, and production plan privately in Lineage Theatre with administrator access.";
export const MAGICLIGHT_GAPS = Object.freeze([
  "Account API entitlement and documented authentication",
  "Supported clip submission, upload, status, output and reconciliation contract",
  "Verified account quality tiers, clip limits and exact job costs",
  "Character reference, voice, music and continuity capabilities",
  "API commercial and in-app resale permission",
  "Durable media assembly worker and private playable output verification",
]);

export class FilmProductionError extends Error {
  constructor(message, status = 400, code = "INVALID_PRODUCTION_REQUEST") { super(message); this.status = status; this.code = code; }
}
const unavailable = () => new FilmProductionError("Film production is not available yet. You can continue preparing your screenplay.", 503, "PRODUCTION_UNAVAILABLE");
const invalid = message => { throw new FilmProductionError(message); };
const clone = value => structuredClone(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function owner(email) {
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email)) invalid("Sign in to prepare this film.");
  return email.toLowerCase();
}
function reference(id) { if (typeof id !== "string" || !UUID.test(id)) invalid("Choose a valid production reference."); return id; }
function key(value) { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) invalid("Begin a new production preparation request."); return value; }
function textField(value, label, max = 20_000) {
  if (typeof value !== "string" || value.length > max) invalid(`${label} is missing or too long.`);
  return value;
}
function select(value, fields) { return Object.fromEntries(fields.map(field => [field, value?.[field]])); }
function conflict(error) { return /precondition|already exists|etag|if.?match/i.test(`${error?.name} ${error?.message}`); }
export const productionJobPath = (email, id) => `production/jobs/${digest(owner(email))}/${reference(id)}.json`;

// App timing targets, not a claim about a provider's supported clip lengths.
// The immutable manifest keeps evidence hashes, not uploaded family source files.
export function buildFilmManifest(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) invalid("Review a screenplay before preparing your film.");
  reference(project.id);
  const title = textField(project.title, "The film title", 200).trim();
  if (!title) invalid("Add a title before preparing your film.");
  if (!Number.isSafeInteger(project.duration) || project.duration < 15 || project.duration > 600) invalid("Choose a film length between 15 and 600 seconds.");
  const { family } = prepareStory({ project });
  const screenplay = {
    logline: project.logline,
    selectedThemes: project.selectedThemes?.map(t => select(t, ["title", "plot", "climax", "reason"])),
    characters: project.characters?.map(c => select(c, ["id", "name", "role", "description", "basis", "sourceIds"])),
    assumptions: project.assumptions?.map(a => select(a, ["id", "description", "reason"])),
    scenes: project.scenes?.map(s => select(s, ["title", "narration", "visual", "sourceIds", "characterIds", "dialogue", "dramatization"])),
  };
  try { validateStory(screenplay, "plan", family); }
  catch { invalid("Review the screenplay, cast, source references, and dramatization notes before preparing your film."); }
  const safeScreenplay = clone(screenplay);
  if (Buffer.byteLength(JSON.stringify(safeScreenplay)) > MAX_MANIFEST_BYTES) invalid("This screenplay is too large for a single production plan.");
  const weights = safeScreenplay.scenes.map(s => Math.max(1, `${s.narration} ${s.dialogue}`.trim().split(/\s+/).filter(Boolean).length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const minimumSceneMs = Math.floor(project.duration * 1000 / (weights.length * 2));
  const weightedRuntimeMs = project.duration * 1000 - minimumSceneMs * weights.length;
  let position = 0, consumedWeight = 0;
  const shots = safeScreenplay.scenes.map((scene, index) => {
    consumedWeight += weights[index];
    const end = index === weights.length - 1 ? project.duration * 1000 : (index + 1) * minimumSceneMs + Math.round(consumedWeight / totalWeight * weightedRuntimeMs);
    const shot = { id: `shot-${String(index + 1).padStart(3, "0")}`, sceneIndex: index, startMs: position, targetDurationMs: end - position, ...scene,
      continuity: { characterIds: [...scene.characterIds], referenceStatus: "requires-verification", precedingShotId: index ? `shot-${String(index).padStart(3, "0")}` : null } };
    position = end;
    return shot;
  });
  const sources = family.sources.map(source => ({ id: source.id, name: source.name, type: source.type, evidenceHash: hash({ text: source.text, note: source.note }), hasReadableText: Boolean(source.text.trim() || source.note.trim()) }));
  const manifest = {
    version: 1, filmId: project.id, title, ancestor: family.ancestor, era: family.era,
    style: project.style === "Documentary" ? "Documentary" : "Cinematic", factuality: family.factuality,
    targetDurationSeconds: project.duration, qualityPreference: "highest", qualityVerified: false,
    screenplay: safeScreenplay, shots, sources, narrativeEvidenceHash: hash(family.script),
    sound: { musicRequested: project.music === true, narration: "requires-voice-and-timing-verification", dialogue: "requires-voice-and-timing-verification", captions: "derive-from-reviewed-spoken-script" },
    continuity: safeScreenplay.characters.map(c => ({ characterId: c.id, appearance: c.description, sourceIds: [...c.sourceIds], referenceStatus: "requires-verification", voiceStatus: "requires-verification" })),
    review: { screenplay: "required", characterReferences: "required", audioAndTiming: "required", shotDurations: "requires-capability-verification" },
  };
  return { manifest, manifestHash: hash(manifest) };
}

// There is deliberately no guessed URL or environment-flag escape hatch.
export const unavailableMagicLightAdapter = Object.freeze({
  id: "magiclight", environment: "unavailable", available: false,
  evidence: Object.freeze({ apiVerified: false, qualityVerified: false, commercialTermsVerified: false, reconciliationVerified: false }),
  gaps: MAGICLIGHT_GAPS,
});
function checkAdapter(adapter) {
  if (adapter?.id !== "magiclight" || adapter.available !== true || !["production", "sandbox"].includes(adapter.environment)
    || !["apiVerified", "qualityVerified", "commercialTermsVerified", "reconciliationVerified"].every(k => adapter.evidence?.[k] === true)
    || !["quote", "submitShot", "reconcileShot", "pollShot", "validateManifest"].every(k => typeof adapter[k] === "function")) throw unavailable();
}

// Exact hostnames must come from a verified server adapter, never request data.
function validateProviderMedia(output, allowedHosts, contentTypes) {
  let url;
  try { url = new URL(output?.url); } catch { throw new FilmProductionError("Film output needs verification.", 502, "OUTPUT_UNVERIFIED"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash
    || !allowedHosts.includes(url.hostname) || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(url.hostname)
    || typeof output.url !== "string" || output.url.length > 8192 || !contentTypes.includes(output.contentType)
    || !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 16 || output.sizeBytes > 250 * 1024 * 1024
    || !Number.isFinite(output.durationSeconds) || output.durationSeconds <= 0 || output.durationSeconds > 600) {
    throw new FilmProductionError("Film output needs verification.", 502, "OUTPUT_UNVERIFIED");
  }
  return { url: output.url, contentType: output.contentType, sizeBytes: output.sizeBytes, durationSeconds: output.durationSeconds };
}

// A server adapter may return a separate, reviewed narration/dialogue mix.
// It stays private and must pass the same host/byte checks as the video, then
// actual full decoding and timeline checks in the media worker.
export function validateProviderAudio(output, allowedHosts = []) {
  return validateProviderMedia(output, allowedHosts, ["audio/mp4", "audio/mpeg", "audio/wav", "audio/webm"]);
}
export function validateProviderOutput(output, allowedHosts = []) {
  const video = validateProviderMedia(output, allowedHosts, ["video/mp4", "video/webm"]);
  return { ...video, ...(output.audio !== undefined ? { audio: validateProviderAudio(output.audio, allowedHosts) } : {}) };
}

function customerJob(job) {
  const status = job.status === "awaiting-assembly" ? "processing" : job.status;
  return { id: job.id, filmId: job.filmId, manifestHash: job.manifestHash, status, sceneCount: job.manifest.shots.length, shotCount: job.shots.length,
    durationSeconds: job.manifest.targetDurationSeconds, completedShots: job.shots.filter(s => s.status === "completed").length,
    createdAt: job.createdAt, updatedAt: job.updatedAt, preparationOnly: job.status === "prepared",
    ...(job.media ? { mediaReady: true } : {}),
    issues: job.status === "prepared" ? ["Review the cast's appearance and voices.", "Film quality and scene timing need confirmation before production."] : [],
  };
}

export function fictionalOperatorProject() {
  return { id: "00000000-0000-4000-8000-000000000001", title: "SAMPLE ONLY - FICTIONAL DATA: The shared garden", ancestor: "Fictional Ada Example", era: "An imaginary village", style: "Cinematic", duration: 15,
    script: "This sample is entirely fictional. Ada and her sister Alice plant a community garden and share their harvest.", sources: [{ id: "fictional-source", name: "SAMPLE ONLY - FICTIONAL DATA.txt", type: "text/plain", text: "Fictional Ada and her fictional sister Alice share their garden harvest." }],
    logline: "Two fictional sisters share a garden harvest.", selectedThemes: [{ title: "A shared garden", plot: "Sisters plant a garden.", climax: "They share the harvest.", reason: "Entirely fictional test material." }],
    characters: [{ id: "ada", name: "Fictional Ada", role: "Gardener", description: "Adult wearing a green apron.", basis: "documented", sourceIds: ["fictional-source"] }, { id: "alice", name: "Fictional Alice", role: "Sister", description: "Adult wearing a blue apron.", basis: "documented", sourceIds: ["fictional-source"] }],
    assumptions: [], factuality: "based-on-a-true-story", music: false,
    scenes: ["Planting", "Tending", "Sharing"].map((title, i) => ({ title, narration: ["Two fictional sisters plant a garden.", "They tend the garden together.", "They share the harvest."][i], visual: "SAMPLE ONLY - FICTIONAL DATA. An imaginary garden with two adult sisters.", dialogue: "", sourceIds: ["fictional-source"], characterIds: ["ada", "alice"], dramatization: "Entirely fictional demonstration; no real person or event." })),
  };
}

export function createFilmProductionService(dependencies = {}) {
  const read = dependencies.readRecordImpl || readRecord;
  const write = dependencies.writeRecordImpl || writeRecord;
  const now = dependencies.now || Date.now;
  const adapter = dependencies.adapter || unavailableMagicLightAdapter;
  const authorize = dependencies.authorize || (async () => ({ allowed: false }));
  const uuid = dependencies.uuid || randomUUID;
  const stamp = () => new Date(now()).toISOString();
  async function get(email, id) {
    const record = await read(productionJobPath(email, id));
    if (!record || record.value.ownerHash !== digest(owner(email))) throw new FilmProductionError("This production does not belong to your account.", 404, "PRODUCTION_NOT_FOUND");
    return record;
  }
  async function requireOperator(actor, email) {
    if (!isOwner(actor) || actor.status !== "active" || actor.mustChangePassword || actor.email !== email)
      throw new FilmProductionError("Only the owner can run this production test.", 403, "OWNER_REQUIRED");
    const current = (await read(userPath(email)))?.value;
    if (!isOwner(current) || current.email !== email || current.status !== "active" || current.mustChangePassword)
      throw new FilmProductionError("Only the current active owner can run this production test.", 403, "OWNER_REQUIRED");
  }
  async function requireProductionContext(job, actor, email) {
    if (adapter.environment === "sandbox" && job.mode !== "operator-test")
      throw new FilmProductionError("Sandbox production is limited to the owner's fixed fictional test.", 403, "SANDBOX_OPERATOR_REQUIRED");
    if (job.mode !== "operator-test") return;
    await requireOperator(actor, email);
    // Mode and a fictionalOnly flag cannot make an arbitrary family project a
    // sandbox test. Verify the saved content against the fixed server sample.
    const fixed = buildFilmManifest(fictionalOperatorProject());
    if (job.manifestHash !== fixed.manifestHash || hash(job.manifest) !== fixed.manifestHash
        || job.filmId !== fixed.manifest.filmId || job.ownerHash !== digest(email)
        || !Array.isArray(job.shots) || job.shots.length !== fixed.manifest.shots.length
        || job.shots.some((shot, index) => shot.id !== fixed.manifest.shots[index].id))
      throw new FilmProductionError("Prepare a new fixed fictional production test from Administration.", 403, "OPERATOR_PLAN_REQUIRED");
  }
  async function prepare({ email, project, idempotencyKey, preparationConsent, mode = "customer" }) {
    email = owner(email); key(idempotencyKey);
    if (preparationConsent !== true) invalid("Allow your screenplay, cast, and production plan to be saved privately before preparing your film.");
    const { manifest, manifestHash } = buildFilmManifest(project);
    // Deterministic request identity makes a lost response safe to retry.
    const seed = digest(`${email}:${idempotencyKey}`);
    const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-${seed.slice(12, 16)}-${seed.slice(16, 20)}-${seed.slice(20, 32)}`;
    const path = productionJobPath(email, id);
    const existing = await read(path);
    if (existing) {
      if (existing.value.manifestHash !== manifestHash || existing.value.mode !== mode) throw new FilmProductionError("This preparation request belongs to an earlier screenplay. Prepare the changed screenplay as a new request.", 409, "IDEMPOTENCY_CONFLICT");
      return customerJob(existing.value);
    }
    const job = { id, ownerHash: digest(email), filmId: manifest.filmId, manifestHash, manifest, mode,
      status: "prepared", createdAt: stamp(), updatedAt: stamp(), preparationConsentAt: stamp(),
      shots: manifest.shots.map(s => ({ id: s.id, status: "prepared", requestKey: digest(`${id}:${manifestHash}:${s.id}`) })), revision: 1 };
    try { await write(path, job); }
    catch (error) { if (conflict(error)) return prepare({ email, project, idempotencyKey, preparationConsent, mode }); throw error; }
    return customerJob(job);
  }
  async function quoteForPayment(project, actor, { idempotencyKey, preparedId, manifestHash } = {}) {
    checkAdapter(adapter);
    key(idempotencyKey);
    // Repricing an unchanged, reviewed plan must retain its identity. The new
    // quote request has its own retry key, separate from preparation retries.
    const prepared = preparedId === undefined
      ? await prepare({ email: actor?.email, project, idempotencyKey, preparationConsent: project?.preparationConsent })
      : customerJob((await get(actor?.email, preparedId)).value);
    const record = await get(actor.email, prepared.id);
    const job = record.value;
    if (buildFilmManifest(project).manifestHash !== job.manifestHash || (manifestHash !== undefined && manifestHash !== job.manifestHash)) {
      throw new FilmProductionError("This screenplay has changed. Prepare the current version before requesting a price.", 409, "PRODUCTION_PLAN_CHANGED");
    }
    if (job.status !== "prepared" || job.shots.some(shot => shot.status !== "prepared")) {
      throw new FilmProductionError("Production has already started for this plan. Check the existing film before making another payment.", 409, "PRODUCTION_ALREADY_STARTED");
    }
    await requireProductionContext(job, actor, actor.email);
    const validated = await adapter.validateManifest(clone(record.value.manifest));
    if (validated?.ready !== true) throw new FilmProductionError("Review your production plan before requesting a price.", 409, "PRODUCTION_REVIEW_REQUIRED");
    const quote = await adapter.quote({ manifest: clone(record.value.manifest), manifestHash: prepared.manifestHash, idempotencyKey: digest(`quote:${prepared.id}:${idempotencyKey}`) });
    if (!quote || quote.manifestHash !== prepared.manifestHash || quote.currency !== "USD" || typeof quote.quoteReference !== "string" || !quote.quoteReference || quote.quoteReference.length > 200
      || !Number.isSafeInteger(quote.providerCostCents) || quote.providerCostCents < 0 || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now()) throw unavailable();
    return { preparedId: prepared.id, filmId: project.id, filmTitle: record.value.manifest.title, manifestHash: prepared.manifestHash,
      quoteReference: quote.quoteReference, currency: "USD", providerCostCents: quote.providerCostCents, expiresAt: quote.expiresAt,
      environment: adapter.environment, apiVerified: true, qualityVerified: true, commercialTermsVerified: true };
  }
  async function prepareOperatorTest({ actor, idempotencyKey }) {
    await requireOperator(actor, actor?.email);
    return prepare({ email: actor.email, project: fictionalOperatorProject(), idempotencyKey, preparationConsent: true, mode: "operator-test" });
  }
  async function save(path, job, etag) { await write(path, { ...job, revision: job.revision + 1, updatedAt: stamp() }, etag); }
  // One external operation per invocation. A scheduler/owner can resume safely.
  // No request-supplied payment, quality, or provider-ready flags are accepted.
  async function advance({ email, id, authorizationReference, actor }) {
    checkAdapter(adapter);
    email = owner(email);
    let record = await get(email, id);
    let job = clone(record.value);
    await requireProductionContext(job, actor, email);
    if (["completed", "failed", "awaiting-assembly"].includes(job.status)) return customerJob(job);
    if (job.lease && job.lease.expiresAt > now()) return customerJob(job);
    const shot = job.shots.find(s => s.status !== "completed");
    if (!shot) return customerJob(job);
    const previousStatus = shot.status;
    let grant = job.authorization;
    if (previousStatus === "prepared") {
      grant = await authorize({ email, id, manifestHash: job.manifestHash, mode: job.mode, authorizationReference });
      if (grant?.allowed !== true || grant.manifestHash !== job.manifestHash || grant.environment !== adapter.environment
        || !Number.isSafeInteger(grant.budgetCents) || grant.budgetCents < 0 || Date.parse(grant.expiresAt) <= now() || !Number.isFinite(Date.parse(grant.expiresAt))
        || (job.mode === "operator-test" && grant.fictionalOnly !== true)
        || (job.mode !== "operator-test" && grant.fictionalOnly === true)) throw new FilmProductionError("Production authorization needs confirmation before this film can begin.", 409, "PRODUCTION_AUTHORIZATION_REQUIRED");
      const validation = await adapter.validateManifest(clone(job.manifest));
      if (validation?.ready !== true || !Number.isSafeInteger(validation.maximumCostCents) || validation.maximumCostCents > grant.budgetCents || validation.maximumCostCents < 0) throw new FilmProductionError("Review your production plan before starting the film.", 409, "PRODUCTION_REVIEW_REQUIRED");
      job.authorization = { ...select(grant, ["manifestHash", "environment", "budgetCents", "quoteReference"]), authorizedAt: stamp() };
    }
    // Polling and reconciliation never spend money and continue after a quote/grant expires.
    // A recovered old claim can reconcile with its stable request key even if its grant was lost.
    grant ||= {};
    const token = uuid();
    job.lease = { token, expiresAt: now() + 90_000 };
    if (previousStatus === "prepared") { shot.status = "submitting"; shot.submittedAt = stamp(); }
    job.status = shot.status === "uncertain" || previousStatus === "submitting" ? "uncertain" : "processing";
    try { await save(productionJobPath(email, id), job, record.etag); }
    catch (error) { if (conflict(error)) return customerJob((await get(email, id)).value); throw error; }
    let result;
    try {
      const request = { manifestHash: job.manifestHash, shot: clone(job.manifest.shots.find(s => s.id === shot.id)), manifest: clone(job.manifest), idempotencyKey: shot.requestKey,
        ...(shot.providerJobId ? { providerJobId: shot.providerJobId } : {}), budgetCents: grant.budgetCents, quoteReference: grant.quoteReference };
      if (previousStatus === "prepared") result = await adapter.submitShot(request);
      else if (["submitting", "uncertain"].includes(previousStatus)) result = await adapter.reconcileShot(request);
      else result = await adapter.pollShot(request);
    } catch { result = { status: "uncertain" }; }
    record = await get(email, id);
    job = clone(record.value);
    if (job.lease?.token !== token) return customerJob(job);
    const current = job.shots.find(s => s.id === shot.id);
    const statuses = new Set(["queued", "processing", "completed", "failed", "uncertain"]);
    // A missing/unknown reconciliation result never causes automatic resubmission.
    current.status = statuses.has(result?.status) ? result.status : "uncertain";
    if (result?.providerJobId !== undefined) {
      if (typeof result.providerJobId !== "string" || !result.providerJobId || result.providerJobId.length > 200 || (current.providerJobId && current.providerJobId !== result.providerJobId)) current.status = "uncertain";
      else current.providerJobId = result.providerJobId;
    }
    if (["queued", "processing", "completed"].includes(current.status) && !current.providerJobId) current.status = "uncertain";
    if (current.status === "completed") {
      try { current.output = validateProviderOutput(result.output, adapter.outputHosts); }
      catch { current.status = "uncertain"; }
    }
    delete job.lease;
    job.status = current.status === "failed" ? "failed" : current.status === "uncertain" ? "uncertain" : job.shots.every(s => s.status === "completed") ? "awaiting-assembly" : "processing";
    try { await save(productionJobPath(email, id), job, record.etag); }
    catch (error) { if (!conflict(error)) throw error; }
    return customerJob((await get(email, id)).value);
  }
  // A media worker must verify the actual private file before this transition.
  async function acceptAssembly({ email, id, manifestHash, artifact, stillOwned = async () => true }) {
    if (typeof dependencies.verifyAssembledMedia !== "function") throw unavailable();
    const record = await get(email, id), job = clone(record.value);
    if (job.status === "completed" && job.manifestHash === manifestHash) return customerJob(job);
    if (job.status !== "awaiting-assembly" || job.manifestHash !== manifestHash) throw new FilmProductionError("This film is not ready for assembly.", 409, "ASSEMBLY_NOT_READY");
    const verified = await dependencies.verifyAssembledMedia({ email: owner(email), id, manifestHash, artifact, manifest: clone(job.manifest) });
    // Verification can stream a large private artifact. Recheck the worker's
    // claim after that await, before the conditional write that marks delivery.
    if (!await stillOwned()) throw new FilmProductionError("The assembly claim expired. Production will resume safely.", 409, "ASSEMBLY_CLAIM_EXPIRED");
    const expectedPrefix = `production/media/${digest(owner(email))}/${id}/`;
    if (verified?.playable !== true || verified.manifestHash !== manifestHash || typeof verified.pathname !== "string" || !verified.pathname.startsWith(expectedPrefix)
      || verified.pathname.includes("..") || !HASH.test(verified.sha256 || "") || !["video/mp4", "video/webm"].includes(verified.contentType)
      || !Number.isSafeInteger(verified.sizeBytes) || verified.sizeBytes < 16 || verified.sizeBytes > 250 * 1024 * 1024 || !Number.isFinite(verified.durationSeconds)
      || Math.abs(verified.durationSeconds - job.manifest.targetDurationSeconds) > 1) throw new FilmProductionError("The finished film needs playback verification.", 502, "OUTPUT_UNVERIFIED");
    let profile;
    try { profile = verifiedMediaProfile(verified); }
    catch { throw new FilmProductionError("The finished film needs quality verification.", 502, "OUTPUT_UNVERIFIED"); }
    job.media = { ...select(verified, ["pathname", "sha256", "contentType", "sizeBytes", "durationSeconds"]), ...profile };
    job.status = "completed";
    await save(productionJobPath(email, id), job, record.etag);
    return customerJob(job);
  }
  return {
    prepare, prepareOperatorTest, quoteForPayment, advance, acceptAssembly,
    status: async ({ email, id }) => customerJob((await get(email, id)).value),
    manifest: async ({ email, id }) => { const job = (await get(email, id)).value; return { id: job.id, manifestHash: job.manifestHash, manifest: clone(job.manifest) }; },
    getPrepared: async ({ email, id }) => clone((await get(email, id)).value),
    readiness: () => {
      let available = false;
      try { checkAdapter(adapter); available = true; } catch { /* Keep undocumented providers disabled. */ }
      return { available, preparationAvailable: true, adapter: adapter.id, environment: adapter.environment, gaps: available ? [] : [...MAGICLIGHT_GAPS] };
    },
  };
}

export const filmProduction = createFilmProductionService({
  // Lazy import avoids a construction-time cycle with payment quotes. The
  // payment service verifies the saved account, plan, order and merchant grant.
  authorize: async ({ email, id, manifestHash, authorizationReference }) =>
    (await import("./payments.mjs")).payments.authorizeProduction({ email, preparedId: id, manifestHash, orderId: authorizationReference }),
});
export const quoteForPayment = (...args) => filmProduction.quoteForPayment(...args);
