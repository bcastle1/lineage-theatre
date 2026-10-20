// One bounded whole-scene recognition retry over unchanged cached PCM.
// No per-cut transcript projection, synthesis, provider call, or audio edit.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyAuthoredSceneEquivalence } from './repair-name-proof.mjs';
import { markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

const hash = value => createHash('sha256').update(value).digest('hex'), jsonHash = value => hash(JSON.stringify(value));
const HASH = /^[a-f0-9]{64}$/;
const fail = () => markFinishingFailure(Object.assign(new Error('The complete authored scene needs speech review.'),
  { code: 'FILM_SPEECH_REVIEW_REQUIRED' }), 'speech-review', 'SPEECH_SCRIPT_MISMATCH');
const check = value => { if (!value) throw fail(); };

export function authoredPcm(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 44 && bytes.length <= 6_000_000
    && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
    && bytes.readUInt32LE(4) + 8 === bytes.length);
  let data, channels, offset = 12;
  for (; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    check(start + size <= bytes.length);
    if (type === 'fmt ') {
      check(channels === undefined && size >= 16 && bytes.readUInt16LE(start) === 1
        && [1, 2].includes(bytes.readUInt16LE(start + 2)) && bytes.readUInt32LE(start + 4) === 48000
        && bytes.readUInt16LE(start + 14) === 16);
      channels = bytes.readUInt16LE(start + 2);
      check(bytes.readUInt16LE(start + 12) === channels * 2 && bytes.readUInt32LE(start + 8) === 48000 * channels * 2);
    }
    if (type === 'data') { check(data === undefined); data = bytes.subarray(start, start + size); }
    offset = start + size + size % 2;
  }
  check(offset === bytes.length && channels && data?.length && data.length % (channels * 2) === 0);
  return { channels, data, frames: data.length / (channels * 2) };
}

export function joinAuthoredPcm(sources, durationsMs) {
  check(Array.isArray(sources) && sources.length === 2 && durationsMs.length === 2);
  const parsed = sources.map(authoredPcm), channels = parsed[0].channels;
  check(parsed.every((value, index) => value.channels === channels && Number.isSafeInteger(durationsMs[index])
    && durationsMs[index] > 0 && durationsMs[index] <= 15000 && value.frames === durationsMs[index] * 48));
  const pcm = Buffer.concat(parsed.map(value => value.data)), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(48000 * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const bytes = Buffer.concat([header, pcm]); check(authoredPcm(bytes).data.equals(pcm));
  return { bytes, pcmSha256: hash(pcm), sha256: hash(bytes), channels };
}

export function createAdjacentAuthoredSpeechContext({ manifest, manifestHash, voices, provenance, constructionRoot,
  bindingHash, prefix, guard, transcribe, read, write, persist = true, verifyEquivalence = verifyAuthoredSceneEquivalence } = {}) {
  check(HASH.test(manifestHash || '') && jsonHash(manifest) === manifestHash && provenance?.manifestHash === manifestHash
    && HASH.test(bindingHash || '') && typeof guard === 'function' && typeof transcribe === 'function'
    && typeof read === 'function' && typeof write === 'function' && typeof persist === 'boolean'
    && /^production\/soundtracks\/[a-f0-9]{64}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(prefix || '') && prefix.endsWith('/' + bindingHash));
  let used = false;
  return async input => {
    check(!used); used = true;
    await guard();
    const previous = input.previous, index = manifest.shots.findIndex(shot => shot.id === input.shot?.id), shot = manifest.shots[index], prior = manifest.shots[index - 1];
    check(jsonHash(input.manifest) === manifestHash && index > 0 && prior && jsonHash(shot) === jsonHash(input.shot)
      && jsonHash(prior) === jsonHash(previous?.shot) && shot.sceneParts === 2 && prior.sceneParts === 2
      && prior.scenePart === 1 && shot.scenePart === 2 && shot.sceneIndex === prior.sceneIndex
      && manifest.shots.filter(value => value.sceneIndex === shot.sceneIndex).length === 2
      && shot.continuity?.precedingShotId === prior.id && shot.startMs === prior.startMs + prior.targetDurationMs
      && previous.review?.shotId === prior.id && previous.review.scriptMatched === true && !previous.review.edit
      && !previous.review.adjacentContextProof && previous.review.verificationScope !== 'authored-scene-window');
    const shots = [prior, shot], audioPaths = [previous.audioPath, input.audioPath], sourceAudio = [], sourceBytes = [];
    for (const [i, current] of shots.entries()) {
      const source = provenance.scenes.find(value => value.shotId === current.id), descriptor = source?.mix;
      check(source?.originalProviderAudioIncluded === false && source.durationMs === current.targetDurationMs
        && /^[a-z0-9-]{1,80}\.wav$/.test(descriptor?.file || '') && HASH.test(descriptor.sha256 || ''));
      const expectedPath = join(resolve(constructionRoot), 'soundtrack', descriptor.file), info = await lstat(audioPaths[i]);
      check(info.isFile() && !info.isSymbolicLink() && info.size === descriptor.sizeBytes && info.size <= 6_000_000
        && await realpath(audioPaths[i]) === await realpath(expectedPath));
      const bytes = await readFile(audioPaths[i]); check(hash(bytes) === descriptor.sha256);
      sourceBytes.push(bytes); sourceAudio.push({ shotId: current.id, sha256: descriptor.sha256, sizeBytes: bytes.length });
    }
    check(previous.audioSha256 === sourceAudio[0].sha256 && previous.audioSizeBytes === sourceAudio[0].sizeBytes);
    const joined = joinAuthoredPcm(sourceBytes, shots.map(value => value.targetDurationMs));
    const directory = join(resolve(constructionRoot), 'scene-context'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const combinedAudioPath = join(directory, joined.sha256 + '.wav');
    try { await writeFile(combinedAudioPath, joined.bytes, { flag: 'wx', mode: 0o600 }); }
    catch { check(hash(await readFile(combinedAudioPath)) === joined.sha256); }
    const durationSeconds = shots.reduce((sum, value) => sum + value.targetDurationMs, 0) / 1000, raw = [], receipts = [];
    const windowPrefix = `${prefix}/scene-context/${prior.id}-${shot.id}/${joined.sha256}`;
    const save = async (pathname, value) => {
      const serialized = JSON.stringify(value); check(Buffer.byteLength(serialized) <= 1_500_000);
      if (persist) {
        await guard(); try { await write(pathname, value); } catch { /* Exact immutable readback only. */ }
        check(jsonHash((await read(pathname))?.value) === hash(serialized));
      }
      return { pathname, sha256: hash(serialized) };
    };
    for (const contextSilence of [false, true]) {
      await guard(); check(hash(await readFile(combinedAudioPath)) === joined.sha256);
      const transcript = await transcribe(combinedAudioPath, { contextSilence });
      check(Number.isFinite(transcript?.duration) && Math.abs(transcript.duration - durationSeconds) < .001
        && Array.isArray(transcript.words) && transcript.words.length <= 1000 && Buffer.byteLength(JSON.stringify(transcript)) <= 500_000);
      check(hash(await readFile(combinedAudioPath)) === joined.sha256);
      raw.push(transcript);
      receipts.push(await save(`${windowPrefix}/${contextSilence ? 'context' : 'normal'}-${jsonHash(transcript)}.json`,
        { version: 1, kind: 'authored-scene-window-transcription', manifestHash, bindingHash,
          shotIds: shots.map(value => value.id), sourceAudio, combinedAudioSha256: joined.sha256, combinedPcmSha256: joined.pcmSha256,
          contextSilence, model: 'medium.en', transcriptSha256: jsonHash(transcript), transcript }));
    }
    const [normalTranscript, contextTranscript] = raw;
    const equivalenceProof = await verifyEquivalence({ manifest, manifestHash, voices, provenance, constructionRoot,
      shotIds: shots.map(value => value.id), audioPaths, combinedAudioPath, normalTranscript, contextTranscript });
    for (const [i, path] of audioPaths.entries()) check(hash(await readFile(path)) === sourceAudio[i].sha256);
    check(hash(await readFile(combinedAudioPath)) === joined.sha256); await guard();
    const meta = { kind: 'adjacent-authored-scene-proof-v1', version: 1, verificationScope: 'authored-scene-window', perCutLocalization: false,
      manifestHash, shotIds: shots.map(value => value.id), sourceAudio, combinedAudioSha256: joined.sha256,
      combinedPcmSha256: joined.pcmSha256, durationSeconds, sceneIndex: shot.sceneIndex, previousReviewSha256: jsonHash(previous.review),
      standaloneNormalTranscriptSha256: jsonHash(input.normalTranscript), standaloneContextTranscriptSha256: jsonHash(input.contextTranscript),
      fullNormalTranscriptSha256: jsonHash(normalTranscript), fullContextTranscriptSha256: jsonHash(contextTranscript),
      provenanceSha256: jsonHash(provenance), voiceAssignmentsSha256: jsonHash(voices), bindingHash, pcmUnchanged: true };
    const evidence = { ...meta, normalTranscript, contextTranscript, equivalenceProof }, serialized = JSON.stringify(evidence);
    const receipt = await save(`${windowPrefix}/evidence-${hash(serialized)}.json`, evidence);
    const evidencePath = join(directory, `evidence-${receipt.sha256}.json`);
    try { await writeFile(evidencePath, serialized, { flag: 'wx', mode: 0o600 }); }
    catch { check(hash(await readFile(evidencePath)) === receipt.sha256); }
    return { normalTranscript, contextTranscript, equivalenceProof,
      proof: { ...meta, evidencePath, receiptPath: receipt.pathname, evidenceSha256: receipt.sha256 } };
  };
}
