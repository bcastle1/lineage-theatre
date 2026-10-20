import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOUNDTRACK_MAX_OUTPUT_BYTES, validateBoundarySilence, verifyBoundarySilencePcm } from '../scripts/rebuild-film-soundtrack.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function pcm(values) { const bytes = Buffer.alloc(values.length * 2); values.forEach((value, index) => bytes.writeInt16LE(value, index * 2)); return bytes; }
function wav(data) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function fixture() {
  // Interior silence and quiet speech must survive byte for byte.
  const source = pcm([...Array(2400).fill(1), 20, ...Array(2000).fill(0), -20, ...Array(3600).fill(-1)]);
  const start = 1200, end = 2400, selected = source.subarray(start * 2, source.length - end * 2);
  const turn = { originalAudio: { file: 'original.wav' }, durationSeconds: selected.length / 48000,
    startSeconds: .12, endSeconds: .12 + selected.length / 48000,
    boundarySilence: { version: 1, method: 'pcm16-edge-silence-v1', threshold: 1 / 32768, guardMs: 50, sampleRate: 24000,
      sourceSamples: source.length / 2, retainedSamples: selected.length / 2, trimStartSamples: start, trimEndSamples: end,
      sourcePcmSha256: hash(source), selectedPcmSha256: hash(selected) } };
  return { source, selected, turn };
}

test('boundary trim retains the exact PCM span, interior pauses and 50ms guards', () => {
  const { turn, source, selected } = fixture();
  assert.equal(validateBoundarySilence(turn), true);
  assert.equal(verifyBoundarySilencePcm(turn, wav(source), wav(selected)), true);
  assert.equal(selected.readInt16LE(1200 * 2), 20);
  assert.equal(selected.subarray(1201 * 2, 3201 * 2).equals(Buffer.alloc(4000)), true);
  assert.equal(validateBoundarySilence({}), false); // Existing receipts remain readable.
});

test('boundary proof rejects changed samples, missing guards and inconsistent provenance', () => {
  for (const change of [t => { t.boundarySilence.guardMs = 40; }, t => { t.boundarySilence.threshold = .008; },
    t => { t.boundarySilence.retainedSamples--; }, t => { t.durationSeconds += .01; }, t => { delete t.originalAudio; }]) {
    const { turn, source, selected } = fixture(); change(turn);
    assert.throws(() => verifyBoundarySilencePcm(turn, wav(source), wav(selected)));
  }
  const { turn, source, selected } = fixture(), changed = Buffer.from(selected); changed.writeInt16LE(21, 1200 * 2);
  turn.boundarySilence.selectedPcmSha256 = hash(changed);
  assert.throws(() => verifyBoundarySilencePcm(turn, wav(source), wav(changed)));
  const f = fixture(); f.turn.boundarySilence.trimStartSamples++;
  f.turn.boundarySilence.retainedSamples--; f.turn.durationSeconds -= 1 / 24000; f.turn.endSeconds -= 1 / 24000;
  f.turn.boundarySilence.selectedPcmSha256 = hash(f.selected.subarray(2));
  assert.throws(() => verifyBoundarySilencePcm(f.turn, wav(f.source), wav(f.selected.subarray(2))));
});

test('bounded builder output accommodates 200 scenes and 600 dual-audio turn receipts', () => {
  const descriptor = { file: 'scene-200-turn-20-original.wav', sha256: 'a'.repeat(64), sizeBytes: 250 * 1024 * 1024 };
  const turn = { ...fixture().turn, turnIndex: 20, speakerId: 'a'.repeat(100), source: 'dialogue', voice: 'am_' + 'a'.repeat(24),
    textSha256: 'a'.repeat(64), synthesisTextSha256: 'a'.repeat(64), phonemesSha256: 'a'.repeat(64), gain: .123456789,
    speed: 1, originalAudio: descriptor, audio: descriptor };
  const scenes = Array.from({ length: 200 }, (_, i) => ({ shotId: 's'.repeat(100), sceneIndex: i + 1, durationMs: 3000,
    narrationSha256: 'a'.repeat(64), dialogueSha256: 'a'.repeat(64), speech: descriptor, mix: descriptor,
    turns: [turn, turn, turn] }));
  const bytes = Buffer.byteLength(JSON.stringify({ status: 'constructed', manifestHash: 'a'.repeat(64), scenes }));
  assert.ok(bytes > 200_000);
  assert.ok(bytes < SOUNDTRACK_MAX_OUTPUT_BYTES);
  assert.equal(SOUNDTRACK_MAX_OUTPUT_BYTES, 2_000_000);
});

test('offline Python boundary selector trims only guarded contiguous digital silence', t => {
  const executable = process.env.LINEAGE_TEST_PYTHON || 'python3';
  const available = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (available.error?.code === 'ENOENT') { t.skip('Python is unavailable'); return; }
  assert.equal(available.status, 0);
  const modulePath = fileURLToPath(new URL('../scripts/rebuild-film-soundtrack.py', import.meta.url));
  const program = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('soundtrack',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
x=[1/32768]*2400+[20/32768]+[0]*2000+[-20/32768]+[-1/32768]*3600
a,b=m.boundary_silence_bounds(x,24000)
assert (a,b)==(1200,len(x)-2400)
assert x[a:b][1200:3202]==x[2400:4402]
assert m.boundary_silence_bounds([.1,0,-.1],24000)==(0,3)
try:m.boundary_silence_bounds([0]*3000,24000);raise AssertionError('silent accepted')
except m.SoundtrackError:pass
print(json.dumps({'guarded':True,'interiorUnchanged':True}))`;
  const result = spawnSync(executable, ['-B', '-c', program, modulePath], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { guarded: true, interiorUnchanged: true });
});
