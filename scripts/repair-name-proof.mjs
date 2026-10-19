// Optional operator-repair evidence only. The ordinary production recognizer
// does not import or configure this resolver, and transcripts are never edited.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSpeech } from './review-film-speech.mjs';
import { soundtrackPlan } from './rebuild-film-soundtrack.mjs';
import { markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

const HASH = /^[a-f0-9]{64}$/;
const DICTIONARY_SHA256 = '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22';
const DICTIONARY_COMMIT = '74790861f652b15e4ac49015a90074ad62a27690';
const PRONUNCIATION_RUNTIME = Object.freeze({ misaki: '0.9.4', spacy: '3.8.7', 'en-core-web-sm': '3.8.0',
  phonemizer: '3.4.0', 'espeakng-loader': '0.2.4', 'kokoro-onnx': '0.6.1' });
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const fail = () => markFinishingFailure(Object.assign(new Error('The cast-name pronunciation could not be verified.'),
  { code: 'FILM_SPEECH_REVIEW_REQUIRED' }), 'speech-review', 'SPEECH_SCRIPT_MISMATCH');
const requireValue = value => { if (!value) throw fail(); };
const words = transcript => (transcript.words || []).flatMap(word => normalizeSpeech(word.word)
  .map(token => ({ token, start: word.start, end: word.end })));
const intendedWords = shot => normalizeSpeech(`${shot.narration || ''} ${(shot.dialogue || '').replace(/(?:^|\n)[A-Z][A-Z\s'-]*:\s*/g, ' ')}`);

async function checkedFile(path, root, descriptor) {
  const stat = await lstat(path), full = await realpath(path), base = await realpath(root), within = relative(base, full);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size >= 16 && stat.size <= 250 * 1024 * 1024
    && within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  const bytes = await readFile(full), sha256 = hash(bytes);
  requireValue(bytes.length === stat.size && (!descriptor || descriptor.sha256 === sha256 && descriptor.sizeBytes === bytes.length));
  return { sha256, sizeBytes: bytes.length };
}

function comparePronunciations(pairs, python) {
  return new Promise((resolveProof, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('./compare-repair-name-pronunciations.py', import.meta.url))],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', TMPDIR: process.env.TMPDIR || '/tmp',
          HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2',
          OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2',
          ...(process.env.LINEAGE_PRONUNCIATION_DIR ? { LINEAGE_PRONUNCIATION_DIR: process.env.LINEAGE_PRONUNCIATION_DIR } : {}) } });
    const chunks = []; let length = 0, finished = false;
    const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolveProof(result); };
    const timer = setTimeout(() => { child.kill(); finish(fail()); }, 120_000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 200_000) { child.kill(); finish(fail()); } else chunks.push(chunk);
    });
    child.once('error', () => finish(fail())); child.stdin.on('error', () => finish(fail()));
    child.once('close', code => {
      if (code !== 0) { finish(fail()); return; }
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(fail()); }
    });
    child.stdin.end(JSON.stringify({ pairs }));
  });
}

export function createRepairCastNameResolver({ manifest, manifestHash, voices, provenance, constructionRoot, receiptRoot,
  python = process.env.LINEAGE_TTS_PYTHON || '/opt/soundtrack/bin/python' }) {
  requireValue(HASH.test(manifestHash || '') && jsonHash(manifest) === manifestHash && typeof constructionRoot === 'string'
    && typeof receiptRoot === 'string' && provenance?.manifestHash === manifestHash
    && provenance.recipe === 'local-authored-soundtrack-v1' && provenance.engine === 'kokoro-82m-v1.0-cpu'
    && provenance.sourceTextRewritten === false && provenance.speed === 1 && provenance.runtimeVersions?.misaki === '0.9.4');
  const plan = soundtrackPlan({ manifest, manifestHash, ...voices, music: provenance.musicRequested });
  const sourceDirectory = resolve(constructionRoot, 'soundtrack');
  return async input => {
    requireValue(jsonHash(input.manifest) === manifestHash && input.shot?.id && Array.isArray(provenance.scenes));
    const shot = manifest.shots.find(value => value.id === input.shot.id);
    const scene = plan.scenes.find(value => value.shotId === shot?.id), source = provenance.scenes.find(value => value.shotId === shot?.id);
    requireValue(shot && scene && source && jsonHash(shot) === jsonHash(input.shot) && source.durationMs === shot.targetDurationMs
      && source.originalProviderAudioIncluded === false && Array.isArray(source.turns) && source.turns.length === scene.turns.length);
    // The actual selected mixed audio must be the hash-verified construction,
    // not an original provider track or a substituted review recording.
    const currentAudio = await readFile(input.audioPath);
    const audioSha256 = hash(currentAudio);
    requireValue(audioSha256 === source.mix?.sha256 && currentAudio.length === source.mix.sizeBytes);
    await checkedFile(resolve(sourceDirectory, source.mix.file), sourceDirectory, source.mix);
    const expected = intendedWords(shot), normal = words(input.normalTranscript), contextual = words(input.contextTranscript);
    requireValue(expected.length && expected.length === normal.length && expected.length === contextual.length
      && normal.every((word, index) => word.token === contextual[index].token)
      && [input.normalTranscript, input.contextTranscript].every(value => Number.isFinite(value.duration)
        && value.duration >= shot.targetDurationMs / 1000 - .05));
    for (const transcript of [normal, contextual]) requireValue(transcript.every((word, index) => Number.isFinite(word.start)
      && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start && word.end <= shot.targetDurationMs / 1000
      && (!index || word.start >= transcript[index - 1].start)));
    const binding = [];
    for (const [turnIndex, turn] of scene.turns.entries()) {
      const generated = source.turns[turnIndex];
      requireValue(generated.turnIndex === turn.turnIndex && generated.speakerId === turn.speakerId && generated.source === turn.source
        && generated.voice === turn.voice && /^(?:af|am)_[a-z]{2,24}$/.test(turn.voice) && generated.speed === 1
        && generated.textSha256 === turn.textSha256 && generated.synthesisTextSha256 === turn.textSha256
        && HASH.test(generated.phonemesSha256 || '') && Number.isFinite(generated.startSeconds) && Number.isFinite(generated.endSeconds)
        && generated.startSeconds >= 0 && generated.endSeconds > generated.startSeconds && generated.endSeconds <= shot.targetDurationMs / 1000);
      await checkedFile(resolve(sourceDirectory, generated.audio.file), sourceDirectory, generated.audio);
      for (const token of normalizeSpeech(turn.text)) binding.push({ token, generated, turn });
    }
    requireValue(binding.length === expected.length && binding.every((value, index) => value.token === expected[index]));
    const spans = [];
    for (const cast of manifest.screenplay.characters) {
      const name = normalizeSpeech(cast.name);
      // Only full multi-token cast names qualify. Common isolated words and
      // isolated first/surnames do not become a general spelling exception.
      if (name.length < 2 || name.length > 8) continue;
      for (let start = 0; start <= expected.length - name.length; start++) if (name.every((token, offset) => expected[start + offset] === token)
        && name.every((_, offset) => binding[start + offset].turn === binding[start].turn)) spans.push({ castId: cast.id, start, end: start + name.length });
    }
    const mismatches = expected.flatMap((token, index) => token === normal[index].token ? [] : [index]);
    requireValue(mismatches.length > 0 && mismatches.length <= 64);
    const matches = mismatches.map(index => {
      const selectedSpans = spans.filter(span => index >= span.start && index < span.end);
      requireValue(selectedSpans.length === 1);
      const bound = binding[index], turn = bound.generated;
      // ASR boundary variation is bounded to the exact synthesized turn. No
      // recognized timestamp is moved or replaced by the construction timing.
      for (const actual of [normal[index], contextual[index]]) requireValue(actual.start >= Math.max(0, turn.startSeconds - .35)
        && actual.end <= Math.min(shot.targetDurationMs / 1000, turn.endSeconds + .35));
      return { index, span: selectedSpans[0], bound };
    });
    const compared = await comparePronunciations(matches.map(({ index }) => ({ expected: expected[index], recognized: normal[index].token })), python);
    requireValue(compared?.version === 1 && compared.status === 'compared' && Array.isArray(compared.pairs) && compared.pairs.length === matches.length);
    const tokens = matches.map(({ index, span, bound }, pairIndex) => {
      const proof = compared.pairs[pairIndex];
      requireValue(proof?.equal === true && proof.expectedSha256 === hash(expected[index]) && proof.recognizedSha256 === hash(normal[index].token)
        && ['misaki-exact', 'cmudict-exact'].includes(proof.method) && proof.engineVersion === 'misaki-0.9.4'
        && HASH.test(proof.phonemeHash || '') && HASH.test(proof.evidenceHash || '')
        && HASH.test(proof.expectedPhonemeHash || '') && HASH.test(proof.recognizedPhonemeHash || '')
        && proof.dictionarySha256 === DICTIONARY_SHA256 && proof.dictionaryCommit === DICTIONARY_COMMIT
        && Object.entries(PRONUNCIATION_RUNTIME).every(([name, version]) => proof.runtimeVersions?.[name] === version));
      return { wordIndex: index, castId: span.castId, castNameSpan: { start: span.start, end: span.end },
        expectedSha256: proof.expectedSha256, recognizedSha256: proof.recognizedSha256,
        normalTiming: { start: normal[index].start, end: normal[index].end }, contextTiming: { start: contextual[index].start, end: contextual[index].end },
        turnIndex: bound.turn.turnIndex, turnTextSha256: bound.turn.textSha256, turnAudioSha256: bound.generated.audio.sha256,
        voice: bound.turn.voice, synthesisPhonemesSha256: bound.generated.phonemesSha256,
        method: proof.method, phonemeHash: proof.phonemeHash, evidenceHash: proof.evidenceHash,
        expectedPhonemeHash: proof.expectedPhonemeHash, recognizedPhonemeHash: proof.recognizedPhonemeHash,
        engineVersion: proof.engineVersion, dictionarySha256: proof.dictionarySha256, dictionaryCommit: proof.dictionaryCommit,
        runtimeVersions: { ...PRONUNCIATION_RUNTIME } };
    });
    requireValue(hash(await readFile(input.audioPath)) === audioSha256);
    const proof = { kind: 'repair-cast-name-phoneme-proof-v1', version: 1, manifestHash, shotId: shot.id, audioSha256,
      normalTranscriptSha256: jsonHash(input.normalTranscript), contextTranscriptSha256: jsonHash(input.contextTranscript),
      provenanceSha256: jsonHash(provenance), voiceAssignmentsSha256: jsonHash(voices), tokens };
    const directory = join(receiptRoot, 'review', 'name-proofs'); await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 });
    return proof;
  };
}
