// Offline media-worker entry point. Never run long FFmpeg work in a Vercel API function.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifiedMediaProfile } from "../api/_lib/media-profile.mjs";

async function run(binary, args, onStderrLine) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "", pendingLine = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("The media operation exceeded its time limit.")); }, 15 * 60_000);
    const collect = (value, chunk) => (value + chunk.toString()).slice(-200_000);
    child.stdout.on("data", chunk => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", chunk => {
      stderr = collect(stderr, chunk);
      if (onStderrLine) {
        const lines = (pendingLine + chunk.toString()).split(/\r?\n/);
        pendingLine = lines.pop();
        for (const line of lines) onStderrLine(line);
      }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (pendingLine && onStderrLine) onStderrLine(pendingLine); code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`Media operation failed (${code}). ${stderr.slice(-3000)}`)); });
  });
}
async function mediaInfo(ffmpeg, path) {
  // Decode the whole file, so a container header alone cannot count as playable.
  let profile, rate, invalidProfile = false, hasAudio = false, decodedFrames = 0, previousTime;
  const result = await run(ffmpeg, ["-hide_banner", "-v", "info", "-nostdin", "-xerror", "-err_detect", "explode", "-protocol_whitelist", "file,pipe", "-i", path, "-map", "0:v:0", "-vf", "showinfo", "-fps_mode", "passthrough", "-f", "null", "-", "-progress", "pipe:1"], line => {
    if (/Stream .*Audio:/.test(line)) hasAudio = true;
    if (!/Parsed_showinfo_/.test(line)) return;
    const config = /config in .*frame_rate:\s*(\d+)\/(\d+)/.exec(line);
    if (config) {
      const next = { numerator: Number(config[1]), denominator: Number(config[2]) };
      if (rate && rate.numerator * next.denominator !== next.numerator * rate.denominator) invalidProfile = true;
      rate = next;
    }
    const frame = /\bsar:(\d+)\/(\d+)\s+s:(\d+)x(\d+)\s+i:([PTB])/.exec(line);
    if (frame) {
      decodedFrames++;
      const next = { width: Number(frame[3]), height: Number(frame[4]) };
      const timestamp = /\bpts_time:([\d.eE+-]+)/.exec(line);
      const time = timestamp ? Number(timestamp[1]) : NaN;
      if (Number(frame[1]) !== Number(frame[2]) || Number(frame[2]) === 0 || frame[5] !== "P"
        || !Number.isFinite(time) || !rate || (previousTime !== undefined && Math.abs(time - previousTime - rate.denominator / rate.numerator) > 0.002)
        || (profile && (next.width !== profile.width || next.height !== profile.height))) invalidProfile = true;
      profile = next;
      previousTime = time;
    }
  });
  const frames = [...result.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1);
  const decoded = [...result.stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1);
  if (!profile || !rate || invalidProfile || decodedFrames < 1 || !frames || Number(frames[1]) < 1 || !decoded || Number(decoded[1]) <= 0 || !/progress=end/.test(result.stdout)) throw new Error("The file did not decode into a consistent progressive, square-pixel video profile at a constant frame rate.");
  const checked = chooseAssemblyProfile([{ ...profile, frameRate: rate.numerator / rate.denominator,
    frameRateRatio: `${rate.numerator}/${rate.denominator}` }]);
  return { ...checked, durationSeconds: Number(decoded[1]) / 1_000_000, decodedDurationSeconds: Number(decoded[1]) / 1_000_000, frameCount: Number(frames[1]), hasAudio };
}

// Same-aspect inputs use their smallest native dimensions and slowest native
// frame rate. We never upscale, invent frames, crop, or silently letterbox.
export function chooseAssemblyProfile(profiles) {
  if (!Array.isArray(profiles) || profiles.length < 1) throw new Error("Supply a decoded video profile for every clip.");
  for (const profile of profiles) {
    verifiedMediaProfile(profile);
    if (profile.width * profiles[0].height !== profiles[0].width * profile.height)
      throw new Error("Clip aspect ratios differ. Review matching framing before assembly.");
    if (profile.frameRateRatio !== undefined) {
      const ratio = /^(\d+)\/(\d+)$/.exec(profile.frameRateRatio);
      if (!ratio || !Number.isSafeInteger(Number(ratio[1])) || !Number.isSafeInteger(Number(ratio[2]))
        || Number(ratio[1]) < 1 || Number(ratio[2]) < 1 || Math.abs(Number(ratio[1]) / Number(ratio[2]) - profile.frameRate) > 0.000001)
        throw new Error("The decoded video frame rate is inconsistent.");
    }
  }
  const smallest = profiles.reduce((a, b) => a.width <= b.width ? a : b);
  const slowest = profiles.reduce((a, b) => a.frameRate <= b.frameRate ? a : b);
  return { width: smallest.width, height: smallest.height, frameRate: slowest.frameRate,
    frameRateRatio: slowest.frameRateRatio || String(slowest.frameRate) };
}

async function audioInfo(ffmpeg, path) {
  let sampleDuration = 0, frames = 0, invalid = false, firstTime;
  const result = await run(ffmpeg, ["-hide_banner", "-v", "info", "-nostdin", "-xerror", "-err_detect", "explode", "-protocol_whitelist", "file,pipe", "-i", path, "-map", "0:a:0", "-af", "ashowinfo", "-f", "null", "-", "-progress", "pipe:1"], line => {
    if (!/Parsed_ashowinfo_/.test(line)) return;
    const frame = /\brate:(\d+)\s+nb_samples:(\d+)/.exec(line);
    if (frame) {
      const rate = Number(frame[1]), samples = Number(frame[2]);
      const timestamp = /\bpts_time:([\d.eE+-]+)/.exec(line);
      const time = timestamp ? Number(timestamp[1]) : NaN;
      if (firstTime === undefined) firstTime = time;
      if (rate < 1 || samples < 1 || !Number.isFinite(time) || Math.abs(time - firstTime - sampleDuration) > 0.05) invalid = true;
      else { sampleDuration += samples / rate; frames++; }
    }
  });
  const decoded = [...result.stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1);
  if (invalid || frames < 1 || !decoded || Number(decoded[1]) <= 0 || !/progress=end/.test(result.stdout)) throw new Error("The reviewed audio did not fully decode.");
  return { durationSeconds: Math.min(sampleDuration, Number(decoded[1]) / 1_000_000) };
}
const timecode = ms => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), fraction = Math.round(ms % 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
};
export function filmCaptions(manifest) {
  return "WEBVTT\n\n" + manifest.shots.map(shot => `${shot.id}\n${timecode(shot.startMs)} --> ${timecode(shot.startMs + shot.targetDurationMs)}\n${`${shot.narration}\n${shot.dialogue}`.trim().replace(/[\r\n]+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n`).join("\n");
}
export async function assembleFilm({ manifest, manifestHash, clips, outputPath, ffmpeg = "ffmpeg", technicalSample = false }) {
  if (typeof technicalSample !== "boolean") throw new Error("The technical sample marker must be explicit.");
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.shots) || manifest.shots.length < 1 || manifest.shots.length > 30
    || createHash("sha256").update(JSON.stringify(manifest)).digest("hex") !== manifestHash) throw new Error("The immutable manifest hash does not match.");
  if (!Array.isArray(clips) || clips.length !== manifest.shots.length || new Set(clips.map(c => c.shotId)).size !== clips.length) throw new Error("Supply exactly one reviewed clip for each manifest shot.");
  const output = resolve(outputPath);
  if (extname(output).toLowerCase() !== ".mp4") throw new Error("The assembled film must use an MP4 output path.");
  const inputs = [], filters = [], segments = [], reviewed = [];
  for (const shot of manifest.shots) {
    const clip = clips.find(c => c.shotId === shot.id);
    if (!clip || typeof clip.path !== "string" || ![".mp4", ".webm"].includes(extname(clip.path).toLowerCase())) throw new Error(`Missing local video clip for ${shot.id}.`);
    const path = resolve(clip.path), size = (await stat(path)).size;
    if (path === output || size < 16 || size > 250 * 1024 * 1024) throw new Error("A clip is too large or conflicts with the output file.");
    const info = await mediaInfo(ffmpeg, path), seconds = shot.targetDurationMs / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0 || info.durationSeconds < seconds - 0.05 || info.decodedDurationSeconds < seconds - 0.1) throw new Error(`Clip ${shot.id} is shorter than its reviewed timeline.`);
    let audioPath = info.hasAudio ? path : null;
    if (clip.audioPath !== undefined) {
      if (typeof clip.audioPath !== "string" || ![".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".mp4", ".webm"].includes(extname(clip.audioPath).toLowerCase())) throw new Error(`Invalid reviewed audio file for ${shot.id}.`);
      audioPath = resolve(clip.audioPath);
      const audioSize = (await stat(audioPath)).size;
      if (audioPath === output || audioSize < 16 || audioSize > 250 * 1024 * 1024) throw new Error("A reviewed audio file is too large or conflicts with the output file.");
    }
    if (audioPath) {
      const audio = await audioInfo(ffmpeg, audioPath);
      if (audio.durationSeconds < seconds - 0.05) throw new Error(`Reviewed audio for ${shot.id} is shorter than its reviewed timeline.`);
    } else if (!technicalSample) throw new Error(`Clip ${shot.id} has no reviewed audio. Prepare narration and dialogue before assembling a customer film.`);
    reviewed.push({ info, path, audioPath, seconds });
  }
  const profile = chooseAssemblyProfile(reviewed.map(clip => clip.info));
  let inputIndex = 0;
  for (const [index, clip] of reviewed.entries()) {
    const videoIndex = inputIndex++;
    inputs.push("-protocol_whitelist", "file,pipe", "-i", clip.path);
    let audioIndex = videoIndex;
    if (clip.audioPath && clip.audioPath !== clip.path) {
      audioIndex = inputIndex++;
      inputs.push("-protocol_whitelist", "file,pipe", "-i", clip.audioPath);
    }
    // Apply fps before scale, which can discard the final input frame's duration.
    filters.push(`[${videoIndex}:v:0]trim=duration=${clip.seconds},setpts=PTS-STARTPTS,fps=${profile.frameRateRatio},scale=${profile.width}:${profile.height},setsar=1,format=yuv420p[v${index}]`);
    filters.push(clip.audioPath ? `[${audioIndex}:a:0]atrim=duration=${clip.seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.seconds}[a${index}]`);
    segments.push(`[v${index}][a${index}]`);
  }
  filters.push(`${segments.join("")}concat=n=${clips.length}:v=1:a=1[video][audio]`);
  await mkdir(dirname(output), { recursive: true });
  await run(ffmpeg, ["-hide_banner", "-nostdin", "-n", ...inputs, "-filter_complex", filters.join(";"), "-map", "[video]", "-map", "[audio]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", profile.frameRateRatio, "-fps_mode", "cfr", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-metadata", `comment=${technicalSample ? "SAMPLE ONLY - FICTIONAL DATA. Technical assembly demonstration; no generated historical film." : "Lineage Theatre assembled film"}`, output]);
  const info = await mediaInfo(ffmpeg, output);
  if (Math.abs(info.durationSeconds - manifest.targetDurationSeconds) > 1 || Math.abs(info.decodedDurationSeconds - manifest.targetDurationSeconds) > 1) throw new Error("The assembled duration does not match the reviewed film.");
  if (info.width !== profile.width || info.height !== profile.height || Math.abs(info.frameRate - profile.frameRate) > 0.000001 || !info.hasAudio) throw new Error("The assembled video does not match its reviewed output profile.");
  const audio = await audioInfo(ffmpeg, output);
  if (audio.durationSeconds < manifest.targetDurationSeconds - 0.1) throw new Error("The assembled audio is shorter than the reviewed film.");
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
