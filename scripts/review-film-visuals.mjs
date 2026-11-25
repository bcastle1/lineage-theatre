import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { visualSampleTimes, visualReviewSampleTimes, boundedVisualJson } from '../api/_lib/film-visual-review.mjs';
import { markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

const failed = reason => markFinishingFailure(Object.assign(new Error('Visual continuity needs review before delivery.'), { code: reason }), 'visual-review', reason);
export async function extractVisualFrame({ path, atMs, maxAtMs = 30_000, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', spawnImpl = spawn }) {
  if (typeof path !== 'string' || !path || !Number.isSafeInteger(atMs) || atMs < 0
    || !Number.isSafeInteger(maxAtMs) || maxAtMs < 1 || maxAtMs > 600_000 || atMs > maxAtMs) throw failed('VISUAL_REVIEW_REQUIRED');
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
      body: JSON.stringify({ ...body, action: 'review-film-visuals', workerProtocol: 2 }) });
    if (!response.ok) {
      let result; try { result = await boundedVisualJson(response, 4096); } catch { /* Fixed fallback only. */ }
      throw failed(['VISUAL_REVIEW_UNCERTAIN', 'VISUAL_REVIEW_INVALID', 'VISUAL_REVIEW_AUTH_REQUIRED'].includes(result?.code)
        ? result.code : 'VISUAL_REVIEW_UNAVAILABLE');
    }
    return boundedVisualJson(response, 4096);
  };
}
export function createFilmVisualReviewer({ extract = extractVisualFrame, review = createRemoteVisualReview() } = {}) {
  return async ({ email, id, job, clips, ffmpeg, stillOwned, work, assembled }) => {
    if (!job.manifest.visualContinuity) return null;
    const assembledRecovery = job.assembledVisualReviewRecovery;
    if (assembledRecovery && (assembledRecovery.policy !== 'assembled-ending-review-v6'
      || !assembled || typeof assembled.path !== 'string' || !assembled.path
      || !/^[a-f0-9]{64}$/.test(assembled.sha256 || '') || !Number.isSafeInteger(assembled.sizeBytes)
      || assembled.sizeBytes < 16 || assembled.sizeBytes > 250 * 1024 * 1024
      || !Number.isFinite(assembled.durationSeconds) || assembled.durationSeconds <= 0 || assembled.durationSeconds > 600
      || Math.abs(assembled.durationSeconds - job.manifest.targetDurationSeconds) > 1)) throw failed('VISUAL_REVIEW_REQUIRED');
    const proofs = [], previousFrames = new Map();
    for (const [index, shot] of job.manifest.shots.entries()) {
      if (!await stillOwned()) throw failed('WORKER_CLAIM_EXPIRED');
      const clip = clips[index]; if (clip?.shotId !== shot.id) throw failed('VISUAL_REVIEW_REQUIRED');
      const assembledTarget = assembledRecovery?.shotId === shot.id;
      const previous = job.manifest.shots[index - 1];
      const frames = [];
      for (const localAtMs of visualReviewSampleTimes(job, shot)) {
        const atMs = assembledTarget ? shot.startMs + localAtMs : localAtMs;
        frames.push({ shotId: shot.id, atMs, dataUrl: await extract({ path: assembledTarget ? assembled.path : clip.path,
          atMs, ffmpeg, ...(assembledTarget ? { maxAtMs: Math.ceil(assembled.durationSeconds * 1000) } : {}) }) });
      }
      previousFrames.set(shot.id, frames.find(frame => frame.atMs === visualSampleTimes(shot)[2]));
      if (previous && previous.sceneIndex === shot.sceneIndex) {
        if (assembledTarget) {
          const atMs = previous.startMs + visualSampleTimes(previous)[2];
          frames.push({ shotId: previous.id, atMs, dataUrl: await extract({ path: assembled.path, atMs, ffmpeg,
            maxAtMs: Math.ceil(assembled.durationSeconds * 1000) }) });
        } else frames.push(previousFrames.get(previous.id));
      }
      if (!await stillOwned()) throw failed('WORKER_CLAIM_EXPIRED');
      const proof = await review({ email, preparedId: id, manifestHash: job.manifestHash, shotId: shot.id, frames,
        ...(assembledTarget ? { assembledArtifact: { sha256: assembled.sha256, sizeBytes: assembled.sizeBytes,
          durationSeconds: assembled.durationSeconds } } : {}) });
      if (!await stillOwned()) throw failed('WORKER_CLAIM_EXPIRED');
      if (proof?.version !== 1 || proof.manifestHash !== job.manifestHash || proof.shotId !== shot.id
        || !/^[a-f0-9]{64}$/.test(proof.bindingHash || '') || typeof proof.receiptPath !== 'string') throw failed('VISUAL_REVIEW_REQUIRED');
      if (assembledTarget && (proof.reviewVersion !== 6 || proof.assembledArtifact?.sha256 !== assembled.sha256
        || proof.assembledArtifact?.sizeBytes !== assembled.sizeBytes
        || proof.assembledArtifact?.durationSeconds !== assembled.durationSeconds)) throw failed('VISUAL_REVIEW_REQUIRED');
      if (proof.passed !== true) throw failed(proof.failureReason === 'VISUAL_EVIDENCE_INSUFFICIENT'
        ? 'VISUAL_EVIDENCE_INSUFFICIENT' : 'VISUAL_CONTINUITY_MISMATCH');
      proofs.push(proof);
    }
    const result = { version: 1, manifestHash: job.manifestHash, passed: true,
      sampling: assembledRecovery ? 'assembled-ending-and-retained-scene-evidence'
        : job.visualEditorialRecovery ? 'editorial-expanded-evidence-and-same-scene-boundary'
        : job.visualEvidenceRecovery ? 'expanded-evidence-and-same-scene-boundary' : 'three-frames-per-cut-and-same-scene-boundary', shots: proofs };
    if (work) await writeFile(join(work, 'visual-review.json'), JSON.stringify(result), { flag: 'wx' });
    return result;
  };
}
