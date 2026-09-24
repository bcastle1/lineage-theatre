import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw, Save } from "lucide-react";
import { api } from "../studio/model";

type Settings = {
  revision: number;
  merchantReceiptEmail: string;
  mailConfigured: boolean;
  mailStatus: string;
};
const problem = (error: unknown) => error instanceof Error ? error.message : "Receipt settings could not be saved. Reload before trying again.";
function verified(value: Settings) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || typeof value.merchantReceiptEmail !== "string"
    || typeof value.mailConfigured !== "boolean" || typeof value.mailStatus !== "string")
    throw new Error("The saved receipt settings could not be verified. Reload before continuing.");
  return value;
}

export default function ReceiptSettings({ disabled = false }: { disabled?: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);

  const reload = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    const request = ++generation.current;
    setBusy(true); setError(""); setMessage("");
    try {
      const value = verified(await api<Settings>("/api/admin?action=receiptSettings"));
      if (mounted.current && generation.current === request) { setSettings(value); setEmail(value.merchantReceiptEmail); }
    } catch (cause) { if (mounted.current && generation.current === request) setError(problem(cause)); }
    finally { lock.current = false; if (mounted.current && generation.current === request) setBusy(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; };
  }, [reload]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || disabled || !settings) return;
    lock.current = true;
    const request = ++generation.current, expectedRevision = settings.revision, recipient = email.trim().toLowerCase();
    setBusy(true); setError(""); setMessage("");
    try {
      const saved = verified(await api<Settings>("/api/admin", { action: "saveReceiptSettings", expectedRevision, merchantReceiptEmail: recipient }));
      if (saved.revision !== expectedRevision + 1 || saved.merchantReceiptEmail !== recipient)
        throw new Error("The saved recipient could not be confirmed. Reload before saving again.");
      if (mounted.current && generation.current === request) {
        setSettings(saved); setEmail(saved.merchantReceiptEmail);
        setMessage("Merchant receipt email saved. Receipts already queued keep their original recipients.");
      }
    } catch (cause) { if (mounted.current && generation.current === request) setError(problem(cause)); }
    finally { lock.current = false; if (mounted.current && generation.current === request) setBusy(false); }
  }

  return <section className="admin-hosted-checkout" aria-labelledby="receipt-settings-heading">
    <div className="admin-section-heading"><div>
      <h2 id="receipt-settings-heading">Payment receipt emails</h2>
      <p>After QuickBooks confirms payment, send separate receipts to the customer's account email and the merchant email below.</p>
    </div><button type="button" className="button secondary small" disabled={disabled || busy} onClick={() => void reload()}>
      <RefreshCw size={15} aria-hidden="true"/>Reload receipt settings
    </button></div>
    {error && <p className="admin-inline-error" role="alert">{error}</p>}
    {message && <p className="admin-feedback info" role="status">{message}</p>}
    {!settings && busy && <p role="status">Loading receipt settings…</p>}
    {settings && <>
      <p className={settings.mailConfigured ? "field-note" : "admin-inline-error"} role="status">{settings.mailStatus}</p>
      {!settings.mailConfigured && <p className="field-note">The deployment needs the dedicated Microsoft Graph mail application's tenant ID, client ID, client secret, and sender mailbox in the LINEAGE_MAIL_* settings. Saving a recipient does not activate email.</p>}
      <form onSubmit={event => void save(event)}>
        <fieldset disabled={disabled || busy}>
          <legend>Merchant receipt recipient</legend>
          <label htmlFor="merchant-receipt-email">Merchant receipt email</label>
          <input id="merchant-receipt-email" type="email" required maxLength={254} autoComplete="email" value={email}
            aria-describedby="merchant-receipt-help" onChange={event => { setEmail(event.target.value); setMessage(""); }}/>
          <p className="field-note" id="merchant-receipt-help">Any administrator can edit this address. Changes apply to future receipt deliveries; receipts already queued retain the saved address. Customer and merchant addresses are not shared in the other recipient's email.</p>
          <button type="submit" className="button primary"><Save size={16} aria-hidden="true"/>{busy ? "Saving…" : "Save merchant receipt email"}</button>
        </fieldset>
      </form>
      <p className="field-note">Email accepted for sending is not proof of delivery. Receipts with an uncertain send outcome require review before any resend.</p>
    </>}
  </section>;
}
