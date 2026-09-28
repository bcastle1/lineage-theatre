import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Video } from "lucide-react";
import { api } from "./model";
import { generationStatusLabel, normalizeGenerationAttempt, type GenerationAttempt, type GenerationIdentity } from "./generation-attempt";
import FilmProductionProgress from "./FilmProductionProgress";
import FilmGenerationReview from "./FilmGenerationReview";

export default function FilmGenerationStatus({ allowed, onStatus, onApproved, ...identity }: GenerationIdentity & {
  allowed: boolean; onStatus?: (attempt: GenerationAttempt | null) => void; onApproved?: () => void;
}) {
  const [attempt, setAttempt] = useState<GenerationAttempt | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [consent, setConsent] = useState(false), [now, setNow] = useState(Date.now());
  const context = JSON.stringify(identity), latest = useRef(context), callback = useRef(onStatus), lock = useRef(false);
  const mounted = useRef(false), revision = useRef(0);
  latest.current = context; callback.current = onStatus;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!allowed) return;
    let active = true, reading = false;
    setAttempt(null); setLoading(true); setConsent(false); setError(""); callback.current?.(null);
    const refresh = async () => {
      if (reading || lock.current || document.visibilityState !== "visible") return;
      reading = true;
      const requestRevision = revision.current;
      try {
        const saved = normalizeGenerationAttempt(await api(`/api/studio?action=generationAttempt&id=${encodeURIComponent(identity.preparedId)}`), identity);
        if (active && requestRevision === revision.current) { setAttempt(saved); callback.current?.(saved); setError(""); }
      } catch { if (active && requestRevision === revision.current) setError("The generation status could not be checked. Refresh before starting another request."); }
      finally { reading = false; if (active) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const returned = () => void refresh();
    window.addEventListener("focus", returned); document.addEventListener("visibilitychange", returned);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", returned); document.removeEventListener("visibilitychange", returned); };
  }, [allowed, context]);
  useEffect(() => {
    if (!attempt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [attempt?.submittedAt]);
  async function act(start: boolean) {
    if (lock.current || !allowed || start && (!consent || attempt || loading || error)) return;
    const expectedContext = context;
    revision.current++;
    lock.current = true; setBusy(true); setError("");
    try {
      const value = await api("/api/studio", start
        ? { action: "requestFilmGeneration", preparedId: identity.preparedId, orderId: identity.orderId, consent: true }
        : { action: "checkFilmGeneration", preparedId: identity.preparedId });
      const saved = normalizeGenerationAttempt(value, identity);
      if (mounted.current && latest.current === expectedContext) { setAttempt(saved); callback.current?.(saved); }
    } catch (cause) {
      if (mounted.current && latest.current === expectedContext) setError(cause instanceof Error ? cause.message : "Generation could not be confirmed. Check the saved request before continuing.");
    } finally { lock.current = false; if (mounted.current && latest.current === expectedContext) setBusy(false); }
  }
  if (!allowed) return null;
  const current = attempt && Object.entries(identity).every(([key, item]) => attempt[key as keyof GenerationIdentity] === item) ? attempt : null;
  const elapsedMinutes = current ? Math.max(0, Math.floor((now - Date.parse(current.submittedAt)) / 60_000)) : 0;
  return <section className="film-price-review" aria-label="Film generation">
    <h4>{current ? generationStatusLabel(current) : "Create your paid film"}</h4>
    <FilmProductionProgress paid ready={false} status={current?.status || (loading ? undefined : "prepared")} />
    {current ? <>
      <p>Requested {new Date(current.submittedAt).toLocaleString()} · {elapsedMinutes} minutes elapsed.</p>
      <p>Generation time estimate: not available yet. This is an initial full-film attempt; completion timing has not been established.</p>
      <p>{current.status === "verifying" ? "A video result was returned. Watch film unlocks after its technical checks and content review are complete."
        : ["failed", "uncertain"].includes(current.status) ? "This saved request needs administrator review. No replacement generation is sent automatically. Your payment is recorded."
          : "Your saved screenplay has been submitted once. This page updates as the saved request progresses. You can return to this film in your library."}</p>
    </> : <>
      <p>Use your saved paid screenplay for the first generation run. Completion timing, the requested duration, and audio are still being verified. A returned clip will not be labeled as your finished film until it passes those checks.</p>
      <label className="check-label"><input type="checkbox" checked={consent} disabled={busy || loading} onChange={event => setConsent(event.target.checked)} /><span>Start one generation attempt for this paid version.</span></label>
      <button className="button primary small" disabled={busy || loading || !consent || Boolean(error)} onClick={() => void act(true)}><Video size={16} />Start film generation</button>
    </>}
    {current && <button className="button secondary small" disabled={busy} onClick={() => void act(false)}><RefreshCw size={15} />Check generation status</button>}
    {current?.status === "verifying" && <FilmGenerationReview key={context} {...identity} onApproved={onApproved} />}
    {(busy || loading) && <p role="status"><Loader2 size={15} className="spin" /> Checking your saved generation…</p>}
    {error && <p className="feedback error" role="alert">{error}</p>}
  </section>;
}
