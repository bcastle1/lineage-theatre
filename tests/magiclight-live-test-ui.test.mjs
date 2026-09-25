import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { MAGICLIGHT_LIVE_TEST_FIXTURE } from "../api/_lib/magiclight-live-test.mjs";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const dependency = name => pathToFileURL(require.resolve(name)).href;
const modelUrl = dataUrl(compile(await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8")));
const rawSource = await readFile(new URL("../src/admin/MagicLightLiveTest.tsx", import.meta.url), "utf8");
function compiledComponent(reactUrl = dependency("react")) {
  return compile(`${rawSource}\nexport { normalize, safeError, statusText };`)
    .replaceAll('from "react"', `from "${reactUrl}"`)
    .replaceAll('from "react/jsx-runtime"', `from "${dependency("react/jsx-runtime")}"`)
    .replaceAll('from "lucide-react"', `from "${dependency("lucide-react")}"`)
    .replaceAll('from "../studio/model"', `from "${modelUrl}"`);
}
const { normalize, safeError, statusText } = await import(dataUrl(compiledComponent()));
const { ApiError } = await import(modelUrl);
const saved = { id: "11111111-1111-4111-8111-111111111111", status: "completed", submissionCount: 1,
  createdAt: "2026-09-24T06:00:00.000Z", updatedAt: "2026-09-24T06:05:00.000Z", providerCode: 10000, taskStatus: 2 };
function state(patch = {}) {
  return { configured: true, productionReady: false, customerFulfillment: false,
    fixture: MAGICLIGHT_LIVE_TEST_FIXTURE, test: saved, ...patch };
}
async function markup(value) {
  // Exercise the actual component after its initial status request resolves.
  // Server rendering keeps effects and network requests inactive.
  const hooks = dataUrl(`import * as React from ${JSON.stringify(dependency("react"))};
    export const useRef=React.useRef,useEffect=React.useEffect;
    let index=0;export function useState(initial){const current=index++;return React.useState(current===0?${JSON.stringify(value)}:current===1?false:initial);}`);
  const { default: Component } = await import(dataUrl(compiledComponent(hooks)));
  return renderToStaticMarkup(React.createElement(Component));
}
test("old saved-test responses remain valid without media and never claim playback", () => {
  assert.equal(normalize(state()).media, undefined);
  assert.equal(normalize(state({ media: { ready: false } })).media.ready, false);
  assert.match(statusText("completed"), /Import the saved output/);
});
test("ready media is bound to a completed saved test and its public metadata is validated", () => {
  assert.equal(normalize(state({ media: { ready: true, sizeBytes: 2048, sha256: "a".repeat(64) } })).media.ready, true);
  for (const patch of [{ test: null }, { test: { ...saved, status: "submitted" } }, { test: { ...saved, status: "failed" } }]) {
    assert.throws(() => normalize(state({ ...patch, media: { ready: true } })));
  }
  for (const media of [null, {}, { ready: "true" }, { ready: true, sizeBytes: 0 }, { ready: true, sizeBytes: 1.5 },
    { ready: true, sha256: "secret-token" }, { ready: true, sha256: "a".repeat(63) }]) assert.throws(() => normalize(state({ media })));
});
test("completed clips offer import without another generation button", async () => {
  const html = await markup(normalize(state()));
  assert.match(html, /Import completed test clip<\/button>/);
  assert.match(html, /does not submit another generation request/);
  assert.doesNotMatch(html, /<video|Generate one live test clip<\/button>/);
  assert.match(html, /does not create a customer payment or fulfill a paid film/);
});
test("unfinished saved jobs offer only job checks and cannot expose import or playback", async () => {
  const html = await markup(normalize(state({ test: { ...saved, status: "submitted", taskStatus: 1 } })));
  assert.match(html, /Check saved job<\/button>/);
  assert.doesNotMatch(html, /Import completed test clip<\/button>|<video|Download test clip|Generate one live test clip<\/button>/);
});
test("saved clip playback and download use only the fixed private same-origin endpoint", async () => {
  const html = await markup(normalize(state({ media: { ready: true, sizeBytes: 2048, sha256: "a".repeat(64), url: "https://untrusted.example/private.mp4" } })));
  assert.match(html, /<video[^>]*controls=""[^>]*playsinline=""[^>]*preload="metadata"[^>]*src="\/api\/admin\?action=magicLightLiveTestMedia"/);
  assert.match(html, /aria-label="Fictional shipyard test clip player"/);
  assert.match(html, /href="\/api\/admin\?action=magicLightLiveTestMedia&amp;download=1"[^>]*download=""/);
  assert.match(html, /Actual test clip/);
  assert.match(html, /not the full paid film/);
  assert.match(html, /duration is unknown until the video metadata loads/);
  assert.doesNotMatch(html, /untrusted\.example|Import completed test clip<\/button>|Generate one live test clip<\/button>/);
});
test("raw provider errors never become owner-facing copy", () => {
  assert.deepEqual(safeError(new ApiError("secret URL and token", "MAGICLIGHT_MEDIA_IMPORT_FAILED", 502)), { code: "MAGICLIGHT_MEDIA_IMPORT_FAILED", httpStatus: 502 });
  assert.deepEqual(safeError(new Error("secret URL and token")), { code: "MAGICLIGHT_LIVE_TEST_CHECK_REQUIRED" });
});
