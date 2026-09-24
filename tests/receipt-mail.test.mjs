import test from "node:test";
import assert from "node:assert/strict";
import { createReceiptMail, receiptMailContent } from "../api/_lib/receipt-mail.mjs";

const env = { LINEAGE_MAIL_TENANT_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", LINEAGE_MAIL_CLIENT_ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  LINEAGE_MAIL_CLIENT_SECRET: "synthetic-secret-only", LINEAGE_MAIL_SENDER: "receipts@example.invalid" };
const receipt = { orderId: "a".repeat(64), invoiceId: "45", invoiceNumber: "INV-45", currency: "USD", amountCents: 330,
  recordedAt: "2026-09-24T02:00:00.000Z", paymentDates: ["2026-09-23"] };
const input = { to: "customer@example.invalid", receipt };

test("receipt mail requires dedicated valid application credentials before any network request", async () => {
  let calls = 0;
  for (const settings of [{}, { ...env, LINEAGE_MAIL_TENANT_ID: "common" }, { ...env, LINEAGE_MAIL_SENDER: "sender@example.invalid/../../me" }]) {
    const mail = createReceiptMail({ env: settings, fetchImpl: async () => { calls++; } });
    assert.equal(mail.available(), false); await assert.rejects(mail.prepare(input), /unavailable/);
  }
  assert.equal(calls, 0);
});

test("mail preparation obtains a token but cannot send until the durable claim caller invokes send", async () => {
  const requests = [];
  const mail = createReceiptMail({ env, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? Response.json({ token_type: "Bearer", access_token: "synthetic-access-token" }) : new Response(null, { status: 202 });
  } });
  const send = await mail.prepare(input); assert.equal(requests.length, 1);
  assert.equal(new URLSearchParams(requests[0].options.body).get("scope"), "https://graph.microsoft.com/.default");
  assert.deepEqual(await send(), { accepted: true, deliveryVerified: false });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://graph.microsoft.com/v1.0/users/receipts%40example.invalid/sendMail");
  const message = JSON.parse(requests[1].options.body).message;
  assert.deepEqual(message.toRecipients, [{ emailAddress: { address: input.to } }]);
  assert.equal(message.ccRecipients, undefined); assert.equal(message.bccRecipients, undefined);
  assert.equal(message.subject, "Lineage Theatre payment receipt"); assert.equal(message.body.contentType, "Text");
  assert.match(message.body.content, /\$3\.30 USD/); assert.match(message.body.content, /2026-09-23/);
  assert.match(message.body.content, /INV-45/); assert.match(message.body.content, /BROCO Technologies LLC/);
  assert.match(message.body.content, /does not verify processor capture, bank settlement/);
  assert.doesNotMatch(message.body.content, /info@brocotech\.ai|customer@example\.invalid/);
  for (const request of requests) assert.equal(request.options.redirect, "error");
  await assert.rejects(send(), /unavailable/); assert.equal(requests.length, 2);
});

test("receipt email rejects injection, invalid amounts and dates without provider calls", async () => {
  let calls = 0;
  const mail = createReceiptMail({ env, fetchImpl: async () => { calls++; } });
  for (const change of [{ to: "user@example.invalid\r\nBcc:bad@example.invalid" }, { to: "a@example.invalid,b@example.invalid" },
    { receipt: { ...receipt, amountCents: -1 } }, { receipt: { ...receipt, currency: "EUR" } },
    { receipt: { ...receipt, invoiceNumber: "INV\nPay attacker" } }, { receipt: { ...receipt, paymentDates: ["2026-09-23\nInjected"] } }]) {
    await assert.rejects(mail.prepare({ ...input, ...change }), /unavailable/);
  }
  assert.equal(calls, 0);
  assert.doesNotMatch(receiptMailContent({ ...receipt, filmTitle: "private story", card: "private card" }), /private/);
});

test("only Graph 202 is accepted and failed or timed out sends cannot reuse a send closure", async () => {
  for (const outcome of [200, 400, 500, "timeout"]) {
    let calls = 0;
    const mail = createReceiptMail({ env, fetchImpl: async () => {
      if (++calls === 1) return Response.json({ token_type: "Bearer", access_token: "synthetic-access-token" });
      if (outcome === "timeout") throw new Error("PRIVATE PROVIDER RESPONSE");
      return new Response("PRIVATE PROVIDER RESPONSE", { status: outcome });
    } });
    const send = await mail.prepare(input);
    await assert.rejects(send(), error => error.message.includes("unavailable") && !error.message.includes("PRIVATE"));
    await assert.rejects(send(), /unavailable/); assert.equal(calls, 2);
  }
});

test("receipt authentication responses are bounded and private token errors are never returned", async () => {
  for (const response of [new Response("x".repeat(40000)), Response.json({ token_type: "Other", access_token: "synthetic-access-token" }),
    Response.json({ token_type: "Bearer", access_token: "SECRET\nInjected" }), new Response("PRIVATE", { status: 401 })]) {
    const mail = createReceiptMail({ env, fetchImpl: async () => response });
    await assert.rejects(mail.prepare(input), error => error.message.includes("unavailable") && !error.message.includes("PRIVATE"));
  }
});
