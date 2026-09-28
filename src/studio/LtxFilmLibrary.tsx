import { useEffect, useState } from "react";
import { api } from "./model";
import { ltxEndpoint, ltxStatus, type LtxJob } from "./ltx-film";
import LtxFilmReview from "./LtxFilmReview";
import "./ltx-film.css";

export default function LtxFilmLibrary() {
  const [jobs, setJobs] = useState<LtxJob[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try { const result = await api<{ jobs: LtxJob[] }>(`${ltxEndpoint}&action=history`);
        if (!cancelled) { setJobs(result.jobs.filter(job => job.mode === "film")); setLoaded(true); setError(""); } }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Your LTX films could not load."); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const current = jobs.find(job => job.id === selected);
  return <section className="ltx-library" aria-labelledby="ltx-library-heading">
    <h2 id="ltx-library-heading">LTX films</h2><p>Generated footage, your narration, and a saved review. These versions are stored in your account.</p>
    {error && <p role="alert">{error}</p>}
    {!loaded && !error && <p role="status">Loading LTX films…</p>}
    {loaded && !jobs.length && <p className="field-note">Open a film draft and choose Create & watch → LTX full film to make your first version.</p>}
    <ul className="ltx-library-list">{jobs.map(job => <li key={job.id}><button className="button secondary" onClick={() => setSelected(job.id)} aria-pressed={selected === job.id}>{job.title} · {ltxStatus(job)} · {new Date(job.createdAt).toLocaleString()}</button></li>)}</ul>
    {current && (current.mediaUrl ? <LtxFilmReview key={current.id} job={current} onChange={changed => setJobs(previous => previous.map(job => job.id === changed.id ? changed : job))} />
      : <p role="status">{ltxStatus(current)}{current.message ? ` — ${current.message}` : ". Return here to review the finished render."}</p>)}
  </section>;
}
