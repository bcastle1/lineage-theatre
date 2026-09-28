import { useEffect, useState } from "react";
import { Download, Film as FilmIcon, Loader2, RefreshCw } from "lucide-react";
import { api, type Film } from "./model";

type Job = { id: string; mode?: string; title?: string; status: string; progress: number; message?: string; mediaUrl?: string; durationSeconds?: number };
type Availability = { available: boolean; message: string };
const endpoint = "/api/studio?local=ltx";

export default function AiVideoPanel({ film, update }: { film: Film; update: (patch: Partial<Film>) => void }) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = film.scenes.find(scene => scene.id === film.aiVideoSceneId) || film.scenes[0];
  const description = film.aiVideoPrompt ?? selected?.visual ?? "";
  const duration = film.aiVideoDuration || 2;
  const active = job?.status === "queued" || job?.status === "rendering";
  const locked = busy || !!active || !!film.aiVideoRequestId;

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const [caps, status, recent] = await Promise.all([
          api<Availability>(`${endpoint}&action=capabilities`),
          film.aiVideoJobId ? api<Job>(`${endpoint}&action=status&id=${encodeURIComponent(film.aiVideoJobId)}`) : Promise.resolve(null),
          api<{ jobs: Job[] }>(`${endpoint}&action=history`),
        ]);
        if (!cancelled) { setAvailability(caps); setJob(status); setHistory((recent.jobs || []).filter(item => item.mode !== "film")); }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "The AI renderer could not be checked."); }
    };
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [film.aiVideoJobId]);

  async function start() {
    if (!selected || !consent) return;
    setBusy(true); setError("");
    const requestId = film.aiVideoRequestId || crypto.randomUUID();
    update({ aiVideoRequestId: requestId, aiVideoPrompt: description, aiVideoSceneId: selected.id, aiVideoDuration: duration });
    try {
      const result = await api<Job>(endpoint, { filmId: film.id, requestId, consent: true,
        title: `${film.title || "Family story"} · ${selected.title}`.slice(0, 200), duration,
        scenes: [{ title: selected.title, visual: description }] });
      setJob(result); update({ aiVideoJobId: result.id });
    } catch (e) { setError(e instanceof Error ? e.message : "The AI scene could not be started. Retry to check the same request."); }
    finally { setBusy(false); }
  }

  return <section className="local-video-panel" aria-labelledby="ai-scene-heading">
    <div className="section-subtitle"><h3 id="ai-scene-heading"><FilmIcon size={19} />AI scene video</h3><span className="eyebrow">$0 · LTX-2.5</span></div>
    <p>Create a short scene with AI-generated movement and sound from a description.</p>
    <p className="field-note">1024 × 576 MP4 · 2 or 5 seconds · One scene per render. Images and sound are imagined from your text; reference photos and exact narration are not used. Rendering can take several minutes.</p>
    <p className="field-note" role="status">{availability?.message || "Checking the AI renderer…"}</p>
    {!film.scenes.length && <p>Add a scene to your script to prepare an AI video.</p>}
    {film.scenes.length > 0 && <>
      <label className="field"><span>Scene</span><select value={selected?.id || ""} disabled={locked} onChange={e => {
        const scene = film.scenes.find(item => item.id === e.target.value);
        update({ aiVideoSceneId: e.target.value, aiVideoPrompt: scene?.visual || "" });
      }}>{film.scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.title}</option>)}</select></label>
      <label className="field"><span>Describe the movement, setting, and sound</span><textarea rows={4} maxLength={1800} value={description} disabled={locked}
        placeholder="A slow camera move across a wooden shipyard at sunrise. An adult carpenter planes a plank. Quiet harbor sounds."
        onChange={e => update({ aiVideoPrompt: e.target.value })} /></label>
      <label className="field"><span>Clip length</span><select value={duration} disabled={locked} onChange={e => update({ aiVideoDuration: Number(e.target.value) as 2 | 5 })}>
        <option value={2}>2 seconds</option><option value={5}>5 seconds</option></select></label>
    </>}
    {!active && job?.status !== "completed" && job?.status !== "failed" && <>
      <label className="consent"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
        <span>Send this description to our local AI studio computer and save the generated clip privately in my account.</span></label>
      <div className="action-group"><button className="button primary" disabled={busy || !consent || !availability?.available || !selected || !description.trim()} onClick={() => void start()}>
        {busy ? <Loader2 size={16} className="spin" /> : <FilmIcon size={16} />}{busy ? "Adding your scene to the queue…" : "Create AI scene video"}</button>
        <button className="text-button" disabled={busy} onClick={() => { void api<Availability>(`${endpoint}&action=capabilities`).then(value => { setAvailability(value); setError(""); }).catch(e => setError(e.message)); }}><RefreshCw size={15} />Check AI renderer</button></div>
    </>}
    {active && <div className="render-progress" role="status"><p><Loader2 size={16} className="spin" />{job?.status === "queued" ? "Queued for AI rendering" : `Generating your scene · ${job?.progress}%`}</p>
      <p>You can leave this page and return. Your render is saved to your account.</p><progress max="100" value={job?.progress || 0} aria-label="AI scene rendering progress" /></div>}
    {job?.status === "failed" && <p role="alert">{job.message}</p>}
    {error && <p role="alert">{error}</p>}
    {job?.status === "completed" && job.mediaUrl && <div className="finished-film"><h3>Your AI scene is ready</h3>
      <video controls playsInline preload="metadata" src={job.mediaUrl} onError={() => setError("Playback could not load. Refresh or download your clip.")} />
      <a className="button secondary small" href={`${job.mediaUrl}&download=1`}><Download size={16} />Download MP4</a>
      <p className="field-note">{Math.round(job.durationSeconds || 0)} seconds · AI-generated scene · Saved privately to your account.</p></div>}
    {(job?.status === "completed" || job?.status === "failed" || error && film.aiVideoRequestId) && <button className="text-button" disabled={busy || !!active} onClick={() => {
      update({ aiVideoRequestId: undefined, aiVideoJobId: undefined }); setJob(null); setConsent(false); setError("");
    }}>Prepare another AI scene</button>}
    {history.some(item => item.id !== film.aiVideoJobId) && <details><summary>Earlier AI scenes</summary><ul>{history.filter(item => item.id !== film.aiVideoJobId).map(item => <li key={item.id}>
      <button className="text-button" disabled={busy || !!active} onClick={() => { update({ aiVideoJobId: item.id }); setJob(item); setError(""); }}>{item.title || "AI scene"} · {item.status}</button>
    </li>)}</ul></details>}
  </section>;
}
