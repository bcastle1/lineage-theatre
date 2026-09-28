import test from "node:test";
import assert from "node:assert/strict";
import { createLocalVideoService, localFilmInput, aiSceneInput, AI_VIDEO_PROFILE } from "../api/_lib/local-video.mjs";
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
  return { service, records, grants, data, storage: { read, write, listBlobs }, advance: ms => { time += ms; }, report: () => ({ sha256: digest(data), sizeBytes: data.length, durationSeconds: 15, width: 1280, height: 720, hasAudio: true, engine: "ffmpeg-espeak" }) };
}

const aiInput = () => ({ ...input(), duration: 2, scenes: [{ title: "A shared harvest", visual: "A slow camera move across a family garden. Leaves move in the breeze." }] });
const filmInput = () => ({ ...input(), mode: "film", voice: "zira", era: "A family garden", style: "Cinematic",
  characters: [{ id: "gardener", name: "Alex", description: "An adult gardener in a straw hat", photoId }],
  scenes: [{ id: "harvest", title: "A shared harvest", visual: "The gardener picks vegetables.", narration: "The garden brought us together.",
    duration: 5, characterIds: ["gardener"], referenceCharacterId: "gardener", audioMode: "tts" }] });
const filmReport = h => ({ ...h.report(), engine: AI_VIDEO_PROFILE.engine, width: 1024, height: 576, durationSeconds: 5.042,
  timeline: [{ id: "harvest", start: 0, duration: 5, shots: 1, referenceApplied: true, audioMode: "tts" }] });

test("full-film plans bind character photos and narration, reject invalid cast, runtime, and audio", () => {
  const plan = filmInput(), normalized = aiSceneInput(plan);
  assert.equal(normalized.scenes[0].photoId, photoId);
  assert.equal(normalized.scenes[0].narration, plan.scenes[0].narration);
  assert.equal(normalized.duration, 5);
  assert.throws(() => aiSceneInput({ ...plan, scenes: [{ ...plan.scenes[0], audioMode: "recording", audioId: photoId }] }), /separate image and audio/);
  for (const scene of [{ ...plan.scenes[0], characterIds: [] }, { ...plan.scenes[0], audioMode: "recording" },
    { ...plan.scenes[0], narration: "" }, { ...plan.scenes[0], duration: 61 }, { ...plan.scenes[0], visual: "" }])
    assert.throws(() => aiSceneInput({ ...plan, scenes: [scene] }));
  assert.throws(() => aiSceneInput({ ...plan, characters: [...plan.characters, ...plan.characters] }), /unique/);
  assert.throws(() => aiSceneInput({ ...plan, voice: "external-voice" }), /narrator/);
  assert.throws(() => aiSceneInput({ ...plan, scenes: Array.from({ length: 11 }, (_, i) => ({ ...plan.scenes[0], id: `scene-${i}`, duration: 60 })) }), /10 minutes/);
});
test("film sources are owned, typed, scoped to the claim, and cannot be arbitrary files", async () => {
  const audioId = "a0000000-0000-4000-8000-000000000009";
  const h = harness({ profile: AI_VIDEO_PROFILE, sources: { file: async (current, owner, id) => {
    assert.equal(owner, current.email);
    if (![photoId, audioId].includes(id)) throw new Error("not owned");
    return { contentType: id === photoId ? "image/png" : "audio/wav", size: 300, pathname: `private/${id}`, customerState: "active" };
  } } });
  await h.service.poll(); const plan = filmInput(); plan.scenes[0].audioMode = "recording"; plan.scenes[0].audioId = audioId;
  const job = await h.service.start(actor, plan), ticket = await h.service.poll();
  assert.equal(ticket.job.mode, "film"); assert.equal(ticket.job.characters[0].photoId, photoId);
  assert.equal((await h.service.source(job.id, ticket.claim, audioId)).contentType, "audio/wav");
  await assert.rejects(h.service.source(job.id, ticket.claim, filmId), /not part/);
  const foreign = filmInput(); foreign.requestId = filmId; foreign.characters[0].photoId = filmId;
  await assert.rejects(h.service.start(actor, foreign), /not owned/);
  const wrongType = filmInput(); wrongType.requestId = filmId; wrongType.characters[0].photoId = audioId;
  await assert.rejects(h.service.start(actor, wrongType), /sources under/);
});
test("full films require complete scene evidence then review of the exact verified output", async () => {
  const h = harness({ profile: AI_VIDEO_PROFILE }); await h.service.poll();
  const job = await h.service.start(actor, filmInput()), ticket = await h.service.poll(), report = filmReport(h);
  for (const changed of [{ ...report, timeline: [] }, { ...report, durationSeconds: 12 },
    { ...report, timeline: [{ ...report.timeline[0], referenceApplied: false }] }, { ...report, timeline: [{ ...report.timeline[0], id: "wrong" }] }])
    await assert.rejects(h.service.upload(job.id, ticket.claim, changed));
  await h.service.upload(job.id, ticket.claim, report);
  const ready = await h.service.complete(job.id, ticket.claim, report);
  assert.equal(ready.status, "review"); assert.equal(ready.plan.scenes[0].narration, filmInput().scenes[0].narration);
  assert.equal((await h.service.video(actor, job.id)).sha256, report.sha256);
  assert.equal((await h.service.poll()).job, null);
  const review = { id: job.id, sha256: report.sha256, decision: "approve", checks: { characters: true, narration: true, timing: true } };
  await assert.rejects(h.service.review({ ...actor, email: "other@example.invalid" }, review));
  await assert.rejects(h.service.review(actor, { ...review, sha256: "f".repeat(64) }), /Refresh/);
  await assert.rejects(h.service.review(actor, { ...review, checks: { characters: true } }), /Review character/);
  const approved = await h.service.review(actor, review);
  assert.equal(approved.status, "completed"); assert.equal(approved.review.sha256, report.sha256);
  assert.equal((await h.service.status(actor, job.id)).review.decision, "approve");
});
test("requests for changes save notes and keep the review version accessible without requeueing", async () => {
  const h = harness({ profile: AI_VIDEO_PROFILE }); await h.service.poll();
  const job = await h.service.start(actor, filmInput()), ticket = await h.service.poll(), report = filmReport(h);
  await h.service.upload(job.id, ticket.claim, report); await h.service.complete(job.id, ticket.claim, report);
  await assert.rejects(h.service.review(actor, { id: job.id, sha256: report.sha256, decision: "changes", notes: "" }), /review notes/);
  const changed = await h.service.review(actor, { id: job.id, sha256: report.sha256, decision: "changes", notes: "Revise the opening shot." });
  assert.equal(changed.status, "changes_requested"); assert.equal(changed.review.notes, "Revise the opening shot.");
  assert.equal((await h.service.history(actor)).jobs[0].status, "changes_requested");
  assert.equal((await h.service.poll()).job, null);
  assert.equal((await h.service.video(actor, job.id)).sha256, report.sha256);
});
test("AI scene input limits duration and scope without accepting unverified reference photos", () => {
  assert.equal(aiSceneInput(aiInput()).scenes[0].visual, aiInput().scenes[0].visual);
  for (const duration of [0, 1, 3, 6, 600]) assert.throws(() => aiSceneInput({ ...aiInput(), duration }), /two- or five-second/);
  assert.throws(() => aiSceneInput({ ...aiInput(), scenes: [aiInput().scenes[0], aiInput().scenes[0]] }), /one scene/);
  assert.throws(() => aiSceneInput({ ...aiInput(), scenes: [{ ...aiInput().scenes[0], visual: " " }] }), /description/);
  assert.throws(() => aiSceneInput({ ...aiInput(), scenes: [{ ...aiInput().scenes[0], photoId }] }), /Reference photos/);
  assert.throws(() => aiSceneInput({ ...aiInput(), consent: false }), /Confirm/);
});
test("AI and archive queues, heartbeats, history and output paths remain isolated", async () => {
  const h = harness({ profile: AI_VIDEO_PROFILE });
  const archive = createLocalVideoService({ ...h.storage, enabled: () => true, now: () => 1000 });
  await h.service.poll();
  assert.equal((await archive.capabilities()).available, false);
  const job = await h.service.start(actor, aiInput());
  await assert.rejects(archive.status(actor, job.id), /not found/);
  assert.equal((await archive.poll()).job, null);
  const ticket = await h.service.poll();
  assert.equal(ticket.job.id, job.id);
  await assert.rejects(h.service.upload(job.id, ticket.claim, h.report()), /verified/);
  const report = { ...h.report(), engine: AI_VIDEO_PROFILE.engine, width: 1024, height: 576, durationSeconds: 2.042 };
  await h.service.upload(job.id, ticket.claim, report);
  const completed = await h.service.complete(job.id, ticket.claim, report);
  assert.match(completed.mediaUrl, /local=ltx/);
  assert.match(h.grants[0].pathname, /^ai-video\/media\//);
  assert.deepEqual((await archive.history(actor)).jobs, []);
  await assert.rejects(h.service.video({ email: "other@example.invalid" }, job.id), /not found/);
});
test("AI worker requires its own credential and applies its own daily quota", async () => {
  const limits = [];
  const handler = createLocalVideoHandler({ service: { poll: async () => ({ job: null }), start: async () => ({ id: "ai" }), review: async () => ({ status: "completed" }) },
    sessionFor: async () => ({ user: actor }), workerKey: () => "a".repeat(48), ratePrefix: "ai-video", dailyLimit: 6,
    limiter: async (...args) => { limits.push(args); return true; } });
  async function call(url, headers, body) {
    const result = {};
    await handler({ url, method: "POST", headers: { host: "lineagetheater.com", ...headers }, body }, {
      set statusCode(value) { result.status = value; }, setHeader() {}, removeHeader() {}, end(value) { result.body = JSON.parse(value); },
    }); return result;
  }
  assert.equal((await call("/api/studio?local=ltx&worker=1", { authorization: `Bearer ${"s".repeat(48)}` }, { action: "poll" })).status, 401);
  assert.equal((await call("/api/studio?local=ltx&worker=1", { authorization: `Bearer ${"a".repeat(48)}` }, { action: "poll" })).status, 200);
  assert.equal((await call("/api/studio?local=ltx", { origin: "https://lineagetheater.com" }, aiInput())).status, 202);
  assert.deepEqual(limits, [[`ai-video:${actor.email}`, 6, 86400_000]]);
  assert.equal((await call("/api/studio?local=ltx&action=review", { origin: "https://unrelated.invalid" }, {})).status, 403);
  assert.equal(limits.length, 1);
  assert.equal((await call("/api/studio?local=ltx&action=review", { origin: "https://lineagetheater.com" }, {})).status, 200);
  assert.deepEqual(limits[1], [`ai-video-review:${actor.email}`, 60, 3600_000]);
});
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

test("neural narration is validated, claimed, and verified against the saved voice and pace", async () => {
  const h = harness({profile: AI_VIDEO_PROFILE}); await h.service.poll();
  const plan = {...filmInput(), voice:"af_heart", speed:0.9};
  plan.scenes[0].voice="bm_fable";
  const job=await h.service.start(actor,plan), ticket=await h.service.poll();
  assert.equal(ticket.job.voice,"af_heart"); assert.equal(ticket.job.speed,0.9);
  assert.equal(ticket.job.scenes[0].voice,"bm_fable");
  assert.equal(job.plan.speed,0.9);
  await assert.rejects(h.service.start(actor,{...plan,speed:1.1}),/different saved draft/);
  const report=filmReport(h);
  for (const narration of [{}, {voice:"af_heart",speed:0.9}, {voice:"bm_fable",speed:1}]) {
    await assert.rejects(h.service.upload(job.id,ticket.claim,{...report,timeline:[{...report.timeline[0],...narration}]}),/voice and pace/);
  }
  report.timeline[0]={...report.timeline[0],voice:"bm_fable",speed:0.9};
  await h.service.upload(job.id,ticket.claim,report);
  const ready=await h.service.complete(job.id,ticket.claim,report);
  assert.equal(ready.timeline[0].voice,"bm_fable"); assert.equal(ready.timeline[0].speed,0.9);
  assert.equal((await h.service.history(actor)).jobs[0].plan.scenes[0].voice,"bm_fable");
});

test("voice controls reject unknown presets and unsafe pace without changing legacy snapshots", () => {
  for (const speed of [null,"1",false,0.79,1.21,NaN,Infinity]) assert.throws(()=>aiSceneInput({...filmInput(),speed}),/speaking pace/);
  const plan=filmInput();
  assert.equal(Object.hasOwn(aiSceneInput(plan),"speed"),false);
  assert.throws(()=>aiSceneInput({...plan,scenes:[{...plan.scenes[0],voice:"../../unsafe"}]}),/scene narrator/);
  const silent=aiSceneInput({...plan,speed:1,scenes:[{...plan.scenes[0],audioMode:"silent",voice:"af_heart"}]});
  assert.equal(Object.hasOwn(silent.scenes[0],"voice"),false);
});
