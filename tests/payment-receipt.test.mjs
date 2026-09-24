import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const contractUrl = moduleUrl(await compile("../src/studio/checkout-contract.ts"));
const { createFilmReceiptData, createFilmReceiptHtml } = await import(moduleUrl((await compile("../src/studio/payment-receipt.ts")).replace('"./checkout-contract"', JSON.stringify(contractUrl))));
const receipt = (changes = {}) => ({ receiptId: "a".repeat(64), filmTitle: "Fictional family garden", currency: "USD",
  amountCents: 567, refundedCents: 0, capturedAt: "2026-09-23T15:37:14.000Z", status: "captured", sandbox: false,
  transactionId: "synthetic-transaction-123", ...changes });

test("a printable receipt uses the recorded capture, transaction, amount and published merchant name", () => {
  const html = createFilmReceiptHtml(receipt());
  assert.match(html, /<h1>Payment receipt<\/h1>/);assert.match(html, /BROCO Technologies LLC/);
  assert.match(html, /Payment confirmed/);assert.match(html, /\$5\.67 USD/);assert.match(html, /\$0\.00 USD/);
  assert.match(html, /September 23, 2026.*3:37:14 PM UTC/);assert.match(html, /synthetic-transaction-123/);
  assert.match(html, /does not confirm bank settlement or completion of your film/);
  assert.match(html, /Print command.*save it as a PDF/);assert.match(html, /@media print/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|\bsrc=|\bonclick=/i);
});

test("receipt strings are escaped and unrecognized card or provider fields cannot become HTML", () => {
  const html = createFilmReceiptHtml(receipt({ filmTitle: '<script>alert("x")</script><img src=x onerror=alert(1)> & \'family\'',
    transactionId: '<img src="x">', processorDisclosure: '<script>bad</script>', paymentToken: "secret-token", card: { number: "4111111111111111" } }));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&amp; &#39;family&#39;/);assert.match(html, /Transaction reference<\/th><td>Not available/);
  assert.doesNotMatch(html, /<script\b|<img\b|secret-token|4111111111111111/);
  assert.match(html, /Intuit Payments Inc\./);
});

test("sandbox, refund and uncertain receipts never mislabel a current unconfirmed payment as paid", () => {
  const sandbox = createFilmReceiptHtml(receipt({ sandbox: true }));
  assert.match(sandbox, /<h1>Sandbox test receipt<\/h1>/);assert.match(sandbox, /No real money was charged/);
  const uncertain = createFilmReceiptHtml(receipt({ status: "uncertain" }));
  assert.match(uncertain, /<h1>Payment record<\/h1>/);assert.match(uncertain, /does not confirm a successful payment/);
  assert.match(uncertain, /Recorded capture amount/);assert.doesNotMatch(uncertain, /Payment confirmed|<h1>Payment receipt/);
  assert.match(createFilmReceiptHtml(receipt({ status: "refund-pending" })), /Refund pending/);
  assert.match(createFilmReceiptHtml(receipt({ status: "partially-refunded", refundedCents: 200 })), /Partially refunded/);
  const refunded = createFilmReceiptHtml(receipt({ status: "refunded", refundedCents: 567 }));
  assert.match(refunded, /Fully refunded/);assert.match(refunded, /Confirmed refunds<\/th><td>\$5\.67 USD/);
  for (const change of [{ status: "submitting" }, { status: "declined" }, { capturedAt: "" }, { refundedCents: 568 }])
    assert.throws(() => createFilmReceiptHtml(receipt(change)), /could not be verified/);
});

test("hosted receipts report accounting evidence without claiming processor capture or a current refund balance", () => {
  const html = createFilmReceiptHtml(receipt({ confirmationSource: "quickbooks-accounting", checkoutMethod: "quickbooks-hosted-invoice" }));
  assert.match(html, /<h1>QuickBooks payment record<\/h1>/);
  assert.match(html, /Payment recorded by QuickBooks/);
  assert.match(html, /QuickBooks payment reference/);
  assert.match(html, /does not confirm payment processor capture, bank settlement/);
  assert.match(html, /latest refund status/);
  assert.doesNotMatch(html, /Payment confirmed|Payment is processed by|Recorded capture date|Confirmed refunds/);
  assert.throws(() => createFilmReceiptHtml(receipt({ confirmationSource: "invented-processor" })), /could not be verified/);
  assert.throws(() => createFilmReceiptHtml(receipt({ checkoutMethod: "quickbooks-hosted-invoice" })), /could not be verified/);
});

test("downloadable accounting receipt data marks refunds unverified and omits a zero refund claim", () => {
  const data = createFilmReceiptData(receipt({ confirmationSource: "quickbooks-accounting", checkoutMethod: "quickbooks-hosted-invoice" }));
  assert.equal(data.confirmationSource, "quickbooks-accounting");
  assert.equal(data.type, "QuickBooks payment record");
  assert.equal(data.totalAmount, "$5.67");
  assert.equal("refunded" in data, false);
  assert.match(data.refundStatus, /Not verified/);
  assert.match(data.notice, /does not confirm payment processor capture, bank settlement, film completion, or any later refund/);
  const legacy = createFilmReceiptData(receipt({ refundedCents: 200, status: "partially-refunded" }));
  assert.equal(legacy.refunded, "$2.00");
  assert.equal("refundStatus" in legacy, false);
});
