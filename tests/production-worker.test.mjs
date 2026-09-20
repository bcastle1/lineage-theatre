import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join, dirname, resolve } from "node:path";
import { downloadProductionClip, verifyPublishedFilm, cleanStaleWorkerDirectories } from "../scripts/production-worker.mjs";
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
    contentType: "video/mp4", sizeBytes: bytes.length, durationSeconds: 15, hasAudio: true, playable: true, technicalSample: false };
  const input = { email, id, artifact, manifestHash: artifact.manifestHash, manifest: { targetDurationSeconds: 15 } };
  const getBlob = async () => ({ blob: { size: bytes.length, contentType: "video/mp4" }, stream: new Response(bytes).body });
  assert.equal((await verifyPublishedFilm(input, { getBlob })).sha256, hash);
  for (const change of [{ technicalSample: true }, { hasAudio: false }, { pathname: "production/media/other/film.mp4" }, { durationSeconds: 50 }, { sha256: "b".repeat(64) }])
    await assert.rejects(verifyPublishedFilm({ ...input, artifact: { ...artifact, ...change } }, { getBlob }));
  await assert.rejects(verifyPublishedFilm(input, { getBlob: async () => ({ blob: { size: bytes.length, contentType: "video/mp4" }, stream: new Response(Buffer.alloc(bytes.length)).body }) }), /checksum/);
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
