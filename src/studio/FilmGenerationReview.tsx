import { useEffect, useRef, useState } from "react";
import { api } from "./model";
import type { GenerationIdentity } from "./generation-attempt";
import { normalizeGenerationReview, type GenerationReview } from "./generation-review";
import { libraryFilmLink } from "./film-library";

export default function FilmGenerationReview({ onApproved, ...identity }: GenerationIdentity & { onApproved?: () => void }) {
  const [review, setReview] = useState<GenerationReview | null>(null), [error, setError] = useState("");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [previewError, setPreviewError] = useState(false);
  const context = JSON.stringify(identity), latest = useRef(context), lock = useRef(false), mounted = useRef(false);
  const revision = useRef(0), shownArtifact = useRef<string | undefined>(undefined);
  latest.current = context;
  shownArtifact.current = review && review.status !== "needs-attention" ? review.artifactSha256 : undefined;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true, reading = false;
    setReview(null); setConsent(false); setError("");
    const refresh = async () => {
      if (reading || lock.current || document.visibilityState !== "visible") return;
      reading = true;
      const expectedRevision = revision.current;
      try {
        const saved = normalizeGenerationReview(await api(`/api/studio?action=generationReview&id=${identity.preparedId}`), identity);
        if (active && expectedRevision === revision.current) {
          if ((saved && saved.status !== "needs-attention" ? saved.artifactSha256 : undefined) !== shownArtifact.current) { setConsent(false); setPreviewError(false); }
          setReview(saved); setError("");
        }
      } catch { if (active && expectedRevision === revision.current) setError("The generated film review could not be loaded. Your saved request remains recorded."); }
      finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000), returned = () => void refresh();
    window.addEventListener("focus", returned); document.addEventListener("visibilitychange", returned);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", returned); document.removeEventListener("visibilitychange", returned); };
  }, [context]);
  async function approve() {
    if (!review || !consent || lock.current || previewError || review.status !== "awaiting-review") return;
    revision.current++; lock.current = true; setBusy(true); setError("");
    const expected = context;
    try {
      const result = normalizeGenerationReview(await api("/api/studio", { action: "approveGeneration", preparedId: identity.preparedId, artifactSha256: review.artifactSha256, consent: true }), identity);
      if (!result || result.status !== "approved" || result.artifactSha256 !== review.artifactSha256) throw new Error("The reviewed film approval could not be verified. Refresh its saved status.");
      if (mounted.current && latest.current === expected) { setReview(result); setConsent(false); onApproved?.(); }
    } catch (cause) { if (mounted.current && latest.current === expected) setError(cause instanceof Error ? cause.message : "Film approval could not be confirmed."); }
    finally { lock.current = false; if (mounted.current && latest.current === expected) setBusy(false); }
  }
  const current = review && Object.entries(identity).every(([key, item]) => review[key as keyof GenerationIdentity] === item) ? review : null;
  return <section aria-label="Generated film review">
    {!current ? <p>The returned video is waiting for duration, audio, and playback verification.</p> : current.status === "needs-attention" ? <p className="feedback" role="status">{current.message}</p> : current.status === "approved" ? <>
      <p>Your reviewed film is complete. Open its saved library version to watch and download it.</p>
      <a className="button primary small" href={libraryFilmLink(identity.preparedId)}>Open finished film</a>
    </> : <>
      <h4>Review your generated film</h4>
      <p>The video passed duration, audio, and playback checks. Watch this first run and confirm that its scenes and narration match the saved screenplay before publishing it as the finished film.</p>
      <video key={current.artifactSha256} className="film-player" controls preload="metadata" src={current.previewUrl} aria-label="Generated film for review" onError={() => { if (shownArtifact.current === current.artifactSha256) { setConsent(false); setPreviewError(true); } }} />
      {previewError && <p className="feedback error">This video could not be played. Reload its review before approving it.</p>}
      <label className="check-label"><input type="checkbox" checked={consent} disabled={busy || previewError} onChange={event => setConsent(event.target.checked)} /><span>I reviewed this video and confirm that its scenes and narration match my saved film.</span></label>
      <button className="button primary small" disabled={!consent || busy || previewError} onClick={() => void approve()}>{busy ? "Saving reviewed film…" : "Approve finished film"}</button>
    </>}
    {error && <p className="feedback error" role="alert">{error}</p>}
  </section>;
}
