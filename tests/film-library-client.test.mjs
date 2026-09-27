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
const fulfillmentUrl = moduleUrl(compile(await readFile(new URL("../src/studio/film-fulfillment.ts", import.meta.url), "utf8")));
const generationStatusUrl = moduleUrl("export default function FilmGenerationStatus() { return null; }");
const progressHelperUrl = moduleUrl(compile(await readFile(new URL("../src/studio/film-production-progress.ts", import.meta.url), "utf8")));
const progressSource = compile(await readFile(new URL("../src/studio/FilmProductionProgress.tsx", import.meta.url), "utf8"))
  .replace(/import "\.\/film-production-progress\.css";\s*/g, "")
  .replaceAll('from "./film-production-progress"', `from "${progressHelperUrl}"`)
  .replaceAll('from "react/jsx-runtime"', `from "${pathToFileURL(require.resolve("react/jsx-runtime")).href}"`);
const progressComponentUrl = moduleUrl(progressSource);
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
  assert.equal(helpers.productionLabel(paid), "Not started");
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

test("film status links identify one immutable plan with no query or URL ambiguity", () => {
  const id = entry().id, link = helpers.libraryFilmLink(id);
  assert.equal(link, `#library?film=${id}`);
  assert.deepEqual(helpers.parseLibraryFilmLink(link), { kind: "plan", id });
  assert.throws(() => helpers.libraryFilmLink("browser-draft-1"));
  for (const invalid of ["#library", `#library?film=${id}&film=${id}`, `#library?film=${id}&kind=upload`,
    `#library?film=${id}%20`, `#library?film=${id}#other`, `https://example.test/${link}`, "#library?film=../../private", `#library?film=${id}\n`]) {
    assert.equal(helpers.parseLibraryFilmLink(invalid), null, invalid);
  }
});

test("a linked paid film loads directly even when it is not on the first library page", async () => {
  const expected = helpers.normalizeLibraryEntry(entry()), requests = [];
  const response = { entry: entry(), manifest: { id: expected.id, manifestHash: expected.manifestHash, manifest } };
  const detail = await helpers.loadLibraryLinkedFilm(helpers.libraryFilmLink(expected.id), async path => { requests.push(path); return response; });
  assert.deepEqual(requests, [`/api/library?action=detail&kind=plan&id=${expected.id}`]);
  assert.equal(detail.entry.id, expected.id);
  assert.equal(detail.scenes[0].narration, manifest.screenplay.scenes[0].narration);
  assert.equal(detail.entry.payments[0].status, "captured");
  assert.equal(helpers.libraryCanWatch(detail.entry), false, "A paid saved plan is not a produced video.");
});

test("invalid, denied, missing or mismatched film links never open a substitute film", async () => {
  const expected = entry(), other = "22222222-2222-4222-8222-222222222222", requests = [];
  await assert.rejects(() => helpers.loadLibraryLinkedFilm("#library?film=invalid", async path => { requests.push(path); }));
  assert.deepEqual(requests, []);
  for (const response of [null, { entry: entry({ id: other }) }, { entry: entry({ kind: "upload", manifestHash: undefined }) },
    { entry: expected, manifest: { id: expected.id, manifestHash: expected.manifestHash, manifest: { ...manifest, title: "Substituted story" } } }]) {
    await assert.rejects(() => helpers.loadLibraryLinkedFilm(helpers.libraryFilmLink(expected.id), async path => { requests.push(path); return response; }));
  }
  let deniedRequests = 0;
  await assert.rejects(() => helpers.loadLibraryLinkedFilm(helpers.libraryFilmLink(expected.id), async () => { deniedRequests++; throw new Error("Not found or access denied"); }), /Not found or access denied/);
  assert.equal(deniedRequests, 1, "Denied links must not fall back to a list or another film.");
  assert.ok(requests.every(path => path === `/api/library?action=detail&kind=plan&id=${expected.id}`));
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
  source = source.replaceAll('from "./film-fulfillment"', `from "${fulfillmentUrl}"`).replaceAll('from "./FilmGenerationStatus"', `from "${generationStatusUrl}"`);
  source = source.replaceAll('from "./FilmProductionProgress"', `from "${progressComponentUrl}"`);
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

test("paid saved plan status confirms payment without claiming a completed video", async () => {
  const { LibraryFilmStatus } = await libraryComponents();
  const html = renderToStaticMarkup(React.createElement(LibraryFilmStatus, { entry: helpers.normalizeLibraryEntry(entry()), productionAvailable: false }));
  assert.match(html, /Paid · \$3\.30/);
  assert.match(html, /Not started/);
  assert.match(html, /Payment is confirmed/);
  assert.match(html, /Your video has not been created yet/);
  assert.match(html, /Film creation is currently unavailable/);
  assert.match(html, /You do not need to pay again/);
  assert.match(html, /Get help with this paid film/);
  assert.match(html, /Estimated time remaining: Unavailable/);
  assert.match(html, /Estimated progress/);
  assert.match(html, /<span>0%<\/span>/);
  assert.match(html, /frame-by-frame production percentage is not available/);
  assert.doesNotMatch(html, /Ready to watch|video is complete|>Watch film<|>Download film<|MagicLight|QuickBooks/i);
  const unknown = renderToStaticMarkup(React.createElement(LibraryFilmStatus, { entry: helpers.normalizeLibraryEntry(entry()) }));
  assert.doesNotMatch(unknown, /Film creation is currently unavailable/);
});

test("generation status controls require capability and exactly one eligible real payment", async () => {
  const { LibraryGenerationStatus, LibraryFilmStatus } = await libraryComponents();
  const value = helpers.normalizeLibraryEntry(entry());
  assert.equal(LibraryGenerationStatus({ entry: value, allowed: false }), null);
  const element = LibraryGenerationStatus({ entry: value, allowed: true });
  assert.deepEqual(element.props, { preparedId: value.id, manifestHash: value.manifestHash, filmId: value.filmId,
    orderId: value.payments[0].id, allowed: true });
  for (const patch of [{ sandbox: true }, { requiresReview: true }, { refundedCents: 1 }, { receiptAvailable: false },
    { status: "awaiting-payment" }, { status: "uncertain" }, { status: "refunded" }]) {
    assert.equal(LibraryGenerationStatus({ entry: { ...value, payments: [{ ...value.payments[0], ...patch }] }, allowed: true }), null);
  }
  assert.equal(LibraryGenerationStatus({ entry: { ...value, kind: "upload" }, allowed: true }), null);
  assert.equal(LibraryGenerationStatus({ entry: { ...value, payments: [value.payments[0], { ...value.payments[0], id: "b".repeat(64) }] }, allowed: true }), null);
  const html = renderToStaticMarkup(React.createElement(LibraryFilmStatus, { entry: value, productionAvailable: false, generationAttemptAllowed: true }));
  assert.match(html, /See generation status/);
  assert.match(html, /Your video has not been created yet/);
  assert.doesNotMatch(html, /Film creation is currently unavailable|Estimated time remaining|Not started|Ready to watch/);
});

test("only verified playable delivery receives a ready-to-watch status", async () => {
  const { LibraryFilmStatus } = await libraryComponents();
  const value = entry({ production: { status: "completed", completedShots: 12, shotCount: 12, mediaReady: true, needsAttention: false } });
  value.mediaUrl = helpers.libraryMediaUrl(value); value.downloadUrl = helpers.libraryMediaUrl(value, true);
  const ready = helpers.normalizeLibraryEntry(value);
  assert.equal(helpers.libraryCanWatch(ready), true);
  const html = renderToStaticMarkup(React.createElement(LibraryFilmStatus, { entry: ready, productionAvailable: false }));
  assert.match(html, /Ready to watch/);
  assert.match(html, /Your video is complete and ready to watch or download/);
  assert.doesNotMatch(html, /Film creation is currently unavailable|has not been created/);
  for (const patch of [{ downloadUrl: undefined }, { mediaUrl: "https://example.test/wrong.mp4" },
    { production: { ...ready.production, status: "prepared" } }, { production: { ...ready.production, mediaReady: false } }]) {
    assert.equal(helpers.libraryCanWatch({ ...ready, ...patch }), false);
  }
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
