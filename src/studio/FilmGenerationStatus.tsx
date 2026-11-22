import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "./model";
import { generationStatusLabel, generationAttemptExplanation, generationDiagnosticExplanation, normalizeGenerationAttempt, type GenerationAttempt, type GenerationIdentity } from "./generation-attempt";
import FilmProductionProgress from "./FilmProductionProgress";
import FilmGenerationReview from "./FilmGenerationReview";

export default function FilmGenerationStatus({ allowed, onStatus, onApproved, ...identity }: GenerationIdentity & {
  allowed: boolean; onStatus?: (attempt: GenerationAttempt | null) => void; onApproved?: () => void;
}) {
  const [attempt, setAttempt] = useState<GenerationAttempt | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const context = JSON.stringify(identity), latest = useRef(context), callback = useRef(onStatus), lock = useRef(false);
  const mounted = useRef(false), revision = useRef(0);
  latest.current = context; callback.current = onStatus;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!allowed) return;
    let active = true, reading = false;
    setAttempt(null); setLoading(true); setBusy(false); setError(""); callback.current?.(null);
    const refresh = async () => {
      if (reading || lock.current || document.visibilityState !== "visible") return;
      reading = true;
      const requestRevision = revision.current;
      try {
        const saved = normalizeGenerationAttempt(await api(`/api/studio?action=generationAttempt&id=${encodeURIComponent(identity.preparedId)}`), identity);
        if (active && requestRevision === revision.current) { setAttempt(saved); callback.current?.(saved); setError(""); }
      } catch { if (active && requestRevision === revision.current) setError("The generation status could not be checked. Refresh to check the saved request."); }
      finally { reading = false; if (active) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const returned = () => void refresh();
    window.addEventListener("focus", returned); document.addEventListener("visibilitychange", returned);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", returned); document.removeEventListener("visibilitychange", returned); };
  }, [allowed, context]);
  async function checkStatus() {
    if (lock.current || !allowed || !attempt) return;
    const expectedContext = context;
    revision.current++;
    lock.current = true; setBusy(true); setError("");
    try {
      const value = await api("/api/studio", { action: "checkFilmGeneration", preparedId: identity.preparedId });
      const saved = normalizeGenerationAttempt(value, identity);
      if (mounted.current && latest.current === expectedContext) { setAttempt(saved); callback.current?.(saved); }
    } catch (cause) {
      if (mounted.current && latest.current === expectedContext) setError(cause instanceof Error ? cause.message : "Generation could not be confirmed. Check the saved request before continuing.");
    } finally { lock.current = false; if (mounted.current && latest.current === expectedContext) setBusy(false); }
  }
  if (!allowed) return null;
  const current = attempt && Object.entries(identity).every(([key, item]) => attempt[key as keyof GenerationIdentity] === item) ? attempt : null;
  const diagnosticExplanation = current ? generationDiagnosticExplanation(current) : null;
  return <section className="film-price-review" aria-label="Film generation">
    <h4>{current ? generationStatusLabel(current) : "Previous production request"}</h4>
    <FilmProductionProgress paid ready={false} status={current?.recovery ? "uncertain" : current?.status || (loading ? undefined : "prepared")} />
    {current ? <>
      <p>Request recorded {new Date(current.submittedAt).toLocaleString()}.</p>
      <p>Generation time estimate: not available yet. This is an initial full-film attempt; completion timing has not been established.</p>
      <p>{generationAttemptExplanation(current)}</p>
      {diagnosticExplanation && <div className="feedback warning" role="status">
        <p>{diagnosticExplanation}</p>
        {current.diagnostic && <p className="field-note">Recorded response: {current.diagnostic.code}
          {current.diagnostic.httpStatus !== undefined ? ` · HTTP ${current.diagnostic.httpStatus}` : ""}
          {current.diagnostic.providerCode !== undefined ? ` · Provider code ${current.diagnostic.providerCode}` : ""}
          {current.diagnostic.stage !== undefined ? ` · Stage: ${current.diagnostic.stage}` : ""}</p>}
        {current.recovery && <p>This saved request needs operator review. Its payment and screenplay are preserved.</p>}
      </div>}
    </> : !loading && !error && <p>No earlier generation request was found for this paid film.</p>}
    {current && <button className="button secondary small" disabled={busy} onClick={() => void checkStatus()}><RefreshCw size={15} />Check generation status</button>}
    {current?.status === "verifying" && <FilmGenerationReview key={context} {...identity} onApproved={onApproved} />}
    {(busy || loading) && <p role="status"><Loader2 size={15} className="spin" /> Checking your saved generation…</p>}
    {error && <p className="feedback error" role="alert">{error}</p>}
  </section>;
}
