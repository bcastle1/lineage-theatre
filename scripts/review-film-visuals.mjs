import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { visualSampleTimes, boundedVisualJson, visualReviewVersion } from '../api/_lib/film-visual-review.mjs';
import { markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

const failed = reason => markFinishingFailure(Object.assign(new Error('Visual continuity needs review before delivery.'), { code: reason }), 'visual-review', reason);
export async function extractVisualFrame({ path, atMs, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', spawnImpl = spawn }) {
  if (typeof path !== 'string' || !path || !Number.isSafeInteger(atMs) || atMs < 0 || atMs > 15_000) throw failed('VISUAL_REVIEW_REQUIRED');
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffmpeg, ['-v', 'error', '-nostdin', '-ss', (atMs / 1000).toFixed(3),
      '-protocol_whitelist', 'file,pipe', '-i', path, '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease',
      '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, over = false;
    const timer = setTimeout(() => { child.kill(); reject(failed('VISUAL_REVIEW_UNAVAILABLE')); }, 30_000);
    child.stdout.on('data', bytes => { size += bytes.length; if (size > 250_000) { over = true; child.kill(); } else chunks.push(bytes); });
    child.on('error', () => { clearTimeout(timer); reject(failed('VISUAL_REVIEW_UNAVAILABLE')); });
    child.on('close', code => { clearTimeout(timer); if (over || code !== 0 || size < 100) reject(failed('VISUAL_REVIEW_UNAVAILABLE'));
      else resolve(`data:image/jpeg;base64,${Buffer.concat(chunks).toString('base64')}`); });
  });
}
export function createRemoteVisualReview({ env = process.env, fetchImpl = fetch } = {}) {
  return async body => {
    if (!/^[a-f0-9]{64}$/.test(env.LINEAGE_WORKER_SECRET || '')) throw failed('VISUAL_REVIEW_UNAVAILABLE');
    const response = await fetchImpl('https://lineagetheater.com/api/production-worker', { method: 'POST', redirect: 'error',
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(170_000),
      headers: { Authorization: `Bearer ${env.LINEAGE_WORKER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'review-film-visuals', ...body }) });
    if (!response.ok) {
      let result; try { result = await boundedVisualJson(response, 4096); } catch { /* Fixed fallback only. */ }
      throw failed(['VISUAL_REVIEW_UNCERTAIN', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED'].includes(result?.code)
        ? result.code : 'VISUAL_REVIEW_UNAVAILABLE');
    }
    return boundedVisualJson(response, 4096);
  };
}
export function createFilmVisualReviewer({ extract = extractVisualFrame, review = createRemoteVisualReview() } = {}) {
  return async ({ email, id, job, clips, ffmpeg, stillOwned, work }) => {
    const version = visualReviewVersion(job.manifest);
    if (!job.manifest.visualContinuity) {
      if (version !== 1) throw failed('VISUAL_REVIEW_REQUIRED');
      return null;
    }
    const proofs = [], previousFrames = new Map();
    for (const [index, shot] of job.manifest.shots.entries()) {
      if (!await stillOwned()) throw failed('WORKER_CLAIM_EXPIRED');
      const clip = clips[index]; if (clip?.shotId !== shot.id) throw failed('VISUAL_REVIEW_REQUIRED');
      const frames = [];
      for (const atMs of visualSampleTimes(shot, version)) frames.push({ shotId: shot.id, atMs, dataUrl: await extract({ path: clip.path, atMs, ffmpeg }) });
      previousFrames.set(shot.id, frames.at(-1));
      const previous = job.manifest.shots[index - 1];
      if (previous && previous.sceneIndex === shot.sceneIndex) frames.push(previousFrames.get(previous.id));
      if (!await stillOwned()) throw failed('WORKER_CLAIM_EXPIRED');
      const proof = await review({ email, preparedId: id, manifestHash: job.manifestHash, shotId: shot.id, frames });
      if (!await stillOwned()) throw failed('WORKER_CLAIM_EXPIRED');
      if (proof?.version !== version || proof.manifestHash !== job.manifestHash || proof.shotId !== shot.id
        || !/^[a-f0-9]{64}$/.test(proof.bindingHash || '') || typeof proof.receiptPath !== 'string') throw failed('VISUAL_REVIEW_REQUIRED');
      if (proof.passed !== true) throw failed('VISUAL_CONTINUITY_MISMATCH');
      proofs.push(proof);
    }
    const result = { version, manifestHash: job.manifestHash, passed: true,
      sampling: version === 2 ? 'five-frames-including-first-and-final-percent-and-same-scene-boundary' : 'three-frames-per-cut-and-same-scene-boundary', shots: proofs };
    if (work) await writeFile(join(work, 'visual-review.json'), JSON.stringify(result), { flag: 'wx' });
    return result;
  };
}
