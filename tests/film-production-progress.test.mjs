import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const helperUrl = moduleUrl(compile(await readFile(new URL("../src/studio/film-production-progress.ts", import.meta.url), "utf8")));
const { filmProductionProgress } = await import(helperUrl);
const source = compile(await readFile(new URL("../src/studio/FilmProductionProgress.tsx", import.meta.url), "utf8"))
  .replace(/import "\.\/film-production-progress\.css";\s*/g, "")
  .replaceAll('from "./film-production-progress"', `from "${helperUrl}"`)
  .replaceAll('from "react/jsx-runtime"', `from "${pathToFileURL(require.resolve("react/jsx-runtime")).href}"`);
const { default: FilmProductionProgress } = await import(moduleUrl(source));
const input = { paid: true, ready: false };

test("production percentages are stable estimates of confirmed workflow stages", () => {
  for (const [status, percent] of [["prepared", 0], ["not-started", 0], ["queued", 10], ["submitting", 10], ["submitted", 10], ["processing", 20], ["verifying", 85], ["completed", 85]]) {
    const result = filmProductionProgress({ ...input, status });
    assert.equal(result.percent, percent);
    assert.equal(result.label, "Estimated progress");
    assert.match(result.explanation, /frame-by-frame production percentage is not available/);
    assert.deepEqual(filmProductionProgress({ ...input, status, elapsedSeconds: 86400 }), result, "Elapsed time cannot invent production progress.");
  }
});

test("verified shot counts advance an estimate without claiming full delivery", () => {
  const partial = filmProductionProgress({ ...input, status: "processing", completedShots: 5, shotCount: 10 });
  assert.equal(partial.percent, 50);
  assert.match(partial.stage, /5 of 10 shots complete/);
  assert.equal(filmProductionProgress({ ...input, status: "processing", completedShots: 10, shotCount: 10 }).percent, 80);
  for (const counts of [{ completedShots: 20, shotCount: 10 }, { completedShots: -1, shotCount: 10 },
    { completedShots: 1.5, shotCount: 10 }, { completedShots: 1, shotCount: 0 }, { completedShots: NaN, shotCount: 10 }]) {
    assert.equal(filmProductionProgress({ ...input, status: "processing", ...counts }).percent, 20);
  }
});

test("actual reported percentages take precedence but only verified playback permits 100 percent", () => {
  const actual = filmProductionProgress({ ...input, status: "processing", reportedPercent: 63 });
  assert.equal(actual.percent, 63);
  assert.equal(actual.label, "Reported progress");
  assert.equal(filmProductionProgress({ ...input, status: "completed", reportedPercent: 100 }).percent, 99);
  assert.equal(filmProductionProgress({ ...input, status: "completed", ready: true }).percent, 100);
  assert.equal(filmProductionProgress({ ...input, status: "completed" }).percent, 85);
  for (const reportedPercent of [-1, 101, Infinity, NaN, "100"]) {
    assert.equal(filmProductionProgress({ ...input, status: "processing", reportedPercent }).percent, 20);
  }
});

test("failed, uncertain and unknown states remain indeterminate without a completion claim", () => {
  for (const status of ["failed", "uncertain", "unexpected", undefined, null]) {
    const result = filmProductionProgress({ ...input, status, reportedPercent: 100 });
    assert.equal(result.percent, null);
    assert.doesNotMatch(result.stage, /ready to watch/);
  }
});

test("progress UI is accessible, hidden before payment and honest about incomplete output", () => {
  assert.equal(renderToStaticMarkup(React.createElement(FilmProductionProgress, { ...input, paid: false, status: "prepared" })), "");
  const working = renderToStaticMarkup(React.createElement(FilmProductionProgress, { ...input, status: "processing" }));
  assert.match(working, /Estimated progress/);
  assert.match(working, /<span>20%<\/span>/);
  assert.match(working, /<progress[^>]*max="100"[^>]*value="20"/);
  assert.match(working, /aria-valuetext="20% · Creating your film"/);
  assert.doesNotMatch(working, /MagicLight|provider|api|frames rendered|time remaining/i);
  const unknown = renderToStaticMarkup(React.createElement(FilmProductionProgress, { ...input, status: "uncertain" }));
  assert.match(unknown, /Not available/);
  assert.match(unknown, /<progress/);
  assert.doesNotMatch(unknown, /value="[0-9]+"/);
  const ready = renderToStaticMarkup(React.createElement(FilmProductionProgress, { ...input, status: "completed", ready: true }));
  assert.match(ready, /<span>100%<\/span>/);
  assert.match(ready, /Complete — ready to watch/);
});
