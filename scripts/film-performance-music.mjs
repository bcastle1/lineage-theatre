import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { digest } from '../api/_lib/auth.mjs';
import { performanceReviewFailure, validatePerformanceMusicReceipt } from '../api/_lib/film-performance-review.mjs';
import { validateFilmPerformance } from '../api/_lib/film-performance.mjs';

function construct(request, { python = process.env.LINEAGE_TTS_PYTHON || '/opt/soundtrack/bin/python' } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('./film-performance-music.py', import.meta.url))],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); value ? resolveResult(value) : reject(performanceReviewFailure('PERFORMANCE_MUSIC_UNAVAILABLE')); };
    const timer = setTimeout(() => { child.kill(); finish(); }, 180_000);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 16000) { child.kill(); finish(); } });
    child.stderr.resume(); child.stdin.on('error', () => finish()); child.once('error', () => finish());
    child.once('close', code => { try { finish(code === 0 ? JSON.parse(output) : null); } catch { finish(); } });
    child.stdin.end(JSON.stringify(request));
  });
}
const defaults = () => ({ fluidsynth: process.env.FLUIDSYNTH_PATH || '/usr/bin/fluidsynth',
  soundfont: process.env.LINEAGE_SOUNDFONT || '/usr/share/sounds/sf2/FluidR3_GM.sf2' });
let assets;
// One inexpensive asset check per worker process; rendering is per film. The
// separate --check command exercises the real composer before a release.
export function checkPerformanceMusicAssets() {
  return assets ??= construct({ mode: 'assets', ...defaults() }).then(value => ({ ready: value.ready === true,
    soundfontSha256: value.soundfontSha256, soundfontPackageVersion: value.soundfontPackageVersion }), () => ({ ready: false }));
}
export async function buildPerformanceMusic({ manifest, manifestHash, work }, { build = construct } = {}) {
  if (!validateFilmPerformance(manifest) || digest(JSON.stringify(manifest)) !== manifestHash) throw performanceReviewFailure('PERFORMANCE_PROVENANCE_INVALID');
  if (manifest.sound?.musicRequested !== true) return { receipt: { requested: false } };
  const directory = join(work, 'performance-score'); await mkdir(directory);
  const receipt = await build({ mode: 'render', ...defaults(), directory, durationSeconds: manifest.targetDurationSeconds });
  validatePerformanceMusicReceipt(receipt, manifest);
  const path = join(directory, 'score.wav'), bytes = await readFile(path), midi = await readFile(join(directory, 'score.mid'));
  if (bytes.length !== receipt.scoreBytes || digest(bytes) !== receipt.scoreSha256 || midi.length !== receipt.midiBytes || digest(midi) !== receipt.midiSha256)
    throw performanceReviewFailure('PERFORMANCE_MUSIC_UNAVAILABLE');
  return { path, receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--check') throw new Error('Usage: node scripts/film-performance-music.mjs --check');
  const work = await mkdtemp(join(tmpdir(), 'lineage-score-check-'));
  try {
    const receipt = await construct({ mode: 'render', ...defaults(), directory: work, durationSeconds: 3 });
    validatePerformanceMusicReceipt(receipt, { targetDurationSeconds: 3, sound: { musicRequested: true } });
    const { verifyPerformanceMusicMedia } = await import('./assemble-film.mjs');
    await verifyPerformanceMusicMedia({ music: { path: join(work, 'score.wav'), receipt },
      manifest: { targetDurationSeconds: 3, sound: { musicRequested: true } }, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg' });
    process.stdout.write(`${JSON.stringify({ ready: true, syntheticScoreOnly: true, providerCalls: 0, ...receipt })}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ ready: false, reason: 'PERFORMANCE_MUSIC_UNAVAILABLE', providerCalls: 0 })}\n`); process.exitCode = 1; }
  finally { await rm(work, { recursive: true, force: true }); }
}
