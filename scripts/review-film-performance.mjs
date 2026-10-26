// Local decoded-media and selected-voice provenance. No provider submissions.
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { digest, readRecord, writeRecord } from '../api/_lib/auth.mjs';
import { validateFilmPerformance, validatePerformanceOutput, FILM_PERFORMANCE_RECIPE } from '../api/_lib/film-performance.mjs';
import { performanceReviewFailure, performanceReceiptPath, validatePerformanceReviewBinding } from '../api/_lib/film-performance-review.mjs';
import { preparePerformanceClip } from './assemble-film.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
async function snapshot(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 16 || info.size > 250 * 1024 * 1024) throw performanceReviewFailure('PERFORMANCE_MEDIA_UNVERIFIED');
  const bytes = await readFile(path);
  if (bytes.length !== info.size) throw performanceReviewFailure('PERFORMANCE_MEDIA_UNVERIFIED');
  return { sha256: hash(bytes), bytes: bytes.length };
}

export async function prepareFilmPerformance({ job, clips, work, ffmpeg, stillOwned }, { prepareClip = preparePerformanceClip } = {}) {
  if (!validateFilmPerformance(job.manifest)) return null;
  if (digest(JSON.stringify(job.manifest)) !== job.manifestHash || clips.length !== job.manifest.shots.length
    || job.shots.length !== clips.length) throw performanceReviewFailure('PERFORMANCE_PROVENANCE_INVALID');
  const observations = [];
  for (const [index, shot] of job.manifest.shots.entries()) {
    if (!await stillOwned()) throw performanceReviewFailure();
    const clip = clips[index], saved = job.shots[index];
    if (clip.shotId !== shot.id || saved.id !== shot.id || saved.status !== 'completed') throw performanceReviewFailure('PERFORMANCE_PROVENANCE_INVALID');
    const provenance = validatePerformanceOutput(job.manifest, shot, saved.output);
    const video = await snapshot(clip.path), sourceAudioPath = clip.audioPath;
    const sourceAudio = sourceAudioPath ? await snapshot(sourceAudioPath) : null;
    const decoded = await prepareClip({ manifest: job.manifest, shot, clip, work, ffmpeg });
    if (!same(video, await snapshot(clip.path)) || sourceAudio && !same(sourceAudio, await snapshot(sourceAudioPath)))
      throw performanceReviewFailure('PERFORMANCE_AUDIO_MISMATCH');
    const selected = await snapshot(clip.audioPath || clip.path);
    observations.push({ shotId: shot.id, outputHash: digest(JSON.stringify(saved.output)), provenance,
      videoSha256: video.sha256, videoBytes: video.bytes, providerAudioSha256: sourceAudio?.sha256 ?? null,
      providerAudioBytes: sourceAudio?.bytes ?? null, selectedAudioContainerSha256: selected.sha256,
      selectedAudioContainerBytes: selected.bytes, ...decoded });
  }
  return observations;
}

export async function storeFilmPerformanceReview({ email, id, job, clips, observations, artifactSha256, speechReview, music, stillOwned },
  { read = readRecord, write = writeRecord, now = Date.now } = {}) {
  if (!validateFilmPerformance(job.manifest)) return null;
  const ownerHash = digest(email), binding = { version: 1, recipe: FILM_PERFORMANCE_RECIPE, ownerHash, id,
    manifestHash: job.manifestHash, artifactSha256, speechReviewSha256: digest(JSON.stringify(speechReview)),
    music: music ?? { requested: false }, shots: observations };
  validatePerformanceReviewBinding(binding, { job, ownerHash, id, artifactSha256, speechReview });
  for (const [index, clip] of clips.entries()) {
    const original = observations[index], video = await snapshot(clip.path), selected = await snapshot(clip.audioPath || clip.path);
    if (clip.shotId !== original.shotId || video.sha256 !== original.videoSha256 || video.bytes !== original.videoBytes
      || selected.sha256 !== original.selectedAudioContainerSha256 || selected.bytes !== original.selectedAudioContainerBytes)
      throw performanceReviewFailure('PERFORMANCE_AUDIO_MISMATCH');
  }
  if (!await stillOwned()) throw performanceReviewFailure();
  const current = (await read(`production/jobs/${ownerHash}/${id}.json`))?.value;
  if (!current || current.manifestHash !== job.manifestHash || current.status !== 'awaiting-assembly'
    || digest(JSON.stringify(current.manifest)) !== job.manifestHash || !same(current.shots, job.shots)) throw performanceReviewFailure('PERFORMANCE_PROVENANCE_INVALID');
  validatePerformanceReviewBinding(binding, { job: current, ownerHash, id, artifactSha256, speechReview });
  const bindingHash = digest(JSON.stringify(binding)), receiptPath = performanceReceiptPath(ownerHash, id, bindingHash);
  const value = { version: 1, state: 'verified', bindingHash, binding, verifiedAt: new Date(now()).toISOString() };
  // Immutable content identity; a lost write reply succeeds only after readback.
  try { await write(receiptPath, value); } catch { /* Readback below is mandatory. */ }
  const saved = (await read(receiptPath))?.value;
  if (saved?.version !== 1 || saved.state !== 'verified' || saved.bindingHash !== bindingHash || !same(saved.binding, binding)
    || !await stillOwned()) throw performanceReviewFailure('PERFORMANCE_PROVENANCE_INVALID');
  return { version: 1, recipe: FILM_PERFORMANCE_RECIPE, manifestHash: job.manifestHash, passed: true,
    artifactSha256, bindingHash, receiptPath, shotCount: observations.length };
}
