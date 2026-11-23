import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateFilmTextCorrections } from '../api/_lib/film-text-correction.mjs';

const fail = () => Object.assign(new Error('The approved clip text correction could not be verified.'), { code: 'VISUAL_REVIEW_INVALID' });
const need = value => { if (!value) throw fail(); };
const digest = value => createHash('sha256').update(value).digest('hex');
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function run(binary, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveRun(result); };
    const timer = setTimeout(() => { child.kill(); finish(fail()); }, 120_000);
    child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-100_000); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-100_000); });
    child.on('error', () => finish(fail()));
    child.on('close', code => finish(code === 0 ? null : fail(), { stdout, stderr }));
  });
}
async function sourceProfile(ffmpeg, path) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-v', 'info', '-nostdin', '-xerror',
    '-protocol_whitelist', 'file,pipe', '-i', path, '-map', '0:v:0', '-an', '-vf', 'showinfo',
    '-frames:v', '1', '-f', 'null', '-']);
  const rate = /config in[^\r\n]*frame_rate:\s*(\d+)\/(\d+)/.exec(stderr);
  const frame = /\bn:\s*0\s+pts:[^\r\n]*?pts_time:\s*([\d.eE+-]+)[^\r\n]*?\bs:(\d+)x(\d+)/.exec(stderr);
  const numerator = Number(rate?.[1]), denominator = Number(rate?.[2]);
  need(frame && Number(frame[1]) === 0 && Number(frame[2]) === 1920 && Number(frame[3]) === 1080
    && Number.isSafeInteger(numerator) && numerator > 0 && Number.isSafeInteger(denominator) && denominator > 0
    && numerator / denominator >= 1 && numerator / denominator <= 60);
  return { numerator, denominator };
}
async function audioHash(ffmpeg, path) {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe',
    '-i', path, '-map', '0:a', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1']);
  const match = /^SHA256=([a-f0-9]{64})\s*$/m.exec(stdout); need(match); return match[1];
}
function eventTime(ms, rate) {
  // ASS has centisecond timestamps. Put the event boundary between the last
  // excluded and first included source frames, preserving the millisecond window.
  const frame = Math.ceil(ms * rate.numerator / (1000 * rate.denominator) - 1e-9);
  const ticks = Math.floor(frame * 100 * rate.denominator / rate.numerator + 1e-9);
  return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}
const color = rgb => `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
function correctionAss(value, rate) {
  const { x, y, width, height, fontSize, text } = value;
  // The shared validator excludes braces, backslashes, newlines and controls.
  // Text is an ASS text field only; no shell or drawtext expression contains it.
  need(!/[{}\\\r\n\x00-\x1f\x7f]/.test(text));
  const start = eventTime(value.startMs, rate), end = eventTime(value.endMs, rate);
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Box,Arial,${fontSize},${color(value.background)},${color(value.background)},${color(value.background)},${color(value.background)},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\nStyle: Label,Arial,${fontSize},${color(value.fontColor)},${color(value.fontColor)},${color(value.fontColor)},${color(value.fontColor)},0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,${start},${end},Box,,0,0,0,,{\\an7\\pos(${x},${y})\\bord0\\shad0\\p1}m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height}{\\p0}\nDialogue: 1,${start},${end},Label,,0,0,0,,{\\an5\\pos(${x + width / 2},${y + height / 2})\\clip(${x},${y},${x + width},${y + height})\\q2\\bord0\\shad0}${text}\n`;
}

// Apply only an already-authorized correction to a separate working file.
// Both visual review and assembly must consume the returned clip array.
export async function applyFilmTextCorrections({ job, clips, work, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg' }) {
  const corrections = validateFilmTextCorrections(job, job?.visualReviewRecovery?.textCorrections);
  if (!corrections.length) return clips;
  need(Array.isArray(clips) && new Set(clips.map(clip => clip.shotId)).size === clips.length
    && corrections.every(value => clips.some(clip => clip.shotId === value.shotId)));
  const root = await realpath(resolve(work)); need((await stat(root)).isDirectory());
  const corrected = new Map();
  for (const value of corrections) {
    const clip = clips.find(row => row.shotId === value.shotId), source = await realpath(resolve(clip.path));
    need(!clip.audioPath && !clip.sourceClipPath && !clip.textCorrection && (await stat(source)).isFile());
    need(await fileHash(source) === value.sourceSha256);
    const [profile, originalAudioHash] = await Promise.all([sourceProfile(ffmpeg, source), audioHash(ffmpeg, source)]);
    const destination = await mkdtemp(join(root, 'text-correction-'));
    const output = join(destination, 'corrected.mp4');
    await writeFile(join(destination, 'correction.ass'), correctionAss(value, profile), { flag: 'wx', mode: 0o600 });
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-i', source, '-map', '0:v:0', '-map', '0:a', '-vf', 'ass=correction.ass', '-c:v', 'libx264', '-preset', 'medium',
      '-crf', '16', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-c:a', 'copy', '-movflags', '+faststart', output], destination);
    need(await fileHash(source) === value.sourceSha256 && await audioHash(ffmpeg, output) === originalAudioHash);
    const outputProfile = await sourceProfile(ffmpeg, output);
    need(outputProfile.numerator * profile.denominator === profile.numerator * outputProfile.denominator);
    corrected.set(value.shotId, { ...clip, path: output, sourceClipPath: clip.path,
      textCorrection: { version: 1, sourceSha256: value.sourceSha256, correctionHash: digest(JSON.stringify(value)),
        outputSha256: await fileHash(output), audioSha256: originalAudioHash } });
  }
  return clips.map(clip => corrected.get(clip.shotId) || clip);
}
