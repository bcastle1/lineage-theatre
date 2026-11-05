import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function load(path) {
  const source = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { startLibraryRefresh } = await load('../src/studio/library-refresh.ts');
const { libraryRefreshDelay, libraryMediaUrl, productionLabel, loadLibraryWindow } = await load('../src/studio/film-library.ts');
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function entry(number = 1, production = {}) {
  return { kind: 'plan', id: `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`, filmId: `film-${number}`,
    title: 'Fictional test film', durationSeconds: 15, manifestHash: 'a'.repeat(64),
    createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-05T12:00:00Z', libraryState: 'active', revision: 0, payments: [],
    production: { status: 'processing', completedShots: 1, shotCount: 3, mediaReady: false, needsAttention: false, ...production } };
}
function ready(number = 1) {
  const value = entry(number, { status: 'completed', completedShots: 3, mediaReady: true });
  return { ...value, mediaUrl: libraryMediaUrl(value), downloadUrl: libraryMediaUrl(value, true) };
}
function clock() {
  let now = 0, next = 0;
  const pending = new Map(), focusTarget = new EventTarget(), visibilityTarget = new EventTarget();
  return { focusTarget, visibilityTarget, pending,
    schedule: (callback, delay) => { const id = ++next; pending.set(id, { at: now + delay, callback }); return id; },
    cancel: id => pending.delete(id),
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; pending.delete(next[0]); next[1].callback(); await settle();
      }
      now = target; await settle();
    },
  };
}

test('labels prioritize verified playback, attention, reconciliation and finishing without inventing readiness', () => {
  const finishing = entry(1, { progress: { version: 1, stage: 'finishing' } });
  assert.equal(productionLabel(finishing), 'Finishing checks');
  assert.equal(productionLabel({ ...finishing, production: { ...finishing.production, needsAttention: true } }), 'Needs attention');
  assert.equal(productionLabel(entry(1, { status: 'failed', progress: { version: 1, stage: 'finishing' } })), 'Failed');
  for (const status of ['prepared', 'processing', 'uncertain'])
    assert.equal(productionLabel(entry(1, { status, progress: { version: 1, stage: 'reconciling' } })), 'Checking status');
  assert.equal(productionLabel(entry(1, { status: 'uncertain' })), 'Status needs review');
  assert.equal(productionLabel(entry(1, { progress: { version: 1, stage: 'ready' } })), 'Rendering');
  assert.equal(productionLabel(entry(1, { progress: { version: 99, stage: 'finishing' } })), 'Rendering');
  const complete = ready(); complete.production.needsAttention = true;
  assert.equal(productionLabel(complete), 'Ready to watch');
  complete.downloadUrl = '/wrong-film';
  assert.equal(productionLabel(complete), 'Needs attention');
});

test('active films use ten-second checks while idle lists retain sixty-second checks', () => {
  for (const status of ['queued', 'submitting', 'processing', 'uncertain', 'completed', 'uploaded']) assert.equal(libraryRefreshDelay([entry(1, { status })]), 10_000);
  for (const value of [ready(), entry(1, { needsAttention: true }), entry(1, { status: 'failed' }), entry(1, { status: 'prepared' })])
    assert.equal(libraryRefreshDelay([value]), 60_000);
  const paid = entry(1, { status: 'prepared' });
  paid.payments = [{ id: 'b'.repeat(64), status: 'captured', sandbox: false, requiresReview: false, refundedCents: 0, receiptAvailable: true }];
  assert.equal(libraryRefreshDelay([paid]), 10_000);
  assert.equal(libraryRefreshDelay([ready(), entry()]), 10_000);
  assert.equal(libraryRefreshDelay([ready()], 30_000), 30_000);
  for (const status of ['completed', 'uploaded']) {
    assert.equal(libraryRefreshDelay([entry(1, { status, needsAttention: true })]), 60_000);
    assert.equal(libraryRefreshDelay([entry(1, { status, needsAttention: true })], 30_000), 30_000);
  }
  const missingPrivateUrl = ready(); delete missingPrivateUrl.downloadUrl;
  assert.equal(libraryRefreshDelay([missingPrivateUrl]), 10_000);
});

test('a delivered film becomes visible at the next active interval without a manual refresh', async () => {
  const timer = clock(); let shown = entry(), calls = 0;
  const stop = startLibraryRefresh({ ...timer, intervalMs: libraryRefreshDelay([shown]), canRefresh: () => true,
    refresh: async () => { calls++; shown = ready(); } });
  await timer.advance(9_999); assert.equal(calls, 0); assert.equal(shown.production.mediaReady, false);
  await timer.advance(1); assert.equal(calls, 1); assert.equal(productionLabel(shown), 'Ready to watch');
  stop(); assert.equal(timer.pending.size, 0);
});

test('focus and visibility return refresh immediately while hidden or conflicting actions do not fetch', async () => {
  const timer = clock(); let visible = false, blocked = false, calls = 0;
  const stop = startLibraryRefresh({ ...timer, intervalMs: 60_000, canRefresh: () => visible && !blocked,
    refresh: async () => { calls++; } });
  await timer.advance(60_000); assert.equal(calls, 0);
  timer.focusTarget.dispatchEvent(new Event('focus')); await settle(); assert.equal(calls, 0);
  visible = true; timer.visibilityTarget.dispatchEvent(new Event('visibilitychange')); await settle(); assert.equal(calls, 1);
  blocked = true; timer.focusTarget.dispatchEvent(new Event('focus')); await settle(); assert.equal(calls, 1);
  blocked = false; timer.focusTarget.dispatchEvent(new Event('focus')); await settle(); assert.equal(calls, 2);
  stop();
});

test('slow reads cannot overlap across timers and return events, and cleanup cannot restart polling', async () => {
  const timer = clock(); let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const stop = startLibraryRefresh({ ...timer, intervalMs: 10_000, canRefresh: () => true,
    refresh: async () => { calls++; await pending; } });
  await timer.advance(10_000); assert.equal(calls, 1);
  timer.focusTarget.dispatchEvent(new Event('focus')); timer.visibilityTarget.dispatchEvent(new Event('visibilitychange'));
  await timer.advance(30_000); assert.equal(calls, 1); assert.equal(timer.pending.size, 0);
  stop(); release(); await settle(); assert.equal(timer.pending.size, 0);
  timer.focusTarget.dispatchEvent(new Event('focus')); await timer.advance(60_000); assert.equal(calls, 1);
});

test('a failed status read preserves confirmed data and a later scheduled read can recover', async () => {
  const timer = clock(); let shown = entry(), attempts = 0, errors = 0;
  const original = shown;
  const stop = startLibraryRefresh({ ...timer, intervalMs: 10_000, canRefresh: () => true,
    refresh: async () => { try { if (++attempts === 1) throw Error('temporary'); shown = ready(); } catch { errors++; } } });
  await timer.advance(10_000); assert.equal(shown, original); assert.equal(errors, 1);
  await timer.advance(10_000); assert.equal(productionLabel(shown), 'Ready to watch'); stop();
});

test('background window refresh preserves all loaded pages until the complete replacement is verified', async () => {
  let shown = [entry(1), entry(2)], release;
  const original = shown, calls = [];
  const waiting = new Promise(resolve => { release = resolve; });
  const read = async path => {
    calls.push(path);
    if (!path.includes('cursor=')) return { entries: [ready(1)], cursor: 'second-page' };
    await waiting; return { entries: [ready(2)], cursor: 'third-page' };
  };
  const refreshing = loadLibraryWindow('active', read, 2).then(page => { shown = page.entries; return page; });
  await settle(); assert.equal(shown, original); assert.equal(shown.length, 2);
  release(); const page = await refreshing;
  assert.deepEqual(shown.map(productionLabel), ['Ready to watch', 'Ready to watch']);
  assert.equal(page.cursor, 'third-page'); assert.equal(page.pageCount, 2);
  assert.deepEqual([...page.cursors], ['second-page']);
  assert.deepEqual(calls, ['/api/library?view=active', '/api/library?view=active&cursor=second-page']);
});

test('empty pages lead to delivered films and repeated cursors or invalid pages never replace confirmed data', async () => {
  const page = await loadLibraryWindow('active', async path => path.includes('cursor=') ? { entries: [ready()] } : { entries: [], cursor: 'uploads' });
  assert.equal(page.entries.length, 1); assert.equal(page.pageCount, 2);
  await assert.rejects(loadLibraryWindow('active', async () => ({ entries: [], cursor: 'repeat' })), /page repeated/);
  let shown = [entry()], previous = shown;
  await assert.rejects(loadLibraryWindow('active', async () => ({ entries: [ready(1)], cursor: 123 })).then(page => { shown = page.entries; }));
  assert.equal(shown, previous);
});
