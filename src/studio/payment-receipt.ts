import { normalizeFilmReceipt } from "./checkout-contract";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
// Published Source Materials Ownership and Use Agreement, section 1.
const merchantName = "BROCO Technologies LLC";

export function createFilmReceiptData(value: unknown) {
  const receipt = normalizeFilmReceipt(value);
  if (!receipt) throw new Error("The receipt could not be verified.");
  const accounting = receipt.confirmationSource === "quickbooks-accounting";
  return {
    receiptId: receipt.receiptId, transactionId: receipt.transactionId, filmTitle: receipt.filmTitle, currency: receipt.currency,
    paymentAmount: money(receipt.amountCents), totalAmount: money(receipt.amountCents), status: receipt.status,
    type: receipt.sandbox ? "Sandbox test receipt — no real money" : receipt.status === "uncertain" ? "Payment record — status needs review"
      : accounting ? "QuickBooks payment record" : "Payment receipt",
    paidAt: receipt.capturedAt,
    processorDisclosure: `${receipt.sandbox ? "Sandbox test only. " : ""}${receipt.processorDisclosure}`,
    ...(accounting ? {
      confirmationSource: receipt.confirmationSource,
      refundStatus: "Not verified. Contact the administrator for the latest refund status.",
      notice: "This accounting record does not confirm payment processor capture, bank settlement, film completion, or any later refund.",
    } : {
      refunded: money(receipt.refundedCents),
      notice: "A payment receipt does not confirm bank settlement or completion of your film.",
    }),
  };
}

export function createFilmReceiptHtml(value: unknown): string {
  const receipt = normalizeFilmReceipt(value);
  if (!receipt) throw new Error("The receipt could not be verified.");
  const needsReview = receipt.status === "uncertain";
  const accounting = receipt.confirmationSource === "quickbooks-accounting";
  const title = receipt.sandbox ? "Sandbox test receipt" : needsReview ? "Payment record" : accounting ? "QuickBooks payment record" : "Payment receipt";
  const status = {
    captured: accounting ? "Payment recorded by QuickBooks" : "Payment confirmed", uncertain: "Payment status needs review", "refund-pending": "Refund pending",
    "partially-refunded": "Partially refunded", refunded: "Fully refunded",
  }[receipt.status as "captured" | "uncertain" | "refund-pending" | "partially-refunded" | "refunded"];
  const capturedDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" }).format(new Date(receipt.capturedAt));
  const rows = [
    ["Merchant", merchantName], ["Film", receipt.filmTitle], ["Status", status],
    [accounting ? "Invoice payment recorded" : needsReview ? "Recorded capture amount" : "Original payment", `${money(receipt.amountCents)} USD`],
    ...(!accounting ? [["Confirmed refunds", `${money(receipt.refundedCents)} USD`]] : []),
    [accounting ? "Payment recorded at" : "Recorded capture date", capturedDate],
    [accounting ? "QuickBooks payment reference" : "Transaction reference", receipt.transactionId || "Not available"], ["Receipt reference", receipt.receiptId],
  ].map(([label, content]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(content)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>Lineage Theatre — ${escapeHtml(title)}</title>
<style>
body{max-width:760px;margin:40px auto;padding:0 24px;font:12pt/1.5 Arial,sans-serif;color:#172b25;background:#fff}
h1{font-size:24pt;line-height:1.2}h2{font-size:15pt}.brand{font-size:14pt}table{width:100%;border-collapse:collapse;margin:24px 0}
th,td{padding:12px 0;border-bottom:1px solid #ddd;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{width:35%;padding-right:20px}
.notice{padding:14px;border:1px solid #aaa}.print-help{color:#4d5b55}footer{margin-top:32px;font-size:10pt}
@media print{body{max-width:none;margin:0;padding:0}.print-help{display:none}tr{break-inside:avoid}h1,h2{break-after:avoid}}
</style></head><body>
<p class="brand">Lineage Theatre</p><h1>${escapeHtml(title)}</h1>
<p class="print-help">Use your browser’s Print command to print this receipt or save it as a PDF.</p>
${receipt.sandbox ? '<p class="notice">Sandbox test only. No real money was charged. This is not a live payment receipt.</p>' : ""}
${needsReview ? '<p class="notice">The current payment status needs review. This record does not confirm a successful payment. Do not submit another payment; contact the administrator.</p>' : ""}
<table aria-label="Payment details"><tbody>${rows}</tbody></table>
<h2>${accounting ? "Payment record source" : "Payment processing"}</h2><p>${escapeHtml(receipt.processorDisclosure)}</p>
<p>${accounting ? "This accounting record does not confirm payment processor capture, bank settlement, film completion, or any later refund. Contact the administrator for the latest refund status." : "A payment receipt does not confirm bank settlement or completion of your film. Refund amounts show only confirmed refunds in this record."}</p>
<footer>Questions about this record? Contact admin@brocotech.ai and include the receipt reference.</footer>
</body></html>`;
}
