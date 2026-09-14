// Microsoft Graph application mail. Configure a dedicated, mailbox-scoped grant;
// never reuse a developer's browser token or the QuickBooks authorization.
// Official contracts: learn.microsoft.com/graph/api/user-sendmail and
// learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMAIL = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const unavailable = () => new Error("Verification email is unavailable. Contact the administrator for help.");

function configuration(env) {
  const tenant = env.LINEAGE_MAIL_TENANT_ID;
  const clientId = env.LINEAGE_MAIL_CLIENT_ID;
  const clientSecret = env.LINEAGE_MAIL_CLIENT_SECRET;
  const sender = env.LINEAGE_MAIL_SENDER;
  if (!UUID.test(tenant || "") || !UUID.test(clientId || "")
      || typeof clientSecret !== "string" || clientSecret.length < 16 || clientSecret.length > 4096
      || typeof sender !== "string" || sender.length > 254 || !EMAIL.test(sender)) return null;
  return { tenant, clientId, clientSecret, sender };
}

async function boundedJson(response, max = 32768) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw unavailable();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export function createVerificationMail({ env = () => process.env, fetchImpl = fetch } = {}) {
  const config = () => configuration(typeof env === "function" ? env() : env);
  return {
    available: () => Boolean(config()),
    async send({ to, token }) {
      const settings = config();
      if (!settings || typeof to !== "string" || to.length > 254 || !EMAIL.test(to)
          || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw unavailable();
      // Fixed origin and template prevent this service becoming an arbitrary mail relay.
      const link = `https://lineagetheater.com/#verify-email=${token}`;
      try {
        const auth = await fetchImpl(`https://login.microsoftonline.com/${settings.tenant}/oauth2/v2.0/token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret,
            scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString(),
        });
        if (!auth.ok) { await auth.body?.cancel(); throw unavailable(); }
        const grant = await boundedJson(auth);
        if (grant.token_type?.toLowerCase() !== "bearer" || typeof grant.access_token !== "string"
            || grant.access_token.length < 16 || grant.access_token.length > 16384
            || /[\s\x00-\x1f]/.test(grant.access_token)) throw unavailable();
        const response = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(settings.sender)}/sendMail`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { subject: "Verify your Lineage Theatre email",
            body: { contentType: "Text", content: `Confirm this email address for your Lineage Theatre account. Sign in to the same account, then confirm using this link within 30 minutes:\n\n${link}\n\nIf you did not request this email, you can ignore it. No account changes occur until you confirm.` },
            toRecipients: [{ emailAddress: { address: to } }],
          }, saveToSentItems: true }),
        });
        await response.body?.cancel();
        if (response.status !== 202) throw unavailable();
        // Graph acceptance is not delivery proof. The link consumption proves control.
        return { accepted: true };
      } catch { throw unavailable(); }
    },
  };
}

export const verificationMail = createVerificationMail();
