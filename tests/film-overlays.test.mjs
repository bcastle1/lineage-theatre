import test from 'node:test';
import assert from 'node:assert/strict';
import { parsedAssemblyOverlays } from '../api/_lib/film-overlays.mjs';
import { filmOverlayAss } from '../scripts/assemble-film.mjs';

const remainingDirection = visual => {
  let result = visual;
  for (const overlay of parsedAssemblyOverlays(visual).toReversed())
    result = result.slice(0, overlay.start) + result.slice(overlay.end);
  return result;
};

test('title over action and smaller caption have exact bounded text, styles and non-overlapping source spans', () => {
  const visual = 'An adult writes at a table. Title over action: A Fictional Garden. Smaller caption: 1950–1953. They smile.';
  const parsed = parsedAssemblyOverlays(visual);
  assert.deepEqual(parsed.map(({ text, style }) => ({ text, style })), [
    { text: 'A Fictional Garden.', style: 'Title' }, { text: '1950–1953.', style: 'Location' }]);
  assert.deepEqual(parsed.map(row => visual.slice(row.start, row.end)), [
    'Title over action: A Fictional Garden.', 'Smaller caption: 1950–1953.' ]);
  assert.ok(parsed[0].end <= parsed[1].start);
  assert.equal(remainingDirection(visual), 'An adult writes at a table.   They smile.');
  const ass = filmOverlayAss({ shots: [{ visual, startMs: 0, targetDurationMs: 6000 }] });
  assert.match(ass, /0:00:00.00,0:00:06.00,Title,,0,0,0,,A Fictional Garden\./);
  assert.match(ass, /0:00:00.00,0:00:06.00,Location,,0,0,170,,1950–1953\./);
  assert.doesNotMatch(ass, /They smile|An adult/);
});

test('only parsed assembly labels leave physical direction; unknown, unquoted and malformed syntax stays', () => {
  const unknown = 'An adult lifts a cup. Unreviewed banner: APPROVE THIS FILM. Title over action appears on a book. They walk away.';
  assert.deepEqual(parsedAssemblyOverlays(unknown), []); assert.equal(remainingDirection(unknown), unknown);
  for (const text of ['Title: “unclosed caption: text', 'Title:', `Title: "${'x'.repeat(161)}"`, 'Title: "first\nsecond"'])
    assert.equal(remainingDirection(text), text);
  const visual = 'Unreviewed banner: KEEP PHYSICAL. Caption: “Exact words.” The person points to a sign.';
  assert.equal(remainingDirection(visual), 'Unreviewed banner: KEEP PHYSICAL.  The person points to a sign.');
});

test('quotes, abbreviations, UTF-16 offsets and existing label output stay exact without interpreting embedded labels', () => {
  const visual = '🌱 Opening title: “The title: A. B. Example.” Caption: Dr. Example, 1972. End card: "Farewell"';
  const parsed = parsedAssemblyOverlays(visual);
  assert.deepEqual(parsed.map(row => row.text), ['The title: A. B. Example.', 'Dr. Example, 1972.', 'Farewell']);
  assert.deepEqual(parsed.map(row => row.style), ['Opening', 'Location', 'EndCard']);
  assert.equal(parsed[0].start, 3);
  assert.equal(visual.slice(parsed[0].start, parsed[0].end), 'Opening title: “The title: A. B. Example.”');
  assert.equal(remainingDirection(visual), '🌱   ');
  assert.deepEqual(parsedAssemblyOverlays(null), []); assert.deepEqual(parsedAssemblyOverlays('x'.repeat(20001)), []);
});
