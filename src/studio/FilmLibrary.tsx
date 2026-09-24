import { useEffect, useRef, useState } from "react";
import { Archive, Download, Film as FilmIcon, Loader2, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { api, formatDuration, type Film } from "./model";
import { libraryActionRequest, libraryKey, localLibraryState, mergeLibraryPages, normalizeLibraryAction, normalizeLibraryPage,
  paymentLabel, productionLabel, verifyLibraryDetail, type LibraryAction, type LibraryDetail, type LibraryEntry, type LibraryView } from "./film-library";
import "./film-library.css";

type Confirmation = { action: LibraryAction; entry?: LibraryEntry; draft?: Film };
const actions = { archive: "Archive", trash: "Move to trash", restore: "Restore" };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The film library could not complete this action. Please refresh.";
function downloadPlan(detail: LibraryDetail) {
  if (!detail.manifest) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ id: detail.entry.id, manifestHash: detail.entry.manifestHash, manifest: detail.manifest }, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = "saved-film-plan.json"; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export default function FilmLibrary({ projects, disabled, onCreate, onOpenDraft, onLocalAction, onBusyChange }: {
  projects: Film[]; disabled: boolean; onCreate: () => void; onOpenDraft: (id: string) => void;
  onLocalAction: (id: string, action: LibraryAction) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [view, setView] = useState<LibraryView>("active");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<LibraryDetail | null>(null);
  const [playing, setPlaying] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), mounted = useRef(false), sequence = useRef(0);
  const pageCursors = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { onBusyChange(Boolean(busy)); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true); setEntries([]); setCursor(undefined); setError(""); setDetail(null); setPlaying(""); pageCursors.current.clear();
    void api<unknown>(`/api/library?view=${view}`)
      .then(value => { const page = normalizeLibraryPage(value, view); if (request === sequence.current) { setEntries(page.entries); setCursor(page.cursor); } })
      .catch(cause => { if (request === sequence.current) setError(errorText(cause)); })
      .finally(() => { if (request === sequence.current) setLoading(false); });
  }, [view, reload]);
  useEffect(() => {
    if (confirmation && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [confirmation]);
  useEffect(() => {
    if (detail) { detailPanel.current?.focus({ preventScroll: true }); detailPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }, [detail]);
  async function loadMore() {
    if (!cursor || lock.current || loading || disabled) return;
    const next = cursor, request = sequence.current;
    lock.current = true; setBusy("Loading more films…"); setError("");
    try {
      if (pageCursors.current.has(next)) throw new Error("The next library page could not be verified. Refresh the library to continue.");
      const page = normalizeLibraryPage(await api<unknown>(`/api/library?view=${view}&cursor=${encodeURIComponent(next)}`), view);
      if (request === sequence.current) {
        pageCursors.current.add(next); setEntries(current => mergeLibraryPages(current, page.entries)); setCursor(page.cursor);
      }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function openDetail(entry: LibraryEntry) {
    if (lock.current || disabled) return;
    const request = sequence.current;
    lock.current = true; setBusy("Opening your saved version…"); setError("");
    try {
      const value = await api<unknown>(`/api/library?action=detail&kind=${entry.kind}&id=${encodeURIComponent(entry.id)}`);
      const verified = await verifyLibraryDetail(value, entry);
      if (request === sequence.current) { setDetail(verified); setPlaying(""); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function confirmAction() {
    if (!confirmation || lock.current || disabled) return;
    const selected = confirmation;
    lock.current = true; setBusy(`${actions[selected.action]}…`); setError("");
    try {
      if (selected.entry) {
        const value = await api<unknown>("/api/library", libraryActionRequest(selected.entry, selected.action));
        const changed = normalizeLibraryAction(value, selected.entry, selected.action);
        if (mounted.current) { setEntries(current => current.filter(entry => libraryKey(entry) !== libraryKey(changed))); setDetail(null); setPlaying(""); }
      } else if (selected.draft) onLocalAction(selected.draft.id, selected.action);
      if (mounted.current) {
        setMessage(selected.action === "restore" ? "Film restored to your library." : selected.action === "archive" ? "Film archived. You can restore it from Archived." : "Film moved to Trash. You can restore it at any time.");
        dialog.current?.close(); setConfirmation(null);
      }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  const blocked = disabled || Boolean(busy);
  const drafts = projects.filter(project => localLibraryState(project) === view);
  const closeConfirmation = () => { if (!busy) { dialog.current?.close(); setConfirmation(null); } };
  const openConfirmation = (value: Confirmation) => { if (!blocked) { setError(""); setConfirmation(value); } };
  const savedVersionTitle = detail?.entry.payments.some(payment => payment.status === "captured" && !payment.sandbox) ? "Saved paid version" : "Saved film version";
  return <div className="film-library">
    <div className="page-heading"><div><h1>Your film library</h1><p>Your saved films, production progress, and drafts in one place.</p></div>
      <button type="button" className="button primary" disabled={blocked} onClick={onCreate}><Plus size={17} aria-hidden="true" />Create film</button>
    </div>
    <div className="film-library-toolbar">
      <nav aria-label="Film library views">{(["active", "archived", "trash"] as LibraryView[]).map(item => <button type="button" key={item}
        className={`button small ${view === item ? "primary" : "secondary"}`} aria-current={view === item ? "page" : undefined}
        disabled={blocked} onClick={() => { setView(item); setMessage(""); }}>{item === "active" ? "My films" : item === "archived" ? "Archived" : "Trash"}</button>)}</nav>
      <button type="button" className="text-button" disabled={blocked || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh films</button>
    </div>
    {message && <p className="feedback success" role="status">{message}</p>}
    {error && !confirmation && <p className="feedback error" role="alert">{error}</p>}
    {busy && <p role="status"><Loader2 className="spin" size={16} aria-hidden="true" /> {busy}</p>}
    {view !== "active" && <p className="field-note">{view === "trash" ? "Nothing here is permanently deleted." : "Archived films stay in your account."} Active production continues, and payment records are retained. Restore returns a film to My films.</p>}
    <section aria-labelledby="saved-films-heading" aria-busy={loading}>
      <div className="section-title"><div><h2 id="saved-films-heading">Saved to your account</h2><p>Each card is a saved version. Its payment and production status are shown separately.</p></div></div>
      {loading && <p role="status">Loading your saved films…</p>}
      {!loading && !entries.length && !error && <p className="film-library-empty">{cursor ? "No films in this part of the list. Load more to continue." : view === "active" ? "No saved films yet. Create a film, or continue a browser draft below." : "No saved films in this view."}</p>}
      <div className="library-list">{entries.map(entry => {
        const key = libraryKey(entry), local = projects.find(project => project.id === entry.filmId && localLibraryState(project) === "active");
        const isPlaying = playing === key;
        return <article className="library-item film-library-item" key={key} aria-labelledby={`film-${entry.kind}-${entry.id}`}>
          <div className="library-art"><FilmIcon size={27} strokeWidth={1.2} aria-hidden="true" /></div>
          <div className="film-library-content"><h3 id={`film-${entry.kind}-${entry.id}`}>{entry.title || "Untitled family film"}</h3>
            <p>{formatDuration(entry.durationSeconds)}{entry.kind === "plan" ? " target" : " runtime"} · Saved {new Date(entry.createdAt).toLocaleString()}</p>
            <div className="film-library-statuses"><div><span>Payment</span>{entry.payments.length ? entry.payments.map(payment => <strong key={payment.id}>
              {payment.sandbox ? "Test · " : ""}{paymentLabel(payment)} · {(payment.amountCents / 100).toLocaleString(undefined, { style: "currency", currency: payment.currency })}
            </strong>) : <strong>{entry.kind === "upload" ? "Not required for upload" : "No payment recorded"}</strong>}</div>
              <div><span>Production</span><strong>{entry.kind === "upload" && entry.production.status === "prepared" ? "Film details saved" : productionLabel(entry)}</strong></div></div>
            {entry.production.needsAttention && <p>Production needs attention. Your saved version and payment records remain available.</p>}
            {entry.production.status === "prepared" && entry.kind === "plan" && <p>Your plan is saved. Rendering has not started.</p>}
            {entry.production.shotCount > 0 && ["queued", "submitting", "processing"].includes(entry.production.status) && <p>{entry.production.completedShots} of {entry.production.shotCount} shots complete.</p>}
            <div className="action-group film-library-actions">
              <button type="button" className="button secondary small" disabled={blocked} onClick={() => void openDetail(entry)}>{entry.kind === "plan" ? "View saved plan" : "View film details"}</button>
              {entry.production.mediaReady && entry.mediaUrl && entry.downloadUrl && <>
                <button type="button" className="button primary small" disabled={blocked} onClick={() => setPlaying(isPlaying ? "" : key)}>{isPlaying ? "Close player" : "Watch film"}</button>
                <a className="text-button" href={entry.downloadUrl} download><Download size={15} aria-hidden="true" />Download film</a>
              </>}
              {local && <button type="button" className="text-button" disabled={blocked} onClick={() => onOpenDraft(local.id)}>Open browser draft</button>}
              {view === "active" && <button type="button" className="text-button" disabled={blocked} onClick={() => openConfirmation({ entry, action: "archive" })}><Archive size={14} aria-hidden="true" />Archive</button>}
              {view !== "active" && <button type="button" className="text-button" disabled={blocked} onClick={() => openConfirmation({ entry, action: "restore" })}><RotateCcw size={14} aria-hidden="true" />Restore</button>}
              {view !== "trash" && <button type="button" className="text-button" disabled={blocked} onClick={() => openConfirmation({ entry, action: "trash" })}><Trash2 size={14} aria-hidden="true" />Move to trash</button>}
            </div>
            {isPlaying && entry.mediaUrl && <video controls playsInline preload="metadata" src={entry.mediaUrl} aria-label={`${entry.title || "Family film"} player`}
              onError={() => setError("This film could not be played. Refresh its status or try the download.")} />}
          </div>
        </article>;
      })}</div>
      {cursor && <button type="button" className="button secondary film-library-more" disabled={blocked || loading} onClick={() => void loadMore()}>Load more saved films</button>}
    </section>
    {detail && <section ref={detailPanel} tabIndex={-1} className="panel film-library-detail" aria-labelledby="saved-film-detail-heading">
      <div className="section-title"><div><h2 id="saved-film-detail-heading">{savedVersionTitle}: {detail.entry.title || "Untitled family film"}</h2>
        <p>{formatDuration(detail.entry.durationSeconds)} target · Saved {new Date(detail.entry.createdAt).toLocaleString()}</p></div>
        <button type="button" className="icon-button" aria-label="Close saved film details" onClick={() => setDetail(null)}><X size={18} /></button></div>
      <p className="field-note">This saved version is separate from any edits in your browser draft.</p>
      {detail.scenes?.map((scene, index) => <article className="film-library-scene" key={index}><h3>{index + 1}. {scene.title || "Scene"}</h3>
        {scene.narration && <p><strong>Narration:</strong> {scene.narration}</p>}{scene.visual && <p><strong>Visual:</strong> {scene.visual}</p>}{scene.dialogue && <p><strong>Dialogue:</strong> {scene.dialogue}</p>}</article>)}
      {detail.manifest && <button type="button" className="button secondary small" onClick={() => downloadPlan(detail)}><Download size={15} aria-hidden="true" />Download saved plan</button>}
    </section>}
    <section aria-labelledby="browser-drafts-heading" className="film-library-drafts"><div className="section-title"><div>
      <h2 id="browser-drafts-heading">Browser drafts</h2><p>These editable drafts and original source files are stored on this browser. They are not a backup of your account's saved versions.</p>
    </div></div>
      {!drafts.length && <p className="film-library-empty">No browser drafts in this view.</p>}
      <div className="library-list">{drafts.map(draft => <article className="library-item film-library-item" key={draft.id}>
        <div className="library-art"><FilmIcon size={24} aria-hidden="true" /></div><div className="film-library-content"><h3>{draft.title || "Untitled family film"}</h3>
          <p>Saved in this browser · {draft.sources.length} sources · {new Date(draft.updatedAt).toLocaleDateString()}</p>
          <p>{draft.paymentReference ? "A payment reference is saved. Use the account version above for confirmed payment and production status." : draft.scenes.length ? "Script draft ready to review." : "Story in development."}</p>
          <div className="action-group film-library-actions">
            {view === "active" && <><button type="button" className="button secondary small" disabled={blocked} onClick={() => onOpenDraft(draft.id)}>Continue draft</button>
              <button type="button" className="text-button" disabled={blocked} onClick={() => openConfirmation({ draft, action: "archive" })}>Archive draft</button></>}
            {view !== "active" && <button type="button" className="text-button" disabled={blocked} onClick={() => openConfirmation({ draft, action: "restore" })}>Restore draft</button>}
            {view !== "trash" && <button type="button" className="text-button" disabled={blocked} onClick={() => openConfirmation({ draft, action: "trash" })}>Move draft to trash</button>}
          </div></div>
      </article>)}</div>
    </section>
    {confirmation && <dialog ref={dialog} className="film-library-dialog" aria-labelledby="library-confirm-title" aria-describedby="library-confirm-description"
      onCancel={event => { if (busy) event.preventDefault(); else setConfirmation(null); }}>
      <h2 id="library-confirm-title">{actions[confirmation.action]} {confirmation.entry?.title || confirmation.draft?.title || "Untitled family film"}?</h2>
      <p id="library-confirm-description">{confirmation.action === "restore" ? "Return this item to My films." : confirmation.action === "archive" ? "Move this item to Archived. You can restore it at any time." : "Move this item to Trash. You can restore it at any time; nothing is permanently deleted."}
        {confirmation.draft ? " This changes this browser draft only." : " This changes the saved version's library location only."} Active production is not cancelled. Payment records are retained.</p>
      {error && <p className="feedback error" role="alert">{error}</p>}
      <div className="action-group"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={closeConfirmation} autoFocus>Cancel</button>
        <button type="button" className="button primary" disabled={blocked} onClick={() => void confirmAction()}>{busy || actions[confirmation.action]}</button></div>
    </dialog>}
  </div>;
}
