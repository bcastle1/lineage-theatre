import { useEffect, useState } from "react";
import { CloudUpload, Download, Film as FilmIcon, Loader2, RefreshCw } from "lucide-react";
import { getSourceBlob } from "../lib/storage";
import { api, type Film } from "./model";

export interface CloudFilm {
  id: string;
  ownerEmail: string;
  title: string;
  ancestor: string;
  duration: number;
  createdAt: string;
  updatedAt: string;
  hasVideo: boolean;
  status: "draft" | "upload-pending" | "uploaded";
}
interface ArchivePage { films: CloudFilm[]; cursor?: string }
interface ArchiveSave { film: CloudFilm; upload?: { pathname: string; clientPayload: string } }
const MAX_BYTES = 250 * 1024 * 1024;
export function cloudMediaUrl(film: CloudFilm, download = false) {
  return `/api/archive?${new URLSearchParams({ action: "media", id: film.id, owner: film.ownerEmail, ...(download ? { download: "1" } : {}) })}`;
}
const labelFor = (film: CloudFilm) => film.hasVideo ? "Uploaded finished film" : film.status === "upload-pending" ? "Upload awaiting verification" : "Film details saved";

export default function CloudArchivePanel({ projects, onBusyChange, showFilms = true }: { projects: Film[]; onBusyChange?: (busy: boolean) => void; showFilms?: boolean }) {
  const [films, setFilms] = useState<CloudFilm[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selection, setSelection] = useState(projects[0]?.id || "new");
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const selected = projects.find((film) => film.id === selection);
  const [title, setTitle] = useState(selected?.title || "");
  const [ancestor, setAncestor] = useState(selected?.ancestor || "");
  const [duration, setDuration] = useState(selected?.duration || 120);
  const [source, setSource] = useState<"none" | "saved" | "file">(selected?.outputId ? "saved" : "none");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState<string>();
  useEffect(() => { onBusyChange?.(Boolean(busy) && !busy.startsWith("Loading")); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const id = selected?.id || newId;
  const alreadyUploaded = films.some((film) => film.id === id && film.hasVideo);
  function feedback(text: string, failed = false) { setMessage(text); setError(failed); }
  function remember(film: CloudFilm) { setFilms((current) => [film, ...current.filter((item) => item.id !== film.id)]); }
  async function load(next?: string) {
    setBusy(next ? "Loading more cloud films…" : "Loading cloud archive…");
    try {
      const result = await api<ArchivePage>(`/api/archive?action=list${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
      setFilms((current) => next ? [...current, ...result.films.filter((film) => !current.some((entry) => entry.id === film.id))] : result.films);
      setCursor(result.cursor);
    } catch (cause) { feedback(cause instanceof Error ? cause.message : "The cloud archive could not be loaded.", true); }
    finally { setBusy(""); }
  }
  useEffect(() => {
    let active = true;
    setBusy("Loading cloud archive…");
    void api<ArchivePage>("/api/archive?action=list")
      .then((result) => { if (active) { setFilms(result.films); setCursor(result.cursor); } })
      .catch((cause) => { if (active) feedback(cause instanceof Error ? cause.message : "The cloud archive could not be loaded.", true); })
      .finally(() => { if (active) setBusy(""); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!busy || busy.startsWith("Loading")) return;
    const preserveUpload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preserveUpload);
    return () => window.removeEventListener("beforeunload", preserveUpload);
  }, [busy]);
  function choose(value: string) {
    const film = projects.find((project) => project.id === value);
    setSelection(value); setTitle(film?.title || ""); setAncestor(film?.ancestor || "");
    setDuration(film?.duration || 120); setSource(film?.outputId ? "saved" : value === "new" ? "file" : "none");
    setFile(null); setFileKey((current) => current + 1); setConsent(false); setMessage("");
    if (value === "new") setNewId(crypto.randomUUID());
  }
  async function verify(filmId: string) {
    const result = await api<{ film: CloudFilm }>("/api/archive", { action: "finalize", id: filmId });
    remember(result.film);
    return result.film;
  }
  async function save() {
    if (!consent) { feedback("Review and accept the cloud archive sharing details before saving.", true); return; }
    if (!title.trim()) { feedback("Add a film title before saving.", true); return; }
    setBusy("Preparing your private cloud copy…"); setMessage("");
    try {
      let video: Blob | null = null;
      if (!alreadyUploaded && source === "saved") {
        video = selected?.outputId ? await getSourceBlob(selected.outputId) : null;
        if (!video) throw new Error("The finished video is not available in this browser. Choose a saved MP4 or WebM file instead.");
      } else if (!alreadyUploaded && source === "file") {
        if (!file) throw new Error("Choose the finished MP4 or WebM video to upload.");
        video = file;
      }
      if (video && !["video/mp4", "video/webm"].includes(video.type)) {
        const name = file?.name || "";
        const type = /\.mp4$/i.test(name) ? "video/mp4" : /\.webm$/i.test(name) ? "video/webm" : "";
        if (!type) throw new Error("Choose an MP4 or WebM finished film.");
        video = new Blob([video], { type });
      }
      if (video && (video.size < 16 || video.size > MAX_BYTES)) throw new Error("Choose a finished video up to 250 MB.");
      const result = await api<ArchiveSave>("/api/archive", {
        action: "save", id, title: title.trim(), ancestor: ancestor.trim(), duration,
        archiveConsent: true, ...(video ? { video: { type: video.type, size: video.size } } : {}),
      });
      remember(result.film);
      if (video && result.upload) {
        setBusy("Uploading finished film… 0%");
        try {
          const { upload } = await import("@vercel/blob/client");
          await upload(result.upload.pathname, video, {
            access: "private", handleUploadUrl: "/api/archive", clientPayload: result.upload.clientPayload,
            contentType: video.type, multipart: true,
            onUploadProgress: ({ percentage }) => setBusy(`Uploading finished film… ${Math.round(percentage)}%`),
          });
        } catch (cause) {
          // An interrupted response may still have completed at the provider. Verify the fixed server path.
          try { await verify(id); }
          catch { throw cause; }
        }
        setBusy("Verifying your private cloud film…");
        await verify(id);
        feedback("Finished film saved and verified in your private cloud archive. You and Lineage Theatre administrators can watch it here.");
      } else feedback("Film details saved to your private cloud archive. Find uploaded originals in Media library. Your working draft remains in this browser.");
      setConsent(false); setFile(null); setFileKey((current) => current + 1);
      if (!selected) { setNewId(crypto.randomUUID()); setTitle(""); setAncestor(""); }
    } catch (cause) { feedback(cause instanceof Error ? cause.message : "Cloud save did not finish. Your local project remains available.", true); }
    finally { setBusy(""); }
  }
  return (
    <section className="panel" aria-labelledby="cloud-archive-title" aria-busy={!!busy}>
      <div className="section-title">
        <div><h2 id="cloud-archive-title">Your private cloud archive</h2><p>Keep completed films available when you sign in on another device.</p></div>
        <CloudUpload size={24} />
      </div>
      <p className="field-note">Cloud copies can be viewed by you and Lineage Theatre administrators. Saving here is optional. Your family documents, original photographs, and full script stay in this browser.</p>
      <div className="form-grid">
        <label>Film to save<select value={selection} disabled={!!busy} onChange={(event) => choose(event.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.title || "Untitled local film"}</option>)}
          <option value="new">Upload another completed film</option>
        </select></label>
        <label>Cloud film title<input maxLength={200} value={title} disabled={!!busy} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Ancestor<input maxLength={160} value={ancestor} disabled={!!busy} onChange={(event) => setAncestor(event.target.value)} /></label>
        <label>Runtime in seconds<input type="number" min={0} max={14400} value={duration} disabled={!!busy} onChange={(event) => setDuration(Number(event.target.value))} /></label>
        {!alreadyUploaded && <label>Finished video<select value={source} disabled={!!busy} onChange={(event) => { setSource(event.target.value as typeof source); setConsent(false); }}>
          <option value="none">Save film details only</option>
          {selected?.outputId && <option value="saved">Upload this film's saved video</option>}
          <option value="file">Choose a completed MP4 or WebM file</option>
        </select></label>}
        {!alreadyUploaded && source === "file" && <label>Completed film file<input key={fileKey} type="file" accept="video/mp4,video/webm,.mp4,.webm" disabled={!!busy} onChange={(event) => { setFile(event.target.files?.[0] || null); setConsent(false); }} /><small>Up to 250 MB per film. 100 films and 5 GB of uploads per account.</small></label>}
      </div>
      {alreadyUploaded && <p className="field-note">This film already has a verified cloud video. Saving updates its details. Choose “Upload another completed film” for another version.</p>}
      <label className="check-label">
        <input type="checkbox" checked={consent} disabled={!!busy} onChange={(event) => setConsent(event.target.checked)} />
        I have permission to upload this film. Save its title, ancestor, runtime and selected finished video privately, with access for Lineage Theatre administrators.
      </label>
      <div className="panel-actions"><button className="button primary" disabled={!!busy || !consent} onClick={() => void save()}>
        {busy ? <Loader2 className="spin" size={17} /> : <CloudUpload size={17} />}{busy || "Save to cloud archive"}
      </button><button className="text-button" disabled={!!busy} onClick={() => void load()}><RefreshCw size={15} />Refresh cloud films</button></div>
      {busy && <p className="field-note" role="status">{busy}</p>}
      {message && <p className={`feedback ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{message}</p>}
      {showFilms && <><div className="library-list">
        {!busy && films.length === 0 && <p>No cloud films saved yet. Your local projects are listed above.</p>}
        {films.map((film) => <article className="panel" key={film.id}>
          <div className="section-title"><div><h3><FilmIcon size={17} /> {film.title}</h3><p>{film.ancestor || "Family film"} · {labelFor(film)} · {new Date(film.updatedAt).toLocaleDateString()}</p></div>
            <div className="action-group">{film.hasVideo ? <>
              <button className="button secondary small" onClick={() => setPlaying(playing === film.id ? undefined : film.id)}>{playing === film.id ? "Close player" : "Watch film"}</button>
              <a className="text-button" href={cloudMediaUrl(film, true)} download><Download size={15} />Download</a>
            </> : film.status === "upload-pending" ? <button className="text-button" disabled={!!busy} onClick={() => {
              setBusy("Verifying cloud upload…"); void verify(film.id).then(() => feedback("Cloud film verified and ready to watch.")).catch((cause) => feedback(cause instanceof Error ? cause.message : "Verification failed.", true)).finally(() => setBusy(""));
            }}>Verify finished upload</button> : null}</div>
          </div>
          {playing === film.id && film.hasVideo && <video controls playsInline preload="metadata" src={cloudMediaUrl(film)} style={{ width: "100%", maxHeight: 540 }} onError={() => feedback("The private video could not be played. Refresh the archive or download the file to try again.", true)} />}
        </article>)}
      </div>
      {cursor && <button className="button secondary" disabled={!!busy} onClick={() => void load(cursor)}>Load more cloud films</button>}</>}
    </section>
  );
}
