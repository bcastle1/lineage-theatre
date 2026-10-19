// Optional operator-repair evidence only. The ordinary production recognizer
// does not import or configure this resolver, and transcripts are never edited.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSpeech, repairCardinalSpan } from './review-film-speech.mjs';
import { soundtrackPlan } from './rebuild-film-soundtrack.mjs';
import { markFinishingFailure } from '../api/_lib/film-finishing-diagnostics.mjs';

const HASH = /^[a-f0-9]{64}$/;
const DICTIONARY_SHA256 = '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22';
const DICTIONARY_COMMIT = '74790861f652b15e4ac49015a90074ad62a27690';
const PRONUNCIATION_RUNTIME = Object.freeze({ misaki: '0.9.4', spacy: '3.8.7', 'en-core-web-sm': '3.8.0',
  phonemizer: '3.4.0', 'espeakng-loader': '0.2.4', 'kokoro-onnx': '0.6.1' });
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const fail = () => markFinishingFailure(Object.assign(new Error('The exact repair speech equivalence could not be verified.'),
  { code: 'FILM_SPEECH_REVIEW_REQUIRED' }), 'speech-review', 'SPEECH_SCRIPT_MISMATCH');
const requireValue = value => { if (!value) throw fail(); };
const words = transcript => (transcript.words || []).flatMap((word, rawIndex) => normalizeSpeech(word.word)
  .map(token => ({ token, raw: word.word, rawIndex, start: word.start, end: word.end })));
const intendedWords = shot => normalizeSpeech(`${shot.narration || ''} ${(shot.dialogue || '').replace(/(?:^|\n)[A-Z][A-Z\s'-]*:\s*/g, ' ')}`);
function rawCardinalSpanValid(rawTokens, first, last, canonicalTokens) {
  // Normalization drops punctuation-only tokens. Retain their raw adjacency
  // so a separated sign, decimal point or fraction bar cannot disappear.
  const unsafeNeighbor = raw => /^[\s\("'“‘\[{]*[+\-−±.\/⁄][\s\)"'”’\]}]*$/.test(String(raw || ''));
  if (unsafeNeighbor(rawTokens[first - 1]) || unsafeNeighbor(rawTokens[last + 1])) return false;
  const raw = rawTokens.slice(first, last + 1).join(' ').normalize('NFKC').trim().toLowerCase();
  // Tokens come only from the fixed cardinal grammar: digits or ASCII words.
  // A hyphen is allowed only between the two canonical spoken number words.
  return new RegExp(`^[\\("'“‘]?${canonicalTokens.join('[\\s-]+')}[\\)"'”’]?[,.!?;:]?$`).test(raw);
}

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

export function createRepairSpeechResolver({ manifest, manifestHash, voices, provenance, constructionRoot, receiptRoot,
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
    requireValue(expected.length && normal.length && normal.length === contextual.length
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
      const rawTokens = turn.text.split(/\s+/);
      for (const [rawIndex, raw] of rawTokens.entries()) for (const token of normalizeSpeech(raw)) binding.push({ token, raw, rawIndex, rawTokens, generated, turn });
    }
    requireValue(binding.length === expected.length && binding.every((value, index) => value.token === expected[index]));
    const nameSpans = [], castNames = manifest.screenplay.characters.map(cast => ({ cast, name: normalizeSpeech(cast.name) }));
    for (const { cast, name } of castNames) {
      if (name.length < 2 || name.length > 8) continue;
      for (let start = 0; start <= expected.length - name.length; start++) if (name.every((token, offset) => expected[start + offset] === token)
        && name.every((_, offset) => binding[start + offset].turn === binding[start].turn)) nameSpans.push({ castId: cast.id, start, end: start + name.length, nameScope: 'full-name' });
    }
    const actualTokens = normal.map(word => word.token), changes = [];
    let left = 0, right = 0;
    while (left < expected.length || right < normal.length) {
      requireValue(left < expected.length && right < normal.length);
      if (expected[left] === normal[right].token) { left++; right++; continue; }
      const expectedNumber = repairCardinalSpan(expected, left), actualNumber = repairCardinalSpan(actualTokens, right);
      let change;
      if (expectedNumber && actualNumber && expectedNumber.form !== actualNumber.form && expectedNumber.value === actualNumber.value) {
        requireValue(binding.slice(left, expectedNumber.end).every(value => value.turn === binding[left].turn));
        requireValue(rawCardinalSpanValid(binding[left].rawTokens, binding[left].rawIndex,
          binding[expectedNumber.end - 1].rawIndex, expected.slice(left, expectedNumber.end)));
        for (const [transcript, rawTranscript] of [[normal, input.normalTranscript], [contextual, input.contextTranscript]])
          requireValue(rawCardinalSpanValid(rawTranscript.words.map(word => word.word), transcript[right].rawIndex,
            transcript[actualNumber.end - 1].rawIndex, actualTokens.slice(right, actualNumber.end)));
        change = { kind: 'cardinal', expectedStart: left, expectedEnd: expectedNumber.end,
          actualStart: right, actualEnd: actualNumber.end, canonicalValue: expectedNumber.value,
          expectedForm: expectedNumber.form, recognizedForm: actualNumber.form, method: 'canonical-cardinal-0-99-v1' };
      } else {
        let candidates = nameSpans.filter(span => left >= span.start && left < span.end);
        const honorificPrecedes = left > 0 && right > 0 && ['mr', 'mrs', 'ms', 'dr'].includes(expected[left - 1])
          && normal[right - 1].token === expected[left - 1];
        if (!candidates.length && !honorificPrecedes) {
          // A lone first name qualifies only when it uniquely identifies one
          // saved cast member. This branch permits no surname or other alias.
          const firstNames = castNames.filter(({ name }) => name[0] === expected[left]);
          if (firstNames.length === 1 && firstNames[0].name.length >= 2 && firstNames[0].name.length <= 8
            && /^[a-z]{2,64}$/.test(expected[left])) candidates = [{ castId: firstNames[0].cast.id,
              start: left, end: left + 1, nameScope: 'unique-first-name' }];
        }
        if (!candidates.length && honorificPrecedes && binding[left - 1].turn === binding[left].turn) {
          // A surname is permitted only immediately after an already exact
          // honorific, within one verified synthesis turn, and unique in cast.
          const surnames = castNames.filter(({ name }) => name.at(-1) === expected[left]);
          if (surnames.length === 1 && surnames[0].name.length >= 2 && surnames[0].name.length <= 8
            && /^[a-z]{2,64}$/.test(expected[left])) candidates = [{ castId: surnames[0].cast.id,
              start: left - 1, end: left + 1, nameScope: 'honorific-surname',
              honorific: { token: expected[left - 1], expectedWordIndex: left - 1, actualWordIndex: right - 1,
                normalTiming: { start: normal[right - 1].start, end: normal[right - 1].end },
                contextTiming: { start: contextual[right - 1].start, end: contextual[right - 1].end } } }];
        }
        requireValue(candidates.length === 1);
        change = { kind: 'cast-name', expectedStart: left, expectedEnd: left + 1, actualStart: right, actualEnd: right + 1,
          castId: candidates[0].castId, nameScope: candidates[0].nameScope,
          castNameSpan: { start: candidates[0].start, end: candidates[0].end },
          ...(candidates[0].honorific ? { honorific: candidates[0].honorific } : {}) };
      }
      const bound = binding[left], generated = bound.generated;
      requireValue(binding.slice(change.expectedStart, change.expectedEnd).every(value => value.turn === bound.turn));
      // Both unchanged ASR timestamp spans must lie in the exact verified
      // synthesis turn; the bounded variation is only a decoder boundary.
      const timingStart = change.honorific ? change.honorific.actualWordIndex : change.actualStart;
      for (const transcript of [normal, contextual]) for (const actual of transcript.slice(timingStart, change.actualEnd))
        requireValue(actual.start >= Math.max(0, generated.startSeconds - .35)
          && actual.end <= Math.min(shot.targetDurationMs / 1000, generated.endSeconds + .35));
      changes.push({ ...change, bound }); requireValue(changes.length <= 64);
      left = change.expectedEnd; right = change.actualEnd;
    }
    requireValue(changes.length > 0);
    const names = changes.filter(change => change.kind === 'cast-name');
    const compared = names.length ? await comparePronunciations(names.map(change => ({ expected: expected[change.expectedStart],
      recognized: normal[change.actualStart].token })), python) : null;
    if (names.length) requireValue(compared?.version === 1 && compared.status === 'compared'
      && Array.isArray(compared.pairs) && compared.pairs.length === names.length);
    const spans = changes.map(change => {
      const { bound, ...alignment } = change;
      const base = { ...alignment, expectedTokensSha256: jsonHash(expected.slice(change.expectedStart, change.expectedEnd)),
        recognizedTokensSha256: jsonHash(actualTokens.slice(change.actualStart, change.actualEnd)),
        normalTiming: normal.slice(change.actualStart, change.actualEnd).map(({ start, end }) => ({ start, end })),
        contextTiming: contextual.slice(change.actualStart, change.actualEnd).map(({ start, end }) => ({ start, end })),
        turnIndex: bound.turn.turnIndex, turnTextSha256: bound.turn.textSha256, turnAudioSha256: bound.generated.audio.sha256,
        voice: bound.turn.voice, synthesisPhonemesSha256: bound.generated.phonemesSha256 };
      if (change.kind === 'cardinal') return { ...base, evidenceHash: jsonHash(base) };
      const pairIndex = names.indexOf(change);
      const proof = compared.pairs[pairIndex];
      requireValue(proof?.equal === true && proof.expectedSha256 === hash(expected[change.expectedStart])
        && proof.recognizedSha256 === hash(normal[change.actualStart].token)
        && ['misaki-exact', 'cmudict-exact'].includes(proof.method) && proof.engineVersion === 'misaki-0.9.4'
        && HASH.test(proof.phonemeHash || '') && HASH.test(proof.evidenceHash || '')
        && HASH.test(proof.expectedPhonemeHash || '') && HASH.test(proof.recognizedPhonemeHash || '')
        && proof.dictionarySha256 === DICTIONARY_SHA256 && proof.dictionaryCommit === DICTIONARY_COMMIT
        && Object.entries(PRONUNCIATION_RUNTIME).every(([name, version]) => proof.runtimeVersions?.[name] === version));
      return { ...base,
        expectedSha256: proof.expectedSha256, recognizedSha256: proof.recognizedSha256,
        method: proof.method, phonemeHash: proof.phonemeHash, evidenceHash: proof.evidenceHash,
        expectedPhonemeHash: proof.expectedPhonemeHash, recognizedPhonemeHash: proof.recognizedPhonemeHash,
        engineVersion: proof.engineVersion, dictionarySha256: proof.dictionarySha256, dictionaryCommit: proof.dictionaryCommit,
        runtimeVersions: { ...PRONUNCIATION_RUNTIME } };
    });
    requireValue(hash(await readFile(input.audioPath)) === audioSha256);
    const proof = { kind: 'repair-speech-equivalence-proof-v2', version: 2, manifestHash, shotId: shot.id, audioSha256,
      normalTranscriptSha256: jsonHash(input.normalTranscript), contextTranscriptSha256: jsonHash(input.contextTranscript),
      provenanceSha256: jsonHash(provenance), voiceAssignmentsSha256: jsonHash(voices), expectedWordCount: expected.length,
      actualWordCount: normal.length, spans };
    const directory = join(receiptRoot, 'review', 'speech-proofs'); await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 });
    return proof;
  };
}
