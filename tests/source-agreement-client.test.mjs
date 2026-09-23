import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { builtInSourceAgreement } from "../api/_lib/source-agreement.mjs";

const source = ts.transpileModule(await readFile(new URL("../src/source-agreement.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { normalizeSourceAgreement, sourceAgreementAcceptance } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const initial = builtInSourceAgreement();
const updated = { ...initial, revision: 1, version: `source-agreement-v1-${initial.contentHash}-${"b".repeat(32)}`, updatedAt: "2026-09-22T18:30:00.000Z" };

test("client accepts the server's built-in version and published versions with immutable snapshot nonces", () => {
  assert.deepEqual(normalizeSourceAgreement({ agreement: initial }), initial);
  assert.deepEqual(normalizeSourceAgreement({ agreement: updated }), updated);
  const withoutNonce = { ...updated, version: `source-agreement-v1-${initial.contentHash}` };
  assert.deepEqual(normalizeSourceAgreement({ agreement: withoutNonce }), withoutNonce);
});

test("client refuses incomplete, mismatched, malformed, or unbounded agreement records", () => {
  for (const value of [null, {}, { agreement: null }, { agreement: [] }, { agreement: initial.body }]) {
    assert.throws(() => normalizeSourceAgreement(value));
  }
  for (const patch of [
    { title: " " }, { title: "x".repeat(161) }, { body: "" }, { body: "x".repeat(10_001) },
    { consentLabel: "" }, { consentLabel: "x".repeat(501) }, { contentHash: "a".repeat(64) },
    { version: `source-agreement-v2-${updated.contentHash}-${"b".repeat(32)}` },
    { version: `${updated.version}/../other` }, { version: updated.version.slice(0, -1) },
    { revision: "1" }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { updatedAt: null }, { updatedAt: "today" }, { updatedAt: "2026-09-22" },
  ]) assert.throws(() => normalizeSourceAgreement({ agreement: { ...updated, ...patch } }));
  assert.throws(() => normalizeSourceAgreement({ agreement: { ...initial, updatedAt: updated.updatedAt } }));
});

test("registration requires explicit acceptance and sends only the exact loaded version and hash", () => {
  assert.throws(() => sourceAgreementAcceptance(null, true));
  assert.throws(() => sourceAgreementAcceptance(updated, false));
  assert.throws(() => sourceAgreementAcceptance(updated, "true"));
  assert.deepEqual(sourceAgreementAcceptance(updated, true), {
    sourceAgreementAccepted: true,
    sourceAgreementVersion: updated.version,
    sourceAgreementHash: updated.contentHash,
  });
  assert.throws(() => sourceAgreementAcceptance({ ...updated, version: initial.version }, true));
});

test("client retains readable plain text and discards nonpublic response fields", () => {
  const response = normalizeSourceAgreement({ agreement: { ...updated, adminEmail: "private@example.test", acceptance: { signedName: "Other person" } }, token: "unexpected" });
  assert.deepEqual(response, updated);
  assert.equal(response.body, initial.body);
  assert.equal(response.adminEmail, undefined);
  assert.equal(response.acceptance, undefined);
});
