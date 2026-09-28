import { useEffect, useState } from "react";
import { Download, Film as FilmIcon, Loader2, RefreshCw } from "lucide-react";
import { api, type Film } from "./model";
import { getSourceBlob } from "../lib/storage";
import { uploadMedia } from "./media-library";

type Job = { id: string; title?: string; status: string; progress: number; message?: string; mediaUrl?: string; durationSeconds?: number };
type Availability = { available: boolean; message: string };
export default function LocalVideoPanel({ film, update }: { film: Film; update: (patch: Partial<Film>) => void }) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Job[]>([]);
  const endpoint = "/api/studio?local=1";
  const jobId = film.localVideoJobId;
  async function refresh() {
    try {
      setAvailability(await api<Availability>(`${endpoint}&action=capabilities`));
      if (jobId) setJob(await api<Job>(`${endpoint}&action=status&id=${encodeURIComponent(jobId)}`));
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "The local renderer could not be checked."); }
  }
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const [caps, result, recent] = await Promise.all([
          api<Availability>(`${endpoint}&action=capabilities`),
          jobId ? api<Job>(`${endpoint}&action=status&id=${encodeURIComponent(jobId)}`) : Promise.resolve(null),
          api<{jobs:Job[]}>(`${endpoint}&action=history`),
        ]);
        if (!cancelled) { setAvailability(caps); setJob(result); setHistory(recent.jobs || []); }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "The local renderer could not be checked."); }
    };
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [jobId]);
  const active = job?.status === "queued" || job?.status === "rendering";
  async function start() {
    setBusy("Preparing your photos…"); setError("");
    const requestId = film.localVideoRequestId || crypto.randomUUID();
    update({ localVideoRequestId: requestId });
    try {
      const photos = film.sources.filter(source => ["image/jpeg", "image/png", "image/webp"].includes(source.type));
      const scenes = film.scenes.map((scene, index) => ({ title: scene.title, narration: scene.narration || "", dialogue: scene.dialogue || "", visual: scene.visual || "",
        photoId: photos.find(photo => scene.sourceIds.includes(photo.id))?.id || photos[index % Math.max(photos.length, 1)]?.id }));
      const used = new Set(scenes.map(scene => scene.photoId).filter(Boolean));
      for (const photo of photos.filter(source => used.has(source.id))) {
        const stored = await getSourceBlob(photo.id);
        if (stored) await uploadMedia(new File([stored], photo.name, { type: photo.type }), photo.id, { id: film.id, title: film.title });
      }
      setBusy("Adding your film to the render queue…");
      const result = await api<Job>(endpoint, { filmId: film.id, requestId, consent: true, title: film.title || "Family archive", duration: film.duration, scenes });
      update({ localVideoJobId: result.id }); setJob(result);
    } catch (e) { setError(e instanceof Error ? e.message : "The render could not be started. Try again to check the same request."); }
    finally { setBusy(""); }
  }
  return <section className="local-video-panel" aria-labelledby="free-film-heading">
    <div className="section-subtitle"><h3 id="free-film-heading"><FilmIcon size={19} />Free archive film</h3><span className="eyebrow">$0 · Local rendering</span></div>
    <p>Turn your script and family photos into a narrated film with gentle photo motion, scene titles, and captions.</p>
    <p className="field-note">720p MP4 · Computer narration · Title cards for scenes without photos. Timing follows your narration. This option creates an archive film; animated scenes use the production option below.</p>
    <p className="field-note" role="status">{availability?.message || "Checking the local renderer…"}</p>
    {!active && job?.status !== "completed" && job?.status !== "failed" && <>
      <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={!!busy} />
        <span>Render this script and its photos on our local studio computer and save the finished film in my account.</span></label>
      <div className="action-group"><button className="button primary" disabled={!consent || !availability?.available || !film.scenes.length || !!busy} onClick={() => void start()}>
        {busy ? <Loader2 size={16} className="spin" /> : <FilmIcon size={16} />}{busy || "Create free archive film"}</button>
        <button className="text-button" onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={15} />Check renderer</button></div>
    </>}
    {active && <div className="render-progress" role="status"><p><Loader2 className="spin" size={16} />{job?.status === "queued" ? "Queued for local rendering" : `Rendering your film · ${job?.progress}%`}</p>
      <p>You can leave this page and return. Your render is saved to your account.</p><progress max="100" value={job?.progress || 0} aria-label="Local film rendering progress" /></div>}
    {job?.status === "failed" && <p role="alert">{job.message}</p>}
    {error && <p role="alert">{error}</p>}
    {job?.status === "completed" && job.mediaUrl && <div className="finished-film"><h3>Your archive film is ready</h3>
      <video controls playsInline preload="metadata" src={job.mediaUrl} onError={() => setError("Playback could not load. Refresh or download your film.")} />
      <a className="button secondary small" href={`${job.mediaUrl}&download=1`}><Download size={16} />Download MP4</a>
      <p className="field-note">{Math.round(job.durationSeconds || 0)} seconds · Saved privately to your account.</p></div>}
    {(job?.status === "completed" || job?.status === "failed" || error && film.localVideoRequestId) && <button className="text-button" disabled={!!busy || !!active} onClick={() => { update({ localVideoRequestId: undefined, localVideoJobId: undefined }); setJob(null); setConsent(false); setError(""); }}>Prepare a new render</button>}
    {history.some(item => item.id !== jobId) && <details><summary>Earlier archive films</summary><ul>{history.filter(item => item.id !== jobId).map(item => <li key={item.id}>
      <button className="text-button" disabled={!!busy || !!active} onClick={() => { update({localVideoJobId:item.id}); setJob(item); setError(""); }}>{item.title || "Family archive"} · {item.status}</button>
    </li>)}</ul></details>}
  </section>;
}
