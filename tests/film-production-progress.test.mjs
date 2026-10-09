import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const helperUrl = moduleUrl(compile(await readFile(new URL('../src/studio/film-production-progress.ts', import.meta.url), 'utf8')));
const { filmProductionProgress, normalizeFilmProgress } = await import(helperUrl);
const source = compile(await readFile(new URL('../src/studio/FilmProductionProgress.tsx', import.meta.url), 'utf8'))
  .replace(/import "\.\/film-production-progress\.css";\s*/g, '')
  .replaceAll('from "./film-production-progress"', `from "${helperUrl}"`)
  .replaceAll('from "react"', `from "${pathToFileURL(require.resolve('react')).href}"`)
  .replaceAll('from "react/jsx-runtime"', `from "${pathToFileURL(require.resolve('react/jsx-runtime')).href}"`);
const { default: FilmProductionProgress } = await import(moduleUrl(source));
const NOW = Date.parse('2026-10-08T12:00:00Z'), input = { paid: true, ready: false, now: NOW };
const time = seconds => new Date(NOW + seconds * 1000).toISOString();
const progress = () => ({ version: 1, stage: 'creating', percent: 42, basis: 'measured-estimate', timing: 'available',
  asOf: time(0), observedAt: time(-15), completedScenes: 2, totalScenes: 5,
  estimate: { earliestAt: time(600), latestAt: time(900), sampleCount: 8 } });

test('measured delivery range and ongoing percentage render together without exposing the supplier', () => {
  const html = renderToStaticMarkup(React.createElement(FilmProductionProgress, { ...input, progress: progress() }));
  assert.match(html, /42%/); assert.match(html, /About 10–15 minutes remaining/); assert.match(html, /Delivery window:/);
  assert.match(html, /aria-current="step"/); assert.match(html, /Last production update/);
  assert.doesNotMatch(html, /MagicLight|provider|credits|API|task.id/i);
});
test('unverified and stale timing never produces a fake countdown', () => {
  const unknown = filmProductionProgress({ ...input, status: 'processing' });
  assert.equal(unknown.percent, 10); assert.equal(unknown.estimate, null);
  assert.equal(filmProductionProgress({ ...input, status: 'processing', now: NOW + 1000000 }).percent, 10);
  const stale = filmProductionProgress({ ...input, progress: progress(), now: NOW + 601000 });
  assert.equal(stale.percent, 42); assert.equal(stale.timing, 'stale'); assert.equal(stale.estimate, null);
  const delayed = filmProductionProgress({ ...input, progress: { ...progress(), asOf: time(900) }, now: NOW + 900000 });
  assert.equal(delayed.timing, 'delayed'); assert.equal(delayed.estimate, null); assert.doesNotMatch(delayed.remaining, /0 minutes/);
});
test('only independently verified playback reaches one hundred percent', () => {
  const completed = { ...progress(), stage: 'ready', percent: 100, timing: 'complete', estimate: null };
  assert.equal(filmProductionProgress({ ...input, progress: completed }).percent, 99);
  assert.equal(filmProductionProgress({ ...input, progress: completed }).stageKey, 'finishing');
  assert.equal(filmProductionProgress({ ...input, progress: completed, ready: true }).percent, 100);
  assert.equal(filmProductionProgress({ ...input, status: 'completed' }).percent, 90);
});
test('attention states stay paused even when a stale percentage exists', () => {
  const html = renderToStaticMarkup(React.createElement(FilmProductionProgress, { ...input, progress: progress(), needsAttention: true }));
  assert.match(html, /Delivery estimate paused/); assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /<progress|aria-valuenow|42%|Delivery window:/);
  assert.match(html, /do not need to pay again/);
  assert.equal(renderToStaticMarkup(React.createElement(FilmProductionProgress, { ...input, paid: false })), '');
});
test('invalid timing and percentages fail closed to stage-based progress', () => {
  for (const patch of [{ percent: 101 }, { percent: -1 }, { percent: NaN }, { stage: 'secret' }, { observedAt: 'bad' },
    { estimate: { ...progress().estimate, sampleCount: 1 } }, { estimate: { ...progress().estimate, latestAt: 'bad' } },
    { estimate: null }, { totalScenes: 1 }]) assert.equal(normalizeFilmProgress({ ...progress(), ...patch }), null);
  const safe = normalizeFilmProgress({ ...progress(), providerKey: 'PRIVATE', taskId: 'PRIVATE' });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE/);
});
test('confirmed scene completions advance progress without timing history', () => {
  assert.equal(filmProductionProgress({ ...input, status: 'processing', completedShots: 5, shotCount: 10 }).percent, 47);
  assert.equal(filmProductionProgress({ ...input, status: 'processing', completedShots: 10, shotCount: 10 }).percent, 85);
});
