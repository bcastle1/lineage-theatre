// Offline media-worker entry point. Never run long FFmpeg work in a Vercel API function.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function run(binary, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("The media operation exceeded its time limit.")); }, 15 * 60_000);
    const collect = (value, chunk) => (value + chunk.toString()).slice(-200_000);
    child.stdout.on("data", chunk => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = collect(stderr, chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`Media operation failed (${code}). ${stderr.slice(-3000)}`)); });
  });
}
async function mediaInfo(ffmpeg, path) {
  // Decode the whole file, so a container header alone cannot count as playable.
  const result = await run(ffmpeg, ["-hide_banner", "-v", "info", "-nostdin", "-xerror", "-err_detect", "explode", "-protocol_whitelist", "file,pipe", "-i", path, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-", "-progress", "pipe:1"]);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(result.stderr);
  const frames = [...result.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1);
  const decoded = [...result.stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1);
  if (!duration || !frames || Number(frames[1]) < 1 || !decoded || Number(decoded[1]) <= 0 || !/progress=end/.test(result.stdout)) throw new Error("The file did not decode into playable video.");
  return { durationSeconds: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]), decodedDurationSeconds: Number(decoded[1]) / 1_000_000, frameCount: Number(frames[1]), hasAudio: /Stream .*Audio:/.test(result.stderr) };
}
const timecode = ms => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), fraction = Math.round(ms % 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
};
export function filmCaptions(manifest) {
  return "WEBVTT\n\n" + manifest.shots.map(shot => `${shot.id}\n${timecode(shot.startMs)} --> ${timecode(shot.startMs + shot.targetDurationMs)}\n${`${shot.narration}\n${shot.dialogue}`.trim().replace(/[\r\n]+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n`).join("\n");
}
export async function assembleFilm({ manifest, manifestHash, clips, outputPath, ffmpeg = "ffmpeg", technicalSample = false }) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.shots) || manifest.shots.length < 1 || manifest.shots.length > 30
    || createHash("sha256").update(JSON.stringify(manifest)).digest("hex") !== manifestHash) throw new Error("The immutable manifest hash does not match.");
  if (!Array.isArray(clips) || clips.length !== manifest.shots.length || new Set(clips.map(c => c.shotId)).size !== clips.length) throw new Error("Supply exactly one reviewed clip for each manifest shot.");
  const output = resolve(outputPath);
  if (extname(output).toLowerCase() !== ".mp4") throw new Error("The assembled film must use an MP4 output path.");
  const inputs = [], filters = [], segments = [];
  for (const [index, shot] of manifest.shots.entries()) {
    const clip = clips.find(c => c.shotId === shot.id);
    if (!clip || typeof clip.path !== "string" || ![".mp4", ".webm"].includes(extname(clip.path).toLowerCase())) throw new Error(`Missing local video clip for ${shot.id}.`);
    const path = resolve(clip.path), size = (await stat(path)).size;
    if (path === output || size < 16 || size > 250 * 1024 * 1024) throw new Error("A clip is too large or conflicts with the output file.");
    const info = await mediaInfo(ffmpeg, path), seconds = shot.targetDurationMs / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0 || info.durationSeconds < seconds - 0.05 || info.decodedDurationSeconds < seconds - 0.1) throw new Error(`Clip ${shot.id} is shorter than its reviewed timeline.`);
    if (!info.hasAudio && !technicalSample) throw new Error(`Clip ${shot.id} has no reviewed audio. Prepare narration and dialogue before assembling a customer film.`);
    inputs.push("-protocol_whitelist", "file,pipe", "-i", path);
    filters.push(`[${index}:v:0]trim=duration=${seconds},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`);
    filters.push(info.hasAudio ? `[${index}:a:0]atrim=duration=${seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds}[a${index}]`);
    segments.push(`[v${index}][a${index}]`);
  }
  filters.push(`${segments.join("")}concat=n=${clips.length}:v=1:a=1[video][audio]`);
  await mkdir(dirname(output), { recursive: true });
  await run(ffmpeg, ["-hide_banner", "-nostdin", "-n", ...inputs, "-filter_complex", filters.join(";"), "-map", "[video]", "-map", "[audio]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-metadata", `comment=${technicalSample ? "SAMPLE ONLY - FICTIONAL DATA. Technical assembly demonstration; no generated historical film." : "Lineage Theatre assembled film"}`, output]);
  const info = await mediaInfo(ffmpeg, output);
  if (Math.abs(info.durationSeconds - manifest.targetDurationSeconds) > 1 || Math.abs(info.decodedDurationSeconds - manifest.targetDurationSeconds) > 1) throw new Error("The assembled duration does not match the reviewed film.");
  const bytes = await readFile(output);
  const report = { manifestHash, playable: true, technicalSample, verification: "FFmpeg fully decoded every source and the assembled output", ...info, contentType: "video/mp4", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), outputPath: output };
  await writeFile(`${output}.vtt`, filmCaptions(manifest), { flag: "wx" });
  await writeFile(`${output}.verification.json`, JSON.stringify(report, null, 2), { flag: "wx" });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputFile, outputPath] = process.argv.slice(2);
  if (!inputFile || !outputPath) throw new Error("Usage: node scripts/assemble-film.mjs manifest-and-clips.json output.mp4. Set FFMPEG_PATH to the local worker binary.");
  const input = JSON.parse(await readFile(resolve(inputFile), "utf8"));
  const report = await assembleFilm({ ...input, outputPath, ffmpeg: process.env.FFMPEG_PATH || "ffmpeg" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
