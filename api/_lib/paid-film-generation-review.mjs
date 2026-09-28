import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "@vercel/blob";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { isOwner, accessStatusForUser } from "./access.mjs";
import { productionJobPath } from "./film-production.mjs";
import { paidFilmGenerationPath } from "./paid-film-generation.mjs";
import { requireFinishedFilmPayment } from "./production-media.mjs";
import { hostedCheckout } from "./hosted-checkout.mjs";
import { verifiedMediaProfile } from "./media-profile.mjs";
import { parseRange } from "./archive.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 250 * 1024 * 1024;
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const clone = value => structuredClone(value);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export class PaidFilmReviewError extends Error {
  constructor(code, status, message) { super(message); this.name = "PaidFilmReviewError"; this.code = code; this.status = status; }
}
const denied = () => new PaidFilmReviewError("GENERATION_REVIEW_OWNER_REQUIRED", 403, "Only the current owner can review this generation result.");
const invalid = () => new PaidFilmReviewError("GENERATION_REVIEW_INVALID", 400, "Choose the saved film and confirm the exact video you reviewed.");
const changed = () => new PaidFilmReviewError("GENERATION_REVIEW_CHANGED", 409, "The film or video changed. Refresh its review before approving it.");
const unavailable = () => new PaidFilmReviewError("GENERATION_REVIEW_UNAVAILABLE", 503, "The saved video could not be verified. Its payment and generation request remain saved.");
const unpaid = () => new PaidFilmReviewError("GENERATION_REVIEW_PAYMENT_REQUIRED", 409, "This saved film needs a confirmed payment before its video can be reviewed or approved.");
function exact(input, fields) {
  if (!plain(input) || Object.keys(input).some(key => !fields.includes(key)) || !UUID.test(input.preparedId || "")) throw invalid();
}
export function paidFilmReviewPath(email, preparedId) {
  paidFilmGenerationPath(email, preparedId);
  return `production/generation-delivery/${digest(email)}/${preparedId}.json`;
}
function sameRecord(a, b) { return Boolean(a?.etag && b?.etag && a.etag === b.etag && digest(JSON.stringify(a.value)) === digest(JSON.stringify(b.value))); }
function blobMatches(blob, artifact, range) {
  const length = range?.length ?? artifact.sizeBytes;
  return Boolean(blob?.stream && blob.statusCode === 200 && blob.blob?.pathname === artifact.pathname
    && blob.blob?.contentType === "video/mp4" && blob.blob?.size === length
    && blob.headers?.get("content-type") === "video/mp4" && blob.headers?.get("content-length") === String(length)
    && blob.headers?.get("content-range") === (range?.contentRange ?? null)
    && [null, "identity"].includes(blob.headers?.get("content-encoding")));
}

export function createPaidFilmGenerationReviewService({ read = readRecord, write = writeRecord, getBlob = get,
  checkPayment = (actor, input) => hostedCheckout.check(actor, input), now = Date.now, timeoutMs = 45_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw invalid();
  async function stored(path) { try { return await read(path); } catch { throw unavailable(); } }
  async function owner(actor) {
    if (!isOwner(actor) || actor.mustChangePassword || accessStatusForUser(actor) !== "approved") throw denied();
    const current = (await stored(userPath(actor.email)))?.value;
    if (!isOwner(current) || current.email !== actor.email || current.mustChangePassword || accessStatusForUser(current) !== "approved") throw denied();
  }
  function authorization(attempt) {
    return { environment: "production", manifestHash: attempt.manifestHash, kind: "owner-generation-attempt", orderId: attempt.orderId,
      attemptId: attempt.id, taskHash: digest(attempt.taskId), sourceHash: digest(attempt.outputUrl), authorizedAt: attempt.submittedAt };
  }
  function approvedJob(job, attempt, artifact) {
    const review = job.generationReview;
    return job.status === "completed" && ["pathname", "sha256", "sizeBytes", "contentType", "durationSeconds", "width", "height", "frameRate"].every(key => job.media?.[key] === artifact[key])
      && plain(review) && review.version === 1 && review.kind === "owner-generation-attempt" && review.artifactSha256 === artifact.sha256
      && review.preparedId === job.id && review.manifestHash === attempt.manifestHash && review.orderId === attempt.orderId
      && review.taskHash === digest(attempt.taskId) && review.sourceHash === digest(attempt.outputUrl)
      && review.promptHash === attempt.promptHash && review.approvedBy === attempt.ownerEmail && date(review.approvedAt)
      && Date.parse(review.approvedAt) <= now()
      && job.authorization?.kind === "owner-generation-attempt" && job.authorization?.attemptId === attempt.id
      && job.authorization?.environment === "production" && job.authorization?.manifestHash === attempt.manifestHash
      && job.authorization?.orderId === attempt.orderId && job.authorization?.taskHash === review.taskHash && job.authorization?.sourceHash === review.sourceHash;
  }
  async function payment(actor, candidate) {
    try { await requireFinishedFilmPayment({ job: candidate, email: actor.email, actor, read: stored, now }); }
    catch { throw unpaid(); }
  }
  async function binding(actor, preparedId) {
    await owner(actor);
    const [attemptRecord, stageRecord, jobRecord] = await Promise.all([
      stored(paidFilmGenerationPath(actor.email, preparedId)), stored(paidFilmReviewPath(actor.email, preparedId)), stored(productionJobPath(actor.email, preparedId)),
    ]);
    const attempt = attemptRecord?.value, stage = stageRecord?.value, job = jobRecord?.value;
    if (!jobRecord?.etag || !job || job.id !== preparedId || job.ownerHash !== digest(actor.email) || job.mode !== "customer"
      || !HASH.test(job.manifestHash || "") || !plain(job.manifest) || digest(JSON.stringify(job.manifest)) !== job.manifestHash
      || !UUID.test(job.filmId || "") || job.manifest.filmId !== job.filmId
      || !Number.isSafeInteger(job.manifest.targetDurationSeconds) || job.manifest.targetDurationSeconds < 15 || job.manifest.targetDurationSeconds > 600) throw changed();
    if (!stage) { await owner(actor); return null; }
    if (!["awaiting-review", "completed", "attention"].includes(stage.status)) { await owner(actor); return null; }
    if (!attemptRecord?.etag || !stageRecord?.etag || attempt?.version !== 1 || attempt.id !== preparedId || attempt.ownerEmail !== actor.email
      || attempt.status !== "verifying" || attempt.submissionCount !== 1 || typeof attempt.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(attempt.taskId)
      || typeof attempt.outputUrl !== "string" || !attempt.outputUrl.startsWith("https://") || !date(attempt.submittedAt) || !HASH.test(attempt.promptHash || "")
      || !HASH.test(attempt.orderId || "") || attempt.manifestHash !== job.manifestHash || attempt.filmId !== job.filmId
      || attempt.orderId !== digest(`${actor.email}:production:${job.manifestHash}`)
      || stage.version !== 1 || stage.id !== preparedId || stage.ownerEmail !== actor.email || stage.filmId !== job.filmId
      || stage.manifestHash !== job.manifestHash || stage.orderId !== attempt.orderId || stage.taskHash !== digest(attempt.taskId)
      || stage.sourceHash !== digest(attempt.outputUrl) || stage.promptHash !== attempt.promptHash || stage.submittedAt !== attempt.submittedAt
      || !UUID.test(stage.changeId || "")) throw changed();
    const candidate = { ...job, authorization: authorization(attempt) };
    if (stage.status === "attention") {
      if (job.status !== "prepared") throw changed();
      await payment(actor, candidate); await owner(actor);
      return { attemptRecord, stageRecord, jobRecord, attempt, stage, job, candidate, needsAttention: true };
    }
    if (!date(stage.verifiedAt) || !plain(stage.artifact)) throw changed();
    const artifact = stage.artifact;
    if (!HASH.test(artifact.sha256 || "") || artifact.pathname !== `production/media/${digest(actor.email)}/${preparedId}/${artifact.sha256}.mp4`
      || artifact.manifestHash !== job.manifestHash || artifact.contentType !== "video/mp4"
      || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 16 || artifact.sizeBytes > MAX_BYTES
      || !Number.isFinite(artifact.durationSeconds) || Math.abs(artifact.durationSeconds - job.manifest.targetDurationSeconds) > 1
      || artifact.durationSeconds <= 0 || artifact.durationSeconds > 600 || artifact.hasAudio !== true || artifact.playable !== true
      || artifact.technicalSample !== false || artifact.verification !== "full-video-and-audio-decode" || artifact.contentReviewed !== false) throw changed();
    try { verifiedMediaProfile(artifact); } catch { throw changed(); }
    const approved = approvedJob(job, attempt, artifact);
    if (job.status !== "prepared" && !approved || stage.status === "completed" && !approved) throw changed();
    if (!approved && (!Array.isArray(job.shots) || !job.shots.length || job.shots.some(shot => shot.status !== "prepared"))) throw changed();
    await payment(actor, candidate); await owner(actor);
    return { attemptRecord, stageRecord, jobRecord, attempt, stage, job, artifact, candidate, approved };
  }
  function view(value) {
    if (!value) return null;
    const { artifact, attempt, approved } = value;
    if (value.needsAttention) return { preparedId: attempt.id, filmId: attempt.filmId, manifestHash: attempt.manifestHash, orderId: attempt.orderId,
      status: "needs-attention", message: "The returned video could not pass verification. Your payment and saved film remain recorded." };
    return { preparedId: attempt.id, filmId: attempt.filmId, manifestHash: attempt.manifestHash, orderId: attempt.orderId,
      status: approved ? "approved" : "awaiting-review", artifactSha256: artifact.sha256, durationSeconds: artifact.durationSeconds,
      width: artifact.width, height: artifact.height, hasAudio: true, previewReady: true,
      previewUrl: `/api/studio?action=reviewVideo&id=${encodeURIComponent(attempt.id)}&artifact=${artifact.sha256}` };
  }
  async function unchanged(actor, initial) {
    const current = await binding(actor, initial.attempt.id);
    if (!current || !sameRecord(current.attemptRecord, initial.attemptRecord) || !sameRecord(current.stageRecord, initial.stageRecord)
      || !sameRecord(current.jobRecord, initial.jobRecord)) throw changed();
    return current;
  }
  async function verifyBytes(artifact) {
    const controller = new AbortController(); let upstream, reader;
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reader?.cancel().catch(() => {}); reject(unavailable());
    }, timeoutMs); });
    async function verify() {
      upstream = await getBlob(artifact.pathname, { access: "private", useCache: false, headers: { "accept-encoding": "identity" }, abortSignal: controller.signal });
      if (controller.signal.aborted) { await upstream?.stream?.cancel().catch(() => {}); upstream = undefined; throw unavailable(); }
      if (!blobMatches(upstream, artifact)) throw unavailable();
      reader = upstream.stream.getReader(); const hash = createHash("sha256"); let received = 0;
      for (;;) {
        const result = await reader.read();
        if (controller.signal.aborted) throw unavailable();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array) || (received += result.value.byteLength) > artifact.sizeBytes) throw unavailable();
        hash.update(result.value);
      }
      if (received !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256) throw unavailable();
    }
    try { await Promise.race([verify(), deadline]); }
    catch { throw unavailable(); }
    finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); if (!reader) await upstream?.stream?.cancel().catch(() => {}); }
  }
  async function review(actor, input) { exact(input, ["preparedId"]); return view(await binding(actor, input.preparedId)); }
  async function approve(actor, input) {
    exact(input, ["preparedId", "artifactSha256", "consent"]);
    if (input.consent !== true || !HASH.test(input.artifactSha256 || "")) throw invalid();
    const initial = await binding(actor, input.preparedId);
    if (!initial?.artifact || initial.artifact.sha256 !== input.artifactSha256) throw changed();
    let checked;
    try { checked = await checkPayment(actor, { orderId: initial.attempt.orderId }); } catch { throw unpaid(); }
    const checkedOrder = (await stored(`payments/orders/${initial.attempt.orderId}.json`))?.value;
    if (checked?.id !== initial.attempt.orderId || checked.preparedId !== input.preparedId || checked.filmId !== initial.job.filmId
      || checked.status !== "captured" || checked.sandbox !== false || checked.refundedCents !== 0 || checked.requiresReview !== false
      || checked.checkoutMethod !== "quickbooks-hosted-invoice" || checked.confirmationSource !== "quickbooks-accounting"
      || checked.currency !== "USD" || checked.receiptAvailable !== true || checked.amountCents !== checkedOrder?.amountCents) throw unpaid();
    await verifyBytes(initial.artifact);
    const current = await unchanged(actor, initial);
    if (current.approved) return view(current);
    const { artifact, attempt, job } = current, approvedAt = new Date(now()).toISOString();
    const media = Object.fromEntries(["pathname", "sha256", "sizeBytes", "contentType", "durationSeconds", "width", "height", "frameRate"].map(key => [key, artifact[key]]));
    const next = { ...clone(job), status: "completed", media, authorization: authorization(attempt), updatedAt: approvedAt,
      revision: Number.isSafeInteger(job.revision) ? job.revision + 1 : 1,
      generationReview: { version: 1, kind: "owner-generation-attempt", preparedId: job.id, manifestHash: job.manifestHash,
        orderId: attempt.orderId, artifactSha256: artifact.sha256, taskHash: digest(attempt.taskId), sourceHash: digest(attempt.outputUrl),
        promptHash: attempt.promptHash, approvedBy: actor.email, approvedAt } };
    // The whole-film result has its own explicit provenance. Per-shot statuses,
    // a provider quotation, or a spending grant are never invented here.
    await owner(actor); await payment(actor, current.candidate);
    try { await write(productionJobPath(actor.email, job.id), next, current.jobRecord.etag); }
    catch { /* Confirm a lost response or an identical concurrent approval. */ }
    const saved = await binding(actor, job.id);
    if (!saved?.approved || saved.artifact.sha256 !== input.artifactSha256) throw changed();
    return view(saved);
  }
  async function stream({ actor, preparedId, artifactSha256, req, res }) {
    let upstream;
    res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Vary", "Cookie"); res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      exact({ preparedId }, ["preparedId"]);
      if (!HASH.test(artifactSha256 || "")) throw invalid();
      if (!["GET", "HEAD"].includes(req.method)) throw new PaidFilmReviewError("GENERATION_REVIEW_METHOD", 405, "Use the saved film's review player.");
      const initial = await binding(actor, preparedId); if (!initial?.artifact || initial.artifact.sha256 !== artifactSha256) throw changed();
      const artifact = initial.artifact, etag = `"sha256-${artifact.sha256}"`; let range;
      try { range = parseRange(req.headers?.["if-range"] && req.headers["if-range"] !== etag ? null : req.headers?.range, artifact.sizeBytes); }
      catch (error) {
        if (error.status !== 416) throw error;
        res.statusCode = 416; res.setHeader("Content-Range", `bytes */${artifact.sizeBytes}`); res.setHeader("Accept-Ranges", "bytes"); return res.end();
      }
      upstream = await getBlob(artifact.pathname, { access: "private", useCache: false,
        headers: { "accept-encoding": "identity", ...(range ? { Range: range.header } : {}) } });
      if (!blobMatches(upstream, artifact, range)) throw unavailable();
      const current = await unchanged(actor, initial);
      if (current.artifact?.sha256 !== artifactSha256) throw changed();
      const length = range?.length ?? artifact.sizeBytes;
      res.statusCode = range ? 206 : 200; res.setHeader("Content-Type", "video/mp4"); res.setHeader("Content-Length", String(length));
      res.setHeader("Accept-Ranges", "bytes"); res.setHeader("ETag", etag); res.setHeader("Content-Disposition", 'inline; filename="generation-review.mp4"');
      if (range) res.setHeader("Content-Range", range.contentRange);
      if (req.method === "HEAD") { await upstream.stream.cancel(); upstream = undefined; return res.end(); }
      let received = 0;
      const exactLength = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length; callback(received > length ? unavailable() : null, chunk);
      }, flush(callback) { callback(received === length ? undefined : unavailable()); } });
      const source = Readable.fromWeb(upstream.stream); upstream = undefined;
      await pipeline(source, exactLength, res);
    } catch (error) {
      await upstream?.stream?.cancel().catch(() => {});
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      for (const header of ["Content-Length", "Content-Range", "Content-Disposition", "ETag", "Accept-Ranges"]) res.removeHeader?.(header);
      const safe = error instanceof PaidFilmReviewError ? error : unavailable();
      res.statusCode = safe.status; res.setHeader("Content-Type", "application/json");
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ code: safe.code, message: safe.message }));
    }
  }
  return { review, approve, stream };
}

export const paidFilmGenerationReview = createPaidFilmGenerationReviewService();
