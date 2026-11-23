import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { validateFilmTextCorrections } from '../api/_lib/film-text-correction.mjs';

function fixture() {
  const sourceSha256 = digest('fictional preserved clip bytes');
  const job = { manifest: { shots: [{ id: 'shot-004', targetDurationMs: 8000,
    visual: 'An illustrated fictional family tree. End card: Morgan Example | 1933–2002.' }] },
  shots: [{ id: 'shot-004', status: 'completed', output: { sha256: sourceSha256 } }] };
  const correction = { version: 1, shotId: 'shot-004', sourceSha256, text: 'Morgan Example | 1933–2002',
    startMs: 1500, endMs: 4000, x: 900, y: 650, width: 700, height: 130, fontSize: 38,
    background: '112233', fontColor: 'FfEeDd' };
  return { job, correction };
}

test('approved saved-label correction is exact, bounded, read-only and optional', () => {
  const { job, correction } = fixture(), input = [correction], before = structuredClone({ job, input });
  assert.deepEqual(validateFilmTextCorrections(job, undefined), []);
  assert.deepEqual(validateFilmTextCorrections(job, input), input);
  assert.deepEqual({ job, input }, before);
  const boundary = { ...correction, startMs: 4000, endMs: 8000, x: 0, y: 864, width: 1920, height: 216, fontSize: 100 };
  assert.deepEqual(validateFilmTextCorrections(job, [boundary]), [boundary]);
});

test('text correction rejects changed source, wording, shot identity, unsupported fields and multiple regions', async t => {
  const changes = [
    ['wrong source checksum', (job, row) => { row.sourceSha256 = digest('another clip'); }],
    ['missing source checksum', job => { delete job.shots[0].output.sha256; }],
    ['different target shot', (job, row) => { row.shotId = 'shot-001'; }],
    ['stored shot mismatch', job => { job.shots[0].id = 'shot-002'; }],
    ['unfinished clip', job => { job.shots[0].status = 'processing'; }],
    ['new spelling not saved', (job, row) => { row.text = 'An Invented Name'; }],
    ['added leading space', (job, row) => { row.text = ` ${row.text}`; }],
    ['empty text', (job, row) => { row.text = ''; }],
    ['overlong saved text', (job, row) => { row.text = 'x'.repeat(121); job.manifest.shots[0].visual = row.text; }],
    ['extra region behavior', (job, row) => { row.opacity = 0.5; }],
    ['unknown version', (job, row) => { row.version = 2; }],
  ];
  for (const [name, mutate] of changes) await t.test(name, () => {
    const { job, correction } = fixture(); mutate(job, correction);
    assert.throws(() => validateFilmTextCorrections(job, [correction]), { code: 'VISUAL_REVIEW_INVALID' });
  });
  for (const corrections of [null, {}, [], [fixture().correction, fixture().correction]])
    assert.throws(() => validateFilmTextCorrections(fixture().job, corrections), { code: 'VISUAL_REVIEW_INVALID' });
});

test('ASS instructions and control characters cannot enter an otherwise saved label', async t => {
  for (const text of ['{\\pos(1,1)}Name', 'Name\\Nsecond line', 'Name\nsecond line', 'Name\rsecond line',
    'Name\tsecond', 'Name\0hidden', 'Name\x7fhidden', '{Name}', 'Name}']) await t.test(JSON.stringify(text), () => {
    const { job, correction } = fixture(); job.manifest.shots[0].visual = text; correction.text = text;
    assert.throws(() => validateFilmTextCorrections(job, [correction]), { code: 'VISUAL_REVIEW_INVALID' });
  });
});

test('text correction rejects time, geometry, typography and color outside its bounded contract', async t => {
  const changes = [
    ['start before clip', { startMs: -1 }], ['empty interval', { endMs: 1500 }],
    ['past source duration', { endMs: 8001 }], ['more than four seconds', { startMs: 0, endMs: 4001 }],
    ['fractional time', { startMs: 1.2 }], ['text time', { endMs: '4000' }],
    ['negative x', { x: -1 }], ['negative y', { y: -1 }], ['fractional geometry', { x: 0.5 }],
    ['too narrow', { width: 99 }], ['too short', { height: 39 }], ['too tall', { height: 217 }],
    ['past right edge', { x: 1500, width: 500 }], ['past bottom edge', { y: 1000, height: 100 }],
    ['font too small', { fontSize: 15 }], ['font too large', { fontSize: 101 }],
    ['font fills rectangle', { height: 40, fontSize: 40 }], ['noninteger font', { fontSize: 20.5 }],
    ['color with prefix', { background: '#112233' }], ['alpha channel', { fontColor: 'FF112233' }],
    ['numeric background', { background: 123456 }], ['numeric foreground', { fontColor: 123456 }],
  ];
  for (const [name, overrides] of changes) await t.test(name, () => {
    const { job, correction } = fixture();
    assert.throws(() => validateFilmTextCorrections(job, [{ ...correction, ...overrides }]), { code: 'VISUAL_REVIEW_INVALID' });
  });
});
