import { normalizeHostedInvoiceUrl } from "./checkout-contract";

// Called synchronously from the customer's click. Navigation happens only after
// the saved order returns an allowlisted hosted payment URL.
export function reservePaymentWindow(openWindow: () => Window | null = () => window.open("about:blank", "_blank")) {
  let tab: Window | null = null;
  function close() { try { tab?.close(); } catch { /* A user may have closed it already. */ } tab = null; }
  try {
    tab = openWindow();
    if (tab) {
      tab.opener = null;
      tab.document.title = "Preparing your secure payment page";
      tab.document.body.textContent = "Preparing your secure payment page. You can return to Lineage Theatre while this loads.";
    }
  } catch { close(); }
  return {
    open(value: string) {
      const url = normalizeHostedInvoiceUrl(value);
      if (!url || !tab || tab.closed) { close(); return false; }
      try { tab.location.replace(url); tab = null; return true; }
      catch { close(); return false; }
    },
    close,
  };
}
