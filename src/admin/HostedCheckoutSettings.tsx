import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Save } from "lucide-react";
import { api } from "../studio/model";
import { mergeHostedCheckoutSettings, verifyHostedCheckoutSettings, type HostedCheckoutSettingsValue as Settings } from "./quickbooks-panels";

type Item = { id: string; name: string; active: boolean; type: string; taxable?: boolean };
const problem = (error: unknown) => error instanceof Error ? error.message : "The checkout settings could not be loaded.";

export default function HostedCheckoutSettings({ isOwner, disabled = false, onSaved, refreshedSettings = null }: {
  isOwner: boolean; disabled?: boolean; onSaved?: () => void;
  refreshedSettings?: PromiseSettledResult<Settings> | null;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const unsavedChanges = useRef(false);
  const settingsRequest = useRef(0);
  const previousRefresh = useRef(refreshedSettings);
  useEffect(() => {
    let active = true;
    const request = ++settingsRequest.current;
    void api<Settings>("/api/admin?action=hostedCheckout").then(verifyHostedCheckoutSettings).then(value => {
      if (active && request === settingsRequest.current) setSettings(value);
    }).catch(cause => { if (active && request === settingsRequest.current) setError(problem(cause)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    // A newly mounted panel reads fresh settings instead of replaying a result
    // retained from a previous tab. Only a new owner-action result updates it.
    if (previousRefresh.current === refreshedSettings) return;
    previousRefresh.current = refreshedSettings;
    if (!refreshedSettings) return;
    settingsRequest.current += 1;
    if (refreshedSettings.status === "fulfilled") {
      setSettings(current => mergeHostedCheckoutSettings(current, refreshedSettings.value, unsavedChanges.current));
      setError("");
    } else setError(problem(refreshedSettings.reason));
  }, [refreshedSettings]);
  function update<K extends keyof Settings>(field: K, value: Settings[K]) {
    unsavedChanges.current = true;
    setSettings(current => current ? { ...current, [field]: value } : current);
    setMessage("");
  }
  async function work(action: () => Promise<void>) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (cause) { setError(problem(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function loadItems() {
    await work(async () => {
      const catalog = await api<{items: Item[]}>("/api/admin", { action: "hostedCheckoutCatalog" });
      if (!Array.isArray(catalog.items)) throw new Error("QuickBooks service items could not be verified.");
      setItems(catalog.items.filter(item => item.active && item.type === "Service"));
      setMessage("QuickBooks service items loaded. No invoice was created.");
    });
  }
  async function save() {
    if (!settings || !isOwner) return;
    const current = settings;
    await work(async () => {
      const value = await api<Settings>("/api/admin", { action: "saveHostedCheckout", expectedRevision: current.revision,
        enabled: current.enabled, serviceItemId: current.serviceItemId, taxCode: current.taxCode,
        deliveryTerms: current.deliveryTerms, refundTerms: current.refundTerms,
        merchantConfirmed: current.merchantConfirmed, pciAcknowledged: current.pciAcknowledged,
        automaticInvoiceEmailDisabled: current.automaticInvoiceEmailDisabled });
      if (!Number.isSafeInteger(value.revision) || value.revision <= current.revision || value.enabled !== current.enabled)
        throw new Error("The saved checkout settings could not be confirmed. Reload before saving again.");
      unsavedChanges.current = false;
      setSettings(value); setMessage(value.enabled ? "Hosted checkout settings saved." : "Hosted checkout is disabled.");
      onSaved?.();
    });
  }
  const savedItemMissing = settings?.serviceItemId && !items?.some(item => item.id === settings.serviceItemId);
  return <section className="admin-hosted-checkout" aria-labelledby="hosted-checkout-heading">
    <div className="admin-section-heading"><div><h2 id="hosted-checkout-heading">QuickBooks-hosted checkout</h2>
      <p>Customers enter payment details on QuickBooks. Lineage Theatre creates a fixed-price invoice and checks its recorded payment.</p></div></div>
    {error && <p className="admin-inline-error" role="alert">{error}</p>}
    {message && <p className="admin-feedback info" role="status">{message}</p>}
    {!settings && !error && <p>Loading checkout settings…</p>}
    {settings && <>
      <p>{settings.reason || (settings.configured ? "Checkout settings are configured." : "Complete the invoice settings before enabling checkout.")}</p>
      <fieldset disabled={!isOwner || disabled || busy}>
        <legend>Invoice setup</legend>
        <label>QuickBooks service item
          <select value={settings.serviceItemId || ""} onChange={event => update("serviceItemId", event.target.value)}>
            <option value="">Select a service item</option>
            {savedItemMissing && <option value={settings.serviceItemId}>{settings.serviceItemName || `Saved item ${settings.serviceItemId}`}</option>}
            {items?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="action-group">
          <button type="button" className="button secondary small" onClick={() => void loadItems()}><RefreshCw size={15}/>Load QuickBooks items</button>
          <a className="text-button" href="https://qbo.intuit.com/app/items" target="_blank" rel="noopener noreferrer">Manage items in QuickBooks <ExternalLink size={14}/></a>
        </div>
        {items?.length === 0 && <p className="field-note">No active service item was found. Create the film service in QuickBooks with the correct income account and tax treatment, then reload this list.</p>}
        <p className="field-note">This checkout currently supports USD invoices for a confirmed non-taxable service. Confirm tax treatment with the person responsible for your books before selecting it.</p>
        <label className="consent"><input type="checkbox" checked={settings.taxCode === "NON"} onChange={event => update("taxCode", event.target.checked ? "NON" : "")}/>Film sales using this item are non-taxable.</label>
        <label>Delivery terms<textarea rows={4} maxLength={4000} value={settings.deliveryTerms || ""} onChange={event => update("deliveryTerms", event.target.value)} placeholder="State what the customer receives and when it will be delivered."/></label>
        <label>Cancellation and refund terms<textarea rows={4} maxLength={4000} value={settings.refundTerms || ""} onChange={event => update("refundTerms", event.target.value)} placeholder="State cancellation rights, refund conditions, deadlines, and how to request help."/></label>
        <p className="field-note">These terms appear with the fixed price before the customer continues. Saving terms does not activate film production.</p>
        <label className="consent"><input type="checkbox" checked={Boolean(settings.merchantConfirmed)} onChange={event => update("merchantConfirmed", event.target.checked)}/>I confirm that this company is approved to accept the offered payments through QuickBooks.</label>
        <label className="consent"><input type="checkbox" checked={Boolean(settings.pciAcknowledged)} onChange={event => update("pciAcknowledged", event.target.checked)}/>The business has reviewed its PCI responsibilities for QuickBooks-hosted checkout.</label>
        <a className="text-button" href="https://quickbooks.intuit.com/learn-support/en-us/help-article/data-security/quickbooks-pci-service-faqs/L7ipNg7n9_US_en_US" target="_blank" rel="noopener noreferrer">Review Intuit's PCI guidance <ExternalLink size={14}/></a>
        <label className="consent"><input type="checkbox" checked={Boolean(settings.automaticInvoiceEmailDisabled)} onChange={event => update("automaticInvoiceEmailDisabled", event.target.checked)}/>“Automatically send imported invoices” is off in QuickBooks Sales settings and will remain off for this integration.</label>
        <label className="consent"><input type="checkbox" checked={settings.enabled} onChange={event => update("enabled", event.target.checked)}/>Enable hosted checkout after the setup above is complete.</label>
        <button type="button" className="button primary" onClick={() => void save()}><Save size={16}/>{busy ? "Working…" : "Save checkout settings"}</button>
      </fieldset>
      {!isOwner && <p className="field-note">The owner manages these settings.</p>}
      <p className="field-note">Refunds for hosted invoices are managed in QuickBooks. Recording a payment does not confirm bank settlement or film delivery.</p>
    </>}
  </section>;
}
