import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { assembleFilm, chooseAssemblyProfile } from "../scripts/assemble-film.mjs";

const profile = (width, height, frameRate = 30, frameRateRatio) => ({ width, height, frameRate, ...(frameRateRatio ? { frameRateRatio } : {}) });
test("native assembly profiles retain 1080p and exact fractional frame rates", () => {
  assert.deepEqual(chooseAssemblyProfile([profile(1920, 1080, 30000 / 1001, "30000/1001")]),
    { width: 1920, height: 1080, frameRate: 30000 / 1001, frameRateRatio: "30000/1001" });
});

test("mixed same-aspect clips choose native lower dimensions and rate without upscaling", () => {
  assert.deepEqual(chooseAssemblyProfile([profile(1920, 1080, 24, "24/1"), profile(1280, 720, 30, "30/1")]),
    { width: 1280, height: 720, frameRate: 24, frameRateRatio: "24/1" });
});

test("assembly profiles reject mismatched framing, unsafe geometry, and invalid rates", () => {
  for (const profiles of [[], [null], [profile(1919, 1080)], [profile(5000, 2800)], [profile(4096, 4096)],
    [profile(1920, 1080, 0)], [profile(1920, 1080, 61)], [profile(1920, 1080, NaN)],
    [profile(1920, 1080, 30, "24/1")], [profile(1920, 1080, 30, "30/0")],
    [profile(1920, 1080, 30, "30/1,unsafe")], [profile(1920, 1080), profile(640, 480)]]) {
    assert.throws(() => chooseAssemblyProfile(profiles));
  }
});

function inputFor(paths, durationMs = 1000) {
  const manifest = { version: 1, title: "SAMPLE ONLY - FICTIONAL DATA: assembly test", targetDurationSeconds: paths.length * durationMs / 1000,
    shots: paths.map((_, index) => ({ id: `shot-${index}`, startMs: index * durationMs, targetDurationMs: durationMs,
      narration: "Fictional test narration", dialogue: "" })) };
  return { manifest, manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    clips: paths.map((value, index) => ({ shotId: `shot-${index}`, ...value })) };
}

test("assembly rejects a changed manifest and a nonboolean technical bypass before decoding", async () => {
  const input = inputFor([{ path: "unused.mp4" }]);
  await assert.rejects(assembleFilm({ ...input, manifestHash: "0".repeat(64), outputPath: "unused-output.mp4" }), /manifest hash/);
  await assert.rejects(assembleFilm({ ...input, technicalSample: "false", outputPath: "unused-output.mp4" }), /technical sample marker/);
});

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const probe = spawnSync(ffmpeg, ["-version"], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
const unavailable = !process.env.FFMPEG_PATH && probe.error?.code === "ENOENT";
function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", ...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("FFmpeg fixture timed out.")); }, 60_000);
    child.stdout.on("data", bytes => { output = (output + bytes.toString()).slice(-100_000); });
    child.stderr.on("data", bytes => { output = (output + bytes.toString()).slice(-100_000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolveRun(output) : reject(new Error(`FFmpeg fixture failed (${code}): ${output}`)); });
  });
}

test("real FFmpeg verifies native profiles and separate reviewed audio", { skip: unavailable ? "Optional FFmpeg runtime not installed; set FFMPEG_PATH to require it." : false }, async t => {
  assert.equal(probe.error, undefined, "An explicitly configured or installed FFmpeg must run successfully.");
  assert.equal(probe.status, 0, "An explicitly configured or installed FFmpeg must run successfully.");
  const root = resolve(await mkdtemp(join(tmpdir(), "lineage-assembly-test-")));
  const label = ["-metadata", "comment=SAMPLE ONLY - FICTIONAL DATA. Generated color and tone test fixture."];
  const silent1080 = join(root, "silent-1080.mp4"), audible720 = join(root, "audible-720.mp4"), square = join(root, "square.mp4");
  const audio = join(root, "reviewed-narration.wav"), shortAudio = join(root, "short-narration.wav");
  try {
    await run(["-v", "error", "-n", "-f", "lavfi", "-i", "color=c=green:s=1920x1080:r=24", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...label, silent1080]);
    await run(["-v", "error", "-n", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", ...label, audible720]);
    await run(["-v", "error", "-n", "-f", "lavfi", "-i", "color=c=red:s=640x480:r=24", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...label, square]);
    for (const [path, seconds] of [[audio, "1.1"], [shortAudio, "0.4"]])
      await run(["-v", "error", "-n", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", seconds, "-c:a", "pcm_s16le", ...label, path]);

    await t.test("a silent 1080p clip plus a separate reviewed track retains 1080p and 24fps", async () => {
      const outputPath = join(root, "preserved-1080.mp4");
      const report = await assembleFilm({ ...inputFor([{ path: silent1080, audioPath: audio }]), ffmpeg, outputPath });
      assert.equal(report.width, 1920); assert.equal(report.height, 1080); assert.equal(report.frameRate, 24);
      assert.equal(report.hasAudio, true); assert.equal(report.technicalSample, false); assert.equal(report.frameCount, 24);
      assert.ok(Math.abs(report.durationSeconds - 1) < 0.05);
      const independentDecode = await run(["-i", outputPath, "-f", "null", "-"]);
      assert.match(independentDecode, /1920x1080/); assert.match(independentDecode, /24 fps/); assert.match(independentDecode, /Audio: aac/);
      assert.equal(report.sha256, createHash("sha256").update(await readFile(outputPath)).digest("hex"));
      assert.equal(report.sizeBytes, (await stat(outputPath)).size);
    });

    await t.test("mixed native dimensions use 720p24 without upscaling the smaller input", async () => {
      const report = await assembleFilm({ ...inputFor([{ path: silent1080, audioPath: audio }, { path: audible720 }]), ffmpeg, outputPath: join(root, "mixed.mp4") });
      assert.equal(report.width, 1280); assert.equal(report.height, 720); assert.equal(report.frameRate, 24);
      assert.equal(report.hasAudio, true); assert.ok(Math.abs(report.durationSeconds - 2) < 0.05);
    });

    await t.test("mixed aspect ratios require a framing review", async () => {
      await assert.rejects(assembleFilm({ ...inputFor([{ path: silent1080, audioPath: audio }, { path: square, audioPath: audio }]), ffmpeg, outputPath: join(root, "invalid-aspect.mp4") }), /aspect ratios differ/);
    });

    await t.test("customer clips require real decoded audio covering the reviewed timeline", async () => {
      await assert.rejects(assembleFilm({ ...inputFor([{ path: silent1080 }]), ffmpeg, outputPath: join(root, "missing-audio.mp4") }), /no reviewed audio/);
      await assert.rejects(assembleFilm({ ...inputFor([{ path: silent1080, audioPath: shortAudio }]), ffmpeg, outputPath: join(root, "short-audio.mp4") }), /audio.*shorter/);
      // An explicit reviewed track overrides an existing embedded audio track.
      await assert.rejects(assembleFilm({ ...inputFor([{ path: audible720, audioPath: shortAudio }]), ffmpeg, outputPath: join(root, "override-short-audio.mp4") }), /audio.*shorter/);
    });

    await t.test("synthetic silence is confined to clearly labeled technical samples", async () => {
      const outputPath = join(root, "technical-sample.mp4");
      const report = await assembleFilm({ ...inputFor([{ path: silent1080 }]), ffmpeg, outputPath, technicalSample: true });
      assert.equal(report.technicalSample, true); assert.equal(report.hasAudio, true);
      assert.match(await run(["-i", outputPath, "-f", "null", "-"]), /SAMPLE ONLY - FICTIONAL DATA/);
    });
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
