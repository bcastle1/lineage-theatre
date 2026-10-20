import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { api } from "./model";
import type { LibraryCoverage } from "./film-library";
import { verifiedOriginalPaymentReceipt } from "./original-payment-receipt";
import { createFilmReceiptHtml } from "./payment-receipt";

export default function OriginalPaymentReceipt({ coverage }: { coverage: LibraryCoverage }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  async function download() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const receipt = verifiedOriginalPaymentReceipt(await api(`/api/studio?action=receipt&id=${encodeURIComponent(coverage.orderId)}`), coverage);
      const url = URL.createObjectURL(new Blob([createFilmReceiptHtml(receipt)], { type: "text/html;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `Lineage-Theatre-original-receipt-${receipt.receiptId.slice(0, 12)}.html`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The original receipt could not be opened. Refresh this film's status and try again.");
    } finally { lock.current = false; setBusy(false); }
  }
  return <div>
    <button type="button" className="text-button" disabled={busy} onClick={() => void download()}>
      <Download size={15} aria-hidden="true" />{busy ? "Opening original receipt…" : "Download original payment receipt"}
    </button>
    {error && <p className="field-note" role="alert">{error}</p>}
  </div>;
}
