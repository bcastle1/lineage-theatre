import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../studio/model";

type Check = { configured: boolean; authentication: "rejected" | "unconfirmed";
  code: string; checkedAt: string; generationSubmitted: false; productionReady: false;
  providerCode?: number; httpStatus?: number };

export default function MagicLightConnectionCheck({ disabled = false }: { disabled?: boolean }) {
  const [result, setResult] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function check() {
    if (disabled || lock.current) return;
    lock.current = true; setBusy(true); setError(""); setResult(null);
    try {
      const value = await api<Check>("/api/admin", { action: "checkMagicLightConnection" });
      if (typeof value?.configured !== "boolean" || !["rejected", "unconfirmed"].includes(value.authentication)
        || typeof value.code !== "string" || !/^MAGICLIGHT_[A-Z_]+$/.test(value.code)
        || !Number.isFinite(Date.parse(value.checkedAt)) || value.generationSubmitted !== false || value.productionReady !== false)
        throw new Error("The connection check returned an unexpected result. Refresh before checking again.");
      if (mounted.current) setResult(value);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The connection check could not complete.");
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="admin-hosted-checkout" aria-labelledby="magiclight-check-heading">
    <div className="admin-section-heading"><div>
      <h2 id="magiclight-check-heading">MagicLight connection</h2>
      <p>Send a task-status request with the saved production key. The key stays on the server. This check does not create a video.</p>
    </div><button type="button" className="button secondary small" disabled={disabled || busy} onClick={() => void check()}>
      <RefreshCw size={15} aria-hidden="true"/>{busy ? "Checking saved key…" : "Check saved key"}
    </button></div>
    {busy && <p role="status">Checking the production endpoint…</p>}
    {error && <p className="admin-inline-error" role="alert">{error}</p>}
    {result && <div className="admin-feedback info" role="status">
      <p>{!result.configured ? "This deployment has no saved MagicLight key."
        : result.authentication === "rejected" ? "MagicLight rejected authentication with the saved key."
        : "The check could not confirm authentication. The provider may reject the deliberately nonexistent task reference; this result alone does not show that the key is invalid."}</p>
      <p className="field-note">{result.code}
        {Number.isSafeInteger(result.providerCode) ? ` · Provider code ${result.providerCode}` : ""}
        {Number.isSafeInteger(result.httpStatus) ? ` · HTTP ${result.httpStatus}` : ""}
        {` · Checked ${new Date(result.checkedAt).toLocaleString()}`}</p>
    </div>}
  </section>;
}
