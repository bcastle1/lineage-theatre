import { useEffect, useRef, useState } from "react";
import { Archive, Download, Film as FilmIcon, Loader2, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { api, formatDuration, type Film } from "./model";
import { libraryActionRequest, libraryCanWatch, libraryCoveredDraft, libraryFilmLink, libraryGenerationOrder, libraryKey, libraryRefreshDelay, loadLibraryLinkedFilm, loadLibraryWindow, localLibraryState, mergeLibraryPages, normalizeLibraryAction, normalizeLibraryPage,
  parseLibraryFilmLink, paymentLabel, productionLabel, verifyLibraryDetail, type LibraryAction, type LibraryDetail, type LibraryEntry, type LibraryView } from "./film-library";
import type { ProductionStatus } from "./film-fulfillment";
import "./film-library.css";
import FilmProductionProgress from "./FilmProductionProgress";
import LtxFilmLibrary from "./LtxFilmLibrary";
import OriginalPaymentReceipt from "./OriginalPaymentReceipt";
import { startLibraryRefresh } from "./library-refresh";
import SavedFilmPurchase from "./SavedFilmPurchase";

type Confirmation = { action: LibraryAction; entry?: LibraryEntry; draft?: Film };
const actions = { archive: "Archive", trash: "Move to trash", restore: "Restore" };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The film library could not complete this action. Please refresh.";
// How the page is scrolled to something: not animated when reduced motion is requested.
const scrolling = (): ScrollBehavior => typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
const inPanel = (at: string) => /^(status|detail|version):/.test(at);
// How long presses are ignored after the library itself has moved the page, and the longest that a page still
// scrolling can extend it (see "quiet" below).
const QUIET_MS = 500, QUIET_LIMIT_MS = 4000;
// How long a still pointer is held to the control it was on when the library moved the page, and how far a
// mouse (or a finger or pen, between taps) may stray and still count as the same point (see "hold" below).
// A scroll that starts within OWN_SCROLL_MS of a move the library made is taken to be part of that move.
const HOLD_MS = 8000, MOUSE_RADIUS = 8, TOUCH_RADIUS = 16, OWN_SCROLL_MS = 300;
// How long a control that starts something costly or hard to undo (marked data-arrival-guard: Resume paid film,
// the confirm button of a confirmation) ignores presses after it may have arrived under a pointer: after it
// appears or moves, and after the library has scrolled the page (see "arrivedUntil" below).
const ARRIVAL_MS = 2500;
const CONTROLS = "a[href], button, input, select, textarea, summary, label, video, audio, [role=button], [role=link], [tabindex]";
const controlOf = (target: EventTarget | null) => target instanceof Element ? target.closest(CONTROLS) : null;
type Point = { x: number; y: number; radius: number; control: Element | null };
type Line = "message" | "error" | "busy";
function resumablePayment(detail: LibraryDetail | null) {
  if (!detail?.manifest || !detail.entry.production.needsAttention
    || !["prepared", "queued", "submitting", "processing", "uncertain"].includes(detail.entry.production.status)) return null;
  return libraryGenerationOrder(detail.entry);
}
export function LibraryFilmStatus({ entry, productionAvailable, generationAttemptAllowed }: { entry: LibraryEntry; productionAvailable?: boolean; generationAttemptAllowed?: boolean }) {
  const preRendered = entry.production.deliveryFlow === 'render-before-payment-v1';
  const paid = (!preRendered || !entry.production.paymentLocked) && entry.payments.some(payment => payment.status === "captured" && !payment.sandbox && !payment.requiresReview
    && payment.refundedCents === 0 && payment.receiptAvailable);
  const covered = Boolean(entry.coverage), productionCovered = paid || covered;
  return <div className="film-library-progress">
    <div className="film-library-statuses"><div><span>Payment</span>{covered && <strong>Covered by original payment</strong>}{entry.payments.length ? entry.payments.map(payment => <strong key={payment.id}>
      {payment.sandbox ? "Test · " : ""}{paymentLabel(payment)} · {(payment.amountCents / 100).toLocaleString(undefined, { style: "currency", currency: payment.currency })}
    </strong>) : !covered && <strong>{preRendered ? entry.production.purchaseReady ? "Payment unlocks this film" : "No payment requested" : entry.origin === "studio-delivery" ? "No charge for transfer" : entry.kind === "upload" ? "Not required for upload" : "No payment recorded"}</strong>}</div>
      <div><span>Production</span><strong>{entry.kind === "upload" && entry.production.status === "prepared" ? "Film details saved" : productionCovered && entry.kind === "plan" && !libraryCanWatch(entry) ? "See progress below" : productionLabel(entry)}</strong></div></div>
    {entry.coverage && <div>
      <p className="field-note">This corrected film is covered by your original payment. There is no additional charge for this correction.</p>
      <p className="field-note"><a href={libraryFilmLink(entry.coverage.originalPreparedId)}>View original paid film</a> · Original payment reference: {entry.coverage.orderId.slice(0, 12)}</p>
      <OriginalPaymentReceipt coverage={entry.coverage} />
    </div>}
    {libraryCanWatch(entry) ? <p>Your video is complete and ready to watch or download below.</p> : <>
      {entry.production.needsAttention && <p>Production needs attention. Your saved version and payment records remain available.</p>}
      {entry.production.status === "prepared" && entry.kind === "plan" && <p>{covered ? "Your corrected version is saved; follow its production progress below."
        : paid ? "Payment is confirmed. Your paid version is saved; follow its progress below." : "Your production plan is saved. Your video has not been created yet."}</p>}
      {entry.production.shotCount > 0 && ["queued", "submitting", "processing"].includes(entry.production.status) && <p>{entry.production.completedShots} of {entry.production.shotCount} shots complete. Your video is not ready yet.</p>}
      {entry.production.artifactReady && entry.production.paymentLocked ? <p>Your finished video is verified and saved privately. Complete payment to unlock watching and downloading this film.</p>
        : ["completed", "uploaded"].includes(entry.production.status) && <p>Your video is being prepared for viewing. Watch and download will appear here when the video is available.</p>}
      {productionCovered && entry.kind === "plan" && <p className="field-note">{covered ? "Your original payment covers this corrected version." : "Your payment covers this saved version."} <a href={`mailto:admin@brocotech.ai?subject=${encodeURIComponent(`Lineage Theatre film ${entry.id}`)}`}>Get help with your film</a>.</p>}
    </>}
    {entry.kind === "plan" && <FilmProductionProgress paid={productionCovered} studioFunded={preRendered} ready={libraryCanWatch(entry) || entry.production.purchaseReady === true} available={productionAvailable} status={entry.production.status}
      completedShots={entry.production.completedShots} shotCount={entry.production.shotCount} progress={entry.production.progress} needsAttention={entry.production.needsAttention}
      workerReady={entry.production.workerReady} message={entry.production.message} />}
  </div>;
}
function downloadPlan(detail: LibraryDetail) {
  if (!detail.manifest) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ id: detail.entry.id, manifestHash: detail.entry.manifestHash, manifest: detail.manifest }, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = "saved-film-plan.json"; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export function SavedPlanVersionAction({ detail, disabled, onCreateVersion }: {
  detail: LibraryDetail; disabled: boolean; onCreateVersion: (entry: LibraryEntry) => Promise<void>;
}) {
  if (detail.entry.kind !== "plan" || !detail.manifest) return null;
  return <div className="film-library-version-action">
    <p className="field-note">Create a separate browser draft using this saved screenplay as its source. Original uploads are not copied. {detail.entry.coverage
      ? "The original payment remains with the original paid film. This correction's coverage does not transfer to a new draft."
      : "The original payment stays with this saved plan."} Review the new draft and choose its running time before production.</p>
    {detail.sourceNames && detail.sourceNames.length > 0 && <details className="disclosure">
      <summary>Original source filenames ({detail.sourceNames.length})</summary>
      <p className="field-note">These names are references from the saved plan. Add the original files separately if you want them read again.</p>
      <ul>{detail.sourceNames.map((name, index) => <li key={index}>{name || "Unnamed source"}</li>)}</ul>
    </details>}
    <button type="button" className="button secondary small" disabled={disabled} onClick={() => void onCreateVersion(detail.entry)}>
      <Plus size={15} aria-hidden="true" />Create new version
    </button>
  </div>;
}
export default function FilmLibrary({ projects, disabled, productionAvailable, generationAttemptAllowed, onCreate, onOpenDraft, onLocalAction, onBusyChange, onCreateVersion }: {
  projects: Film[]; disabled: boolean; onCreate: () => void; onOpenDraft: (id: string) => void;
  productionAvailable?: boolean;
  generationAttemptAllowed?: boolean;
  onLocalAction: (id: string, action: LibraryAction) => void;
  onBusyChange: (busy: boolean) => void;
  onCreateVersion: (entry: LibraryEntry) => Promise<void>;
}) {
  const [view, setView] = useState<LibraryView>("active");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Where each line is shown: a saved film's key (its card), "draft:<id>" (a browser draft's card), a place in
  // the open film status panel ("status:", "detail:" or "version:" plus the film's key), "more" (under the
  // "Load more saved films" button), or "" for the top. A place that is not on the page falls back to the top.
  const [busyAt, setBusyAt] = useState("");
  const [errorAt, setErrorAt] = useState("");
  const [messageAt, setMessageAt] = useState("");
  const [revealed, setRevealed] = useState<{ line: Line; count: number }>({ line: "message", count: 0 });
  // Ask for a line to be brought into view once it is rendered (see the effect below).
  const reveal = (line: Line) => setRevealed(current => ({ line, count: current.count + 1 }));
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<LibraryDetail | null>(null);
  const [libraryHash, setLibraryHash] = useState(() => typeof window === "undefined" ? "" : window.location.hash);
  const [playing, setPlaying] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const detailPanel = useRef<HTMLElement>(null), panelOpen = useRef(false), errorInList = useRef(false);
  const messageLine = useRef<HTMLParagraphElement>(null), errorLine = useRef<HTMLParagraphElement>(null), busyLine = useRef<HTMLParagraphElement>(null);
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), mounted = useRef(false), sequence = useRef(0);
  const detailSequence = useRef(0);
  const automaticallyOpenedPlayer = useRef("");
  const pageCursors = useRef(new Set<string>());
  const loadedPageCount = useRef(1), backgroundRead = useRef(false);
  const linkedFilm = parseLibraryFilmLink(libraryHash)?.id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; detailSequence.current++; }; }, []);
  useEffect(() => {
    const changed = () => setLibraryHash(window.location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  // When the library itself moves the page (it brings a line or the status panel into view, the status panel
  // closes, or a line in a card appears, changes or goes after the customer's action), whatever arrives under a
  // pointer that has not moved is not what the customer aimed at. For a moment after each such move, presses
  // are ignored everywhere in the document. Activation from the keyboard (a click with no press count) is never
  // ignored. While the page is still scrolling (a long smooth scroll can take well over a second) the moment is
  // extended, but never past four seconds after the move, so the customer's own scrolling cannot keep presses
  // ignored for long. A background refresh never starts that moment.
  // Independently of that moment, a pointer that has not moved since the library changed the page (any change,
  // a background refresh's included) is held to the control it was on before: a press at that point (within 8 px
  // for a mouse, 16 px for a finger or pen) that would now land on a different control is ignored, however long
  // the customer waits between presses, until the pointer moves away, a press is made somewhere else, the customer
  // scrolls or presses a key, or eight seconds have passed since the library last changed the page. A press on the
  // control that was there before is never ignored by this.
  // And a control that starts something costly or hard to undo ignores every press (not the keyboard) for 2.5 s
  // after it may have arrived under a pointer, wherever that pointer is: after it appears or moves on the page
  // (the status panel opening under "View film status", or a status read, can bring Resume paid film there; on a
  // phone a confirmation's confirm button can open where Archive or Move to trash was pressed), and after the
  // library scrolls the page. An ignored press does nothing at all: it does not even take the focus.
  const quietUntil = useRef(0), quietLimit = useRef(0), ownScroll = useRef(0), arrivedUntil = useRef(0);
  // Until when a scroll is the library's own move, for arming the guard: unlike ownScroll it is not carried on by
  // the scroll events that follow, so a customer who starts scrolling straight after does not keep it armed.
  const arrivalScroll = useRef(0);
  const arrive = (now: number) => { arrivedUntil.current = Math.max(arrivedUntil.current, now + ARRIVAL_MS); };
  const pointer = useRef<Point | null>(null), held = useRef<(Point & { until: number }) | null>(null);
  const hold = () => {
    const now = performance.now(), current = held.current && now < held.current.until ? held.current : pointer.current;
    if (current) held.current = { ...current, until: now + HOLD_MS };
    ownScroll.current = Math.max(ownScroll.current, now + OWN_SCROLL_MS);
    arrivalScroll.current = Math.max(arrivalScroll.current, now + OWN_SCROLL_MS);
  };
  const quiet = () => {
    const now = performance.now();
    quietUntil.current = now + QUIET_MS; quietLimit.current = now + QUIET_LIMIT_MS;
    hold();
  };
  // Every scroll the library asks for goes through here.
  const bring = (target: Element | null | undefined, block: ScrollLogicalPosition) => {
    if (!target || typeof window === "undefined") return;
    const behavior = scrolling();
    quiet();
    const until = performance.now() + (behavior === "smooth" ? 1000 : OWN_SCROLL_MS);
    ownScroll.current = Math.max(ownScroll.current, until); arrivalScroll.current = Math.max(arrivalScroll.current, until);
    target.scrollIntoView({ behavior, block });
  };
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    // The browser reports a scroll at its next frame; a press can arrive before that. Each handler first takes
    // account of a scroll that has happened but has not been reported yet.
    let seenY = window.scrollY;
    // Where each press under way began, by pointer. A touch screen delivers the click of a tap at the nearest
    // control, which can be several pixels from the finger, so a press is judged by where it began, not where its
    // click lands. Two quick taps can both begin before the first one's click arrives (while the page is busy), so
    // each click is matched to its own press; a browser whose clicks carry no pointer uses the latest press.
    const pressedAt = new Map<number, { x: number; y: number }>();
    let lastPress: { x: number; y: number } | null = null;
    const caughtUp = () => { if (window.scrollY !== seenY) scrolled(); };
    // Whether a press is ignored, judged when its mouse button goes down (so that an ignored press does not even
    // take the focus, after which a key would act on that control) and again at its click.
    const ignored = (event: MouseEvent, consume: boolean) => {
      caughtUp();
      const id = (event as Partial<PointerEvent>).pointerId, own = typeof id === "number" ? pressedAt.get(id) : undefined;
      const from = own ?? lastPress ?? { x: event.clientX, y: event.clientY };
      if (consume) { if (own) pressedAt.delete(id as number); lastPress = null; }
      // When the press happened, not when the page got round to it: a busy page delivers taps late, and a
      // page that seems stuck is when a customer taps again.
      const now = Math.min(performance.now(), event.timeStamp > 0 ? event.timeStamp : Infinity), still = held.current;
      const moved = Boolean(still && now < still.until && Math.hypot(from.x - still.x, from.y - still.y) <= still.radius && controlOf(event.target) !== still.control);
      const arriving = now < arrivedUntil.current && Boolean((event.target as Element | null)?.closest?.("[data-arrival-guard]"));
      return now < quietUntil.current || moved || arriving;
    };
    // A press that was ignored when its button went down stays ignored, however slowly it is released.
    let downIgnored = false;
    const ignoreDown = (event: MouseEvent) => {
      if (event.detail === 0) return;
      downIgnored = ignored(event, false);
      if (downIgnored) event.preventDefault();
    };
    const ignorePress = (event: MouseEvent) => {
      if (event.detail === 0) return;   // the keyboard
      const skip = ignored(event, true) || downIgnored;
      downIgnored = false;
      if (skip) { event.preventDefault(); event.stopPropagation(); }
    };
    const release = () => { held.current = null; };
    // A press the browser took over (a touch that became a scroll) sends no click.
    const cancel = (event: PointerEvent) => { pressedAt.delete(event.pointerId); lastPress = null; release(); };
    // Where the pointer is and which control it is on. A move to the same point (as a browser may report after
    // the page moved under it) changes nothing.
    const track = (event: PointerEvent) => {
      caughtUp();
      const at = { x: event.clientX, y: event.clientY, radius: event.pointerType === "mouse" ? MOUSE_RADIUS : TOUCH_RADIUS, control: controlOf(event.target) };
      if (event.type === "pointerdown") {
        // A press on a switched-off control sends no click: keep only the few latest presses.
        pressedAt.delete(event.pointerId); pressedAt.set(event.pointerId, { x: at.x, y: at.y });
        if (pressedAt.size > 4) pressedAt.delete(pressedAt.keys().next().value as number);
        lastPress = { x: at.x, y: at.y };
      }
      const still = held.current, last = pointer.current;
      if (still && performance.now() < still.until && Math.hypot(at.x - still.x, at.y - still.y) <= still.radius) return;
      if (event.type === "pointermove" && last && last.x === at.x && last.y === at.y) return;
      release(); pointer.current = at;
    };
    function scrolled() {
      const now = performance.now();
      seenY = window.scrollY;
      if (now < quietUntil.current) quietUntil.current = Math.min(now + QUIET_MS, quietLimit.current);
      const own = now < ownScroll.current;
      // The library moved the page: what is under a pointer now may be a guarded control.
      if (own) { ownScroll.current = now + OWN_SCROLL_MS; if (now < arrivalScroll.current) arrive(now); }
      if (own && held.current && now < held.current.until) return;
      // Someone else moved the page (or nothing is held): what is under the pointer now is what the customer sees there.
      release();
      const last = pointer.current;
      if (last) last.control = controlOf(document.elementFromPoint(last.x, last.y));
    }
    const capture = { capture: true, passive: true };
    document.addEventListener("click", ignorePress, true);
    document.addEventListener("mousedown", ignoreDown, true);
    document.addEventListener("pointerdown", track, capture);
    document.addEventListener("pointermove", track, capture);
    document.addEventListener("pointercancel", cancel, capture);
    document.addEventListener("wheel", release, capture);
    document.addEventListener("keydown", release, true);
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      document.removeEventListener("click", ignorePress, true);
      document.removeEventListener("mousedown", ignoreDown, true);
      document.removeEventListener("pointerdown", track, capture);
      document.removeEventListener("pointermove", track, capture);
      document.removeEventListener("pointercancel", cancel, capture);
      document.removeEventListener("wheel", release, capture);
      document.removeEventListener("keydown", release, true);
      window.removeEventListener("scroll", scrolled);
      quietUntil.current = 0; held.current = null; pointer.current = null;
    };
  }, []);
  useEffect(() => { onBusyChange(Boolean(busy)); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true); setEntries([]); setCursor(undefined); setError(""); leavePanel(); setDetail(null); setPlaying(""); pageCursors.current.clear(); loadedPageCount.current = 1;
    void loadLibraryWindow(view, api)
      .then(page => { if (request === sequence.current) {
        setEntries(page.entries); setCursor(page.cursor); pageCursors.current = page.cursors; loadedPageCount.current = page.pageCount;
      } })
      .catch(cause => { if (request === sequence.current) { setErrorAt(""); setError(errorText(cause)); } })
      .finally(() => { if (request === sequence.current) setLoading(false); });
  }, [view, reload]);
  useEffect(() => {
    const request = ++detailSequence.current;
    if (!linkedFilm) {
      lock.current = false; leavePanel(); setDetail(null); setPlaying(""); setBusy("");
      if (libraryHash.startsWith("#library?")) { setErrorAt(""); setError("This film link is invalid. Choose a saved film from your library."); }
      return;
    }
    let cancelled = false;
    lock.current = true; setBusyAt(""); setBusy("Opening your film status…"); setError(""); leavePanel(); setDetail(null); setPlaying("");
    void loadLibraryLinkedFilm(libraryHash, api)
      .then(value => { if (!cancelled && request === detailSequence.current) setDetail(value); })
      .catch(() => { if (!cancelled && request === detailSequence.current) { setErrorAt(""); setError("This saved film could not be opened. It may be unavailable or belong to another account. Sign in to the account that purchased it, or refresh to try again."); reveal("error"); } })
      .finally(() => { if (!cancelled && request === detailSequence.current) { lock.current = false; setBusy(""); } });
    return () => { cancelled = true; lock.current = false; };
  }, [linkedFilm, libraryHash, reload]);
  const listRefreshInterval = libraryRefreshDelay(entries);
  // A background refresh, which nobody pressed for, never removes or replaces an error shown in a card or under
  // "Load more saved films": that row would close under a pointer that the error was brought under, and lift
  // Archive / Move to trash into its place. The error stays until the customer's next action.
  useEffect(() => {
    if (disabled || busy || loading || playing || detail || confirmation) return;
    let cancelled = false;
    const request = sequence.current;
    const stop = startLibraryRefresh({ intervalMs: listRefreshInterval, focusTarget: window, visibilityTarget: document,
      canRefresh: () => document.visibilityState === "visible" && !lock.current && !backgroundRead.current,
      refresh: async () => {
        backgroundRead.current = true;
        try {
          // Preserve the visible cards and loaded pages until their replacement
          // is verified. Background checks never close a detail or video player.
          const page = await loadLibraryWindow(view, api, loadedPageCount.current);
          if (!cancelled && request === sequence.current && !lock.current) {
            setEntries(page.entries); setCursor(page.cursor); if (!errorInList.current) setError("");
            pageCursors.current = page.cursors; loadedPageCount.current = page.pageCount;
          }
        } catch { if (!cancelled && request === sequence.current && !errorInList.current) { setErrorAt(""); setError("Film status could not be refreshed. Your last confirmed status is shown. Use Refresh films to try again."); } }
        finally { backgroundRead.current = false; }
      },
    });
    return () => { cancelled = true; stop(); };
  }, [disabled, busy, loading, playing, detail, confirmation, listRefreshInterval, view, reload]);
  useEffect(() => {
    if (confirmation && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      // Its confirm button can open where the customer's finger or pointer already is.
      arrive(performance.now());
    }
  }, [confirmation]);
  // A guarded control that appears, or moves on the page, may have arrived under a pointer. Its place is its
  // layout position in the page (in the window for one in an open dialog), which neither the customer's own
  // scrolling nor a transform (a pressed button, the dialog's entrance) changes.
  const guardedAt = useRef(new Map<Element, string>());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const seen = new Map<Element, string>();
    let arrived = false;
    for (const control of document.querySelectorAll<HTMLElement>(".film-library [data-arrival-guard]")) {
      let x = 0, y = 0;
      for (let node: HTMLElement | null = control; node; node = node.offsetParent as HTMLElement | null) { x += node.offsetLeft; y += node.offsetTop; }
      const at = `${x},${y}`;
      if (guardedAt.current.get(control) !== at) arrived = true;
      seen.set(control, at);
    }
    guardedAt.current = seen;
    if (arrived) arrive(performance.now());
  });
  useEffect(() => {
    // The line an action has just produced can be out of sight: under an action row at the foot of the window,
    // at the head of the status panel, or at the top of the library when its card has left the view.
    // Bring it into view without moving focus; no animated scrolling when reduced motion is requested.
    // "nearest" moves the page no further than the line needs.
    if (!revealed.count) return;
    bring(({ message: messageLine, error: errorLine, busy: busyLine })[revealed.line].current, "nearest");
  }, [revealed]);
  useEffect(() => {
    if (detail) { panelOpen.current = true; detailPanel.current?.focus({ preventScroll: true }); bring(detailPanel.current, "start"); }
    // The panel has gone, whichever way it was closed: the page under it has moved up.
    else if (panelOpen.current) { panelOpen.current = false; quiet(); }
  }, [detail?.entry.kind, detail?.entry.id]);
  useEffect(() => {
    if (!detail) { automaticallyOpenedPlayer.current = ""; return; }
    const key = `detail:${libraryKey(detail.entry)}`;
    if (!libraryCanWatch(detail.entry) || automaticallyOpenedPlayer.current === key) return;
    // Reveal the verified film when it arrives, including after a payment
    // redirect or a status refresh. A customer can then close it normally.
    automaticallyOpenedPlayer.current = key;
    setPlaying(key);
    bring(detailPanel.current, "start");
  }, [detail]);
  useEffect(() => {
    if (!detail || disabled || busy || playing || confirmation) return;
    let cancelled = false;
    const expected = detail.entry;
    const refresh = async () => {
      backgroundRead.current = true;
      try {
        const value = await verifyLibraryDetail(await api<unknown>(`/api/library?action=detail&kind=${expected.kind}&id=${encodeURIComponent(expected.id)}`), expected);
        if (!cancelled) {
          setDetail(value);
          if (!errorInList.current) setError("");
          setEntries(current => current.map(entry => libraryKey(entry) === libraryKey(value.entry) ? value.entry : entry));
        }
      } catch { if (!cancelled && !errorInList.current) { setErrorAt(`detail:${libraryKey(expected)}`); setError("Film status could not be refreshed. Your last confirmed status is shown. Use Refresh film status to try again."); } }
      finally { backgroundRead.current = false; }
    };
    const stop = startLibraryRefresh({ intervalMs: libraryRefreshDelay([expected], 30_000),
      focusTarget: window, visibilityTarget: document,
      canRefresh: () => document.visibilityState === "visible" && !lock.current && !backgroundRead.current,
      refresh,
    });
    return () => { cancelled = true; stop(); };
  }, [detail, disabled, busy, playing, confirmation]);
  async function loadMore() {
    if (!cursor || lock.current || loading || disabled) return;
    const next = cursor, request = sequence.current;
    lock.current = true; setBusyAt(""); setBusy("Loading more films…"); setError("");
    try {
      if (pageCursors.current.has(next)) throw new Error("The next library page could not be verified. Refresh the library to continue.");
      const page = normalizeLibraryPage(await api<unknown>(`/api/library?view=${view}&cursor=${encodeURIComponent(next)}`), view);
      if (request === sequence.current) {
        pageCursors.current.add(next); loadedPageCount.current++; setEntries(current => mergeLibraryPages(current, page.entries)); setCursor(page.cursor);
      }
    } catch (cause) { if (mounted.current) { setErrorAt("more"); setError(errorText(cause)); reveal("error"); } }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function openDetail(entry: LibraryEntry, at = libraryKey(entry)) {
    if (lock.current || disabled) return;
    const request = ++detailSequence.current;
    lock.current = true; setBusyAt(at); setBusy("Opening your saved version…"); setError(""); reveal("busy");
    try {
      const value = await api<unknown>(`/api/library?action=detail&kind=${entry.kind}&id=${encodeURIComponent(entry.id)}`);
      const verified = await verifyLibraryDetail(value, entry);
      if (mounted.current && request === detailSequence.current) {
        if (libraryKey(verified.entry) !== detailKey) leavePanel();
        setDetail(verified); setPlaying("");
        setEntries(current => current.map(saved => libraryKey(saved) === libraryKey(verified.entry) ? verified.entry : saved));
      }
    } catch (cause) { if (mounted.current && request === detailSequence.current) { setErrorAt(at); setError(errorText(cause)); reveal("error"); } }
    finally { if (mounted.current && request === detailSequence.current) { lock.current = false; setBusy(""); } }
  }
  async function confirmAction() {
    if (!confirmation || lock.current || disabled) return;
    const selected = confirmation, at = selected.entry ? libraryKey(selected.entry) : selected.draft ? `draft:${selected.draft.id}` : "";
    lock.current = true; setBusyAt(at); setBusy(`${actions[selected.action]}…`); setError("");
    try {
      if (selected.entry) {
        const value = await api<unknown>("/api/library", libraryActionRequest(selected.entry, selected.action));
        const changed = normalizeLibraryAction(value, selected.entry, selected.action);
        if (mounted.current) { setEntries(current => current.filter(entry => libraryKey(entry) !== libraryKey(changed))); setDetail(null); setPlaying(""); }
      } else if (selected.draft) onLocalAction(selected.draft.id, selected.action);
      if (mounted.current) {
        // The card leaves this view, so its confirmation is shown at the top and brought into view.
        setMessageAt(""); reveal("message");
        setMessage(selected.action === "restore" ? "Film restored to your library." : selected.action === "archive" ? "Film archived. You can restore it from Archived." : "Film moved to Trash. You can restore it at any time.");
        dialog.current?.close(); setConfirmation(null);
      }
    } catch (cause) { if (mounted.current) { setErrorAt(at); setError(errorText(cause)); } }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  async function resumePaidFilm() {
    const payment = resumablePayment(detail);
    if (!detail || !payment || lock.current || disabled || productionAvailable !== true) return;
    const expected = detail.entry, request = ++detailSequence.current, at = libraryKey(expected);
    const isCurrent = () => mounted.current && request === detailSequence.current;
    const refreshDetail = async () => verifyLibraryDetail(await api<unknown>(
      `/api/library?action=detail&kind=${expected.kind}&id=${encodeURIComponent(expected.id)}`), expected);
    const showDetail = (value: LibraryDetail) => {
      if (!isCurrent()) return;
      setDetail(value);
      setEntries(current => current.map(entry => libraryKey(entry) === libraryKey(value.entry) ? value.entry : entry));
    };
    lock.current = true; setBusyAt(`detail:${at}`); setBusy("Resuming your paid film…"); setError(""); setMessage(""); reveal("busy");
    try {
      // Revalidate the exact stored manifest and payment before resuming it.
      const latest = await refreshDetail();
      if (!isCurrent()) return;
      showDetail(latest);
      if (resumablePayment(latest)?.id !== payment.id) {
        throw new Error("This film's status changed. Review its refreshed status before resuming production.");
      }
      const result = await api<ProductionStatus>("/api/studio", {
        action: "startProduction", preparedId: expected.id, orderId: payment.id, productionConsent: true,
      });
      if (!result || result.id !== expected.id || result.manifestHash !== expected.manifestHash
        || !["prepared", "queued", "submitting", "processing", "uncertain", "failed", "completed"].includes(result.status)) {
        throw new Error("The resume result could not be verified. Refresh this film's status before trying again.");
      }
      const refreshed = await refreshDetail();
      showDetail(refreshed);
      if (isCurrent()) {
        setMessageAt(`status:${at}`); reveal("message");
        setMessage(libraryCanWatch(refreshed.entry)
          ? "Your paid film is ready to watch."
          : "Resume request completed. Follow this saved film's current production status below.");
      }
    } catch (cause) { if (isCurrent()) { setErrorAt(`detail:${at}`); setError(errorText(cause)); reveal("error"); } }
    // Resume is offered again where it was: a second press of the same double press must not send it again.
    finally { if (isCurrent()) { lock.current = false; setBusy(""); arrive(performance.now()); } }
  }
  async function createVersion(entry: LibraryEntry) {
    if (lock.current || disabled || !detail?.manifest || detail.entry.kind !== "plan"
      || libraryKey(detail.entry) !== libraryKey(entry)) return;
    lock.current = true; setBusyAt(`version:${libraryKey(entry)}`); setBusy("Creating a separate draft…"); setError(""); setMessage(""); reveal("busy");
    try { await onCreateVersion(entry); }
    catch (cause) { if (mounted.current) { setErrorAt(`version:${libraryKey(entry)}`); setError(errorText(cause)); reveal("error"); } }
    finally { lock.current = false; if (mounted.current) setBusy(""); }
  }
  const blocked = disabled || Boolean(busy);
  const resumePayment = resumablePayment(detail);
  const drafts = projects.filter(project => localLibraryState(project) === view);
  // An error shown in the dialog moves to its film's card when the dialog closes: bring it into view there.
  const leaveConfirmation = () => { setConfirmation(null); if (error) reveal("error"); };
  const closeConfirmation = () => { if (!busy) { dialog.current?.close(); leaveConfirmation(); } };
  const openConfirmation = (value: Confirmation) => { if (!blocked) { setError(""); setConfirmation(value); } };
  // A line shown inside the status panel goes when that panel is closed, reloaded or shows another film
  // (the close button, a view switch, "Refresh films", a film link, the browser's Back).
  const leavePanel = () => { if (inPanel(messagePlace)) setMessage(""); if (inPanel(errorPlace)) setError(""); };
  const closeDetail = (returnToCard = false) => {
    detailSequence.current++;
    leavePanel();
    if (detail) quiet();
    if (returnToCard && detail && typeof document !== "undefined") {
      // Back to the card the panel belongs to: focus its first action ("View film status") and keep the card in view.
      const card = document.getElementById(`film-${detail.entry.kind}-${detail.entry.id}`)?.closest("article");
      card?.querySelector<HTMLElement>(".film-library-actions button")?.focus({ preventScroll: true });
      bring(card, "nearest");
    }
    setDetail(null); setPlaying("");
    if (linkedFilm) { window.history.replaceState(null, "", "#library"); setLibraryHash("#library"); }
  };
  const detailKey = detail ? libraryKey(detail.entry) : "";
  // A line is never placed where nothing is rendered: when its card or its panel is not on the page (another
  // view, a removed card, a panel that closed while the request was running), it is shown at the top.
  const places = new Set([...entries.map(entry => libraryKey(entry)), ...drafts.map(draft => `draft:${draft.id}`),
    ...(detail ? [`status:${detailKey}`, `detail:${detailKey}`, `version:${detailKey}`] : []), ...(cursor ? ["more"] : [])]);
  const placed = (at: string) => places.has(at) ? at : "";
  const attached = places.has(detailKey);
  const busyPlace = placed(busyAt), errorPlace = placed(errorAt), messagePlace = placed(messageAt);
  // Which lines are on the page, and where. When one appears, changes or goes, what follows it moves.
  const shown: [string, string][] = [[messagePlace, message], [errorPlace, confirmation ? "" : error], [busyPlace, busy]];
  const lines = shown.map(([place, text]) => text && `${place}:${text}`).join("|");
  // The lines in cards and under "Load more saved films". Only the customer's own actions write these; a
  // background refresh writes only the top of the library and the status panel.
  const cardLines = shown.map(([place, text]) => text && place && !inPanel(place) ? `${place}:${text}` : "").join("|");
  const linesBefore = useRef(lines), cardLinesBefore = useRef(cardLines);
  // In a card the row of lines does not get shorter while it stays (a one-line error after a two-line working
  // line): the page may have been scrolled for the taller one, and Archive / Move to trash must not rise to the
  // pointer. Each card row's tallest height so far, by place; a row that goes starts again from nothing.
  const [rowFloors, setRowFloors] = useState<Record<string, number>>({});
  useEffect(() => {
    if (linesBefore.current === lines) return;
    linesBefore.current = lines;
    // A row in a card changed: the customer's own action moved what follows it, so presses pause for a moment.
    // Any other change (the top or the panel, which is all a background refresh changes) only holds a still
    // pointer to the control it was on: a press on a control that did not move is never ignored.
    if (cardLinesBefore.current !== cardLines) quiet(); else hold();
    cardLinesBefore.current = cardLines;
    errorInList.current = Boolean(error) && !confirmation && errorPlace !== "" && !inPanel(errorPlace);
    const floors: Record<string, number> = {};
    for (const [place, line] of [[messagePlace, messageLine], [errorPlace, errorLine], [busyPlace, busyLine]] as const) {
      const height = line.current?.parentElement?.offsetHeight;
      if (height && place && !inPanel(place) && place !== "more") floors[place] = Math.max(height, floors[place] ?? 0);
    }
    setRowFloors(current => JSON.stringify(current) === JSON.stringify(floors) ? current : floors);
  }, [lines]);
  const notices = (at: string) => {
    const done = Boolean(message) && messagePlace === at, failed = Boolean(error) && !confirmation && errorPlace === at, working = Boolean(busy) && busyPlace === at;
    const lines = <>
      {done && <p ref={messageLine} className="feedback success" role="status">{message}</p>}
      {failed && <p ref={errorLine} className="feedback error" role="alert">{error}</p>}
      {working && <p ref={busyLine} role="status"><Loader2 className="spin" size={16} aria-hidden="true" /> {busy}</p>}
    </>;
    return at ? (done || failed || working) && <div className="film-library-notices" style={rowFloors[at] ? { minHeight: rowFloors[at] } : undefined}>{lines}</div> : lines;
  };
  // The film status panel sits in the card list, directly under its film's card. Its key keeps the same
  // element, and so the player and focus, wherever the list places it. Under its card it is marked as attached
  // (the notch that points at the card) and its headings rank below the card's own heading.
  const detailSection = detail && <section key="detail" ref={detailPanel} tabIndex={-1} className={`panel film-library-detail${attached ? " film-library-detail-attached" : ""}`} aria-labelledby="saved-film-detail-heading">
    <div className="section-title"><div><h2 id="saved-film-detail-heading" aria-level={attached ? 4 : undefined}>Film status: {detail.entry.title || "Untitled family film"}</h2>
      <p>{formatDuration(detail.entry.durationSeconds)} {detail.entry.kind === "plan" ? "target" : "runtime"} · Saved {new Date(detail.entry.createdAt).toLocaleString()}</p></div>
      <button type="button" className="icon-button" aria-label="Close saved film details" disabled={blocked} onClick={() => closeDetail(true)}><X size={18} /></button></div>
    {notices(`status:${detailKey}`)}
    <LibraryFilmStatus entry={detail.entry} productionAvailable={productionAvailable} generationAttemptAllowed={generationAttemptAllowed} />
    <SavedFilmPurchase key={detail.entry.id} entry={detail.entry} disabled={blocked} onRefresh={()=>openDetail(detail.entry)} />
    {resumePayment && <p className="field-note">Resume production using this saved screenplay and its existing payment.</p>}
    <div className="action-group film-library-actions">
      {resumePayment && <button type="button" className="button primary small" disabled={blocked || productionAvailable !== true} data-arrival-guard=""
        onClick={() => void resumePaidFilm()}><RotateCcw size={15} aria-hidden="true" />Resume paid film</button>}
      {libraryCanWatch(detail.entry) && <>
        <button type="button" className="button primary small" disabled={blocked} onClick={() => { if (errorPlace === detailKey || errorPlace === `detail:${detailKey}`) setError(""); setPlaying(playing === `detail:${libraryKey(detail.entry)}` ? "" : `detail:${libraryKey(detail.entry)}`); }}>{playing === `detail:${libraryKey(detail.entry)}` ? "Close player" : "Watch film"}</button>
        <a className="text-button" href={detail.entry.downloadUrl} download><Download size={15} aria-hidden="true" />Download film</a>
      </>}
      <button type="button" className="text-button" disabled={blocked} onClick={() => void openDetail(detail.entry, `detail:${detailKey}`)}><RefreshCw size={15} aria-hidden="true" />Refresh film status</button>
    </div>
    {notices(`detail:${detailKey}`)}
    {playing === `detail:${libraryKey(detail.entry)}` && libraryCanWatch(detail.entry) && <video controls playsInline preload="metadata" src={detail.entry.mediaUrl} aria-label={`${detail.entry.title || "Family film"} player`}
      onError={() => { setErrorAt(`detail:${detailKey}`); setError("This film could not be played. Refresh its status or try the download."); reveal("error"); }} />}
    <p className="field-note">Payment and production status are checked when you return here and while this page is open. A watch link appears only when your video is ready.</p>
    <p className="field-note">This saved version is separate from any edits in your browser draft.</p>
    {detail.scenes?.map((scene, index) => <article className="film-library-scene" key={index}><h3 aria-level={attached ? 5 : undefined}>{index + 1}. {scene.title || "Scene"}</h3>
      {scene.narration && <p><strong>Narration:</strong> {scene.narration}</p>}{scene.visual && <p><strong>Visual:</strong> {scene.visual}</p>}{scene.dialogue && <p><strong>Dialogue:</strong> {scene.dialogue}</p>}</article>)}
    {detail.manifest && <button type="button" className="button secondary small" onClick={() => downloadPlan(detail)}><Download size={15} aria-hidden="true" />Download saved plan</button>}
    <SavedPlanVersionAction detail={detail} disabled={blocked} onCreateVersion={createVersion} />
    {notices(`version:${detailKey}`)}
  </section>;
  return <div className="film-library">
    <div className="page-heading"><div><h1>Your film library</h1><p>Your saved films, production progress, and drafts in one place.</p></div>
      <button type="button" className="button primary" disabled={blocked} onClick={onCreate}><Plus size={17} aria-hidden="true" />Create film</button>
    </div>
    <div className="film-library-toolbar">
      <nav aria-label="Film library views">{(["active", "archived", "trash"] as LibraryView[]).map(item => <button type="button" key={item}
        className={`button small ${view === item ? "primary" : "secondary"}`} aria-current={view === item ? "page" : undefined}
        disabled={blocked} onClick={() => { closeDetail(); setView(item); setMessage(""); }}>{item === "active" ? "My films" : item === "archived" ? "Archived" : "Trash"}</button>)}</nav>
      <button type="button" className="text-button" disabled={blocked || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh films</button>
    </div>
    {notices("")}
    {view !== "active" && <p className="field-note">{view === "trash" ? "Nothing here is permanently deleted." : "Archived films stay in your account."} Active production continues, and payment records are retained. Restore returns a film to My films.</p>}
    {view === "active" && <LtxFilmLibrary />}
    <section aria-labelledby="saved-films-heading" aria-busy={loading}>
      <div className="section-title"><div><h2 id="saved-films-heading">Saved to your account</h2><p>Each card is a saved version. Its payment and production status are shown separately.</p></div></div>
      {loading && <p role="status"><Loader2 className="spin" size={20} aria-hidden="true" />Loading your saved films…</p>}
      {!loading && !entries.length && !error && <p className="film-library-empty"><FilmIcon size={22} aria-hidden="true" />{cursor ? "No films in this part of the list. Load more to continue." : view === "active" ? "No saved films yet. Create a film, or continue a browser draft below." : "No saved films in this view."}</p>}
      <div className="library-list">{[...entries.flatMap(entry => {
        const key = libraryKey(entry), local = projects.find(project => project.id === entry.filmId && localLibraryState(project) === "active");
        const isPlaying = playing === key;
        return [<article className="library-item film-library-item" key={key} aria-labelledby={`film-${entry.kind}-${entry.id}`}>
          <div className="library-art"><FilmIcon size={27} strokeWidth={1.2} aria-hidden="true" /></div>
          <div className="film-library-content"><h3 id={`film-${entry.kind}-${entry.id}`}>{entry.title || "Untitled family film"}</h3>
            <p>{formatDuration(entry.durationSeconds)}{entry.kind === "plan" ? " target" : " runtime"} · {entry.origin === "studio-delivery" ? "Delivered to your library" : "Saved"} {new Date(entry.createdAt).toLocaleString()}</p>
            <LibraryFilmStatus entry={entry} productionAvailable={productionAvailable} generationAttemptAllowed={generationAttemptAllowed} />
            <div className="action-group film-library-actions">
              <button type="button" className="button secondary small" disabled={blocked} onClick={() => void openDetail(entry)}>View film status</button>
              {libraryCanWatch(entry) && <>
                <button type="button" className="button primary small" disabled={blocked} onClick={() => { if (errorPlace === key || errorPlace === `detail:${key}`) setError(""); setPlaying(isPlaying ? "" : key); }}>{isPlaying ? "Close player" : "Watch film"}</button>
                <a className="text-button" href={entry.downloadUrl} download><Download size={15} aria-hidden="true" />Download film</a>
              </>}
              {local && !entry.coverage && <button type="button" className="text-button" disabled={blocked} onClick={() => onOpenDraft(local.id)}>Open browser draft</button>}
              {/* The film's line sits under its actions and above Archive / Move to trash: bringing it into view
                  can put only the line itself, never that row, under a pointer resting on the actions. */}
              {notices(key)}
              {view === "active" && <button type="button" className="text-button film-library-manage" disabled={blocked} onClick={() => openConfirmation({ entry, action: "archive" })}><Archive size={14} aria-hidden="true" />Archive</button>}
              {view !== "active" && <button type="button" className="text-button film-library-manage" disabled={blocked} onClick={() => openConfirmation({ entry, action: "restore" })}><RotateCcw size={14} aria-hidden="true" />Restore</button>}
              {view !== "trash" && <button type="button" className="text-button film-library-manage film-library-trash" disabled={blocked} onClick={() => openConfirmation({ entry, action: "trash" })}><Trash2 size={14} aria-hidden="true" />Move to trash</button>}
            </div>
            {isPlaying && libraryCanWatch(entry) && <video controls playsInline preload="metadata" src={entry.mediaUrl} aria-label={`${entry.title || "Family film"} player`}
              onError={() => { setErrorAt(key); setError("This film could not be played. Refresh its status or try the download."); reveal("error"); }} />}
          </div>
        </article>, key === detailKey && detailSection];
      }), !attached && detailSection]}</div>
      {cursor && <button type="button" className="button secondary film-library-more" disabled={blocked || loading} onClick={() => void loadMore()}>Load more saved films</button>}
      {notices("more")}
    </section>
    <section aria-labelledby="browser-drafts-heading" className="film-library-drafts"><div className="section-title"><div>
      <h2 id="browser-drafts-heading">Browser drafts</h2><p>These editable drafts and original source files are stored on this browser. They are not a backup of your account's saved versions.</p>
    </div></div>
      {!drafts.length && <p className="film-library-empty"><FilmIcon size={22} aria-hidden="true" />No browser drafts in this view.</p>}
      <div className="library-list">{drafts.map(draft => {
        const covered = libraryCoveredDraft(detail ? [detail.entry, ...entries] : entries, draft);
        return <article className="library-item film-library-item" key={draft.id}>
        <div className="library-art"><FilmIcon size={24} aria-hidden="true" /></div><div className="film-library-content"><h3>{draft.title || "Untitled family film"}</h3>
          <p>Saved in this browser · {draft.sources.length} sources · {new Date(draft.updatedAt).toLocaleDateString()}</p>
          <p>{covered ? "This saved corrected version is covered by the original payment. Open its film status to follow production."
            : draft.paymentReference ? "A payment reference is saved. Use the account version above for confirmed payment and production status." : draft.scenes.length ? "Script draft ready to review." : "Story in development."}</p>
          <div className="action-group film-library-actions">
            {view === "active" && (covered ? <a className="button secondary small" href={libraryFilmLink(covered.id)}>View corrected film status</a>
              : <button type="button" className="button secondary small" disabled={blocked} onClick={() => onOpenDraft(draft.id)}>Continue draft</button>)}
            {notices(`draft:${draft.id}`)}
            {view === "active" && <button type="button" className="text-button film-library-manage" disabled={blocked} onClick={() => openConfirmation({ draft, action: "archive" })}><Archive size={14} aria-hidden="true" />Archive draft</button>}
            {view !== "active" && <button type="button" className="text-button film-library-manage" disabled={blocked} onClick={() => openConfirmation({ draft, action: "restore" })}><RotateCcw size={14} aria-hidden="true" />Restore draft</button>}
            {view !== "trash" && <button type="button" className="text-button film-library-manage film-library-trash" disabled={blocked} onClick={() => openConfirmation({ draft, action: "trash" })}><Trash2 size={14} aria-hidden="true" />Move draft to trash</button>}
          </div></div>
      </article>; })}</div>
    </section>
    {confirmation && <dialog ref={dialog} className="film-library-dialog" data-action={confirmation.action} aria-labelledby="library-confirm-title" aria-describedby="library-confirm-description"
      onCancel={event => { if (busy) event.preventDefault(); else leaveConfirmation(); }}>
      <h2 id="library-confirm-title">{actions[confirmation.action]} {confirmation.entry?.title || confirmation.draft?.title || "Untitled family film"}?</h2>
      <p id="library-confirm-description">{confirmation.action === "restore" ? "Return this item to My films." : confirmation.action === "archive" ? "Move this item to Archived. You can restore it at any time." : "Move this item to Trash. You can restore it at any time; nothing is permanently deleted."}
        {confirmation.draft ? " This changes this browser draft only." : " This changes the saved version's library location only."} Active production is not cancelled. Payment records are retained.</p>
      {error && <p className="feedback error" role="alert">{error}</p>}
      <div className="action-group"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={closeConfirmation} autoFocus>Cancel</button>
        <button type="button" className="button primary" disabled={blocked} data-arrival-guard="" onClick={() => void confirmAction()}>{busy || actions[confirmation.action]}</button></div>
    </dialog>}
  </div>;
}
