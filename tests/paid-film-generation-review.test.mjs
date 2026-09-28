import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { productionJobPath, buildFilmManifest, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import { paidFilmGenerationPath } from "../api/_lib/paid-film-generation.mjs";
import { createPaidFilmGenerationReviewService, paidFilmReviewPath } from "../api/_lib/paid-film-generation-review.mjs";
import { requireFinishedFilmPayment, validateStoredProductionMedia } from "../api/_lib/production-media.mjs";
import { parseRange } from "../api/_lib/archive.mjs";
import { createStudioHandler } from "../api/studio.mjs";

const OWNER = { email: OWNER_EMAIL, role: "owner", status: "active" }, ID = "11111111-1111-4111-8111-111111111111";
const TASK = "2032443088023777281", OUTPUT = "https://videocos.magiclight.ai/private.mp4?signature=secret";
const NOW = Date.parse("2026-09-28T02:00:00Z"), AT = new Date(NOW - 1000).toISOString();
const bytes = Buffer.from(Array.from({ length: 128 }, (_, i) => i)), SHA = digest(bytes);
const clone = value => structuredClone(value);
class Capture extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = 200; this.headersSent = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  _write(chunk, encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); done(); }
  get body() { return Buffer.concat(this.chunks); }
  get data() { return JSON.parse(this.body.toString()); }
}
function fixture(options = {}) {
  let revision = 0;
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject()), orderId = digest(`${OWNER.email}:production:${manifestHash}`);
  const job = { id: ID, ownerHash: digest(OWNER.email), mode: "customer", filmId: manifest.filmId, manifest, manifestHash, status: "prepared", revision: 1,
    shots: manifest.shots.map(shot => ({ id: shot.id, status: "prepared" })) };
  const attempt = { version: 1, id: ID, ownerEmail: OWNER.email, filmId: job.filmId, manifestHash, orderId, status: "verifying", submissionCount: 1,
    taskId: TASK, outputUrl: OUTPUT, submittedAt: AT, promptHash: "a".repeat(64) };
  const artifact = { pathname: `production/media/${digest(OWNER.email)}/${ID}/${SHA}.mp4`, sha256: SHA, sizeBytes: bytes.length, contentType: "video/mp4",
    durationSeconds: manifest.targetDurationSeconds, width: 1280, height: 720, frameRate: 24, hasAudio: true, playable: true, technicalSample: false,
    manifestHash, verification: "full-video-and-audio-decode", contentReviewed: false };
  const stage = { version: 1, id: ID, ownerEmail: OWNER.email, filmId: job.filmId, manifestHash, orderId, taskHash: digest(TASK), sourceHash: digest(OUTPUT),
    submittedAt: AT, promptHash: attempt.promptHash, status: "awaiting-review", changeId: "22222222-2222-4222-8222-222222222222", verifiedAt: AT, artifact };
  const order = { id: orderId, customerEmail: OWNER.email, preparedId: ID, filmId: job.filmId, manifestHash, status: "captured", capturedAt: AT,
    currency: "USD", amountCents: 519, refundedCents: 0, provider: "quickbooks", checkoutMethod: "quickbooks-hosted-invoice",
    merchantBinding: { environment: "production", grantId: "b".repeat(64), realmId: "12345" }, confirmationSource: "quickbooks-accounting",
    invoiceId: "100", balanceCents: 0, accountingCheckedAt: AT, accountingPayments: [{ id: "101", allocatedCents: 519 }] };
  const publicOrder = { id: orderId, preparedId: ID, filmId: job.filmId, status: "captured", sandbox: false, refundedCents: 0, requiresReview: false,
    checkoutMethod: order.checkoutMethod, confirmationSource: order.confirmationSource, amountCents: 519, currency: "USD", receiptAvailable: true };
  const paths = { owner: userPath(OWNER.email), job: productionJobPath(OWNER.email, ID), attempt: paidFilmGenerationPath(OWNER.email, ID),
    stage: paidFilmReviewPath(OWNER.email, ID), order: `payments/orders/${orderId}.json` };
  const records = new Map(Object.entries({ owner: OWNER, job, attempt, stage, order }).map(([key, value]) => [paths[key], { value: clone(value), etag: key }]));
  const read = async path => clone(records.get(path) || null), blobReads = [], paymentChecks = [], writes = [];
  const write = async (path, value, etag) => {
    await options.beforeWrite?.(path, value);
    if (records.get(path)?.etag !== etag) throw new Error("etag conflict");
    writes.push(path); records.set(path, { value: clone(value), etag: `write-${++revision}` });
    await options.afterWrite?.(path, value);
  };
  const getBlob = async (path, settings) => {
    blobReads.push(path); await options.beforeBlob?.();
    if (options.getBlob) return options.getBlob(path, settings);
    const range = parseRange(settings.headers.Range, bytes.length), data = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    const result = { statusCode: 200, stream: new Response(options.corrupt ? Buffer.alloc(data.length) : data).body,
      blob: { pathname: path, size: data.length, contentType: "video/mp4" },
      headers: new Headers({ "content-type": "video/mp4", "content-length": String(data.length), ...(range ? { "content-range": range.contentRange } : {}) }) };
    return options.changeBlob ? options.changeBlob(result) : result;
  };
  const service = createPaidFilmGenerationReviewService({ read, write, getBlob, now: () => NOW, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    checkPayment: async (actor, input) => { paymentChecks.push(input); await options.duringPayment?.(); return clone(publicOrder); } });
  return { service, records, paths, artifact, job, attempt, order, publicOrder, read, blobReads, paymentChecks, writes,
    review: () => service.review(OWNER, { preparedId: ID }), approve: () => service.approve(OWNER, { preparedId: ID, artifactSha256: SHA, consent: true }),
    revoke: () => records.set(paths.owner, { value: { ...OWNER, status: "suspended" }, etag: "revoked" }),
    stream: async (headers = {}, method = "GET", actor = OWNER, artifactSha256 = SHA) => { const res = new Capture(); await service.stream({ actor, preparedId: ID, artifactSha256, req: { method, headers }, res }); return res; } };
}

test("review exposes only exact authenticated preview identity and leaves paid plan uncompleted", async () => {
  const h = fixture(), result = await h.review();
  assert.equal(result.status, "awaiting-review"); assert.equal(result.artifactSha256, SHA); assert.equal(result.previewReady, true);
  assert.equal(result.previewUrl, `/api/studio?action=reviewVideo&id=${ID}&artifact=${SHA}`);
  assert.doesNotMatch(JSON.stringify(result), /2032443088023777281|signature|videocos|production\/media|ownerEmail/);
  assert.equal(h.records.get(h.paths.job).value.status, "prepared"); assert.equal(h.blobReads.length, 0); assert.equal(h.writes.length, 0);
  h.records.delete(h.paths.stage); assert.equal(await h.review(), null);
});

test("delivery attention is an explicit safe outcome, never a preview or silent pending state", async () => {
  const h = fixture(), stage = h.records.get(h.paths.stage).value; stage.status = "attention"; delete stage.artifact; delete stage.verifiedAt;
  stage.lastError = `${OUTPUT} private-provider-failure`;
  const result = await h.review(); assert.equal(result.status, "needs-attention"); assert.equal(result.preparedId, ID);
  assert.equal(result.previewReady, undefined); assert.equal(result.previewUrl, undefined); assert.equal(result.artifactSha256, undefined);
  assert.doesNotMatch(JSON.stringify(result), /videocos|signature|private-provider/);
  await assert.rejects(h.approve(), e => e.code === "GENERATION_REVIEW_CHANGED"); assert.equal((await h.stream()).statusCode, 409);
  assert.equal(h.blobReads.length, 0); assert.equal(h.writes.length, 0);
  stage.taskHash = "c".repeat(64); await assert.rejects(h.review(), e => e.code === "GENERATION_REVIEW_CHANGED");
});

test("owner approval verifies original private bytes, current payment and exact artifact then completes with honest provenance", async () => {
  const h = fixture(), result = await h.approve(), saved = h.records.get(h.paths.job).value;
  assert.equal(result.status, "approved"); assert.equal(saved.status, "completed"); assert.equal(saved.media.sha256, SHA);
  assert.deepEqual(saved.shots, h.job.shots); assert.equal(saved.authorization.kind, "owner-generation-attempt");
  assert.equal(saved.authorization.budgetCents, undefined); assert.equal(saved.authorization.quoteReference, undefined);
  assert.equal(saved.generationReview.artifactSha256, SHA); assert.equal(saved.generationReview.approvedBy, OWNER.email);
  assert.equal(saved.generationReview.taskHash, digest(TASK)); assert.equal(saved.generationReview.sourceHash, digest(OUTPUT));
  assert.deepEqual(h.writes, [h.paths.job]); assert.deepEqual(h.paymentChecks, [{ orderId: h.order.id }]);
  assert.equal(validateStoredProductionMedia(saved, OWNER.email).sha256, SHA);
  await requireFinishedFilmPayment({ job: saved, email: OWNER.email, actor: OWNER, read: h.read, now: () => NOW });
  assert.equal((await h.review()).status, "approved"); await h.approve(); assert.equal(h.writes.length, 1);
});

test("only current owner with complete session may review, preview or approve", async () => {
  for (const actor of [null, { ...OWNER, role: "admin" }, { ...OWNER, role: "customer" }, { ...OWNER, mustChangePassword: true }, { ...OWNER, status: "suspended" }]) {
    const h = fixture(); await assert.rejects(h.service.review(actor, { preparedId: ID }), e => e.status === 403);
    await assert.rejects(h.service.approve(actor, { preparedId: ID, artifactSha256: SHA, consent: true }), e => e.status === 403);
    assert.equal((await h.stream({}, "GET", actor)).statusCode, 403); assert.equal(h.blobReads.length, 0);
  }
  const h = fixture(); h.revoke(); await assert.rejects(h.review(), e => e.status === 403);
});

test("stage, task, source, prompt, manifest, payment and artifact identities must all match", async () => {
  const mutations = [h => h.records.get(h.paths.stage).value.taskHash = "c".repeat(64), h => h.records.get(h.paths.stage).value.sourceHash = "c".repeat(64),
    h => h.records.get(h.paths.stage).value.promptHash = "c".repeat(64), h => h.records.get(h.paths.stage).value.submittedAt = "2026-01-01T00:00:00Z",
    h => h.records.get(h.paths.attempt).value.orderId = "c".repeat(64), h => h.records.get(h.paths.attempt).value.status = "processing",
    h => h.records.get(h.paths.job).value.manifest.title = "changed", h => h.records.get(h.paths.stage).value.artifact.pathname = "production/media/other/a.mp4",
    h => h.records.get(h.paths.stage).value.artifact.durationSeconds = 3, h => h.records.get(h.paths.stage).value.artifact.hasAudio = false,
    h => h.records.get(h.paths.stage).value.artifact.verification = "header-only", h => h.records.get(h.paths.stage).value.artifact.contentReviewed = true,
    h => h.records.get(h.paths.stage).value.artifact.width = 99999];
  for (const mutate of mutations) {
    const h = fixture(); mutate(h); await assert.rejects(h.approve(), e => e.code === "GENERATION_REVIEW_CHANGED");
    assert.equal(h.blobReads.length, 0); assert.equal(h.writes.length, 0);
  }
});

test("refunds, incomplete allocations and non-captured payment cannot preview or publish", async () => {
  for (const patch of [{ status: "awaiting-payment" }, { refundedCents: 1 }, { refundOperation: {} }, { balanceCents: 1 },
    { accountingPayments: [] }, { accountingPayments: [{ id: "101", allocatedCents: 1 }] }, { customerEmail: "other@example.invalid" }]) {
    const h = fixture(); Object.assign(h.records.get(h.paths.order).value, patch);
    await assert.rejects(h.review(), e => e.code === "GENERATION_REVIEW_PAYMENT_REQUIRED");
    assert.equal((await h.stream()).statusCode, 409); assert.equal(h.blobReads.length, 0); assert.equal(h.writes.length, 0);
  }
  const h = fixture(); h.publicOrder.status = "uncertain"; await assert.rejects(h.approve(), e => e.code === "GENERATION_REVIEW_PAYMENT_REQUIRED");
});

test("approval requires exact content confirmation and checksum readback", async () => {
  for (const input of [{ preparedId: ID, artifactSha256: SHA }, { preparedId: ID, artifactSha256: SHA, consent: false },
    { preparedId: ID, artifactSha256: SHA, consent: true, outputUrl: OUTPUT }]) {
    const h = fixture(); await assert.rejects(h.service.approve(OWNER, input), e => e.status === 400); assert.equal(h.writes.length, 0);
  }
  const changedSha = fixture(); await assert.rejects(changedSha.service.approve(OWNER, { preparedId: ID, artifactSha256: "c".repeat(64), consent: true }), e => e.status === 409);
  const corrupt = fixture({ corrupt: true }); await assert.rejects(corrupt.approve(), e => e.code === "GENERATION_REVIEW_UNAVAILABLE"); assert.equal(corrupt.writes.length, 0);
  const headers = fixture({ changeBlob: result => ({ ...result, headers: new Headers({ "content-type": "text/html", "content-length": "128" }) }) });
  await assert.rejects(headers.approve(), e => e.code === "GENERATION_REVIEW_UNAVAILABLE"); assert.equal(headers.writes.length, 0);
});

test("private artifact verification has a bounded deadline even when storage ignores cancellation", async () => {
  const h = fixture({ getBlob: async () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(h.approve(), e => e.code === "GENERATION_REVIEW_UNAVAILABLE"); assert.equal(h.writes.length, 0);
});

test("a late account, stage, plan or payment change stops publication", async () => {
  for (const mutate of [h => h.revoke(), h => h.records.get(h.paths.stage).etag = "changed", h => h.records.get(h.paths.job).etag = "changed",
    h => h.records.get(h.paths.order).value.refundedCents = 519]) {
    let h; h = fixture({ beforeBlob: async () => mutate(h) }); await assert.rejects(h.approve()); assert.equal(h.writes.length, 0);
  }
  const lost = fixture({ afterWrite: async () => { throw new Error("lost accepted response"); } }); assert.equal((await lost.approve()).status, "approved");
  assert.equal(lost.writes.length, 1);
});

test("private preview supports exact byte ranges, HEAD and safe validation errors", async () => {
  const h = fixture(), full = await h.stream(); assert.equal(full.statusCode, 200); assert.deepEqual(full.body, bytes);
  assert.equal(full.headers["cache-control"], "private, no-store"); assert.equal(full.headers.vary, "Cookie");
  const partial = await h.stream({ range: "bytes=10-19" }); assert.equal(partial.statusCode, 206); assert.deepEqual(partial.body, bytes.subarray(10, 20));
  assert.equal(partial.headers["content-range"], "bytes 10-19/128");
  const head = await h.stream({}, "HEAD"); assert.equal(head.statusCode, 200); assert.equal(head.body.length, 0); assert.equal(head.headers["content-length"], "128");
  assert.equal((await h.stream({ range: "bytes=200-300" })).statusCode, 416);
  let revoked; revoked = fixture({ beforeBlob: async () => revoked.revoke() }); const denied = await revoked.stream(); assert.equal(denied.statusCode, 403);
  assert.doesNotMatch(denied.body.toString(), /production\/media|signature|203244/);
});

test("an old artifact preview URL never streams a replaced artifact", async () => {
  const h = fixture();
  const oldUrl = (await h.review()).previewUrl;
  const oldSha = new URL(oldUrl, "https://lineagetheater.com").searchParams.get("artifact");
  const replacement = h.records.get(h.paths.stage).value.artifact;
  replacement.sha256 = "c".repeat(64); replacement.pathname = `production/media/${digest(OWNER.email)}/${ID}/${replacement.sha256}.mp4`;
  const oldResponse = await h.stream({}, "GET", OWNER, oldSha); assert.equal(oldResponse.statusCode, 409);
  assert.equal(h.blobReads.length, 0); assert.equal(oldResponse.headers["content-type"], "application/json");
  const missing = await h.stream({}, "GET", OWNER, ""); assert.equal(missing.statusCode, 400); assert.equal(h.blobReads.length, 0);
});

test("studio review endpoints require owner, strict saved references, same-origin consent and rate limit", async () => {
  const calls = [], limits = [];
  let user = OWNER;
  const handler = createStudioHandler({ getSession: async () => ({ user }), limitAction: async (...args) => { limits.push(args); return true; },
    paidFilmGenerationReview: { review: async (actor, input) => { calls.push(["review", input]); return null; },
      approve: async (actor, input) => { calls.push(["approve", input]); return { status: "approved" }; },
      stream: async ({ preparedId, artifactSha256, res }) => { calls.push(["stream", preparedId, artifactSha256]); res.statusCode = 200; res.end(); } } });
  const invoke = async ({ action = "generationReview", method = "GET", body, query = `action=${action}&id=${ID}${action === "reviewVideo" ? `&artifact=${SHA}` : ""}`, origin = "https://lineagetheater.com" } = {}) => {
    const res = new Capture(); await handler({ method, url: `/api/studio?${query}`, headers: { host: "lineagetheater.com", origin }, body }, res); return res;
  };
  assert.equal((await invoke()).statusCode, 200); assert.deepEqual(calls.pop(), ["review", { preparedId: ID }]);
  assert.equal((await invoke({ action: "reviewVideo", method: "HEAD" })).statusCode, 200); assert.deepEqual(calls.pop(), ["stream", ID, SHA]);
  const approval = { action: "approveGeneration", preparedId: ID, artifactSha256: SHA, consent: true };
  assert.equal((await invoke({ method: "POST", body: approval })).statusCode, 200);
  assert.deepEqual(calls.pop(), ["approve", { preparedId: ID, artifactSha256: SHA, consent: true }]);
  for (const query of [`action=generationReview&id=${ID}&id=${ID}`, `action=reviewVideo&id=${ID}&url=https://other.invalid/`,
    `action=reviewVideo&id=${ID}`, `action=reviewVideo&id=${ID}&artifact=bad`, `action=reviewVideo&id=${ID}&artifact=${SHA}&artifact=${SHA}`, "action=generationReview&id=../other"])
    assert.equal((await invoke({ query })).statusCode, 400);
  for (const change of [{ consent: false }, { artifactSha256: "bad" }, { pathname: "private/path" }])
    assert.equal((await invoke({ method: "POST", body: { ...approval, ...change } })).statusCode, 400);
  assert.equal((await invoke({ method: "POST", body: approval, origin: "https://other.invalid" })).statusCode, 403);
  user = { ...OWNER, role: "admin" }; assert.equal((await invoke()).statusCode, 403);
  assert.equal((await invoke({ method: "POST", body: approval })).statusCode, 403); assert.equal(calls.length, 0);
  assert.equal(limits.some(row => row[0].startsWith("film-generation-approve:")), true);
});
