import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { applyFilmTextCorrections } from '../scripts/apply-film-text-correction.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = args => new Promise((resolveRun, reject) => {
  const child = spawn(ffmpeg, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let bytes = 0;
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) child.kill(); else stdout.push(chunk); });
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolveRun(Buffer.concat(stdout)) : reject(Error(`FFmpeg fixture failed: ${Buffer.concat(stderr).toString().slice(-2000)}`)));
});
const frame = async (path, number) => sharp(await run(['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${number})`,
  '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const pixel = (image, x, y) => [...image.data.subarray((y * image.info.width + x) * image.info.channels, (y * image.info.width + x) * image.info.channels + 3)];
const near = (actual, expected, delta = 5) => actual.every((value, i) => Math.abs(value - expected[i]) <= delta);
const audioHash = async path => (await run(['-v', 'error', '-i', path, '-map', '0:a', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1'])).toString().trim();
const context = sourceSha256 => {
  const correction = { version: 1, shotId: 'shot-004', sourceSha256, text: 'Correct Example Name', startMs: 708, endMs: 1224,
    x: 500, y: 430, width: 920, height: 160, fontSize: 60, background: 'B49C80', fontColor: '171512' };
  return { manifest: { shots: [{ id: correction.shotId, targetDurationMs: 2000, visual: `End card: ${correction.text}.` }] },
    shots: [{ id: correction.shotId, status: 'completed', output: { sha256: sourceSha256 } }],
    visualReviewRecovery: { textCorrections: [correction] } };
};

test('no approved text correction is an exact no-op without touching files or media tools', async () => {
  const clips = [{ shotId: 'shot-001', path: 'not-opened.mp4' }];
  assert.equal(await applyFilmTextCorrections({ job: {}, clips, work: 'not-opened', ffmpeg: 'not-run' }), clips);
});

test('unsafe ASS text and changed source bytes fail before any working correction is created', async t => {
  const work = await mkdtemp(join(tmpdir(), 'film-text-denial-'));
  try {
    const path = join(work, 'source.mp4'); await writeFile(path, 'source bytes');
    const job = context(hash(await readFile(path))), clips = [{ shotId: 'shot-004', path }];
    await t.test('ASS directives cannot enter text', async () => {
      const changed = structuredClone(job); changed.visualReviewRecovery.textCorrections[0].text = '{\\pos(1,1)}Unexpected';
      await assert.rejects(applyFilmTextCorrections({ job: changed, clips, work, ffmpeg: 'not-run' }));
      assert.deepEqual(await readdir(work), ['source.mp4']);
    });
    await t.test('source checksum is checked before invoking FFmpeg', async () => {
      await writeFile(path, 'different source bytes');
      await assert.rejects(applyFilmTextCorrections({ job, clips, work, ffmpeg: 'not-run' }));
      assert.deepEqual(await readdir(work), ['source.mp4']);
    });
  } finally { assert.equal(dirname(resolve(work)), resolve(tmpdir())); await rm(work, { recursive: true, force: true }); }
});

test('approved rectangle changes only the selected frames and pixels, with exact copied audio and untouched source',
  { skip: !available, timeout: 120_000 }, async () => {
    const work = await mkdtemp(join(tmpdir(), 'film-text-pixels-'));
    try {
      const source = join(work, 'source.mp4');
      await run(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x204060:s=1920x1080:r=24:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
        '-vf', 'drawbox=x=500:y=430:w=920:h=160:color=white:t=fill', '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', source]);
      const originalSha256 = hash(await readFile(source)), job = context(originalSha256), originalJob = structuredClone(job);
      const untouched = { shotId: 'another-scene', path: 'unopened.mp4' }, clips = [{ shotId: 'shot-004', path: source }, untouched];
      const revised = await applyFilmTextCorrections({ job, clips, work, ffmpeg }), corrected = revised[0];
      assert.notEqual(revised, clips); assert.equal(revised[1], untouched); assert.notEqual(corrected.path, source);
      assert.equal(dirname(dirname(corrected.path)), work); assert.equal(corrected.sourceClipPath, source);
      assert.equal(clips[0].path, source); assert.deepEqual(job, originalJob);
      assert.equal(hash(await readFile(source)), originalSha256);
      assert.equal(corrected.textCorrection.sourceSha256, originalSha256);
      assert.equal(corrected.textCorrection.outputSha256, hash(await readFile(corrected.path)));
      assert.equal(corrected.textCorrection.correctionHash, hash(JSON.stringify(job.visualReviewRecovery.textCorrections[0])));
      assert.equal(await audioHash(source), await audioHash(corrected.path));
      assert.equal(await audioHash(corrected.path), `SHA256=${corrected.textCorrection.audioSha256}`);
      // At24fps: frame16 precedes708ms,17 is first selected,29 is last selected,
      // and30 follows1224ms. This catches centisecond rounding at both boundaries.
      for (const [number, active] of [[16, false], [17, true], [29, true], [30, false]]) {
        const image = await frame(corrected.path, number);
        assert.equal(image.info.width, 1920); assert.equal(image.info.height, 1080);
        assert.ok(near(pixel(image, 520, 450), active ? [180, 156, 128] : [255, 255, 255]), `box frame${number}`);
        assert.ok(near(pixel(image, 400, 500), [32, 64, 96]), `outside box frame${number}`);
        if (active) {
          let ink = 0;
          for (let y = 460; y < 560; y++) for (let x = 600; x < 1320; x++) if (near(pixel(image, x, y), [23, 21, 18], 12)) ink++;
          assert.ok(ink > 1000, 'approved text has visible centered glyphs');
        }
      }
      const originalFrame = await frame(source, 17);
      assert.ok(near(pixel(originalFrame, 520, 450), [255, 255, 255]));
    } finally { assert.equal(dirname(resolve(work)), resolve(tmpdir())); await rm(work, { recursive: true, force: true }); }
  });
