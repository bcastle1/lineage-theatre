import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPaidFilmDeliveryWorker, generationDeliveryBinding, generationDeliveryPath,
  generationAttemptAuthorization, generationOutputHosts, generationMediaSource } from "../scripts/paid-film-delivery-worker.mjs";
import { verifyFilmMedia } from "../scripts/assemble-film.mjs";
import { buildFilmManifest, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { createPaidFilmGenerationReviewService } from "../api/_lib/paid-film-generation-review.mjs";
import { createFilmLibraryService } from "../api/_lib/film-library.mjs";

const ID = "00000000-0000-4000-8000-000000000009";
const CHANGE = "00000000-0000-4000-8000-000000000008";
const TASK = "2032443088023777281", HOST = "videocos.magiclight.ai";
const SOURCE_URL = `https://${HOST}/private-output.mp4?signature=synthetic-private-token`;
const NOW = Date.parse("2026-09-28T03:00:00Z"), OWNER = { email: OWNER_EMAIL, role: "owner", status: "active" };
const bytes = Buffer.from("0000ftypisom00000000000000000000"); bytes.writeUInt32BE(24, 0);
const clone = structuredClone;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "lineage-paid-worker-test-"));
  let at = NOW, revision = 0;
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject());
  const orderId = digest(`${OWNER_EMAIL}:production:${manifestHash}`);
  const attempt = { version: 1, id: ID, ownerEmail: OWNER_EMAIL, filmId: manifest.filmId, manifestHash, orderId, submissionCount: 1,
    status: "verifying", taskId: TASK, outputUrl: SOURCE_URL, keyFingerprint: "a".repeat(64), promptHash: "b".repeat(64),
    changeId: CHANGE, submittedAt: new Date(NOW - 600_000).toISOString(), updatedAt: new Date(NOW).toISOString() };
  const job = { id: ID, ownerHash: digest(OWNER_EMAIL), filmId: manifest.filmId, manifestHash, manifest, mode: "customer", status: "prepared",
    createdAt: new Date(NOW - 600_000).toISOString(), updatedAt: new Date(NOW - 600_000).toISOString(), revision: 1,
    shots: manifest.shots.map(shot => ({ id: shot.id, status: "prepared" })) };
  const order = { id: orderId, customerEmail: OWNER_EMAIL, preparedId: ID, filmId: manifest.filmId, manifestHash,
    provider: "quickbooks", checkoutMethod: "quickbooks-hosted-invoice", status: "captured", capturedAt: new Date(NOW - 1000).toISOString(),
    currency: "USD", amountCents: 519, refundedCents: 0, merchantBinding: { environment: "production", grantId: "c".repeat(64), realmId: "12345" },
    confirmationSource: "quickbooks-accounting", invoiceId: "209", balanceCents: 0, accountingCheckedAt: new Date(NOW).toISOString(),
    accountingPayments: [{ id: "210", allocatedCents: 519 }] };
  const sourcePath = `production/generation-attempts/${digest(OWNER_EMAIL)}/${ID}.json`;
  const planPath = `production/jobs/${digest(OWNER_EMAIL)}/${ID}.json`, paymentPath = `payments/orders/${orderId}.json`;
  const stagePath = generationDeliveryPath(OWNER_EMAIL, ID);
  const records = new Map([[userPath(OWNER_EMAIL), { value: clone(OWNER), etag: "owner1" }], [sourcePath, { value: clone(attempt), etag: "attempt1" }],
    [planPath, { value: clone(job), etag: "plan1" }], [paymentPath, { value: clone(order), etag: "payment1" }]]);
  const objects = new Map(), fetches = [], puts = [], gets = [], writes = [];
  const read = async path => { await options.beforeRead?.(path); return clone(records.get(path) ?? null); };
  const write = async (path, value, etag) => {
    await options.beforeWrite?.(path, value);
    const old = records.get(path);
    if (old ? old.etag !== etag : Boolean(etag)) throw Error("precondition failed");
    records.set(path, { value: clone(value), etag: `etag-${++revision}` }); writes.push(path);
    await options.afterWrite?.(path, value);
  };
  const dependencies = { read, write, now: () => at, tempRoot: root, allowedHosts: [HOST],
    listBlobs: async input => ({ blobs: [...records.keys()].filter(path => path.startsWith(input.prefix)).map(pathname => ({ pathname })), hasMore: false }),
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
      assert.equal(init.headers.Authorization, undefined);
      return options.fetch ? options.fetch(url, init) : new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } });
    },
    verifyMedia: async input => {
      assert.deepEqual(await readFile(input.path), bytes);
      if (options.verify) return options.verify(input);
      return { manifestHash, contentType: "video/mp4", sizeBytes: bytes.length, durationSeconds: manifest.targetDurationSeconds,
        width: 1920, height: 1080, frameRate: 24, hasAudio: true, playable: true, technicalSample: false,
        contentReviewed: false, verification: "full-video-and-audio-decode", sha256: digest(bytes) };
    },
    putBlob: async (path, data, config) => {
      puts.push(path); assert.equal(config.access, "private"); assert.equal(config.allowOverwrite, false); assert.equal(config.addRandomSuffix, false);
      assert.deepEqual(data, bytes);
      if (objects.has(path)) throw Error("already exists");
      objects.set(path, Buffer.from(data)); await options.afterPut?.(path);
    },
    getBlob: async path => {
      gets.push(path);
      const saved = objects.get(path);
      if (!saved) return null;
      const result = { statusCode: 200, blob: { pathname: path, size: saved.length, contentType: "video/mp4" }, stream: new Response(saved).body,
        headers: new Headers({ "content-type": "video/mp4", "content-length": String(saved.length) }) };
      return options.get ? options.get(path, result) : result;
    }, ...options.overrides };
  const worker = createPaidFilmDeliveryWorker(dependencies);
  return { root, worker, records, objects, sourcePath, stagePath, planPath, paymentPath, attempt, job, order, fetches, puts, gets, writes, dependencies,
    start: () => worker.runOne(sourcePath), peer: () => createPaidFilmDeliveryWorker(dependencies), advance: ms => { at += ms; },
    stage: () => clone(records.get(stagePath)?.value), mutate: (path, patch) => { const old = records.get(path); records.set(path, { value: { ...old.value, ...patch }, etag: `external-${++revision}` }); },
    dispose: async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); } };
}
async function using(options, callback) { const h = await fixture(options); try { await callback(h); } finally { await h.dispose(); } }

test("owner output stages a private checked artifact for content review without fulfilling or altering the paid plan", async () => {
  await using({}, async h => {
    const originalPlan = clone(h.records.get(h.planPath)), originalAttempt = clone(h.records.get(h.sourcePath));
    assert.deepEqual(await h.start(), { state: "awaiting-review" });
    const stage = h.stage(), binding = generationDeliveryBinding(h.attempt);
    assert.equal(stage.status, "awaiting-review"); assert.equal(stage.lease, undefined); assert.equal(stage.attempts, 1);
    for (const [key, value] of Object.entries(binding)) assert.equal(stage[key], value);
    assert.equal(stage.artifact.contentReviewed, false); assert.equal(stage.artifact.sha256, digest(bytes));
    assert.equal(stage.artifact.pathname, `production/media/${digest(OWNER_EMAIL)}/${ID}/${digest(bytes)}.mp4`);
    assert.equal(stage.artifact.manifestHash, h.job.manifestHash);
    assert.deepEqual(h.records.get(h.planPath), originalPlan); assert.deepEqual(h.records.get(h.sourcePath), originalAttempt);
    assert.doesNotMatch(JSON.stringify(stage), /synthetic-private-token|2032443088023777281|https:/);
    assert.equal(h.fetches.length, 1); assert.equal(h.puts.length, 1); assert.equal(h.gets.length, 1);
    assert.deepEqual(await readdir(h.root), []);
    await h.start(); h.mutate(h.planPath, { status: "completed" }); await h.start();
    assert.equal(h.fetches.length, 1); assert.equal(h.puts.length, 1);
    assert.equal(generationAttemptAuthorization(binding).kind, "owner-generation-attempt");
  });
});

test("empty output host allowlist cannot enable or run imports; configured hosts and URLs must be exact public HTTPS names", async () => {
  assert.deepEqual(generationOutputHosts(undefined), []); assert.deepEqual(generationOutputHosts(""), []);
  assert.deepEqual(generationOutputHosts(HOST), [HOST]);
  for (const value of ["*", "*.magiclight.ai", "localhost", "127.0.0.1", "metadata.internal", "https://videocos.magiclight.ai", `${HOST},${HOST}`, `${HOST},`])
    assert.throws(() => generationOutputHosts(value));
  for (const value of ["http://videocos.magiclight.ai/a.mp4", "https://other.com/a.mp4", "https://user@videocos.magiclight.ai/a.mp4",
    "https://videocos.magiclight.ai:443/a.mp4", "https://videocos.magiclight.ai/a.mp4#x", "https://videocos.magiclight.ai\\@other.com/a.mp4", "https://VIDEOCOS.magiclight.ai/a.mp4"])
    assert.throws(() => generationMediaSource(value, [HOST]));
  await using({ overrides: { allowedHosts: [] } }, async h => {
    assert.equal(h.worker.readiness().outputHostsConfigured, false);
    await assert.rejects(h.start(), e => e.code === "DELIVERY_SOURCE_UNAPPROVED");
    await assert.rejects(h.worker.runBatch(), e => e.code === "DELIVERY_SOURCE_UNAPPROVED");
    assert.equal(h.fetches.length, 0); assert.equal(h.writes.length, 0);
  });
});

test("worker staging interoperates with real review and library services: only explicit content approval enables paid playback", async () => {
  await using({}, async h => {
    const { read, write, getBlob, now } = h.dependencies;
    const library = createFilmLibraryService({ read, now });
    const publicOrder = { id: h.order.id, preparedId: ID, filmId: h.job.filmId, status: "captured", sandbox: false,
      refundedCents: 0, requiresReview: false, checkoutMethod: h.order.checkoutMethod, confirmationSource: h.order.confirmationSource,
      amountCents: 519, currency: "USD", receiptAvailable: true };
    const review = createPaidFilmGenerationReviewService({ read, write, getBlob, now, checkPayment: async () => clone(publicOrder) });
    assert.equal((await library.detail(OWNER, { kind: "plan", id: ID })).entry.production.mediaReady, false);
    await h.start();
    assert.equal((await review.review(OWNER, { preparedId: ID })).status, "awaiting-review");
    assert.equal((await library.detail(OWNER, { kind: "plan", id: ID })).entry.production.mediaReady, false);
    assert.equal((await review.approve(OWNER, { preparedId: ID, artifactSha256: h.stage().artifact.sha256, consent: true })).status, "approved");
    const detail = await library.detail(OWNER, { kind: "plan", id: ID });
    assert.equal(detail.entry.production.mediaReady, true); assert.equal(detail.entry.production.status, "completed");
    assert.equal(detail.entry.mediaUrl, `/api/studio?action=productionMedia&id=${ID}`);
    assert.equal(detail.entry.downloadUrl, `/api/studio?action=productionMedia&id=${ID}&download=1`);
    assert.deepEqual(h.records.get(h.planPath).value.shots, h.job.shots);
    assert.equal(h.stage().status, "awaiting-review"); assert.equal(h.stage().artifact.contentReviewed, false);
    assert.deepEqual(await h.start(), { state: "skipped" }); assert.equal(h.fetches.length, 1);
  });
});

test("unapproved owner, changed plan, mismatched attempt and unverified or refunded payment fail before download", async () => {
  const changes = [h => h.mutate(userPath(OWNER_EMAIL), { status: "suspended" }), h => h.mutate(userPath(OWNER_EMAIL), { role: "customer" }),
    h => h.mutate(userPath(OWNER_EMAIL), { mustChangePassword: true }), h => h.mutate(h.planPath, { status: "processing" }),
    h => h.mutate(h.planPath, { manifestHash: "c".repeat(64) }), h => h.mutate(h.sourcePath, { orderId: "d".repeat(64) }),
    h => h.mutate(h.sourcePath, { ownerEmail: "customer@other.com" }), h => h.mutate(h.sourcePath, { outputUrl: "https://other.com/output.mp4" }),
    h => h.mutate(h.paymentPath, { status: "awaiting-payment" }), h => h.mutate(h.paymentPath, { refundedCents: 1 }),
    h => h.mutate(h.paymentPath, { checkOperation: "pending" }), h => h.mutate(h.paymentPath, { refundOperation: "pending" }),
    h => h.mutate(h.paymentPath, { accountingPayments: [{ id: "210", allocatedCents: 330 }] }),
    h => h.mutate(h.paymentPath, { preparedId: CHANGE }), h => h.mutate(h.paymentPath, { merchantBinding: { ...h.order.merchantBinding, environment: "sandbox" } })];
  for (const change of changes) await using({}, async h => {
    change(h); assert.equal((await h.start()).state, "attention"); assert.equal(h.fetches.length, 0); assert.equal(h.puts.length, 0); assert.equal(h.stage(), undefined);
  });
});

test("redirects, changed lengths, encodings, media types and non-MP4 data cannot reach validation or publication", async () => {
  const replies = [() => new Response(bytes, { status: 302 }),
    () => new Response(bytes, { headers: { "content-type": "text/html" } }),
    () => new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length + 1) } }),
    () => new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": "300000000" } }),
    () => new Response(bytes, { headers: { "content-type": "video/mp4", "content-encoding": "gzip" } }),
    () => new Response(bytes, { headers: { "content-type": "video/mp4", "content-range": "bytes 0-31/32" } }),
    () => new Response(Buffer.alloc(bytes.length), { headers: { "content-type": "video/mp4" } })];
  for (const reply of replies) await using({ fetch: async () => reply(), verify: async () => assert.fail("Invalid response reached the decoder.") }, async h => {
    assert.equal((await h.start()).state, "pending"); assert.equal(h.stage().lastFailure, "DELIVERY_DOWNLOAD_FAILED"); assert.equal(h.puts.length, 0);
    assert.deepEqual(await readdir(h.root), []);
  });
});

test("technical failures never stage a false reviewable artifact or leak decoder details", async () => {
  for (const patch of [{ hasAudio: false }, { contentReviewed: true }, { durationSeconds: 2 }, { sha256: "0".repeat(64) },
    { width: 8192 }, { technicalSample: true }, { playable: false }, { sizeBytes: bytes.length + 1 }]) {
    await using({}, async h => {
      const original = h.dependencies.verifyMedia;
      h.dependencies.verifyMedia = async input => ({ ...await original(input), ...patch });
      const worker = createPaidFilmDeliveryWorker(h.dependencies);
      assert.equal((await worker.runOne(h.sourcePath)).state, "attention"); assert.equal(h.stage().lastFailure, "DELIVERY_MEDIA_INVALID");
      assert.equal(h.puts.length, 0); assert.equal(h.stage().artifact, undefined);
    });
  }
  await using({ verify: async () => { throw Error("private-path private-source-token"); } }, async h => {
    await h.start(); assert.doesNotMatch(JSON.stringify(h.stage()), /private-path|private-source-token/);
  });
});

test("concurrent workers and lost commit or upload replies do not duplicate downloads or approve content", async () => {
  const entered = deferred(), release = deferred(); let lostWrites = 2;
  await using({ fetch: async () => { entered.resolve(); await release.promise; return new Response(bytes, { headers: { "content-type": "video/mp4" } }); },
    afterWrite: async path => { if (path.includes("generation-delivery/") && lostWrites-- > 0) throw Error("lost reply"); },
    afterPut: async () => { throw Error("lost upload reply"); } }, async h => {
    const first = h.start(); await entered.promise;
    assert.deepEqual(await h.peer().runOne(h.sourcePath), { state: "skipped" });
    release.resolve(); assert.deepEqual(await first, { state: "awaiting-review" });
    await h.start(); assert.equal(h.fetches.length, 1); assert.equal(h.puts.length, 1); assert.equal(h.stage().artifact.contentReviewed, false);
  });
});

test("lease loss, changed task source and owner revocation during decoding prevent publication", async () => {
  for (const change of [h => h.mutate(h.stagePath, { lease: { token: CHANGE, expiresAt: NOW + 60000 } }),
    h => h.mutate(h.sourcePath, { outputUrl: `https://${HOST}/different.mp4` }), h => h.mutate(h.sourcePath, { taskId: "another-task" }),
    h => h.mutate(userPath(OWNER_EMAIL), { status: "suspended" }), h => h.mutate(h.paymentPath, { refundedCents: 519 })]) {
    await using({}, async h => {
      const original = h.dependencies.verifyMedia;
      h.dependencies.verifyMedia = async input => { const result = await original(input); change(h); return result; };
      assert.notEqual((await createPaidFilmDeliveryWorker(h.dependencies).runOne(h.sourcePath)).state, "awaiting-review");
      assert.equal(h.puts.length, 0); assert.equal(h.records.get(h.planPath).value.status, "prepared");
    });
  }
});

test("payment revocation after upload prevents publishing metadata; corrupt storage can retry the same source safely", async () => {
  await using({}, async h => {
    const put = h.dependencies.putBlob;
    h.dependencies.putBlob = async (...args) => { await put(...args); h.mutate(h.paymentPath, { refundedCents: 519 }); };
    assert.equal((await createPaidFilmDeliveryWorker(h.dependencies).runOne(h.sourcePath)).state, "attention");
    assert.equal(h.stage().artifact, undefined); assert.equal(h.records.get(h.planPath).value.media, undefined);
  });
  let broken = true;
  await using({ get: async (_path, result) => broken ? { ...result, stream: new Response(Buffer.alloc(bytes.length)).body } : result }, async h => {
    assert.equal((await h.start()).state, "pending"); assert.equal(h.stage().artifact, undefined);
    assert.equal((await h.start()).state, "skipped"); h.advance(60_000); broken = false;
    assert.equal((await h.start()).state, "awaiting-review"); assert.equal(h.fetches.length, 2); assert.equal(h.objects.size, 1);
    assert.equal(h.stage().attempts, 2);
  });
});

test("expired claims are recoverable while repeated delivery failures become attention without any provider submission", async () => {
  await using({}, async h => {
    h.records.set(h.stagePath, { etag: "crashed", value: { version: 1, ...generationDeliveryBinding(h.attempt), status: "importing",
      attempts: 1, changeId: CHANGE, createdAt: new Date(NOW - 600_000).toISOString(), nextAttemptAt: 0, lease: { token: CHANGE, expiresAt: NOW - 1 } } });
    assert.equal((await h.start()).state, "awaiting-review"); assert.equal(h.stage().attempts, 2);
  });
  await using({ fetch: async () => { throw Error("provider-private-details"); } }, async h => {
    assert.equal((await h.start()).state, "pending"); h.advance(60_000);
    assert.equal((await h.start()).state, "pending"); h.advance(120_000);
    assert.equal((await h.start()).state, "attention"); h.advance(600_000);
    assert.equal((await h.start()).state, "skipped"); assert.equal(h.fetches.length, 3); assert.equal(h.stage().attempts, 3);
    assert.equal(h.fetches.every(call => call.init.method === "GET"), true);
    assert.doesNotMatch(JSON.stringify(h.stage()), /provider-private-details/);
  });
});

test("paged batches count only bounded saved attempts and preserve a durable cursor", async () => {
  let page = 0; const inputs = [];
  await using({ overrides: { listBlobs: async input => {
    inputs.push(input); return page++ === 0 ? { blobs: [{ pathname: "other/path.json" }], hasMore: true, cursor: "next-page" } : { blobs: [], hasMore: false };
  } } }, async h => {
    assert.deepEqual(await h.worker.runBatch(), { "awaiting-review": 0, pending: 0, attention: 0, skipped: 1, hasMore: true });
    assert.equal((await h.worker.runBatch()).hasMore, false);
    assert.equal(inputs[0].cursor, undefined); assert.equal(inputs[1].cursor, "next-page"); assert.equal(inputs[0].limit, 5);
    assert.equal(h.fetches.length, 0);
  });
});

test("worker CLI check is offline and failures never expose runtime credentials", () => {
  const script = fileURLToPath(new URL("../scripts/paid-film-delivery-worker.mjs", import.meta.url));
  const env = { ...process.env, BLOB_READ_WRITE_TOKEN: "synthetic-private-blob-token", LINEAGE_GENERATION_OUTPUT_HOSTS: "" };
  const check = spawnSync(process.execPath, [script, "--check"], { env, encoding: "utf8", windowsHide: true });
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), { outputHostsConfigured: false, contentReviewRequired: true, generationSubmitted: false, storageConfigured: true, nodeSupported: true });
  const once = spawnSync(process.execPath, [script, "--once"], { env, encoding: "utf8", windowsHide: true });
  assert.equal(once.status, 1); assert.doesNotMatch(once.stdout + once.stderr, /synthetic-private-blob-token/);
});

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const probe = spawnSync(ffmpeg, ["-version"], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
const unavailable = !process.env.FFMPEG_PATH && probe.error?.code === "ENOENT";
async function mediaFixture(args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-n", ...args], { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(Error("Synthetic fixture timeout")); }, 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolveRun() : reject(Error("Synthetic fixture failed")); });
  });
}
test("real decoder verifies the unchanged full video and audio, rejects missing/short audio and incorrect target duration", { skip: unavailable ? "Optional FFmpeg runtime not installed; CI provides it." : false }, async () => {
  assert.equal(probe.error, undefined); assert.equal(probe.status, 0);
  const root = await mkdtemp(join(tmpdir(), "lineage-full-film-test-"));
  try {
    const full = join(root, "full.mp4"), silent = join(root, "silent.mp4"), short = join(root, "short-audio.mp4");
    const video = ["-f", "lavfi", "-i", "color=c=navy:s=320x180:r=24:d=3"], audio = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3"];
    const encoding = ["-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
      "-metadata", "comment=SAMPLE ONLY - SYNTHETIC DECODER TEST. Not a generated family film."];
    await mediaFixture([...video, ...audio, ...encoding, full]);
    await mediaFixture([...video, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    await mediaFixture([...video, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", ...encoding, short]);
    const manifest = { version: 1, targetDurationSeconds: 3 }, manifestHash = digest(JSON.stringify(manifest));
    const result = await verifyFilmMedia({ manifest, manifestHash, path: full, ffmpeg });
    assert.equal(result.contentReviewed, false); assert.equal(result.hasAudio, true); assert.equal(result.sha256, digest(await readFile(full)));
    assert.equal(result.width, 320); assert.equal(result.height, 180); assert.equal(result.frameRate, 24);
    await assert.rejects(verifyFilmMedia({ manifest, manifestHash, path: silent, ffmpeg }));
    await assert.rejects(verifyFilmMedia({ manifest, manifestHash, path: short, ffmpeg }));
    const longer = { ...manifest, targetDurationSeconds: 10 };
    await assert.rejects(verifyFilmMedia({ manifest: longer, manifestHash: digest(JSON.stringify(longer)), path: full, ffmpeg }));
    await assert.rejects(verifyFilmMedia({ manifest, manifestHash: "0".repeat(64), path: full, ffmpeg }));
    const truncated = join(root, "truncated.mp4"), source = await readFile(full); await writeFile(truncated, source.subarray(0, Math.floor(source.length / 2)));
    await assert.rejects(verifyFilmMedia({ manifest, manifestHash, path: truncated, ffmpeg }));
  } finally { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); }
});
