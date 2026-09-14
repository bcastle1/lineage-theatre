// Explicit local technical smoke test. Never submits family material to a provider.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildFilmManifest, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import { assembleFilm } from "./assemble-film.mjs";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const directory = resolve(process.argv[2] || `tmp/film-assembly-${Date.now()}`);
await mkdir(directory, { recursive: true });
const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject());
const clips = [];
for (const [index, shot] of manifest.shots.entries()) {
  const path = resolve(directory, `${shot.id}.mp4`);
  const color = ["darkgreen", "navy", "maroon"][index];
  const seconds = shot.targetDurationMs / 1000;
  await new Promise((resolveRun, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=30`, "-f", "lavfi", "-i", `sine=frequency=${300 + index * 150}:sample_rate=48000`, "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-metadata", "comment=SAMPLE ONLY - FICTIONAL DATA. Synthetic color and tone for media assembly testing.", path], { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", chunk => { error += chunk.toString(); }); child.on("error", reject); child.on("close", code => code === 0 ? resolveRun() : reject(new Error(error)));
  });
  clips.push({ shotId: shot.id, path });
}
await writeFile(resolve(directory, "manifest-and-clips.json"), JSON.stringify({ manifest, manifestHash, clips, technicalSample: true }, null, 2));
const report = await assembleFilm({ manifest, manifestHash, clips, technicalSample: true, ffmpeg, outputPath: resolve(directory, "SAMPLE-ONLY-technical-assembly.mp4") });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
