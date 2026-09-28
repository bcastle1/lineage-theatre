import { useEffect, useState } from "react";
import { Film as FilmIcon, Loader2, ArrowUp, ArrowDown } from "lucide-react";
import { api, type Film } from "./model";
import { uploadMedia, type MediaItem, type MediaPage } from "./media-library";
import { filmPlan, ltxEndpoint, ltxStatus, type LtxDraft, type LtxJob, type LtxScene } from "./ltx-film";
import LtxFilmReview from "./LtxFilmReview";
import "./ltx-film.css";

export default function LtxFilmPanel({ film, update }: { film: Film; update: (patch: Partial<Film>) => void }) {
  const [available, setAvailable] = useState(false);
  const [job, setJob] = useState<LtxJob | null>(null);
  const [history, setHistory] = useState<LtxJob[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const plan = filmPlan(film);
  const active = job?.status === "queued" || job?.status === "rendering";
  const locked = !!busy || !!active || !!film.ltxFilmRequestId || !!job;
  const draft = film.ltxFilmDraft || {};
  const change = (patch: Partial<LtxDraft>) => update({ ltxFilmDraft: { ...draft, ...patch } });
  const sceneChange = (id: string, patch: Partial<LtxScene>) => change({ scenes: { ...draft.scenes, [id]: { ...draft.scenes?.[id], ...patch } } });
  const images = media.filter(item => ["image/jpeg", "image/png", "image/webp"].includes(item.contentType));
  const audio = media.filter(item => item.contentType.startsWith("audio/"));
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [caps, recent, current] = await Promise.all([
          api<{ available: boolean }>(`${ltxEndpoint}&action=capabilities`), api<{ jobs: LtxJob[] }>(`${ltxEndpoint}&action=history`),
          film.ltxFilmJobId ? api<LtxJob>(`${ltxEndpoint}&action=status&id=${encodeURIComponent(film.ltxFilmJobId)}`) : Promise.resolve(null),
        ]);
        if (!cancelled) { setAvailable(caps.available); setJob(current); setHistory(recent.jobs.filter(item => item.mode === "film" && item.filmId === film.id)); }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "The film queue could not be checked."); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [film.id, film.ltxFilmJobId]);
  useEffect(() => {
    let cancelled = false;
    void api<MediaPage>("/api/media?scope=customer&view=active").then(page => { if (!cancelled) { setMedia(page.items.filter(item => item.status === "ready")); setCursor(page.cursor); } })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  async function moreMedia() {
    if (!cursor) return;
    setBusy("Loading sources…"); setError("");
    try { const page = await api<MediaPage>(`/api/media?scope=customer&view=active&cursor=${encodeURIComponent(cursor)}`);
      setMedia(previous => [...new Map([...previous, ...page.items.filter(item => item.status === "ready")].map(item => [item.id, item])).values()]); setCursor(page.cursor); }
    catch (e) { setError(e instanceof Error ? e.message : "Sources could not load."); }
    finally { setBusy(""); }
  }
  async function upload(file: File | undefined, assign: (id: string) => void) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setError("Choose a source smaller than 20 MB."); return; }
    setBusy("Saving your source…"); setError("");
    try { const item = await uploadMedia(file, crypto.randomUUID(), { id: film.id, title: film.title }); setMedia(previous => [...previous, item]); assign(item.id); }
    catch (e) { setError(e instanceof Error ? e.message : "The source could not be saved."); }
    finally { setBusy(""); }
  }
  function move(id: string, delta: number) {
    const ids = plan.scenes.map(scene => scene.id), index = ids.indexOf(id), target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]]; change({ order: ids });
  }
  async function start() {
    if (!consent || !plan.scenes.length) return;
    setBusy("Adding your film to the queue…"); setError("");
    const requestId = film.ltxFilmRequestId || crypto.randomUUID();
    const submission = film.ltxFilmSubmission || { ...plan, title: film.title || "Family film" };
    update({ ltxFilmRequestId: requestId, ltxFilmSubmission: submission });
    try { const result = await api<LtxJob>(ltxEndpoint, { ...submission, mode: "film", filmId: film.id, requestId, consent: true });
      setJob(result); update({ ltxFilmJobId: result.id }); }
    catch (e) { setError(e instanceof Error ? e.message : "The film could not be queued. Retry to check the same request."); }
    finally { setBusy(""); }
  }
  return <section className="local-video-panel ltx-film-panel" aria-labelledby="ltx-film-heading">
    <div className="section-subtitle"><h3 id="ltx-film-heading"><FilmIcon size={19} />LTX full film</h3><span className="eyebrow">Local production</span></div>
    <p>Turn every scene into generated footage, add your chosen narration, and review the assembled film.</p>
    <p className="field-note">1024 × 576 · Up to 30 scenes and 10 minutes. Rendering can take much longer than playback. Keep the studio PC awake. Your film is saved to your account.</p>
    <p role="status" className="field-note">{available ? "LTX renderer is online." : "The LTX renderer is offline. You can prepare your film and review saved versions."}</p>
    {!plan.scenes.length && <p>Add scenes in Review script & cast to prepare a full film.</p>}
    <fieldset disabled={locked} className="ltx-settings"><legend>Prepare your film</legend>
      <p className="field-note">New uploads save to your private media library with administrator access. Choose only photos and recordings you have permission to use.</p>
      <label className="field"><span>Local narrator</span><select value={plan.voice} onChange={e => change({ voice: e.target.value as "david" | "zira" })}><option value="zira">Zira · English</option><option value="david">David · English</option></select></label>
      <details open={plan.characters.length > 0}><summary>Character references ({plan.characters.length})</summary>
        <p className="field-note">Assign a reusable appearance photo to each character, then choose the lead reference for each scene. One photo guides each scene's opening; later shots continue from the preceding frame. Likeness can vary and needs review.</p>
        <div className="ltx-cast">{plan.characters.map(character => <div className="ltx-character" key={character.id}>
          <label className="field"><span>{character.name} · reference photo</span><select value={character.photoId || ""} onChange={e => change({ photos: { ...draft.photos, [character.id]: e.target.value } })}>
            <option value="">No reference photo</option>{images.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          {media.find(item => item.id === character.photoId)?.mediaUrl && <img className="ltx-reference" src={media.find(item => item.id === character.photoId)!.mediaUrl} alt={`Appearance reference for ${character.name}`} />}
          <label className="field"><span>Upload a photo for {character.name}</span><input type="file" accept=".jpg,.jpeg,.png,.webp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void upload(file, id => change({ photos: { ...draft.photos, [character.id]: id } })); }} /></label>
        </div>)}</div>
      </details>
      {cursor && <button className="text-button" onClick={() => void moreMedia()}>Load more library sources</button>}
      <div className="ltx-scene-list">{plan.scenes.map((scene, index) => <details className="ltx-scene" key={scene.id} open={index === 0}>
        <summary>{index + 1}. {scene.title}</summary>
        <div className="action-group"><button className="text-button" disabled={locked || index === 0} onClick={() => move(scene.id, -1)} aria-label={`Move ${scene.title} earlier`}><ArrowUp size={14} />Earlier</button><button className="text-button" disabled={locked || index === plan.scenes.length - 1} onClick={() => move(scene.id, 1)} aria-label={`Move ${scene.title} later`}><ArrowDown size={14} />Later</button></div>
        <label className="field"><span>Scene {index + 1} visual direction</span><textarea rows={3} maxLength={1800} value={scene.visual} onChange={e => sceneChange(scene.id, { visual: e.target.value })} /></label>
        <label className="field"><span>Scene {index + 1} reference character</span><select value={scene.referenceCharacterId || ""} onChange={e => sceneChange(scene.id, { referenceCharacterId: e.target.value })}><option value="">Text-guided scene</option>{plan.characters.filter(character => character.photoId).map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select></label>
        <div className="ltx-columns"><label className="field"><span>Scene {index + 1} minimum seconds</span><input type="number" min={2} max={60} step={1} value={scene.duration} onChange={e => sceneChange(scene.id, { duration: Number(e.target.value) })} /></label>
          <label className="field"><span>Scene {index + 1} audio</span><select value={scene.audioMode} onChange={e => sceneChange(scene.id, { audioMode: e.target.value as LtxScene["audioMode"] })}><option value="tts">Read my script</option><option value="recording">Use my recording</option><option value="silent">Silent</option></select></label></div>
        <label className="field"><span>Scene {index + 1} narration script{scene.audioMode === "recording" ? " / transcript for review" : ""}</span><textarea rows={3} maxLength={1200} value={scene.narration} onChange={e => sceneChange(scene.id, { narration: e.target.value })} /></label>
        {scene.audioMode === "recording" && <><label className="field"><span>Scene {index + 1} recording</span><select value={scene.audioId || ""} onChange={e => sceneChange(scene.id, { audioId: e.target.value })}><option value="">Choose a recording</option>{audio.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span>Upload narration for scene {index + 1}</span><input type="file" accept=".mp3,.wav,.m4a,.ogg" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void upload(file, id => sceneChange(scene.id, { audioId: id })); }} /></label></>}
      </details>)}</div>
      <p className="field-note">Narration extends scenes when needed, up to 60 seconds each. Speech is preserved without trimming; shorten recordings that exceed the limit. Script narration uses one selected voice, including dialogue. LTX sound is replaced by your chosen track. Lip-sync is not guaranteed.</p>
    </fieldset>
    {!job && <><label className="consent"><input type="checkbox" checked={consent} disabled={!!busy} onChange={e => setConsent(e.target.checked)} /><span>Render this film and its selected sources on the local studio PC, then save a private review copy in my account.</span></label>
      <button className="button primary" disabled={!!busy || !consent || !available || !plan.scenes.length} onClick={() => void start()}>{busy ? <Loader2 className="spin" size={16} /> : <FilmIcon size={16} />}{busy || (film.ltxFilmRequestId ? "Retry saved film request" : "Render full film for review")}</button></>}
    {active && <div className="render-progress" role="status"><p>{ltxStatus(job!)}</p><progress max={100} value={job!.progress} aria-label="Full film rendering progress" /><p>You can leave and return. Scene generation and narration continue on the studio PC.</p></div>}
    {job?.status === "failed" && <p role="alert">{job.message}</p>}
    {job?.mediaUrl && <LtxFilmReview key={job.id} job={job} onChange={setJob} />}
    {error && <p role="alert">{error}</p>}
    {!active && (job || film.ltxFilmRequestId) && <button className="text-button" disabled={!!busy} onClick={() => { update({ ltxFilmJobId: undefined, ltxFilmRequestId: undefined, ltxFilmSubmission: undefined }); setJob(null); setConsent(false); setError(""); }}>Edit this draft and render another version</button>}
    {!!history.length && <details><summary>Saved LTX film versions</summary><ul>{history.map(item => <li key={item.id}><button className="text-button" disabled={!!busy || !!active} onClick={() => { update({ ltxFilmJobId: item.id }); setJob(item); setError(""); }}>{item.title} · {ltxStatus(item)} · {new Date(item.createdAt).toLocaleString()}</button></li>)}</ul></details>}
  </section>;
}
