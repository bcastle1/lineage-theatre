import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createWorkerAssembly, downloadProductionClip, downloadProductionAudio, verifyPublishedFilm, cleanStaleWorkerDirectories } from "../scripts/production-worker.mjs";
import { digest } from "../api/_lib/auth.mjs";

const bytes = Buffer.from("0000ftypisom00000000000000000000");
const output = { url: "https://media.example.invalid/clip.mp4?secret=test", contentType: "video/mp4", sizeBytes: bytes.length, durationSeconds: 5 };
test("worker downloads only allowlisted HTTPS media and refuses redirects, changed headers and truncated bytes", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => { calls++; assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); return new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } }); };
  assert.deepEqual(await downloadProductionClip(output, ["media.example.invalid"], { fetchImpl }), bytes);
  for (const url of ["http://media.example.invalid/clip.mp4", "https://127.0.0.1/clip.mp4", "https://other.invalid/clip.mp4", "https://user:pass@media.example.invalid/clip.mp4"])
    await assert.rejects(downloadProductionClip({ ...output, url }, ["media.example.invalid"], { fetchImpl }));
  assert.equal(calls, 1);
  for (const response of [new Response(bytes, { status: 302 }), new Response(bytes, { headers: { "content-type": "text/html" } }),
    new Response(bytes.subarray(0, 20), { headers: { "content-type": "video/mp4" } }), new Response(Buffer.concat([bytes, bytes]), { headers: { "content-type": "video/mp4" } })])
    await assert.rejects(downloadProductionClip(output, ["media.example.invalid"], { fetchImpl: async () => response }));
});

test("completion requires exact private stored bytes, manifest, audio and nonsample output", async () => {
  const email = "customer@example.invalid", id = "00000000-0000-4000-8000-000000000001", hash = createHash("sha256").update(bytes).digest("hex");
  const artifact = { pathname: `production/media/${digest(email)}/${id}/${hash}.mp4`, sha256: hash, manifestHash: "a".repeat(64),
    contentType: "video/mp4", sizeBytes: bytes.length, durationSeconds: 15, hasAudio: true, playable: true, technicalSample: false, width: 1920, height: 1080, frameRate: 24 };
  const input = { email, id, artifact, manifestHash: artifact.manifestHash, manifest: { targetDurationSeconds: 15 } };
  const getBlob = async () => ({ blob: { size: bytes.length, contentType: "video/mp4" }, stream: new Response(bytes).body });
  assert.equal((await verifyPublishedFilm(input, { getBlob })).sha256, hash);
  for (const change of [{ technicalSample: true }, { hasAudio: false }, { pathname: "production/media/other/film.mp4" }, { durationSeconds: 50 }, { sha256: "b".repeat(64) },
    { width: undefined }, { width: 1921 }, { width: 8192 }, { height: -2 }, { frameRate: 0 }, { frameRate: Infinity }])
    await assert.rejects(verifyPublishedFilm({ ...input, artifact: { ...artifact, ...change } }, { getBlob }));
  await assert.rejects(verifyPublishedFilm(input, { getBlob: async () => ({ blob: { size: bytes.length, contentType: "video/mp4" }, stream: new Response(Buffer.alloc(bytes.length)).body }) }), /checksum/);
});

test("separate audio downloads require approved hosts, media types and exact bounded bytes", async () => {
  const audio = { url: "https://media.example.invalid/voice.m4a", contentType: "audio/mp4", sizeBytes: bytes.length, durationSeconds: 5 };
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++; assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Accept, "audio/mp4");
    return new Response(bytes, { headers: { "content-type": "audio/mp4" } });
  };
  assert.deepEqual(await downloadProductionAudio(audio, ["media.example.invalid"], { fetchImpl }), bytes);
  for (const change of [{ url: "https://other.invalid/voice.m4a" }, { contentType: "video/mp4" }, { sizeBytes: 500_000_000 }]) {
    await assert.rejects(downloadProductionAudio({ ...audio, ...change }, ["media.example.invalid"], { fetchImpl }));
  }
  assert.equal(calls, 1);
  for (const response of [new Response(bytes, { status: 302 }), new Response(bytes, { headers: { "content-type": "text/html" } }),
    new Response(bytes.subarray(0, 20), { headers: { "content-type": "audio/mp4" } })]) {
    await assert.rejects(downloadProductionAudio(audio, ["media.example.invalid"], { fetchImpl: async () => response }));
  }
});

test("worker carries private separate audio into assembly, retains native profile and cleans temporary media", async () => {
  const root = await mkdtemp(join(tmpdir(), "lineage-audio-worker-test-"));
  const audioBytes = Buffer.from("0000ftypM4A 00000000000000000000"), requests = [], publications = [];
  const hash = createHash("sha256").update(bytes).digest("hex"), manifestHash = "a".repeat(64);
  const audio = { url: "https://media.example.invalid/voice.m4a?private=fixture", contentType: "audio/mp4", sizeBytes: audioBytes.length, durationSeconds: 5 };
  const job = { status: "awaiting-assembly", manifestHash, manifest: { shots: [{ id: "shot-1" }], targetDurationSeconds: 5 },
    shots: [{ id: "shot-1", status: "completed", output: { ...output, audio } }] };
  try {
    const assemble = createWorkerAssembly({ tempRoot: root, adapter: { available: true, outputHosts: ["media.example.invalid"] },
      fetchImpl: async (url, options) => {
        requests.push(url); assert.equal(options.redirect, "error");
        return new Response(url === audio.url ? audioBytes : bytes, { headers: { "content-type": url === audio.url ? "audio/mp4" : "video/mp4" } });
      },
      assemble: async ({ clips, outputPath, technicalSample }) => {
        assert.equal(technicalSample, false); assert.equal(clips.length, 1);
        assert.deepEqual(await readFile(clips[0].path), bytes);
        assert.deepEqual(await readFile(clips[0].audioPath), audioBytes);
        assert.ok(clips[0].audioPath.endsWith(".m4a"));
        await writeFile(outputPath, bytes); await writeFile(`${outputPath}.vtt`, "WEBVTT\n");
        return { manifestHash, sha256: hash, sizeBytes: bytes.length, contentType: "video/mp4", durationSeconds: 5,
          width: 1920, height: 1080, frameRate: 24, hasAudio: true, playable: true, technicalSample: false };
      }, putBlob: async (pathname, data, options) => { publications.push({ pathname, options }); assert.equal(options.access, "private"); },
    });
    const artifact = await assemble({ email: "customer@example.invalid", id: "00000000-0000-4000-8000-000000000001", job, stillOwned: async () => true });
    assert.deepEqual(requests, [output.url, audio.url]); assert.equal(publications.length, 2);
    assert.equal(artifact.width, 1920); assert.equal(artifact.height, 1080); assert.equal(artifact.frameRate, 24);
    assert.deepEqual(await readdir(root), []);
  } finally { if (dirname(resolve(root)) === resolve(tmpdir())) await rm(root, { recursive: true, force: true }); }
});

test("audio download failures remove temporary clips and cannot publish an incomplete film", async () => {
  const root = await mkdtemp(join(tmpdir(), "lineage-audio-failure-test-"));
  let assembled = false, published = false;
  const audio = { url: "https://media.example.invalid/voice.wav", contentType: "audio/wav", sizeBytes: bytes.length, durationSeconds: 5 };
  try {
    const assemble = createWorkerAssembly({ tempRoot: root, adapter: { available: true, outputHosts: ["media.example.invalid"] },
      fetchImpl: async url => new Response(url === audio.url ? bytes.subarray(0, 20) : bytes,
        { headers: { "content-type": url === audio.url ? "audio/wav" : "video/mp4" } }),
      assemble: async () => { assembled = true; }, putBlob: async () => { published = true; },
    });
    const job = { status: "awaiting-assembly", manifest: { shots: [{ id: "shot-1" }] },
      shots: [{ id: "shot-1", status: "completed", output: { ...output, audio } }] };
    await assert.rejects(assemble({ email: "customer@example.invalid", id: "00000000-0000-4000-8000-000000000001", job, stillOwned: async () => true }), /incomplete/);
    assert.equal(assembled, false); assert.equal(published, false); assert.deepEqual(await readdir(root), []);
  } finally { if (dirname(resolve(root)) === resolve(tmpdir())) await rm(root, { recursive: true, force: true }); }
});

test("crash cleanup removes only aged marked directories of dead processes on this host", async () => {
  const root = await mkdtemp(join(tmpdir(), "lineage-cleanup-test-"));
  try {
    for (const name of ["lineage-worker-old", "lineage-worker-active", "lineage-worker-new", "lineage-worker-unknown", "unrelated"]) await mkdir(join(root, name));
    const marker = { kind: "lineage-film-worker-v1", host: hostname(), createdAt: Date.now() - 7200_000, pid: 123 };
    await writeFile(join(root, "lineage-worker-old", ".lineage-worker.json"), JSON.stringify(marker));
    await writeFile(join(root, "lineage-worker-active", ".lineage-worker.json"), JSON.stringify({ ...marker, pid: 456 }));
    await writeFile(join(root, "lineage-worker-new", ".lineage-worker.json"), JSON.stringify({ ...marker, createdAt: Date.now() }));
    assert.equal(await cleanStaleWorkerDirectories(root, { isRunning: pid => pid === 456 }), 1);
    assert.deepEqual((await readdir(root)).sort(), ["lineage-worker-active", "lineage-worker-new", "lineage-worker-unknown", "unrelated"]);
  } finally { if (dirname(resolve(root)) === resolve(tmpdir())) await rm(root, { recursive: true, force: true }); }
});
