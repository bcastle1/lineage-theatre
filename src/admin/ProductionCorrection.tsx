import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api } from "../studio/model";
import { libraryFilmLink } from "../studio/film-library";
import { productionCorrectionRequest, verifyProductionCorrection, type ProductionCorrectionInput, type ProductionCorrection } from "./production-correction";

const empty: ProductionCorrectionInput = { originalOrderId: "", preparedId: "", manifestHash: "", budget: "", reason: "", confirmed: false };
export default function ProductionCorrectionPanel({ disabled, actionLock, onBusyChange }: {
  disabled: boolean; actionLock: MutableRefObject<boolean>; onBusyChange: (busy: boolean) => void;
}) {
  const [input, setInput] = useState(empty), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [correction, setCorrection] = useState<ProductionCorrection | null>(null);
  const [attempt, setAttempt] = useState<ReturnType<typeof productionCorrectionRequest> | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function change(key: keyof ProductionCorrectionInput, value: string | boolean) {
    setInput(current => ({ ...current, [key]: value, ...(key !== "confirmed" ? { confirmed: false } : {}) }));
    setError(""); setCorrection(null);
  }
  async function submit() {
    if (disabled || busy || actionLock.current || correction) return;
    let request: ReturnType<typeof productionCorrectionRequest>;
    try { request = attempt ?? productionCorrectionRequest(input); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Review the correction fields."); return; }
    actionLock.current = true; setBusy(true); onBusyChange(true); setError(""); setAttempt(request);
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 65_000);
    try {
      const saved = verifyProductionCorrection(await api("/api/admin", request, { signal: controller.signal }), request);
      if (mounted.current) setCorrection(saved);
    } catch (cause) {
      if (mounted.current) setError(`${controller.signal.aborted ? "The correction request did not respond in time." : cause instanceof Error ? cause.message : "The correction result could not be confirmed."} Review the corrected film's saved status. Retrying here uses this exact correction request.`);
    } finally {
      window.clearTimeout(timeout);
      actionLock.current = false; onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }
  const blocked = disabled || busy, fieldsLocked = blocked || Boolean(attempt);
  return <details className="admin-hosted-checkout">
    <summary>Produce corrected version using original payment</summary>
    <p>Owner action: authorize one corrected saved film under its original customer payment. The studio covers production within the approved budget. No new customer invoice or payment is requested.</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={fieldsLocked}>
        <legend>Exact payment and corrected saved version</legend>
        <label>Original order reference<input value={input.originalOrderId} onChange={event => change("originalOrderId", event.target.value)} required maxLength={64} autoComplete="off" /></label>
        <label>Corrected saved plan ID<input value={input.preparedId} onChange={event => change("preparedId", event.target.value)} required maxLength={36} autoComplete="off" /></label>
        <label>Corrected plan manifest hash<input value={input.manifestHash} onChange={event => change("manifestHash", event.target.value)} required maxLength={64} autoComplete="off" /></label>
        <label>Maximum production cost (USD)<input type="number" min="0.01" max="19.80" step="0.01" inputMode="decimal" value={input.budget} onChange={event => change("budget", event.target.value)} required /></label>
        <label>Correction reason<textarea value={input.reason} onChange={event => change("reason", event.target.value)} required minLength={10} maxLength={500} rows={3} /></label>
        <label className="consent"><input type="checkbox" checked={input.confirmed} onChange={event => change("confirmed", event.target.checked)} />
          I verified these references and authorize one corrected film within this production budget, covered by the original payment with no additional customer charge.</label>
      </fieldset>
      <button type="submit" className="button primary small" disabled={blocked || !input.confirmed || Boolean(correction)}>
        {busy ? "Saving correction…" : correction ? "Correction authorized" : attempt ? "Retry this exact correction" : "Authorize corrected film"}
      </button>
    </form>
    {attempt && !correction && <p className="field-note">The submitted references and budget stay fixed so a retry cannot authorize a different correction.</p>}
    {error && <p role="alert">{error}</p>}
    {correction && <p role="status">Correction authorized using the original payment. No additional customer payment was created. Open the corrected film to follow its production status.</p>}
    {attempt && <p><a className="text-button" href={libraryFilmLink(attempt.preparedId)}>View corrected film status</a></p>}
  </details>;
}
