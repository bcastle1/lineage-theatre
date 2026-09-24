import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = ts.transpileModule(await readFile(new URL("../src/admin/quickbooks-panels.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { readQuickBooksPanels, mergeHostedCheckoutSettings } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const saved = () => ({ revision: 4, enabled: true, configured: true, available: false, connectionStatus: "renewal-due",
  reason: "Authorization renewal is due.", environment: "sandbox", serviceItemId: "synthetic-service-1",
  serviceItemName: "Fictional film service", taxCode: "NON", deliveryTerms: "Saved delivery terms.",
  refundTerms: "Saved refund terms.", merchantConfirmed: true, pciAcknowledged: true, automaticInvoiceEmailDisabled: true });

test("owner action reconciliation starts all three panel reads together without a mutation or grant request", async () => {
  const calls = [], pending = [];
  const resultPromise = readQuickBooksPanels((...args) => {
    calls.push(args);
    return new Promise(resolve => pending.push(resolve));
  });
  assert.deepEqual(calls, [["/api/admin?action=overview"], ["/api/admin?action=payments"], ["/api/admin?action=hostedCheckout"]]);
  const overview = { connections: { billing: { available: false, status: "renewal-due" } } };
  const payments = { orders: [{ id: "synthetic-paid-record", status: "captured" }], connectionReady: false, configured: true };
  pending[2](saved()); pending[0](overview); pending[1](payments);
  assert.deepEqual(await resultPromise, { overview: { status: "fulfilled", value: overview },
    payments: { status: "fulfilled", value: payments }, settings: { status: "fulfilled", value: saved() } });
  assert.equal(calls.length, 3);
});

test("a failed panel is reported without suppressing other saved records or retrying any request", async () => {
  const calls = [], failure = new Error("Synthetic overview unavailable");
  const result = await readQuickBooksPanels(async path => {
    calls.push(path);
    if (path.endsWith("=overview")) throw failure;
    return path.endsWith("=payments") ? { orders: [{ status: "captured" }] } : saved();
  });
  assert.deepEqual(result.overview, { status: "rejected", reason: failure });
  assert.deepEqual(result.payments, { status: "fulfilled", value: { orders: [{ status: "captured" }] } });
  assert.equal(result.settings.status, "fulfilled");
  assert.equal(calls.length, 3);
});

test("unverified settings cannot be applied even when the other panel reads succeed", async () => {
  for (const settings of [null, { ...saved(), revision: "5" }, { ...saved(), enabled: undefined }, { ...saved(), configured: undefined }]) {
    const result = await readQuickBooksPanels(async path => path.endsWith("=hostedCheckout") ? settings : {});
    assert.equal(result.overview.status, "fulfilled");
    assert.equal(result.payments.status, "fulfilled");
    assert.equal(result.settings.status, "rejected");
    assert.match(result.settings.reason.message, /could not be verified/);
  }
});

test("status reconciliation preserves unsaved fields and their original revision while refreshing readiness", () => {
  const draft = { ...saved(), enabled: false, serviceItemId: "synthetic-unsaved-service", deliveryTerms: "Unsaved draft.", merchantConfirmed: false };
  const latest = { ...saved(), revision: 7, serviceItemId: "synthetic-externally-changed-service", deliveryTerms: "Changed elsewhere.",
    configured: false, connectionStatus: "needs-attention", reason: "Review the current connection.", environment: "production" };
  const result = mergeHostedCheckoutSettings(draft, latest, true);
  assert.deepEqual(result, { ...draft, configured: latest.configured, available: latest.available, connectionStatus: latest.connectionStatus,
    reason: latest.reason, environment: latest.environment });
  assert.equal(result.revision, 4);
  assert.equal(draft.connectionStatus, "renewal-due");
  assert.equal(latest.deliveryTerms, "Changed elsewhere.");
});

test("an untouched or unloaded settings form adopts the new saved settings and revision", () => {
  const latest = { ...saved(), revision: 5, connectionStatus: "ready", reason: "Checkout is configured." };
  assert.equal(mergeHostedCheckoutSettings(saved(), latest, false), latest);
  assert.equal(mergeHostedCheckoutSettings(null, latest, true), latest);
});

test("a delayed settings read cannot overwrite a save that already returned a newer revision", () => {
  const current = { ...saved(), revision: 5, deliveryTerms: "Newly saved terms." };
  for (const hasUnsavedChanges of [false, true]) {
    assert.equal(mergeHostedCheckoutSettings(current, saved(), hasUnsavedChanges), current);
  }
});
