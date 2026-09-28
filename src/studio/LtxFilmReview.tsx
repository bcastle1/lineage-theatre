import { useRef, useState } from "react";
import { api, formatDuration } from "./model";
import { ltxEndpoint, ltxStatus, type LtxJob } from "./ltx-film";
import { voiceName } from "./LtxVoicePicker";

export default function LtxFilmReview({ job, onChange }: { job: LtxJob; onChange: (job: LtxJob) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [checks, setChecks] = useState({ characters: false, narration: false, timing: false });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function review(decision: "approve" | "changes") {
    setBusy(true); setError("");
    try { onChange(await api<LtxJob>(`${ltxEndpoint}&action=review`, { id: job.id, sha256: job.mediaSha256, decision, checks, notes })); }
    catch (e) { setError(e instanceof Error ? e.message : "The review could not be saved."); }
    finally { setBusy(false); }
  }
  return <section className="ltx-review" aria-label={`Review ${job.title}`}>
    <div className="section-subtitle"><h3>{job.title}</h3><span className="eyebrow">{ltxStatus(job)}</span></div>
    {job.mediaUrl && <>
      <video ref={video} controls playsInline preload="metadata" src={job.mediaUrl} onError={() => setError("The film could not load. Refresh this page to retry.")} />
      <p className="field-note">{formatDuration(job.durationSeconds || 0)} · 1024 × 576 · {job.plan.scenes.length} scenes · Saved privately to your account</p>
      <a className="button secondary small" href={`${job.mediaUrl}&download=1`}>{job.status === "completed" ? "Download approved film" : "Download review copy"}</a>
      <h4>Review each scene</h4>
      <ol className="ltx-timeline">{job.timeline.map(scene => <li key={scene.id}>
        <button className="text-button" onClick={() => { if (video.current) { video.current.currentTime = scene.start; video.current.focus(); } }}>{formatDuration(scene.start)} · {scene.title}</button>
        <span className="field-note">{scene.shots} generated {scene.shots === 1 ? "shot" : "shots"} · {scene.referenceApplied ? "Character photo used" : "Text-guided scene"} · {scene.audioMode === "tts" ? `${voiceName(scene.voice || job.plan.scenes.find(item => item.id === scene.id)?.voice || job.plan.voice)} · ${scene.speed ?? job.plan.speed ?? 1}× pace` : scene.audioMode === "recording" ? "Your recording" : "Silent"}</span>
        <details><summary>Scene direction and narration</summary><p>{job.plan.scenes.find(item => item.id === scene.id)?.visual}</p><p className="ltx-transcript">{job.plan.scenes.find(item => item.id === scene.id)?.narration || "No narration script."}</p></details>
      </li>)}</ol>
    </>}
    {job.review && <p role="status">{job.status === "completed" ? "Approved" : "Changes requested"} on {new Date(job.review.at).toLocaleString()}{job.review.notes ? ` — ${job.review.notes}` : ""}</p>}
    {job.status === "review" && <fieldset disabled={busy} className="ltx-checks"><legend>Finish your review</legend>
      <p className="field-note">Watch the entire film. Reference images guide appearance; review every scene for identity drift, unusual movement, and factual errors.</p>
      {([['characters', 'I reviewed character appearance and continuity.'], ['narration', 'I listened to the narration and checked its words.'], ['timing', 'I reviewed scene order, timing, and the complete ending.']] as const).map(([key, label]) =>
        <label className="consent" key={key}><input type="checkbox" checked={checks[key]} onChange={e => setChecks({ ...checks, [key]: e.target.checked })} /><span>{label}</span></label>)}
      <label className="field"><span>Review notes</span><textarea maxLength={2000} rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe any scene that needs another pass." /></label>
      <div className="action-group"><button className="button primary" disabled={!Object.values(checks).every(Boolean)} onClick={() => void review("approve")}>{busy ? "Saving review…" : "Approve finished film"}</button>
        <button className="button secondary" disabled={!notes.trim()} onClick={() => void review("changes")}>Request changes</button></div>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
