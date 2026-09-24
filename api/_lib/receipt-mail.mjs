// Dedicated Microsoft Graph application mail, using the same mailbox-scoped
// LINEAGE_MAIL_* grant as account verification. No delegated or browser tokens.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMAIL = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const unavailable = () => new Error("Receipt email is unavailable. Review the mail configuration.");

export function receiptEmail(value) {
  if (typeof value !== "string" || value.length > 254 || !EMAIL.test(value)) throw unavailable();
  return value.toLowerCase();
}

function configuration(env) {
  const tenant = env.LINEAGE_MAIL_TENANT_ID, clientId = env.LINEAGE_MAIL_CLIENT_ID;
  const clientSecret = env.LINEAGE_MAIL_CLIENT_SECRET, sender = env.LINEAGE_MAIL_SENDER;
  try {
    if (!UUID.test(tenant || "") || !UUID.test(clientId || "") || typeof clientSecret !== "string"
      || clientSecret.length < 16 || clientSecret.length > 4096) return null;
    return { tenant, clientId, clientSecret, sender: receiptEmail(sender) };
  } catch { return null; }
}

export function receiptMailContent(receipt) {
  if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.orderId || "") || !/^[0-9]{1,30}$/.test(receipt.invoiceId || "")
    || receipt.currency !== "USD" || !Number.isSafeInteger(receipt.amountCents) || receipt.amountCents < 1 || receipt.amountCents > 100_000_000
    || typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt))
    || (receipt.invoiceNumber !== null && (typeof receipt.invoiceNumber !== "string" || !/^[A-Za-z0-9 ._/-]{1,100}$/.test(receipt.invoiceNumber)))
    || !Array.isArray(receipt.paymentDates) || receipt.paymentDates.length > 100
    || receipt.paymentDates.some(value => typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))) throw unavailable();
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(receipt.amountCents / 100);
  return ["Lineage Theatre payment receipt", "BROCO Technologies LLC", "",
    `Payment recorded: ${amount} USD`,
    `Payment date${receipt.paymentDates.length === 1 ? "" : "s"}: ${receipt.paymentDates.length ? receipt.paymentDates.join(", ") : "Not supplied by QuickBooks"}`,
    `Confirmed in Lineage Theatre: ${new Date(receipt.recordedAt).toISOString()}`,
    `Invoice reference: ${receipt.invoiceNumber || receipt.invoiceId}`,
    `Order reference: ${receipt.orderId}`, "", "Service: Lineage Theatre film production", "",
    "QuickBooks has recorded payment against this invoice. This receipt does not verify processor capture, bank settlement, refunds, or film delivery.",
    "Sign in to Lineage Theatre to view your order: https://lineagetheater.com/#studio"].join("\n");
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) throw unavailable();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export function createReceiptMail({ env = () => process.env, fetchImpl = fetch } = {}) {
  const config = () => configuration(typeof env === "function" ? env() : env);
  return {
    available: () => Boolean(config()),
    // Authentication may be retried before a send claim. The returned function
    // must be called only after the delivery service saves its attempted claim.
    async prepare({ to, receipt }) {
      const settings = config();
      let address, content;
      try { address = receiptEmail(to); content = receiptMailContent(receipt); } catch { throw unavailable(); }
      if (!settings) throw unavailable();
      let grant;
      try {
        const auth = await fetchImpl(`https://login.microsoftonline.com/${settings.tenant}/oauth2/v2.0/token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret,
            scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString(),
        });
        if (!auth.ok) { await auth.body?.cancel(); throw unavailable(); }
        grant = await boundedJson(auth);
        if (grant.token_type?.toLowerCase() !== "bearer" || typeof grant.access_token !== "string"
          || grant.access_token.length < 16 || grant.access_token.length > 16384 || /[\s\x00-\x1f]/.test(grant.access_token)) throw unavailable();
      } catch { throw unavailable(); }
      let used = false;
      return async function send() {
        if (used) throw unavailable();
        used = true;
        try {
          const response = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(settings.sender)}/sendMail`, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
            headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: { subject: "Lineage Theatre payment receipt",
              body: { contentType: "Text", content }, toRecipients: [{ emailAddress: { address } }],
            }, saveToSentItems: true }),
          });
          await response.body?.cancel();
          if (response.status !== 202) throw unavailable();
          // Graph 202 proves acceptance for processing, never mailbox delivery.
          return { accepted: true, deliveryVerified: false };
        } catch { throw unavailable(); }
      };
    },
  };
}

export const receiptMail = createReceiptMail();
