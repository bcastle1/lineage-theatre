import test from "node:test";
import assert from "node:assert/strict";
import { createLocalVideoService, localFilmInput } from "../api/_lib/local-video.mjs";
import { createLocalVideoHandler } from "../api/_lib/local-video-handler.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";

const actor = { email: "archive@example.invalid", status: "active", approvedAt: "2026-09-01T00:00:00Z", approvedBy: "erik@brocotech.ai" };
const filmId = "a0000000-0000-4000-8000-000000000001";
const photoId = "a0000000-0000-4000-8000-000000000003";
const input = () => ({ filmId, requestId: "a0000000-0000-4000-8000-000000000002", consent: true, title: "Family garden", duration: 15,
  scenes: [{ title: "A shared harvest", narration: "The garden brought the family together.", visual: "A family garden", dialogue: "" }] });
function harness(options = {}) {
  let time = 1000, seq = 0;
  const records = new Map([[userPath(actor.email), { value: actor, etag: "a" }]]);
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    const old = records.get(path);
    if (old && old.etag !== etag || !old && etag) throw new Error("etag precondition failed");
    records.set(path, { value: structuredClone(value), etag: String(++seq) });
  };
  const listBlobs = async ({ prefix }) => ({ blobs: [...records.keys()].filter(p => p.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false });
  const grants = [], data = Buffer.from("fictional mp4 fixture ".repeat(40));
  let uploaded;
  const service = createLocalVideoService({ read, write, listBlobs, remove: async path => records.delete(path), now: () => time, enabled: () => true,
    sources: { file: async (current, owner, id) => { assert.equal(owner, current.email); assert.equal(id, photoId); return { contentType: "image/png", size: 256, pathname: "private/photo.png", customerState: "active" }; } },
    token: async value => { grants.push(value); uploaded = value.pathname; return "synthetic-scoped-grant"; },
    getBlob: async pathname => ({ stream: new Blob([data]).stream(), blob: { pathname: uploaded || pathname, contentType: "video/mp4", size: data.length } }), ...options });
  return { service, records, grants, data, advance: ms => { time += ms; }, report: () => ({ sha256: digest(data), sizeBytes: data.length, durationSeconds: 15, width: 1280, height: 720, hasAudio: true, engine: "ffmpeg-espeak" }) };
}
test("offline renderer refuses new jobs; durable status remains available", async () => {
  const h = harness();
  assert.equal((await h.service.capabilities()).available, false);
  await assert.rejects(h.service.start(actor, input()), /offline/);
  await h.service.poll();
  const job = await h.service.start(actor, input());
  h.advance(121_000);
  assert.equal((await h.service.capabilities()).available, false);
  assert.equal((await h.service.status(actor, job.id)).status, "queued");
});
test("start is idempotent and rejects changed plans, foreign-account status, and unconfirmed rendering", async () => {
  const h = harness(); await h.service.poll();
  const [first, second] = await Promise.all([h.service.start(actor, input()), h.service.start(actor, input())]);
  assert.equal(first.id, second.id);
  await assert.rejects(h.service.start(actor, { ...input(), title: "Changed" }), /different saved draft/);
  await assert.rejects(h.service.status({ email: "other@example.invalid" }, first.id), /not found/);
  assert.throws(() => localFilmInput({ ...input(), consent: false }), /Confirm/);
});
test("one worker claims a job, renews its lease, and source access is limited to its approved photos", async () => {
  const h = harness(); await h.service.poll();
  const plan = input(); plan.scenes[0].photoId = photoId;
  const job = await h.service.start(actor, plan);
  const [one, two] = await Promise.all([h.service.poll(), h.service.poll()]);
  const ticket = one.job ? one : two;
  assert.equal([one, two].filter(t => t.job).length, 1);
  await assert.rejects(h.service.source(job.id, "bad-claim", photoId), /claim expired/);
  await assert.rejects(h.service.source(job.id, ticket.claim, filmId), /not part/);
  assert.equal((await h.service.source(job.id, ticket.claim, photoId)).pathname, "private/photo.png");
  h.advance(240_000); await h.service.progress(job.id, ticket.claim, 50);
  h.advance(240_000); assert.equal((await h.service.poll()).job, null);
});
test("expired work is recoverable, and an old worker cannot publish or fail a new claim", async () => {
  const h = harness(); await h.service.poll(); const job = await h.service.start(actor, input());
  const old = await h.service.poll(); h.advance(301_000); const current = await h.service.poll();
  assert.notEqual(old.claim, current.claim);
  await assert.rejects(h.service.failed(job.id, old.claim), /claim expired/);
  await assert.rejects(h.service.upload(job.id, old.claim, h.report()), /claim expired/);
  await h.service.failed(job.id, current.claim);
  assert.equal((await h.service.status(actor, job.id)).status, "failed");
});
test("completion requires private byte-identical media; grants cannot overwrite or upload unrelated files", async () => {
  const h = harness(); await h.service.poll(); const job = await h.service.start(actor, input()); const ticket = await h.service.poll();
  await assert.rejects(h.service.video(actor, job.id), /not ready/);
  await h.service.upload(job.id, ticket.claim, h.report());
  assert.equal(h.grants[0].allowOverwrite, false);
  assert.equal(h.grants[0].maximumSizeInBytes, h.data.length);
  assert.deepEqual(h.grants[0].allowedContentTypes, ["video/mp4"]);
  await assert.rejects(h.service.complete(job.id, ticket.claim, { ...h.report(), sha256: "f".repeat(64) }), /verified|checksum/);
  const complete = await h.service.complete(job.id, ticket.claim, h.report());
  assert.equal(complete.status, "completed"); assert.equal(complete.progress, 100);
  assert.ok((await h.service.video(actor, job.id)).pathname.startsWith(`local-video/media/${digest(actor.email)}/`));
  assert.doesNotMatch(JSON.stringify(complete), /lease|token|email|pathname/);
});
test("suspended customers cannot claim, fetch source material, or finish work", async () => {
  const h = harness(); await h.service.poll(); const job = await h.service.start(actor, input()); const ticket = await h.service.poll();
  h.records.set(userPath(actor.email), { value: { ...actor, status: "suspended" }, etag: "suspended" });
  await assert.rejects(h.service.progress(job.id, ticket.claim, 50), /cannot render/);
  await assert.rejects(h.service.complete(job.id, ticket.claim, h.report()), /cannot render/);
});
test("worker HTTP authentication cannot be replaced by a customer session and customer starts require same origin", async () => {
  let polls = 0;
  const handler = createLocalVideoHandler({ service: { poll: async () => { polls++; return { job: null }; } }, sessionFor: async () => ({ user: actor }), workerKey: () => "s".repeat(48), limiter: async () => true });
  const run = async (url, headers = {}, body = {}) => {
    const result = {};
    await handler({ url, method: "POST", headers: { host: "lineagetheater.com", ...headers }, body }, { set statusCode(v) { result.status = v; }, setHeader() {}, removeHeader() {}, end(value) { result.body = JSON.parse(value); } });
    return result;
  };
  assert.equal((await run("/api/studio?local=1&worker=1", {}, { action: "poll" })).status, 401);
  assert.equal(polls, 0);
  assert.equal((await run("/api/studio?local=1&worker=1", { authorization: `Bearer ${"s".repeat(48)}` }, { action: "poll" })).status, 200);
  assert.equal(polls, 1);
  assert.equal((await run("/api/studio?local=1", { origin: "https://unrelated.invalid" }, input())).status, 403);
});
test("renderer rejects oversized plans and arbitrary photo references", () => {
  assert.throws(() => localFilmInput({ ...input(), duration: 601 }), /1–30/);
  assert.throws(() => localFilmInput({ ...input(), scenes: Array(31).fill(input().scenes[0]) }), /1–30/);
  assert.throws(() => localFilmInput({ ...input(), scenes: [{ ...input().scenes[0], photoId: "../../unrelated" }] }), /saved photo/);
});

test("history preserves earlier films privately and finished jobs leave the pending queue", async () => {
  const h = harness(); await h.service.poll();
  const first = await h.service.start(actor, input());
  const ticket = await h.service.poll();
  await h.service.upload(first.id, ticket.claim, h.report());
  await h.service.complete(first.id, ticket.claim, h.report());
  const second = await h.service.start(actor, { ...input(), requestId: photoId, title: "Another film" });
  assert.deepEqual((await h.service.history(actor)).jobs.map(job => job.id), [second.id, first.id]);
  assert.deepEqual((await h.service.history({email: "other@example.invalid"})).jobs, []);
  assert.equal((await h.service.poll()).job.id, second.id);
  assert.equal(h.records.has(`local-video/pending/${first.id}.json`), false);
  assert.equal((await h.service.status(actor, first.id)).status, "completed");
});
