import { useEffect, useRef, useState } from "react";
import { api } from "../studio/model";
import "./film-delivery.css";

type Job = { id: string; ownerEmail: string; title: string; projectId: string; status: "queued" | "processing" | "delivered" | "failed";
  attempts: number; updatedAt: string; error?: string; sizeBytes?: number };
type Page = { jobs: Job[]; automatic: boolean; cursor?: string };
const labels = { queued: "Queued for transfer", processing: "Copying and verifying", delivered: "Delivered to customer library", failed: "Needs attention" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Delivery could not be verified. Refresh before trying again.";

export default function FilmDelivery() {
  const [jobs, setJobs] = useState<Job[]>([]), [cursor, setCursor] = useState<string>();
  const [automatic, setAutomatic] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [ownerEmail, setOwner] = useState(""), [title, setTitle] = useState(""), [sourceUrl, setSource] = useState("");
  const [duration, setDuration] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const live = useRef(false), lock = useRef(false);
  async function refresh(next?: string) {
    const page = await api<Page>(`/api/film-delivery${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
    if (!live.current) return;
    setJobs(old => next ? [...old, ...page.jobs.filter(job => !old.some(item => item.id === job.id))] : page.jobs);
    setCursor(page.cursor); setAutomatic(page.automatic);
  }
  useEffect(() => {
    live.current = true;
    void refresh().catch(cause => { if (live.current) setError(errorText(cause)); }).finally(() => { if (live.current) setLoading(false); });
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    if (!jobs.some(job => ["queued", "processing"].includes(job.status))) return;
    const timer = setInterval(() => { if (!lock.current && document.visibilityState === "visible") void refresh().catch(() => {}); }, 15_000);
    return () => clearInterval(timer);
  }, [jobs]);
  async function action(body: object, success: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ job: Job }>("/api/film-delivery", body);
      if (!live.current) return;
      setMessage(result.job.status === "failed" ? "The transfer needs attention. Its details are below." : success);
      await refresh();
    } catch (cause) { if (live.current) { setError(errorText(cause)); await refresh().catch(() => {}); } }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  return <section className="admin-card film-delivery" aria-labelledby="film-delivery-heading">
    <div className="admin-section-heading"><div><h2 id="film-delivery-heading">Deliver a MagicLight film</h2>
      <p>Assign a finished website export to its customer. Lineage copies and verifies the MP4, then adds private playback and download to their film library.</p></div>
      <button type="button" className="text-button" disabled={busy || loading} onClick={() => void refresh().catch(cause => setError(errorText(cause)))}>Refresh deliveries</button></div>
    <p className="field-note">{automatic ? "The automatic worker checks queued exports every five minutes. Transfer now starts a queued delivery immediately."
      : "Automatic scheduling is not configured. Transfer now can complete a queued delivery."} Assigning the customer and export link is an administrator step. This does not generate a new video or charge the customer.</p>
    <form onSubmit={event => { event.preventDefault(); void action({ action: "enqueue", ownerEmail, title, sourceUrl, duration: Number(duration), assignmentConfirmed: confirmed }, "Delivery saved. The customer will receive the film in their private library after verification."); }}>
      <div className="film-delivery-fields">
        <label>Customer account email<input type="email" value={ownerEmail} required maxLength={254} disabled={busy} onChange={event => { setOwner(event.target.value); setConfirmed(false); }} /></label>
        <label>Film title<input value={title} required maxLength={200} disabled={busy} onChange={event => { setTitle(event.target.value); setConfirmed(false); }} /></label>
        <label className="film-delivery-wide">Finished MagicLight MP4 link<input type="url" value={sourceUrl} required maxLength={1024} placeholder="https://videocos.magiclight.ai/videos/…/….mp4" disabled={busy} onChange={event => { setSource(event.target.value); setConfirmed(false); }} /><small>Copy the finished video's address from MagicLight's video player. Up to 500 MB. Editor/project-page links do not contain a finished video.</small></label>
        <label>Runtime in seconds<input type="number" min="1" max="14400" step="any" value={duration} required disabled={busy} onChange={event => setDuration(event.target.value)} /></label>
      </div>
      <label className="film-delivery-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I verified that this film belongs to the customer account above and is ready for that customer to receive.</label>
      <button type="submit" className="button primary small" disabled={busy || !confirmed}>{busy ? "Working…" : "Queue customer delivery"}</button>
    </form>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading deliveries…</p>}
    <div className="film-delivery-jobs">{jobs.map(job => <article key={job.id}>
      <div><h3>{job.title}</h3><p>{job.ownerEmail}</p><p>{labels[job.status]}</p>
        <small>MagicLight project {job.projectId} · {new Date(job.updatedAt).toLocaleString()}</small>
        {job.error && <p role="alert">{job.error}</p>}</div>
      <div>{job.status === "queued" && <button type="button" className="text-button" disabled={busy} onClick={() => void action({ action: "transfer", id: job.id }, "Transfer verified. The film is available in the customer's library.")}>Transfer now</button>}
        {job.status === "failed" && <button type="button" className="text-button" disabled={busy} onClick={() => void action({ action: "retry", id: job.id }, "Delivery requeued. The existing export will be copied again without a new generation.")}>Retry delivery</button>}
        {job.status === "delivered" && <a href={`/api/archive?action=media&id=${job.id}&owner=${encodeURIComponent(job.ownerEmail)}`} target="_blank" rel="noreferrer">Review delivered video</a>}</div>
    </article>)}</div>
    {!loading && !jobs.length && !error && <p>No deliveries have been assigned yet.</p>}
    {cursor && <button className="text-button" disabled={busy} onClick={() => void refresh(cursor).catch(cause => setError(errorText(cause)))}>Load more deliveries</button>}
  </section>;
}
