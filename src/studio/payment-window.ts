import { normalizeHostedInvoiceUrl } from "./checkout-contract";

// Called synchronously from the customer's click. Navigation happens only after
// the saved order returns an allowlisted hosted payment URL.
export function reservePaymentWindow(openWindow: () => Window | null = () => window.open("about:blank", "_blank")) {
  let tab: Window | null = null;
  let opened = false;
  function close() { if (opened) return; try { tab?.close(); } catch { /* A user may have closed it already. */ } tab = null; }
  try {
    tab = openWindow();
    if (tab) {
      // Keep the normal popup relationship for the allowlisted Intuit flow.
      // Detaching it prevents browsers from returning the payment tab. Never
      // accept child-window messages as payment proof or open arbitrary hosts.
      tab.document.title = "Preparing your secure payment page";
      tab.document.body.textContent = "Preparing your secure payment page. You can return to Lineage Theatre while this loads.";
    }
  } catch { close(); }
  return {
    open(value: string) {
      const url = normalizeHostedInvoiceUrl(value);
      if (!url || !tab || tab.closed) { close(); return false; }
      try { tab.location.replace(url); opened = true; return true; }
      catch { close(); return false; }
    },
    complete(orderId: string) {
      if (!/^[a-f0-9]{64}$/.test(orderId) || !opened || !tab) return false;
      try {
        if (tab.closed) return false;
        // A server-confirmed order is the only completion signal. The return
        // destination is always this app; no payment-document data is read.
        tab.location.replace(`${window.location.origin}/${paymentReturnLink(orderId)}`);
        return true;
      } catch { return false; } // Browser isolation may sever a payment window.
      finally { tab = null; }
    },
    close,
  };
}

export function paymentReturnLink(orderId: string) {
  if (!/^[a-f0-9]{64}$/.test(orderId)) throw new Error("Choose a saved payment.");
  return `#paid-film?order=${orderId}`;
}
export function paymentReturnOrder(hash: string) {
  return /^#paid-film\?order=([a-f0-9]{64})$/.exec(hash)?.[1] || null;
}
const paymentWindows = new Map<string, ReturnType<typeof reservePaymentWindow>>();
export function rememberPaymentWindow(orderId: string, handle: ReturnType<typeof reservePaymentWindow>) {
  paymentReturnLink(orderId); paymentWindows.set(orderId, handle);
}
export function completePaymentWindow(orderId: string) {
  const handle = paymentWindows.get(orderId); paymentWindows.delete(orderId);
  return handle?.complete(orderId) || false;
}
export function releasePaymentWindows() { paymentWindows.clear(); }
