import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const contractUrl = moduleUrl(await compile("../src/studio/checkout-contract.ts"));
const { normalizeCheckoutConfiguration, normalizeFilmQuote, normalizeFilmOrder, normalizeFilmReceipt, quoteMatchesConfiguration, paymentStatusMessage } = await import(contractUrl);
const { commitFilmPayment, recoverFilmPayment } = await import(moduleUrl((await compile("../src/studio/checkout-payment.ts")).replace('"./checkout-contract"', JSON.stringify(contractUrl))));
const { normalizePaymentReference, normalizeFilm, customerProjectBackup, newFilm } = await import(moduleUrl(await compile("../src/studio/model.ts")));
const now = Date.parse("2026-09-14T12:00:00.000Z");
const quote = () => ({ id: "a".repeat(64), orderId: "b".repeat(64), preparedId: "00000000-0000-4000-8000-000000000001", filmId: "film-fixture", filmTitle: "SAMPLE ONLY fictional garden",
  manifestHash: "c".repeat(64), currency: "USD", amountCents: 100, expiresAt: new Date(now + 60_000).toISOString(), sandbox: true });
const reference = () => ({ preparedId: quote().preparedId, manifestHash: quote().manifestHash, quoteId: quote().id, orderId: quote().orderId,
  checkoutKey: "synthetic-checkout-fixture-0001", submittedAt: new Date(now).toISOString(), sandbox: true });
const order = status => ({ id: quote().orderId, quoteId: quote().id, preparedId: quote().preparedId, filmId: quote().filmId, filmTitle: quote().filmTitle, status, currency: "USD", amountCents: 100,
  refundedCents: 0, charged: status === "captured" ? true : status === "declined" ? false : null,
  requiresReview: ["submitting", "uncertain"].includes(status), receiptAvailable: status === "captured", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), sandbox: true });
const token = "SYNTHETIC_TOKEN_NOT_A_REAL_CARD";

test("card destinations accept only documented exact Intuit token endpoints and matching environment", () => {
  const valid = { available: true, environment: "sandbox", tokenization: { method: "intuit-browser-direct", url: "https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens" } };
  assert.deepEqual(normalizeCheckoutConfiguration(valid), valid);
  for (const url of ["https://evil.invalid/tokens", "https://api.intuit.com/quickbooks/v4/payments/tokens", `${valid.tokenization.url}?leak=1`, `${valid.tokenization.url}/other`, "http://sandbox.api.intuit.com/quickbooks/v4/payments/tokens"])
    assert.deepEqual(normalizeCheckoutConfiguration({ ...valid, tokenization: { ...valid.tokenization, url } }), { available: false });
  for (const value of [undefined, {}, { ...valid, available: false }, { ...valid, environment: "other" }]) assert.deepEqual(normalizeCheckoutConfiguration(value), { available: false });
  assert.equal(quoteMatchesConfiguration(quote(), valid), true);
  assert.equal(quoteMatchesConfiguration(quote(), { ...valid, environment: "production" }), false);
  assert.equal(quoteMatchesConfiguration(quote(), { available: false }), false);
});

test("fresh receipt normalization preserves refund changes and the original capture date", () => {
  const receipt = { receiptId: quote().orderId, filmTitle: quote().filmTitle, currency: "USD", amountCents: 100,
    refundedCents: 100, status: "refunded", capturedAt: new Date(now - 60_000).toISOString(), sandbox: true };
  const normalized=normalizeFilmReceipt({ ...receipt, paymentToken: token, transactionId:"synthetic-charge-123", processorDisclosure:"untrusted disclosure" });
  assert.deepEqual({...normalized,transactionId:undefined,processorDisclosure:undefined}, {...receipt,transactionId:undefined,processorDisclosure:undefined});
  assert.equal(normalized.transactionId,"synthetic-charge-123");
  assert.match(normalized.processorDisclosure,/Intuit Payments Inc\..*1-888-536-4801.*1098819/);
  assert.equal(normalizeFilmReceipt({...receipt,transactionId:"bad\nreference"}).transactionId,null);
  assert.equal(normalizeFilmReceipt({ ...receipt, refundedCents: 101 }), null);
  assert.equal(normalizeFilmReceipt({ ...receipt, capturedAt: "unknown" }), null);
});

test("checkout stores only recovery references before one server-priced payment POST", async () => {
  const events = [], posted = [];
  const result = await commitFilmPayment({ quote: quote(), reference: reference(), paymentToken: token, checkoutProof: "d".repeat(64), now: () => now,
    persist: value => { events.push("persist"); assert.deepEqual(value, reference()); },
    request: async (path, body) => { events.push("post"); posted.push({ path, body }); return order("captured"); } });
  assert.deepEqual(events, ["persist", "post"]);
  assert.equal(result.status, "captured");
  assert.deepEqual(posted, [{ path: "/api/studio", body: { action: "checkout", quoteId: quote().id, idempotencyKey: reference().checkoutKey, paymentToken: token, checkoutProof: "d".repeat(64), consent: true } }]);
  assert.doesNotMatch(JSON.stringify(reference()), /SYNTHETIC_TOKEN|amountCents|card|cvc/);
});

test("lost checkout response recovers the captured order by GET without posting again", async () => {
  const calls = [];
  const result = await commitFilmPayment({ quote: quote(), reference: reference(), paymentToken: token, checkoutProof: "d".repeat(64), now: () => now, persist: () => {},
    request: async (path, body) => { calls.push({ path, body }); if (body) throw new Error("simulated response loss after capture"); return order("captured"); } });
  assert.equal(result.status, "captured");
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(call => call.body).length, 1);
  assert.match(calls[1].path, /action=order&id=/);
  assert.equal(calls[1].body, undefined);
});

test("unknown payment remains uncertain and repeated status checks never replay checkout", async () => {
  let posts = 0, reads = 0;
  const request = async (_path, body) => { if (body) { posts++; throw new Error("timeout"); } reads++; return order("uncertain"); };
  const result = await commitFilmPayment({ quote: quote(), reference: reference(), paymentToken: token, checkoutProof: "d".repeat(64), now: () => now, persist: () => {}, request });
  assert.equal(result.charged, null);
  assert.match(paymentStatusMessage(result), /Do not submit another payment/);
  await recoverFilmPayment(request, reference());
  await recoverFilmPayment(request, reference());
  assert.equal(posts, 1);
  assert.equal(reads, 3);
});

test("storage failure, expired quote, or changed manifest prevents checkout entirely", async () => {
  let requests = 0;
  const run = overrides => commitFilmPayment({ quote: quote(), reference: reference(), paymentToken: token, checkoutProof: "d".repeat(64), now: () => now, persist: () => {}, request: async () => { requests++; return order("captured"); }, ...overrides });
  await assert.rejects(run({ persist: () => { throw new Error("Storage full"); } }), /Storage full/);
  await assert.rejects(run({ now: () => now + 60_001 }), /expired or changed/);
  await assert.rejects(run({ reference: { ...reference(), manifestHash: "d".repeat(64) } }), /expired or changed/);
  assert.equal(requests, 0);
});

test("mismatched or unreadable payment responses cannot be presented as a confirmed charge", async () => {
  for (const value of [{}, { ...order("captured"), amountCents: 999 }, { ...order("captured"), id: "f".repeat(64) }, { ...order("captured"), sandbox: false }]) {
    let posts = 0;
    await assert.rejects(commitFilmPayment({ quote: quote(), reference: reference(), paymentToken: token, checkoutProof: "d".repeat(64), now: () => now, persist: () => {}, request: async (_path, body) => { if (body) posts++; return value; } }), /not confirmed/);
    assert.equal(posts, 1);
  }
  assert.equal(normalizeFilmOrder({ ...order("captured"), charged: false }), null);
  assert.equal(normalizeFilmQuote({ ...quote(), amountCents: "1.00" }), null);
});

test("a declined order is read-only and payment references survive reload and backup without token fields", async () => {
  const result = await recoverFilmPayment(async (_path, body) => { assert.equal(body, undefined); return order("declined"); }, reference());
  assert.equal(result.charged, false);
  assert.match(paymentStatusMessage(result), /declined/);
  const unsafe = { ...reference(), paymentToken: token, checkoutProof: "d".repeat(64), card: { number: "SYNTHETIC" }, amountCents: 100 };
  assert.deepEqual(normalizePaymentReference(unsafe), reference());
  const film = { ...newFilm(), paymentReference: unsafe };
  assert.deepEqual(normalizeFilm(JSON.parse(JSON.stringify(film))).paymentReference, reference());
  assert.deepEqual(customerProjectBackup(film).paymentReference, reference());
  assert.equal(normalizePaymentReference({ ...unsafe, orderId: "../other-user" }), undefined);
  await assert.rejects(recoverFilmPayment(async () => ({ ...order("captured"), sandbox: false }), reference()), /not confirmed/);
});
