import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const modelUrl = moduleUrl(compile(await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8")));
const helperUrl = moduleUrl(compile(await readFile(new URL("../src/studio/film-library.ts", import.meta.url), "utf8")));
const helpers = await import(helperUrl);
const { newFilm, normalizeFilm } = await import(modelUrl);
const manifest = { filmId: "browser-draft-1", title: "The orchard", targetDurationSeconds: 120,
  screenplay: { scenes: [{ title: "A shared harvest", narration: "A family gathers.", visual: "An orchard at dusk.", dialogue: "Welcome home." }] } };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function entry(patch = {}) {
  return { kind: "plan", id: "11111111-1111-4111-8111-111111111111", filmId: manifest.filmId, title: manifest.title, durationSeconds: 120,
    createdAt: "2026-09-24T06:00:00.000Z", updatedAt: "2026-09-24T06:00:00.000Z", libraryState: "active", revision: 0,
    production: { status: "prepared", completedShots: 0, shotCount: 12, mediaReady: false, needsAttention: false },
    payments: [{ id: "a".repeat(64), status: "captured", amountCents: 330, refundedCents: 0, currency: "USD", sandbox: false, requiresReview: false, receiptAvailable: true }],
    manifestHash: hash(manifest), ...patch };
}
test("saved versions sharing a browser film stay separate and pagination replaces only the exact version", () => {
  const first = helpers.normalizeLibraryEntry(entry());
  const second = helpers.normalizeLibraryEntry(entry({ id: "22222222-2222-4222-8222-222222222222", manifestHash: "b".repeat(64) }));
  const upload = helpers.normalizeLibraryEntry(entry({ kind: "upload", manifestHash: undefined, payments: [] }));
  assert.equal(helpers.mergeLibraryPages([first], [second, upload]).length, 3);
  assert.equal(helpers.mergeLibraryPages([first, second], [{ ...first, revision: 1 }]).length, 2);
  assert.equal(helpers.mergeLibraryPages([first], [{ ...first, revision: 1 }])[0].revision, 1);
});
test("paid and queued films stay distinct from watchable media", () => {
  const paid = helpers.normalizeLibraryEntry(entry());
  assert.equal(helpers.paymentLabel(paid.payments[0]), "Paid");
  assert.equal(helpers.productionLabel(paid), "Prepared");
  assert.equal(paid.mediaUrl, undefined);
  assert.equal(helpers.productionLabel({ ...paid, production: { ...paid.production, status: "queued" } }), "Queued");
  assert.equal(helpers.productionLabel({ ...paid, production: { ...paid.production, status: "completed" } }), "Delivery pending");
  assert.equal(helpers.paymentLabel({ ...paid.payments[0], status: "awaiting-payment", receiptAvailable: false }), "Payment pending");
  assert.equal(helpers.paymentLabel({ ...paid.payments[0], requiresReview: true }), "Payment needs review");
});
test("watch and download require exact same-origin paths bound to the ready version", () => {
  const ready = entry({ production: { status: "completed", completedShots: 12, shotCount: 12, mediaReady: true, needsAttention: false } });
  ready.mediaUrl = helpers.libraryMediaUrl(ready); ready.downloadUrl = helpers.libraryMediaUrl(ready, true);
  assert.equal(helpers.productionLabel(helpers.normalizeLibraryEntry(ready)), "Ready to watch");
  for (const patch of [{ mediaUrl: "https://cdn.example/film.mp4" }, { mediaUrl: ready.mediaUrl + "&owner=other@example.test" },
    { downloadUrl: ready.mediaUrl }, { mediaUrl: ready.mediaUrl.replace(ready.id, "22222222-2222-4222-8222-222222222222") },
    { production: { ...ready.production, status: "queued" } }, { production: { ...ready.production, mediaReady: false } }]) {
    assert.throws(() => helpers.normalizeLibraryEntry({ ...ready, ...patch }));
  }
  const upload = entry({ kind: "upload", payments: [], manifestHash: undefined, production: { status: "prepared", completedShots: 0, shotCount: 0, mediaReady: false, needsAttention: false } });
  assert.equal(helpers.normalizeLibraryEntry(upload).production.mediaReady, false);
});
test("filtered pages retain their cursor and reject mixed states or duplicate identities", () => {
  assert.deepEqual(helpers.normalizeLibraryPage({ entries: [], cursor: "continue-to-uploads" }, "active"), { entries: [], cursor: "continue-to-uploads" });
  assert.throws(() => helpers.normalizeLibraryPage({ entries: [entry({ libraryState: "trash" })] }, "active"));
  assert.throws(() => helpers.normalizeLibraryPage({ entries: [entry(), entry()] }, "active"));
});
test("saved plan review verifies immutable version and content before showing screenplay", async () => {
  const expected = helpers.normalizeLibraryEntry(entry());
  const response = { entry: entry(), manifest: { id: expected.id, manifestHash: expected.manifestHash, manifest } };
  const result = await helpers.verifyLibraryDetail(response, expected);
  assert.equal(result.scenes[0].narration, manifest.screenplay.scenes[0].narration);
  await assert.rejects(() => helpers.verifyLibraryDetail({ ...response, entry: entry({ id: "22222222-2222-4222-8222-222222222222" }) }, expected));
  await assert.rejects(() => helpers.verifyLibraryDetail({ ...response, manifest: { ...response.manifest, manifest: { ...manifest, title: "Changed after payment" } } }, expected));
  await assert.rejects(() => helpers.verifyLibraryDetail({ ...response, manifest: { ...response.manifest, id: "another-version" } }, expected));
});
test("organization requests contain only version identity and revision, with verified readback", () => {
  const previous = helpers.normalizeLibraryEntry(entry());
  assert.deepEqual(helpers.libraryActionRequest(previous, "trash"), { action: "trash", kind: "plan", id: previous.id, expectedRevision: 0 });
  const changed = { entry: entry({ libraryState: "trash", revision: 1 }) };
  assert.equal(helpers.normalizeLibraryAction(changed, previous, "trash").libraryState, "trash");
  assert.throws(() => helpers.normalizeLibraryAction({ entry: entry({ libraryState: "trash" }) }, previous, "trash"));
  assert.throws(() => helpers.normalizeLibraryAction(changed, previous, "archive"));
  assert.throws(() => helpers.libraryActionRequest(previous, "delete"));
});
test("local trash and restore preserve source, payment, output, and draft identity", () => {
  const original = { ...newFilm(), title: "Local version", script: "Unsaved draft text", sources: [{ id: "source-1", name: "Letter", type: "text/plain", size: 20 }], outputId: "existing-video" };
  const trashed = { ...original, ...helpers.localLibraryPatch("trash") };
  assert.equal(helpers.localLibraryState(trashed), "trash");
  assert.equal(trashed.id, original.id); assert.equal(trashed.script, original.script); assert.deepEqual(trashed.sources, original.sources);
  const restored = normalizeFilm({ ...trashed, ...helpers.localLibraryPatch("restore") });
  assert.equal(helpers.localLibraryState(restored), "active"); assert.equal(restored.outputId, original.outputId);
});
test("signed-in landing is the library while administration deep links retain role checks", () => {
  for (const role of ["customer", "admin", "owner"]) assert.equal(helpers.initialWorkspaceView("", role), "library");
  assert.equal(helpers.initialWorkspaceView("#admin/payments", "owner"), "admin");
  assert.equal(helpers.initialWorkspaceView("#admin/payments", "customer"), "library");
  assert.equal(helpers.initialWorkspaceView("#create", "customer"), "create");
});
async function libraryComponents() {
  let source = compile(await readFile(new URL("../src/studio/FilmLibrary.tsx", import.meta.url), "utf8"));
  source = source.replace(/import "\.\/film-library\.css";\s*/g, "");
  for (const name of ["react", "react/jsx-runtime", "lucide-react"]) source = source.replaceAll(`from "${name}"`, `from "${pathToFileURL(require.resolve(name)).href}"`);
  source = source.replaceAll('from "./model"', `from "${modelUrl}"`).replaceAll('from "./film-library"', `from "${helperUrl}"`);
  return import(moduleUrl(source));
}

test("library renders accessible navigation, a primary creation action and honest browser draft scope", async () => {
  const { default: FilmLibrary } = await libraryComponents();
  const html = renderToStaticMarkup(React.createElement(FilmLibrary, { projects: [{ ...newFilm(), title: "A browser-only draft" }], disabled: false,
    onCreate() {}, onOpenDraft() {}, onLocalAction() {}, onBusyChange() {}, async onCreateVersion() {} }));
  assert.match(html, /<h1>Your film library<\/h1>/);
  assert.match(html, /aria-label="Film library views"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /Create film<\/button>/);
  assert.match(html, /A browser-only draft/); assert.match(html, /Saved in this browser/);
  assert.doesNotMatch(html, /MagicLight|QuickBooks|Vercel|api key/i);
  assert.doesNotMatch(html, />Watch film<|>Download film</);
  assert.doesNotMatch(html, /Create new version/);
});

test("new-version action is limited to a saved plan with its verified manifest", async () => {
  const { SavedPlanVersionAction } = await libraryComponents();
  let calls = 0;
  const onCreateVersion = async () => { calls++; };
  for (const detail of [{ entry: entry() }, { entry: entry({ kind: "upload" }), manifest }]) {
    assert.equal(renderToStaticMarkup(React.createElement(SavedPlanVersionAction, { detail, disabled: false, onCreateVersion })), "");
  }
  const detail = { entry: entry(), manifest, sourceNames: ["A family letter.doc", "<img src=x onerror=alert(1)>.jpg"] };
  const html = renderToStaticMarkup(React.createElement(SavedPlanVersionAction, { detail, disabled: false, onCreateVersion }));
  assert.match(html, /Create new version<\/button>/);
  assert.match(html, /saved screenplay as its source/);
  assert.match(html, /Original uploads are not copied/);
  assert.match(html, /original payment stays with this saved plan/);
  assert.match(html, /choose its running time/);
  assert.match(html, /Original source filenames \(2\)/);
  assert.match(html, /A family letter.doc/);
  assert.match(html, /Add the original files separately/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.jpg/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal(calls, 0, "Displaying the action must not create a draft or accept any consent.");
});

test("new-version action respects the shared busy state and dispatches only the selected immutable entry", async () => {
  const { SavedPlanVersionAction } = await libraryComponents();
  const detail = { entry: entry(), manifest }, before = structuredClone(detail), calls = [];
  const onCreateVersion = async value => { calls.push(value); };
  const disabled = renderToStaticMarkup(React.createElement(SavedPlanVersionAction, { detail, disabled: true, onCreateVersion }));
  assert.match(disabled, /<button[^>]*type="button"[^>]*disabled=""/);
  const element = SavedPlanVersionAction({ detail, disabled: false, onCreateVersion });
  const button = React.Children.toArray(element.props.children).find(child => child.type === "button");
  button.props.onClick();
  assert.deepEqual(calls, [detail.entry]);
  assert.deepEqual(detail, before);
});
