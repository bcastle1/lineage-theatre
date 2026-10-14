import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const dependency = name => pathToFileURL(require.resolve(name)).href;
const source = await readFile(new URL('../src/admin/MagicLightActivationCheck.tsx', import.meta.url), 'utf8');
function component(hooks = dependency('react')) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/from ['"]react['"]/g, `from ${JSON.stringify(hooks)}`)
    .replace(/from ['"]react\/jsx-runtime['"]/g, `from ${JSON.stringify(dependency('react/jsx-runtime'))}`)
    .replace(/from ['"]lucide-react['"]/g, `from ${JSON.stringify(dependency('lucide-react'))}`)
    .replace(/from ['"]\.\.\/studio\/model['"]/g, `from ${JSON.stringify(url('export function api(){throw new Error("No network in UI test")}'))}`);
}
const { normalizeActivationStatus: normalize } = await import(url(component()));
const state = test => ({ generationSubmitted: false, productionReady: false, test });
const pending = { status: 'submitted', submittedAt: '2026-10-08T22:45:52.309Z',
  checkedAt: '2026-10-14T18:00:00.000Z', providerCode: 10000, taskStatus: 1, finishedVideoAvailable: false };
async function markup(value, error = false) {
  const hooks = url(`import * as React from ${JSON.stringify(dependency('react'))};
    export const useRef=React.useRef,useEffect=React.useEffect;
    let index=0;export function useState(initial){const current=index++%3;return React.useState(current===0?${JSON.stringify(value)}:current===1?false:current===2?${error}:initial);}`);
  const { default: Component } = await import(url(component(hooks)));
  return renderToStaticMarkup(React.createElement(Component));
}

test('missing, pending and completed activation states provide only the saved-job check', async () => {
  for (const value of [state(null), state(pending), state({ ...pending, status: 'completed', taskStatus: 2, finishedVideoAvailable: true })]) {
    const html = await markup(normalize(value));
    assert.match(html, /Check October 8 job<\/button>/);
    assert.equal((html.match(/<button/g) || []).length, 1);
    assert.doesNotMatch(html, /<input|<video|href=|Start film generation|Generate one live test clip/);
    assert.match(html, /does not create a job/);
  }
  assert.match(await markup(state(null)), /No saved October 8 task was found/);
  assert.match(await markup(state(pending)), /No finished video is recorded/);
});

test('unconfirmed completion and invalid diagnostic responses are rejected', () => {
  for (const value of [null, {}, { ...state(pending), generationSubmitted: true },
    state({ ...pending, status: 'completed' }), state({ ...pending, finishedVideoAvailable: true }),
    state({ ...pending, checkedAt: 'invalid' }), state({ ...pending, code: 'https://private.example/token' })]) {
    assert.throws(() => normalize(value));
  }
});

test('failed checks retain saved evidence and provide a status-only recovery action', async () => {
  const html = await markup(state(pending), true);
  assert.match(html, /role="alert"/);
  assert.match(html, /No new job or customer payment was requested/);
  assert.match(html, /Last provider check/);
  assert.match(html, /Check October 8 job<\/button>/);
});
