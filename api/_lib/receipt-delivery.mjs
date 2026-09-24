import { randomUUID } from "node:crypto";
import { digest, readRecord, writeRecord } from "./auth.mjs";
import { hasAdminAccess } from "./access.mjs";
import { receiptEmail, receiptMail, receiptMailContent } from "./receipt-mail.mjs";

export const RECEIPT_SETTINGS_PATH = "settings/payment-receipts.json";
export const DEFAULT_MERCHANT_RECEIPT_EMAIL = "info@brocotech.ai";
const HEX = /^[a-f0-9]{64}$/, NUMERIC = /^[0-9]{1,30}$/;
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const amount = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
const orderPath = id => `payments/orders/${id}.json`;
const planPath = id => `payments/receipt-deliveries/${id}/plan.json`;
const deliveryPath = (id, email) => `payments/receipt-deliveries/${id}/${digest(email)}.json`;
const safeEmail = value => { try { return receiptEmail(value) === value; } catch { return false; } };
export class ReceiptDeliveryError extends Error {
  constructor(message, status = 400, code = "RECEIPT_SETTINGS_INVALID") { super(message); this.status = status; this.code = code; }
}
const unavailable = () => new ReceiptDeliveryError("Receipt settings could not be verified. Reload before continuing.", 503, "RECEIPT_UNAVAILABLE");
const conflict = () => new ReceiptDeliveryError("Receipt settings changed. Reload them before saving.", 409, "RECEIPT_SETTINGS_CONFLICT");
function administrator(actor) {
  if (!actor || actor.mustChangePassword || !hasAdminAccess(actor) || !safeEmail(actor.email))
    throw new ReceiptDeliveryError("Administrator access is required.", 403, "RECEIPT_FORBIDDEN");
}
function settingsValue(record) {
  if (!record) return { revision: 0, merchantReceiptEmail: DEFAULT_MERCHANT_RECEIPT_EMAIL, updatedAt: null, updatedBy: null };
  const value = record.value;
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || !safeEmail(value.merchantReceiptEmail)
    || !instant(value.updatedAt) || !safeEmail(value.updatedBy) || typeof record.etag !== "string" || !record.etag) throw unavailable();
  return { revision: value.revision, merchantReceiptEmail: value.merchantReceiptEmail, updatedAt: value.updatedAt, updatedBy: value.updatedBy };
}
function paidOrder(value) {
  const payments = value?.accountingPayments;
  return Boolean(value && value.version === 1 && HEX.test(value.id || "") && value.provider === "quickbooks"
    && value.checkoutMethod === "quickbooks-hosted-invoice" && value.status === "captured" && value.sandbox !== true
    && value.merchantBinding?.environment === "production" && NUMERIC.test(value.merchantBinding.realmId || "") && HEX.test(value.merchantBinding.grantId || "")
    && value.confirmationSource === "quickbooks-accounting" && value.currency === "USD" && amount(value.amountCents)
    && value.balanceCents === 0 && instant(value.capturedAt) && instant(value.accountingCheckedAt) && safeEmail(value.customerEmail)
    && NUMERIC.test(value.customerId || "") && NUMERIC.test(value.invoiceId || "")
    && Array.isArray(payments) && payments.length > 0 && payments.length <= 100
    && payments.every(payment => NUMERIC.test(payment?.id || "") && amount(payment.allocatedCents))
    && new Set(payments.map(payment => payment.id)).size === payments.length
    && payments.reduce((sum, payment) => sum + payment.allocatedCents, 0) === value.amountCents
    && Array.isArray(value.paymentIds) && value.paymentIds.length === payments.length
    && new Set(value.paymentIds).size === payments.length && value.paymentIds.every(id => payments.some(payment => payment.id === id)));
}
function paymentProof(value) {
  return digest(JSON.stringify({ id: value.id, customerEmail: value.customerEmail, customerId: value.customerId,
    realmId: value.merchantBinding.realmId, invoiceId: value.invoiceId, amountCents: value.amountCents, capturedAt: value.capturedAt,
    payments: value.accountingPayments.map(payment => ({ id: payment.id, allocatedCents: payment.allocatedCents })).sort((a, b) => a.id.localeCompare(b.id)) }));
}
function receiptFrom(value) {
  const receipt = { orderId: value.id, invoiceId: value.invoiceId,
    invoiceNumber: typeof value.invoiceNumber === "string" && /^[A-Za-z0-9 ._/-]{1,100}$/.test(value.invoiceNumber) ? value.invoiceNumber : null,
    amountCents: value.amountCents, currency: "USD", recordedAt: value.capturedAt,
    paymentDates: [...new Set(value.accountingPayments.map(payment => payment.transactionDate)
      .filter(date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort() };
  receiptMailContent(receipt);
  return receipt;
}

export function createReceiptDeliveryService({ read = readRecord, write = writeRecord, mail = receiptMail, now = Date.now } = {}) {
  const stamp = () => new Date(now()).toISOString();
  async function settings(actor) {
    administrator(actor);
    const mailConfigured = mail.available();
    return { ...settingsValue(await read(RECEIPT_SETTINGS_PATH)), mailConfigured,
      mailStatus: mailConfigured ? "Configured. Email acceptance and delivery have not been verified."
        : "Receipt email is not set up. Configure the dedicated mail application and sender before receipts can be emailed." };
  }
  async function saveSettings(actor, input) {
    administrator(actor);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["expectedRevision", "merchantReceiptEmail"].includes(key))
      || typeof input.merchantReceiptEmail !== "string") throw new ReceiptDeliveryError("Enter one merchant receipt email address.");
    const email = input.merchantReceiptEmail.trim().toLowerCase();
    if (!safeEmail(email)) throw new ReceiptDeliveryError("Enter one valid merchant receipt email address.");
    const old = await read(RECEIPT_SETTINGS_PATH), current = settingsValue(old);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== current.revision) throw conflict();
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw unavailable();
    const next = { revision: current.revision + 1, merchantReceiptEmail: email, updatedAt: stamp(), updatedBy: actor.email, changeId: randomUUID() };
    try { await write(RECEIPT_SETTINGS_PATH, next, old?.etag); }
    catch {
      const saved = await read(RECEIPT_SETTINGS_PATH);
      if (saved?.value.changeId !== next.changeId) {
        if (saved?.etag !== old?.etag) throw conflict();
        throw unavailable();
      }
    }
    const saved = await read(RECEIPT_SETTINGS_PATH);
    if (saved?.value.changeId !== next.changeId) throw conflict();
    return settings(actor);
  }
  function validatedPlan(record, order) {
    const value = record?.value;
    if (!value || typeof record.etag !== "string" || value.version !== 1 || value.orderId !== order.id || value.paymentProof !== paymentProof(order)
      || !Array.isArray(value.recipients) || value.recipients.length < 1 || value.recipients.length > 2
      || value.recipients.some(entry => !safeEmail(entry?.email) || !Array.isArray(entry.roles) || !entry.roles.length
        || entry.roles.some(role => !["customer", "merchant"].includes(role)))
      || new Set(value.recipients.map(entry => entry.email)).size !== value.recipients.length
      || value.recipients.filter(entry => entry.roles.includes("customer")).length !== 1
      || value.recipients.find(entry => entry.roles.includes("customer")).email !== order.customerEmail
      || value.recipients.filter(entry => entry.roles.includes("merchant")).length !== 1
      || value.receipt?.orderId !== order.id || value.receipt.invoiceId !== order.invoiceId || value.receipt.amountCents !== order.amountCents
      || value.receipt.recordedAt !== order.capturedAt) throw unavailable();
    receiptMailContent(value.receipt);
    return value;
  }
  async function plan(order) {
    const path = planPath(order.id), saved = await read(path);
    if (saved) return validatedPlan(saved, order);
    const current = settingsValue(await read(RECEIPT_SETTINGS_PATH));
    const recipients = [{ email: order.customerEmail, roles: ["customer"] }];
    if (current.merchantReceiptEmail === order.customerEmail) recipients[0].roles.push("merchant");
    else recipients.push({ email: current.merchantReceiptEmail, roles: ["merchant"] });
    const value = { version: 1, orderId: order.id, paymentProof: paymentProof(order), receipt: receiptFrom(order),
      recipients, settingsRevision: current.revision, createdAt: stamp() };
    // Immutable first queue wins; a changed merchant address never redirects an
    // already queued receipt or causes its customer receipt to be sent again.
    try { await write(path, value); } catch { /* Read the conditional-write winner. */ }
    return validatedPlan(await read(path), order);
  }
  async function recipient(plan, entry) {
    const path = deliveryPath(plan.orderId, entry.email);
    let record = await read(path);
    const existing = () => {
      const value = record?.value;
      if (!value || value.orderId !== plan.orderId || value.recipient !== entry.email || value.paymentProof !== plan.paymentProof
        || !["attempted", "accepted", "uncertain"].includes(value.status) || !instant(value.attemptedAt)) throw unavailable();
      return { roles: entry.roles, status: value.status, deliveryVerified: false };
    };
    if (record) return existing();
    let send;
    try { send = await mail.prepare({ to: entry.email, receipt: plan.receipt }); }
    catch { return { roles: entry.roles, status: "pending", deliveryVerified: false }; }
    if (typeof send !== "function") throw unavailable();
    // Check the authoritative order again after authentication, before claiming
    // any external send. Never email receipts for a regressed/unconfirmed order.
    const latest = (await read(orderPath(plan.orderId)))?.value;
    if (!paidOrder(latest) || paymentProof(latest) !== plan.paymentProof) return { roles: entry.roles, status: "payment-changed", deliveryVerified: false };
    const value = { version: 1, orderId: plan.orderId, recipient: entry.email, roles: entry.roles, paymentProof: plan.paymentProof,
      status: "attempted", attemptedAt: stamp(), attemptId: randomUUID(), deliveryVerified: false };
    // A timeout during this create may have saved the claim. Never send from a
    // failed write, even if a read finds our claim; an operator reviews that case.
    try { await write(path, value); } catch {
      record = await read(path);
      return record ? existing() : { roles: entry.roles, status: "pending", deliveryVerified: false };
    }
    record = await read(path);
    if (record?.value.attemptId !== value.attemptId || typeof record.etag !== "string") throw unavailable();
    let result;
    try { result = await send(); } catch { result = null; }
    const status = result?.accepted === true ? "accepted" : "uncertain";
    // A process crash or failed final save leaves 'attempted', which is also
    // non-retriable. Mail accepted by Graph is never labelled delivered.
    try { await write(path, { ...value, status, ...(status === "accepted" ? { acceptedAt: stamp() } : { reviewedAt: stamp() }) }, record.etag); }
    catch { return { roles: entry.roles, status: "attempted", deliveryVerified: false }; }
    return { roles: entry.roles, status, deliveryVerified: false };
  }
  async function deliver(order) {
    if (!HEX.test(order?.id || "")) return { status: "skipped", reason: "unconfirmed-payment" };
    const current = (await read(orderPath(order.id)))?.value;
    if (!paidOrder(current) || current.id !== order.id) return { status: "skipped", reason: "unconfirmed-payment" };
    if (!mail.available()) return { status: "configuration-required", mailConfigured: false, deliveryVerified: false };
    const queued = await plan(current), recipients = [];
    // One recipient's auth/send problem must not prevent the separate other
    // recipient from receiving a receipt. Never use CC or BCC.
    for (const entry of queued.recipients) {
      try { recipients.push(await recipient(queued, entry)); }
      catch { recipients.push({ roles: entry.roles, status: "review-required", deliveryVerified: false }); }
    }
    return { status: recipients.every(entry => entry.status === "accepted") ? "accepted" : "pending-review", recipients, deliveryVerified: false };
  }
  return { settings, saveSettings, deliver };
}

export const receiptDelivery = createReceiptDeliveryService();
