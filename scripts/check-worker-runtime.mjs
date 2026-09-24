// Offline host acceptance only. No credentials, provider, Blob or customer job
// are read. A passed runtime check is not production integration readiness.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function run(binary, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("RUNTIME_MEDIA_TIMEOUT")); }, 60_000);
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-32_000); });
    // Never forward runtime stderr: a malicious executable/path or unexpected
    // media diagnostic must not leak host configuration into acceptance logs.
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(new Error("RUNTIME_MEDIA_UNAVAILABLE")); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolveRun(output) : reject(new Error("RUNTIME_MEDIA_FAILED")); });
  });
}

export async function checkWorkerRuntime({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg" } = {}) {
  const result = { nodeVersion: process.versions.node, nodeSupported: Number(process.versions.node.split(".")[0]) >= 22,
    ffmpegAvailable: false, mediaEncoded: false, mediaDecoded: false, temporaryMediaRemoved: false,
    runtimeReady: false, providerContacted: false, customerWorkProcessed: false };
  const root = resolve(tmpdir());
  let work;
  try {
    if (!result.nodeSupported) throw new Error("NODE_22_REQUIRED");
    await run(ffmpeg, ["-version"]);
    result.ffmpegAvailable = true;
    work = await mkdtemp(join(root, "lineage-runtime-check-"));
    const output = join(work, "SAMPLE-ONLY-synthetic-runtime.mp4");
    await run(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "1", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
      "-metadata", "comment=SAMPLE ONLY - SYNTHETIC RUNTIME ACCEPTANCE. Not a generated customer film.", output]);
    const bytes = await readFile(output);
    if (bytes.length < 16) throw new Error("RUNTIME_MEDIA_EMPTY");
    result.mediaEncoded = true;
    result.sampleBytes = bytes.length;
    result.sampleSha256 = createHash("sha256").update(bytes).digest("hex");
    const decoded = await run(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-xerror", "-err_detect", "explode",
      "-protocol_whitelist", "file,pipe", "-i", output, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-", "-progress", "pipe:1"]);
    const frames = Number([...decoded.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]);
    const duration = Number([...decoded.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]);
    if (frames !== 24 || duration < 950_000 || duration > 1_100_000 || !decoded.includes("progress=end")) throw new Error("RUNTIME_DECODE_INCOMPLETE");
    result.mediaDecoded = true;
    result.decodedFrames = frames;
    result.decodedSeconds = duration / 1_000_000;
  } catch (error) {
    const allowed = new Set(["NODE_22_REQUIRED", "RUNTIME_MEDIA_TIMEOUT", "RUNTIME_MEDIA_UNAVAILABLE", "RUNTIME_MEDIA_FAILED", "RUNTIME_MEDIA_EMPTY", "RUNTIME_DECODE_INCOMPLETE"]);
    result.failure = allowed.has(error?.message) ? error.message : "RUNTIME_CHECK_FAILED";
  } finally {
    if (work) {
      try {
        if (dirname(resolve(work)) !== root || !basename(work).startsWith("lineage-runtime-check-")) throw new Error("RUNTIME_CLEANUP_FAILED");
        await rm(work, { recursive: true, force: true });
        result.temporaryMediaRemoved = await stat(work).then(() => false, error => error.code === "ENOENT");
      } catch { result.failure = "RUNTIME_CLEANUP_FAILED"; }
    } else result.temporaryMediaRemoved = true;
  }
  result.runtimeReady = result.nodeSupported && result.ffmpegAvailable && result.mediaEncoded && result.mediaDecoded && result.temporaryMediaRemoved;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkWorkerRuntime();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.runtimeReady) process.exitCode = 1;
}
