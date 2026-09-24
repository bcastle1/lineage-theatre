import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildFilmManifest, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import ts from "typescript";
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const modelUrl = moduleUrl(await compile("../src/studio/model.ts"));
const contractUrl = moduleUrl(await compile("../src/studio/checkout-contract.ts"));
const { loadPaidFilmPlan, paidPlanMatches, paidOrderMatches, paidFilmStartRequest } = await import(moduleUrl(
  (await compile("../src/studio/paid-film-plan.ts")).replace('"./model"', JSON.stringify(modelUrl)).replace('"./checkout-contract"', JSON.stringify(contractUrl))));

function fixture() {
  const manifest = { filmId: "fictional-film", title: "The paid two-minute film", targetDurationSeconds: 120,
    screenplay: { scenes: [{ title: "A fictional garden", narration: "A family shares a harvest.", visual: "An imaginary garden.", dialogue: "Welcome." }] } };
  const reference = { preparedId: "00000000-0000-4000-8000-000000000001", manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    quoteId: "a".repeat(64), orderId: "b".repeat(64), checkoutKey: "saved-checkout-identity", submittedAt: "2026-09-24T00:00:00Z", sandbox: false };
  const order = { id: reference.orderId, quoteId: reference.quoteId, preparedId: reference.preparedId, filmId: manifest.filmId,
    status: "captured", amountCents: 3000, refundedCents: 0, charged: true, receiptAvailable: true, requiresReview: false, sandbox: false };
  const calls = [], response = { id: reference.preparedId, manifestHash: reference.manifestHash, manifest };
  const request = async (path, body) => { calls.push({ path, body }); return structuredClone(response); };
  return { reference, order, response, calls, request, filmId: manifest.filmId };
}

test("a changed draft reviews and starts only its immutable paid version without another payment", async () => {
  const h = fixture(), before = structuredClone({ reference: h.reference, order: h.order });
  const draft = { id: h.filmId, title: "Later edits", duration: 180, productionPreparation: { id: "a-new-draft-plan", inputHash: "different" } };
  const originalDraft = structuredClone(draft);
  const plan = await loadPaidFilmPlan(h);
  assert.equal(plan.title, "The paid two-minute film");
  assert.equal(plan.durationSeconds, 120);
  assert.deepEqual(h.calls, [{ path: `/api/studio?action=manifest&id=${h.reference.preparedId}`, body: undefined }]);
  assert.deepEqual(paidFilmStartRequest({ ...h, plan, productionAvailable: true }), {
    action: "startProduction", preparedId: h.reference.preparedId, orderId: h.reference.orderId, productionConsent: true,
  });
  assert.deepEqual(draft, originalDraft);
  assert.deepEqual({ reference: h.reference, order: h.order }, before);
});

test("paid review remains usable without local preparation or a completed current-draft hash", async () => {
  const h = fixture(), plan = await loadPaidFilmPlan(h);
  assert.equal(paidPlanMatches(plan, h.reference, h.order, h.filmId), true);
  assert.equal(paidOrderMatches(h.reference, h.order, h.filmId), true);
  // No local preparation or current input hash participates in either helper.
  assert.equal(paidFilmStartRequest({ ...h, plan, productionAvailable: true }).orderId, h.reference.orderId);
});

test("server-accepted large screenplays remain reviewable when shots make the full paid manifest larger", async () => {
  const project = fictionalOperatorProject();
  project.scenes[0].visual = "A fictional garden. ".repeat(42_000);
  const { manifest, manifestHash } = buildFilmManifest(project);
  assert.ok(Buffer.byteLength(JSON.stringify(manifest.screenplay)) < 1_500_000);
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) > 1_500_000);
  const h = fixture();
  h.filmId = project.id; h.order.filmId = project.id;
  h.reference.manifestHash = manifestHash;
  h.response.manifest = manifest; h.response.manifestHash = manifestHash;
  const plan = await loadPaidFilmPlan(h);
  assert.equal(plan.manifestHash, manifestHash);
  assert.equal(plan.scenes[0].visual, project.scenes[0].visual);
  assert.deepEqual(plan.download.manifest, manifest);
  assert.equal(paidFilmStartRequest({ ...h, plan, productionAvailable: true }).preparedId, h.reference.preparedId);
});

test("review never enables production while the provider is unavailable or the payment needs attention", async () => {
  const h = fixture(), plan = await loadPaidFilmPlan(h);
  assert.throws(() => paidFilmStartRequest({ ...h, plan, productionAvailable: false }), /availability/);
  assert.throws(() => paidFilmStartRequest({ ...h, plan: null, productionAvailable: true }), /Review/);
  for (const patch of [{ status: "awaiting-payment" }, { status: "refunded" }, { refundedCents: 1 }, { charged: false }, { receiptAvailable: false }, { requiresReview: true }]) {
    assert.throws(() => paidFilmStartRequest({ ...h, plan, order: { ...h.order, ...patch }, productionAvailable: true }));
  }
  assert.equal(h.calls.length, 1);
});

test("changed order, plan, film or environment invalidates an earlier review", async () => {
  const h = fixture(), plan = await loadPaidFilmPlan(h);
  for (const patch of [{ orderId: "c".repeat(64) }, { quoteId: "c".repeat(64) }, { preparedId: "another-plan" }, { manifestHash: "c".repeat(64) }, { sandbox: true }]) {
    const reference = { ...h.reference, ...patch };
    assert.equal(paidPlanMatches(plan, reference, h.order, h.filmId), false);
    assert.throws(() => paidFilmStartRequest({ ...h, plan, reference, productionAvailable: true }));
  }
  assert.equal(paidPlanMatches(plan, h.reference, h.order, "another-film"), false);
  for (const patch of [{ id: "c".repeat(64) }, { quoteId: "c".repeat(64) }, { preparedId: "another-plan" }, { filmId: "another-film" }, { sandbox: true }]) {
    await assert.rejects(loadPaidFilmPlan({ ...h, order: { ...h.order, ...patch } }), /could not be verified/);
  }
  assert.equal(h.calls.length, 1);
});

test("server manifest identity and actual content must match the paid reference", async () => {
  for (const mutate of [value => { value.id = "another-plan"; }, value => { value.manifestHash = "c".repeat(64); },
    value => { value.manifest.filmId = "another-film"; }, value => { value.manifest.targetDurationSeconds = 180; },
    value => { value.manifest.screenplay.scenes[0].narration = "Unpaid replacement content"; }]) {
    const h = fixture(); mutate(h.response);
    await assert.rejects(loadPaidFilmPlan(h), /could not be verified/);
    assert.ok(h.calls.every(call => call.body === undefined));
  }
});

test("missing server plan never replaces the saved payment or starts any checkout", async () => {
  const h = fixture(), before = structuredClone(h.reference);
  await assert.rejects(loadPaidFilmPlan({ ...h, request: async (path, body) => {
    assert.match(path, /action=manifest/); assert.equal(body, undefined); throw new Error("Plan temporarily unavailable");
  } }), /temporarily unavailable/);
  assert.deepEqual(h.reference, before);
});

test("paid plan review uses a detached snapshot for display and download", async () => {
  const h = fixture(), plan = await loadPaidFilmPlan({ ...h, request: async () => h.response });
  h.response.manifest.screenplay.scenes[0].narration = "Later replacement";
  assert.equal(plan.scenes[0].narration, "A family shares a harvest.");
  assert.equal(plan.download.manifest.screenplay.scenes[0].narration, "A family shares a harvest.");
});
