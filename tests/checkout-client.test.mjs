import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const contractUrl = moduleUrl(await compile("../src/studio/checkout-contract.ts"));
const { normalizeHostedInvoiceUrl, normalizeCheckoutConfiguration, normalizeFilmQuote, normalizeFilmOrder, normalizeFilmReceipt, quoteMatchesConfiguration, paymentStatusMessage } = await import(contractUrl);
const { reservePaymentWindow } = await import(moduleUrl((await compile("../src/studio/payment-window.ts")).replace('"./checkout-contract"', JSON.stringify(contractUrl))));
const { checkFilmPayment, commitFilmPayment, recoverFilmPayment, retryFilmPayment } = await import(moduleUrl((await compile("../src/studio/checkout-payment.ts")).replace('"./checkout-contract"', JSON.stringify(contractUrl))));
const { normalizePaymentReference, normalizeFilm, customerProjectBackup, newFilm } = await import(moduleUrl(await compile("../src/studio/model.ts")));
const now = Date.parse("2026-09-14T12:00:00.000Z");
const method = "quickbooks-hosted-invoice";
const policy = { deliveryTerms: "Delivery within 24 hours after payment.", refundTerms: "Request a full refund within 10 calendar days after payment." };
const quote = () => ({ id: "a".repeat(64), orderId: "b".repeat(64), preparedId: "00000000-0000-4000-8000-000000000001", filmId: "film-fixture", filmTitle: "SAMPLE ONLY fictional garden",
  manifestHash: "c".repeat(64), currency: "USD", amountCents: 100, expiresAt: new Date(now + 60_000).toISOString(), sandbox: true, method, ...policy });
const reference = () => ({ preparedId: quote().preparedId, manifestHash: quote().manifestHash, quoteId: quote().id, orderId: quote().orderId,
  checkoutKey: "synthetic-checkout-fixture-0001", submittedAt: new Date(now).toISOString(), sandbox: true });
const order = status => ({ id: quote().orderId, quoteId: quote().id, preparedId: quote().preparedId, filmId: quote().filmId, filmTitle: quote().filmTitle, status, currency: "USD", amountCents: 100,
  refundedCents: 0, charged: status === "captured" ? true : ["declined", "awaiting-payment"].includes(status) ? false : null,
  requiresReview: ["submitting", "uncertain"].includes(status), receiptAvailable: status === "captured", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), sandbox: true, checkoutMethod: method,
  invoiceUrl: "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-fixture", invoiceNumber: "1234", ...(status === "captured" ? { confirmationSource: "quickbooks-accounting" } : {}) });
const token = "SYNTHETIC_TOKEN_NOT_A_REAL_CARD";

test("verified Intuit short invoice links survive order normalization and payment-tab navigation", () => {
  const base = `https://connect.intuit.com/t/scs-v1-${"a".repeat(96)}`;
  for (const link of [base, `${base}?locale=en_US`, `${base}?locale=EN_us`]) {
    assert.equal(normalizeHostedInvoiceUrl(link), link);
    assert.equal(normalizeFilmOrder({ ...order("awaiting-payment"), invoiceUrl: link }).invoiceUrl, link);
    let navigated;
    const tab={opener:{},document:{title:"",body:{}},closed:false,location:{replace:url=>navigated=url},close:()=>{}};
    assert.equal(reservePaymentWindow(()=>tab).open(link), true);
    assert.equal(navigated, link);
  }
  for (const link of [`${base}?redirect=https://evil.invalid`, `${base}?locale=en_US&redirect=https://evil.invalid`,
    `${base}?locale=en_US&locale=fr_CA`, `${base}?locale=en%5fUS`, `${base}#other`, `${base}/more`,
    base.slice(0,-1), `${base}0`, base.replace("scs-v1-", "other-"), base.replace("/t/", "/t/../t/"),
    base.replace("connect.intuit.com/", "connect.intuit.com:443/"), base.replace("connect.intuit.com", "connect.intuit.com.evil.invalid"),
    base.replace("connect.intuit.com", "user@connect.intuit.com"), base.replace("https:", "http:")]) {
    assert.equal(normalizeHostedInvoiceUrl(link), null, link);
  }
});

test("a saved unpaid invoice without a payment link remains recoverable and locked", () => {
  const pending = normalizeFilmOrder({ ...order("awaiting-payment"), invoiceUrl: null });
  assert.ok(pending);
  assert.equal(pending.requiresReview, false);
  assert.equal(pending.receiptAvailable, false);
  assert.match(paymentStatusMessage(pending), /remains unpaid/);
  assert.match(paymentStatusMessage(pending), /Check payment status/);
  assert.match(paymentStatusMessage(pending), /stays locked/);
});

test("hosted configuration requires a known method, environment and complete policy", () => {
  const valid = { available: true, environment: "sandbox", method, ...policy };
  assert.deepEqual(normalizeCheckoutConfiguration(valid), valid);
  for (const value of [undefined, {}, { ...valid, available: false }, { ...valid, environment: "other" },
    { ...valid, method: "intuit-browser-direct" }, { ...valid, refundTerms: "" }, { ...valid, deliveryTerms: "<script>" }])
    assert.deepEqual(normalizeCheckoutConfiguration(value), { available: false });
  assert.equal(quoteMatchesConfiguration(quote(), valid), true);
  assert.equal(quoteMatchesConfiguration(quote(), { ...valid, environment: "production" }), false);
  assert.equal(quoteMatchesConfiguration(quote(), { ...valid, refundTerms: "Changed policy" }), false);
  assert.equal(quoteMatchesConfiguration(quote(), { available: false }), false);
});

test("payment links require the canonical Intuit invoice portal and never accept lookalike origins", () => {
  const valid = "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-fixture?locale=en_US";
  assert.equal(normalizeHostedInvoiceUrl(valid), valid);
  for (const url of [undefined, "", "https://connect.intuit.com/portal/", "http://connect.intuit.com/portal/invoice", "https://connect.intuit.com.evil.invalid/portal/invoice",
    "https://connect.intuit.com@evil.invalid/portal/invoice", "https://evil.invalid@connect.intuit.com/portal/invoice", "https://connect.intuit.com:443/portal/invoice",
    "https://connect.intuit.com/portal/invoice#other", "https://connect.intuit.com/portal/../login", "https://connect.intuit.com/portal/%2E%2E/login",
    "https://connect.intuit.com/portal/invoice\\other", "https://connect.intuit.com/portal/invoice\n", "javascript:alert(1)", "https://connect.intuit.com/another/page"])
    assert.equal(normalizeHostedInvoiceUrl(url), null, String(url));
  assert.equal(normalizeFilmOrder({ ...order("awaiting-payment"), invoiceUrl: "https://evil.invalid/portal/invoice" }), null);
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

test("checkout stores recovery before exactly one invoice request without card data or client amount", async () => {
  const events = [], posted = [];
  const result = await commitFilmPayment({ quote: quote(), reference: reference(), checkoutProof: "d".repeat(64), now: () => now,
    persist: value => { events.push("persist"); assert.deepEqual(value, reference()); },
    request: async (path, body) => { events.push("post"); posted.push({ path, body }); return order("captured"); } });
  assert.deepEqual(events, ["persist", "post"]);
  assert.equal(result.status, "captured");
  assert.deepEqual(posted, [{ path: "/api/studio", body: { action: "checkout", quoteId: quote().id, idempotencyKey: reference().checkoutKey, checkoutProof: "d".repeat(64), consent: true } }]);
  assert.doesNotMatch(JSON.stringify(reference()), /SYNTHETIC_TOKEN|amountCents|card|cvc/);
});

test("lost checkout response recovers the same invoice by GET without posting again", async () => {
  const calls = [];
  const result = await commitFilmPayment({ quote: quote(), reference: reference(), checkoutProof: "d".repeat(64), now: () => now, persist: () => {},
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
  const result = await commitFilmPayment({ quote: quote(), reference: reference(), checkoutProof: "d".repeat(64), now: () => now, persist: () => {}, request });
  assert.equal(result.charged, null);
  assert.match(paymentStatusMessage(result), /Do not submit another payment/);
  await recoverFilmPayment(request, reference());
  await recoverFilmPayment(request, reference());
  assert.equal(posts, 1);
  assert.equal(reads, 3);
});

test("storage failure, expired quote, or changed manifest prevents checkout entirely", async () => {
  let requests = 0;
  const run = overrides => commitFilmPayment({ quote: quote(), reference: reference(), checkoutProof: "d".repeat(64), now: () => now, persist: () => {}, request: async () => { requests++; return order("captured"); }, ...overrides });
  await assert.rejects(run({ persist: () => { throw new Error("Storage full"); } }), /Storage full/);
  await assert.rejects(run({ now: () => now + 60_001 }), /expired or changed/);
  await assert.rejects(run({ reference: { ...reference(), manifestHash: "d".repeat(64) } }), /expired or changed/);
  assert.equal(requests, 0);
});

test("mismatched or unreadable payment responses cannot be presented as a confirmed invoice payment", async () => {
  for (const value of [{}, { ...order("captured"), amountCents: 999 }, { ...order("captured"), id: "f".repeat(64) }, { ...order("captured"), sandbox: false }]) {
    let posts = 0;
    await assert.rejects(commitFilmPayment({ quote: quote(), reference: reference(), checkoutProof: "d".repeat(64), now: () => now, persist: () => {}, request: async (_path, body) => { if (body) posts++; return value; } }), /not confirmed/);
    assert.equal(posts, 1);
  }
  assert.equal(normalizeFilmOrder({ ...order("captured"), charged: false }), null);
  assert.equal(normalizeFilmQuote({ ...quote(), amountCents: "1.00" }), null);
});

test("a declined order is read-only and payment references survive reload and backup without token fields", async () => {
  const result = await recoverFilmPayment(async (_path, body) => { assert.equal(body, undefined); return order("declined"); }, reference());
  assert.equal(result.charged, false);
  assert.match(paymentStatusMessage(result), /declined/);
  const unsafe = { ...reference(), checkoutProof: "d".repeat(64), card: { number: "SYNTHETIC" }, amountCents: 100 };
  assert.deepEqual(normalizePaymentReference(unsafe), reference());
  const film = { ...newFilm(), paymentReference: unsafe };
  assert.deepEqual(normalizeFilm(JSON.parse(JSON.stringify(film))).paymentReference, reference());
  assert.deepEqual(customerProjectBackup(film).paymentReference, reference());
  assert.equal(normalizePaymentReference({ ...unsafe, orderId: "../other-user" }), undefined);
  await assert.rejects(recoverFilmPayment(async () => ({ ...order("captured"), sandbox: false }), reference()), /not confirmed/);
});

test("unpaid invoice recovery and explicit status checks cannot create or retry checkout", async () => {
  const calls = [];
  const request = async (path, body) => { calls.push({ path, body }); return order("awaiting-payment"); };
  const unpaid = await commitFilmPayment({ request, quote: quote(), reference: reference(), checkoutProof: "d".repeat(64), persist: () => {}, now: () => now });
  assert.equal(unpaid.charged, false);
  assert.equal(unpaid.receiptAvailable, false);
  assert.match(paymentStatusMessage(unpaid), /Complete payment on QuickBooks/);
  assert.match(paymentStatusMessage({ ...unpaid, invoiceUrl: null }), /invoice is saved.*Check payment status/);
  await recoverFilmPayment(request, reference());
  await checkFilmPayment(request, reference(), unpaid);
  assert.equal(calls.filter(call => call.body?.action === "checkout").length, 1);
  assert.deepEqual(calls[2], { path: "/api/studio", body: { action: "checkPayment", orderId: reference().orderId } });
  await assert.rejects(checkFilmPayment(async () => ({ ...unpaid, amountCents: 999 }), reference(), unpaid), /not confirmed/);
});

test("hosted paid orders require accounting provenance and do not claim a processor capture", () => {
  const paid = normalizeFilmOrder(order("captured"));
  assert.equal(paid.confirmationSource, "quickbooks-accounting");
  assert.match(paymentStatusMessage({ ...paid, sandbox: false }), /^Payment recorded by QuickBooks\.$/);
  assert.equal(normalizeFilmOrder({ ...order("captured"), confirmationSource: undefined }), null);
  assert.equal(normalizeFilmOrder({ ...order("awaiting-payment"), charged: true }), null);
  assert.equal(normalizeFilmOrder({ ...order("awaiting-payment"), receiptAvailable: true }), null);
  assert.equal(normalizeFilmOrder({ ...order("captured"), confirmationSource: "processor" }), null);
  const legacy = { ...order("captured") };
  for (const key of ["checkoutMethod", "invoiceUrl", "invoiceNumber", "confirmationSource"]) delete legacy[key];
  assert.equal(normalizeFilmOrder(legacy).receiptAvailable, true);
  assert.match(paymentStatusMessage({ ...legacy, sandbox: false }), /Your payment is confirmed/);
});

test("missing policies, changed quote environment and bad proof prevent invoice creation", async () => {
  let calls = 0;
  const request = async () => { calls++; return order("awaiting-payment"); };
  const run = change => commitFilmPayment({ request, quote: quote(), reference: reference(), checkoutProof: "d".repeat(64), persist: () => {}, now: () => now, ...change });
  await assert.rejects(run({ quote: { ...quote(), refundTerms: "" } }), /expired or changed/);
  await assert.rejects(run({ quote: { ...quote(), sandbox: false } }), /expired or changed/);
  await assert.rejects(run({ checkoutProof: "invalid" }), /security check/);
  assert.equal(calls, 0);
});

test("a server-authorized pre-invoice retry preserves the original quote, order and write identity", async () => {
  const saved = { ...order("uncertain"), invoiceUrl: null, retryAllowed: true }, calls = [];
  const result = await retryFilmPayment({ order: saved, reference: reference(), checkoutProof: "d".repeat(64),
    request: async (path, body) => { calls.push({ path, body }); return order("awaiting-payment"); } });
  assert.equal(result.status, "awaiting-payment");
  assert.equal(result.retryAllowed, false);
  assert.deepEqual(calls, [{ path: "/api/studio", body: { action: "checkout", quoteId: reference().quoteId,
    idempotencyKey: reference().checkoutKey, checkoutProof: "d".repeat(64), consent: true } }]);
  assert.match(paymentStatusMessage(normalizeFilmOrder(saved)), /No invoice was submitted.*retry/);
});

test("a retry response loss only reads saved state and never replays an ambiguous invoice POST", async () => {
  const saved = { ...order("uncertain"), invoiceUrl: null, retryAllowed: true }, calls = [];
  const result = await retryFilmPayment({ order: saved, reference: reference(), checkoutProof: "d".repeat(64),
    request: async (path, body) => { calls.push({ path, body }); if (body) throw new Error("simulated loss"); return { ...saved, retryAllowed: false }; } });
  assert.equal(result.retryAllowed, false);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(call => call.body).length, 1);
  assert.match(calls[1].path, /action=order&id=/);
});

test("missing retry proof, changed references or ambiguous orders cannot request another invoice", async () => {
  const saved = { ...order("uncertain"), invoiceUrl: null, retryAllowed: true };
  let requests = 0;
  const run = change => retryFilmPayment({ order: saved, reference: reference(), checkoutProof: "d".repeat(64),
    request: async () => { requests++; return order("awaiting-payment"); }, ...change });
  for (const value of [{ ...saved, retryAllowed: undefined }, { ...saved, retryAllowed: false }, order("captured"), order("awaiting-payment"),
    { ...saved, status: "submitting" }, { ...saved, invoiceUrl: order("awaiting-payment").invoiceUrl }])
    await assert.rejects(run({ order: value }));
  await assert.rejects(run({ reference: { ...reference(), quoteId: "e".repeat(64) } }));
  await assert.rejects(run({ checkoutProof: "invalid" }));
  assert.equal(requests, 0);
});

test("a retry result must retain the saved amount, environment, method and plan", async () => {
  const saved = { ...order("uncertain"), invoiceUrl: null, retryAllowed: true };
  for (const result of [{ ...order("awaiting-payment"), amountCents: 999 }, { ...order("awaiting-payment"), sandbox: false },
    { ...order("awaiting-payment"), preparedId: "00000000-0000-4000-8000-000000000002" },
    { ...order("captured"), checkoutMethod: undefined }]) {
    let posts = 0;
    await assert.rejects(retryFilmPayment({ order: saved, reference: reference(), checkoutProof: "d".repeat(64),
      request: async (_path, body) => { if (body) posts++; return result; } }), /not confirmed/);
    assert.equal(posts, 1);
  }
});

test("an expired original retry quote is surfaced without creating a replacement identity", async () => {
  let calls = 0;
  await assert.rejects(retryFilmPayment({ order: { ...order("uncertain"), invoiceUrl: null, retryAllowed: true }, reference: reference(), checkoutProof: "d".repeat(64),
    request: async () => { calls++; throw Object.assign(new Error("Expired"), { code: "QUOTE_EXPIRED" }); } }), /saved price or checkout terms changed/);
  assert.equal(calls, 1);
});

test("payment navigation reserves a tab immediately and strips its opener before verified navigation", () => {
  const calls=[];
  const tab={opener:{},document:{title:"",body:{textContent:""}},closed:false,location:{replace:url=>calls.push(url)},close:()=>calls.push("close")};
  const handle=reservePaymentWindow(()=>{calls.push("reserve");return tab;});
  assert.deepEqual(calls,["reserve"]);
  assert.equal(tab.opener,null);
  assert.match(tab.document.body.textContent,/Preparing/);
  assert.equal(handle.open(order("awaiting-payment").invoiceUrl),true);
  handle.close();
  assert.deepEqual(calls,["reserve",order("awaiting-payment").invoiceUrl]);
});
test("blocked or manually closed payment tabs fall back without losing saved checkout", () => {
  assert.equal(reservePaymentWindow(()=>null).open(order("awaiting-payment").invoiceUrl),false);
  assert.equal(reservePaymentWindow(()=>{throw Error("popup blocked");}).open(order("awaiting-payment").invoiceUrl),false);
  let closed=0;
  const tab={opener:null,document:{title:"",body:{}},closed:true,close:()=>closed++,location:{replace:()=>assert.fail("closed tab must not navigate")}};
  assert.equal(reservePaymentWindow(()=>tab).open(order("awaiting-payment").invoiceUrl),false);
  assert.equal(closed,1);
});
test("payment tabs close on failure and never navigate to untrusted destinations", () => {
  let closed=0;
  const tab={opener:null,document:{title:"",body:{}},closed:false,close:()=>closed++,location:{replace:()=>assert.fail("unsafe navigation")}};
  const handle=reservePaymentWindow(()=>tab);
  assert.equal(handle.open("https://evil.invalid/payment"),false);
  handle.close();
  assert.equal(closed,1);
  reservePaymentWindow(()=>tab).close();
  assert.equal(closed,2);
});
