import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Download,
  FileText,
  Film as FilmIcon,
  FolderOpen,
  Loader2,
  Music2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { type Source, type Scene, type Theme, type FilmPaymentReference, formatDuration, productionStatusMessage } from "./model";
import FilmCheckout from "./FilmCheckout";
import type { FilmOrder } from "./checkout-contract";
import { getSourceObjectUrl } from "../lib/storage";

import type { Capabilities, StepProps } from "./Workspace";

function SourceThumb({ source }: { source: Source }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let gone = false;
    let created = "";
    if (source.type.startsWith("image"))
      void getSourceObjectUrl(source.id)
        .then((u) => {
          created = u || "";
          if (!gone) setUrl(created);
          else if (created) URL.revokeObjectURL(created);
        })
        .catch(() => {});
    return () => {
      gone = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [source.id, source.type]);
  return url ? (
    <img className="source-thumb" src={url} alt={source.name} />
  ) : (
    <div className="source-thumb file-thumb">
      {source.type.startsWith("audio") ? (
        <Music2 size={18} />
      ) : source.type.startsWith("video") ? (
        <Video size={18} />
      ) : (
        <FileText size={18} />
      )}
    </div>
  );
}

export function ArchiveStep({
  film,
  update,
  notify,
  busy,
  upload,
  openMediaLibrary,
  next,
}: StepProps & {
  upload: (files: FileList | File[]) => Promise<void>;
  openMediaLibrary: () => void;
  next: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState("");
  return (
    <section className="panel archive-panel">
      <div className="section-title">
        <div>
          <h2>Begin with the people you remember</h2>
          <p>
            Upload your memories and records. They become the foundation for an uplifting
            film with a full cast.
          </p>
        </div>
        <FolderOpen size={22} strokeWidth={1.4} />
      </div>
      <div className="form-grid">
        <label>
          Film title
          <input
            value={film.title}
            maxLength={150}
            placeholder="A story worth keeping"
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        <label>
          Ancestor or family name
          <input
            value={film.ancestor}
            maxLength={150}
            placeholder="Who is at the heart of this story?"
            onChange={(e) => update({ ancestor: e.target.value })}
          />
        </label>
        <label className="full">
          Time period & places
          <input
            value={film.era}
            maxLength={200}
            placeholder="For example, 1890–1945 · Scotland to Baltimore"
            onChange={(e) => update({ era: e.target.value })}
          />
        </label>
        <label className="full">
          A family story, memory, or script
          <textarea
            rows={6}
            value={film.script}
            maxLength={200000}
            placeholder="Begin with what you know. Names, dates, places, small details, turning points…"
            onChange={(e) => update({ script: e.target.value })}
          />
        </label>
      </div>
      <div className="field-row">
        <span className="field-note">
          Include relatives, friends, neighbors, work, and everyday details.
        </span>
        <span className="field-note">
          {film.script.trim() ? film.script.trim().split(/\s+/).length : 0} words
        </span>
      </div>
      <div className="section-subtitle">
        <h3>Photos, letters & archival materials</h3>
        <span>{film.sources.length} sources</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept=".jpg,.jpeg,.png,.webp,.pdf,.docx,.doc,.txt,.md,.ged,.csv,.mp3,.wav,.m4a,.mp4,.mov,.webm,.ogg"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        className="upload-zone"
        disabled={!!busy}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy) void upload(e.dataTransfer.files);
        }}
      >
        <Upload size={24} strokeWidth={1.4} />
        <span>
          {busy.startsWith("Reading") ? busy : "Drop files here or click to upload"}
        </span>
        <small>Photos, PDF, Word, text, GEDCOM, audio & video · 100 MB per file</small>
      </button>
      {film.sources.length > 0 && (
        <div className="source-list">
          {film.sources.map((source) => (
            <div key={source.id} className="source-item">
              <SourceThumb source={source} />
              <div className="source-info">
                <span>{source.name}</span>
                <small>
                  {source.extraction || "Saved source"} ·{" "}
                  {(source.size / 1024 / 1024).toFixed(1)} MB
                </small>
                <input
                  aria-label={`Context for ${source.name}`}
                  placeholder="Add names, dates, or source context…"
                  value={source.note || ""}
                  onChange={(e) =>
                    update({
                      sources: film.sources.map((s) =>
                        s.id === source.id ? { ...s, note: e.target.value } : s,
                      ),
                    })
                  }
                />
                {source.text && (
                  <>
                    <button
                      className="text-button"
                      onClick={() => {
                        setExpanded(expanded === source.id ? "" : source.id);
                        notify("Source text view updated.", "info");
                      }}
                    >
                      {expanded === source.id ? "Hide" : "Review"} extracted text
                    </button>
                    {expanded === source.id && (
                      <pre className="extracted-text">{source.text}</pre>
                    )}
                  </>
                )}
              </div>
              <button
                className="icon-button"
                disabled={!!busy}
                aria-label={`Remove ${source.name}`}
                onClick={() => {
                  update({
                    sources: film.sources.filter((s) => s.id !== source.id),
                    scenes: film.scenes.map((s) => ({
                      ...s,
                      sourceIds: s.sourceIds.filter((id) => id !== source.id),
                    })),
                    characters: film.characters.map((c) => ({
                      ...c,
                      sourceIds: c.sourceIds.filter((id) => id !== source.id),
                    })),
                    ...(film.audioId === source.id ? { audioId: undefined } : {}),
                  });
                  notify(`${source.name} removed from this film.`);
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="panel-actions">
        <span className="field-note">
          New uploads save to your private media library with administrator access, including after you archive or remove them. Film drafts also keep a browser copy. You choose when AI may read your sources.
        </span>
        <button className="button secondary small" disabled={!!busy} onClick={openMediaLibrary}>Browse media library</button>
        <button className="button primary" disabled={!!busy} onClick={next}>
          Develop my film
          <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

// The running times offered. A draft that carries any other value keeps it and shows it as one more option.
const runningTimes = [30, 60, 120, 300, 600];
type DirectionProps = StepProps & {
  caps: Capabilities | null;
  aiConsent: boolean;
  setAiConsent: (v: boolean) => void;
  themeOrigin: string;
  suggest: () => Promise<void>;
  selectTheme: (t: Theme) => void;
  plan: () => Promise<void>;
  editorial: () => void;
  archivePlan: () => void;
};
export function DirectionStep({
  film,
  update,
  busy,
  navigate,
  caps,
  aiConsent,
  setAiConsent,
  themeOrigin,
  suggest,
  selectTheme,
  plan,
  editorial,
  archivePlan,
}: DirectionProps) {
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>A life surrounded by stories</h2>
          <p>Develop a complete film from your memories, photographs, and records.</p>
        </div>
        <Sparkles size={23} />
      </div>
      <div className="story-promise">
        <FilmIcon size={26} />
        <div>
          <h3>The ancestor at the heart. A world around them.</h3>
          <p>
            A warm, respectful portrait with supporting characters, shared moments,
            setbacks, and a hopeful ending. The film can fill gaps with plausible dramatic
            details for your review.
          </p>
        </div>
      </div>
      <div className="choice-row" role="group" aria-label="Story treatment">
        <button
          className={`choice ${film.factuality === "based-on-a-true-story" ? "chosen" : ""}`}
          aria-pressed={film.factuality === "based-on-a-true-story"}
          disabled={!!busy}
          onClick={() =>
            update({ style: "Cinematic", factuality: "based-on-a-true-story" })
          }
        >
          <span>
            <FilmIcon size={19} />
            Based on a true story
            {film.factuality === "based-on-a-true-story" && <Check size={16} />}
          </span>
          <small>
            Recommended · realistic cinematic imagery, an ensemble cast, and clearly labeled
            dramatization.
          </small>
        </button>
        <button
          className={`choice ${film.factuality === "documentary" ? "chosen" : ""}`}
          aria-pressed={film.factuality === "documentary"}
          disabled={!!busy}
          onClick={() => update({ style: "Documentary", factuality: "documentary" })}
        >
          <span>
            <FileText size={19} />
            Documentary{film.factuality === "documentary" && <Check size={16} />}
          </span>
          <small>
            Documented people and events. Gaps remain open rather than becoming invented
            scenes.
          </small>
        </button>
      </div>
      <div className="duration-row">
        <fieldset className="duration-choice">
          <legend>Target running time</legend>
          <div className="duration-options">
            {(runningTimes.includes(film.duration)
              ? runningTimes
              : [...runningTimes, film.duration].sort((a, b) => a - b)
            ).map((s) => (
              <label key={s} className={`choice ${film.duration === s ? "chosen" : ""}`}>
                <input
                  type="radio"
                  name="film-duration"
                  value={s}
                  checked={film.duration === s}
                  disabled={!!busy}
                  onChange={() => update({ duration: s })}
                />
                <span>{formatDuration(s)}</span>
                <small>
                  {s === 120
                    ? "Short film · recommended"
                    : s <= 60
                      ? "Trailer"
                      : "Extended family story"}
                </small>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="field-note">
          Final running time and available film quality will be confirmed before you
          approve production.
        </p>
      </div>
      <div className="ai-consent">
        <label className="check-label">
          <input
            type="checkbox"
            checked={aiConsent}
            disabled={!!busy}
            onChange={(e) => setAiConsent(e.target.checked)}
          />
          Allow Lineage Theatre's AI tools to read my family story, extracted document text, photo
          captions, and up to 8 reference photos to develop this film.
        </label>
        <small>
          Text, context, and available reference photos are sent to our AI service only
          when you request development. See our <a href="/privacy.html" target="_blank"
          rel="noreferrer">privacy information</a> for how these materials are processed.
          Add captions for people and events that a photograph alone cannot establish.
          Source coverage is shown with the draft.
        </small>
      </div>
      {!caps?.story && (
        <div className="feedback info" role="status">
          {caps
            ? "Story development is temporarily unavailable. You can edit your archive and prepare a manual outline."
            : "Checking story development availability…"}
        </div>
      )}
      <div className="develop-action">
        <div>
          <h3>One action to develop your film</h3>
          <p>
            We choose a story direction, then draft the script, supporting cast, scenes,
            and assumptions. Everything stays editable.
          </p>
        </div>
        <button
          className="button primary"
          disabled={!!busy || !caps?.story || !aiConsent}
          onClick={() => void plan()}
        >
          {busy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}Develop
          my film
        </button>
      </div>
      <details className="optional-directions">
        <summary>
          Choose a story direction yourself <span>Optional</span>
        </summary>
        <div className="section-subtitle">
          <div>
            <h3>Story ideas</h3>
            <span>{themeOrigin || "Select up to three, or let us choose."}</span>
          </div>
          <button
            className="button secondary small"
            disabled={!!busy || !caps?.story || !aiConsent}
            onClick={() => void suggest()}
          >
            <RefreshCw size={15} />
            {film.themes.length ? "New ideas" : "Suggest ideas"}
          </button>
        </div>
        {film.themes.length ? (
          <div className="theme-list">
            {film.themes.map((theme, i) => {
              const selected = film.selectedThemes.some((t) => t.id === theme.id);
              return (
                <article
                  className={`theme-item ${selected ? "chosen" : ""}`}
                  key={theme.id}
                >
                  <button
                    className="theme-select"
                    aria-pressed={selected}
                    disabled={!!busy}
                    onClick={() => selectTheme(theme)}
                  >
                    <span className="theme-number">
                      {selected ? <Check size={16} /> : String(i + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h4>{theme.title}</h4>
                      <p>{theme.plot}</p>
                    </div>
                  </button>
                  {selected && (
                    <div className="theme-detail">
                      <p>
                        <span>Proposed climax</span>
                        {theme.climax}
                      </p>
                      <p>
                        <span>Why it fits</span>
                        {theme.reason}
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-inline">
            <p>
              Choose ideas after AI development is connected, or explore editable
              editorial prompts.
            </p>
            <button className="text-button" disabled={!!busy} onClick={editorial}>
              Explore editorial prompts
              <ArrowRight size={14} />
            </button>
          </div>
        )}
      </details>
      <div className="panel-actions">
        <button className="text-button" disabled={!!busy} onClick={() => navigate(0)}>
          <ArrowLeft size={15} />
          My sources
        </button>
        <button className="text-button" disabled={!!busy} onClick={archivePlan}>
          Start a manual outline
          <ArrowRight size={15} />
        </button>
      </div>
    </section>
  );
}

type FilmCharacter = import("./model").Character;
// After a press changes a card's or a section's mode, how long the presses that follow
// are ignored, in milliseconds: any press, and one counted as part of a double click.
const QUIET_AFTER_MODE_CHANGE = 500;
const QUIET_FOR_DOUBLE_CLICK = 1500;
// Reading view: a value as text, or a quiet note that it is still missing.
function readValue(value: string, missing = "Not added yet") {
  return value?.trim() ? value : <span className="read-empty">{missing}</span>;
}
export function CuttingStep({
  film,
  update,
  notify,
  busy,
  navigate,
  changeScene,
}: StepProps & { changeScene: (id: string, patch: Partial<Scene>) => void }) {
  const referencedSources = new Set([
    ...film.scenes.flatMap((s) => s.sourceIds),
    ...film.characters.flatMap((c) => c.sourceIds),
  ]);
  const coverage = film.sourceCoverage;
  const referencePhotos = film.sources.filter(source => ["image/jpeg", "image/png", "image/webp"].includes(source.type));
  const evidenceSources: Source[] = [
    ...(film.script.trim()
      ? [
          {
            id: "@family-narrative",
            name: "Family narrative",
            type: "text/plain",
            size: film.script.length,
          },
        ]
      : []),
    ...film.sources,
  ];
  const changeCharacter = (id: string, patch: Partial<FilmCharacter>) =>
    update({
      characters: film.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  // Character and scene cards open as a reading view. The cards being edited are
  // kept here by film and card id; this is view state only and is never saved.
  const [editing, setEditing] = useState<Set<string>>(() => new Set());
  const focusAfterRender = useRef<{ cardId: string; selector: string } | null>(null);
  const isEditing = (cardId: string) => editing.has(`${film.id}:${cardId}`);
  const setCardsEditing = (cardIds: string[], edit: boolean) =>
    setEditing((current) => {
      const next = new Set(current);
      for (const cardId of cardIds) {
        if (edit) next.add(`${film.id}:${cardId}`);
        else next.delete(`${film.id}:${cardId}`);
      }
      return next;
    });
  // A change of mode never moves the page under the pointer: one card keeps its place
  // in the window while the cards around it change height. (Browsers that anchor the
  // scroll position themselves pick a card of their own, often the one below.)
  const keepInPlace = useRef<{ cardId: string; top: number; limit: number } | null>(null);
  // One card changes mode: it stays where it is, and focus goes to its first field,
  // or back to its Edit button.
  const setCardMode = (cardId: string, edit: boolean) => {
    focusAfterRender.current = {
      cardId,
      selector: edit ? "input, textarea, select" : ".card-mode",
    };
    const box = document.getElementById(cardId)?.getBoundingClientRect();
    keepInPlace.current = box ? { cardId, top: box.top, limit: -Infinity } : null;
    setCardsEditing([cardId], edit);
  };
  // A whole section changes mode: the card being read stays where it is. That is the
  // first card that starts under the section's header, or else the one card that fills
  // the window.
  const setSectionMode = (cardIds: string[], edit: boolean, control: HTMLElement) => {
    const limit = Math.max(
      control.getBoundingClientRect().bottom,
      control.closest(".section-subtitle")?.getBoundingClientRect().bottom ?? 0,
    );
    const shown = cardIds.flatMap((cardId) => {
      const box = document.getElementById(cardId)?.getBoundingClientRect();
      return box && box.bottom > limit && box.top < window.innerHeight ? [{ cardId, top: box.top, limit }] : [];
    });
    keepInPlace.current = shown.find((card) => card.top >= limit - 1) ?? shown[0] ?? null;
    setCardsEditing(cardIds, edit);
  };
  // A double click is one decision, and a change of mode moves the page under a pointer
  // that stays still: a form closes, the cards after it rise, the page ends sooner. So
  // after a press that changes a mode, the document is quiet for a moment: the next
  // presses do nothing, whatever has arrived under the pointer (a remove button, the
  // way forward, a neighbour's checkbox, the navigation outside this step).
  //   any:   until then, every press is ignored: half a second after the change, and
  //          half a second after each ignored press, so that a burst of presses stays
  //          one decision, but never later than "multi";
  //   multi: until then, a press the browser counts as part of a double click is
  //          ignored: a second and a half after the change, for a slow double click.
  // Only presses start and feel the quiet, and a press is judged when it begins: one
  // that begins in the quiet period is ignored as a whole, however slowly it is released.
  // Activation from the keyboard, from assistive technology and from script reports a
  // click count of 0: it is never ignored and never starts a quiet period.
  const quiet = useRef({ any: 0, multi: 0, pending: false });
  const startQuiet = (now: number) => {
    quiet.current = { any: now + QUIET_AFTER_MODE_CHANGE, multi: now + QUIET_FOR_DOUBLE_CLICK, pending: false };
  };
  const isQuiet = (clickCount: number, at: number) =>
    clickCount > 0 && at < (clickCount > 1 ? Math.max(quiet.current.any, quiet.current.multi) : quiet.current.any);
  // Every control that changes a mode goes through here.
  const changeMode =
    (action: (control: HTMLElement) => void) =>
    (event: { detail: number; currentTarget: HTMLElement }) => {
      if (event.detail > 0) {
        startQuiet(performance.now());
        // Counted again once the page has moved (the effect below).
        quiet.current.pending = true;
      }
      action(event.currentTarget);
    };
  useEffect(() => {
    if (typeof document === "undefined") return;
    // Whether the press under way began in the quiet period.
    let pressIgnored = false;
    // An ignored press does nothing at all: it does not take the focus from where the
    // mode change put it (the field of a card that has just opened, the Edit button of
    // one that has just closed), place a caret, select a word, or open a list of options.
    const ignorePress = (event: MouseEvent) => {
      pressIgnored = isQuiet(event.detail, performance.now());
      if (pressIgnored) event.preventDefault();
    };
    const ignoreClick = (event: MouseEvent) => {
      if (event.detail === 0) return;
      const now = performance.now();
      const ignored = pressIgnored || isQuiet(event.detail, now);
      pressIgnored = false;
      if (ignored) {
        event.preventDefault();
        event.stopPropagation();
        quiet.current.any = Math.max(quiet.current.any, Math.min(now + QUIET_AFTER_MODE_CHANGE, quiet.current.multi));
      } else if (event.detail === 1) {
        // A first click that gets through starts a double click of its own.
        quiet.current.multi = 0;
      }
    };
    // On the document, before anything else sees the press: what arrives under the
    // pointer can be outside this step.
    document.addEventListener("mousedown", ignorePress, true);
    document.addEventListener("click", ignoreClick, true);
    return () => {
      document.removeEventListener("mousedown", ignorePress, true);
      document.removeEventListener("click", ignoreClick, true);
      quiet.current = { any: 0, multi: 0, pending: false };
    };
  }, []);
  // Outside the quiet period, the second press of a double click leaves the focus where
  // it is, except in a field, where it selects a word.
  const keepFocus = (event: { detail: number; target: EventTarget; preventDefault: () => void }) => {
    if (
      event.detail > 1 &&
      document.activeElement !== document.body &&
      !(event.target as Element).closest("input, textarea, select, summary")
    )
      event.preventDefault();
  };
  // A key held down is one press: its repeats do not change the mode again.
  const oncePerKeyPress = (event: { repeat: boolean; key: string; target: EventTarget; preventDefault: () => void }) => {
    if (event.repeat && event.key === "Enter" && (event.target as Element).closest(".card-mode, .section-mode"))
      event.preventDefault();
  };
  useEffect(() => {
    if (quiet.current.pending) startQuiet(performance.now());
    const keep = keepInPlace.current;
    keepInPlace.current = null;
    const box = keep && document.getElementById(keep.cardId)?.getBoundingClientRect();
    if (keep && box) {
      // Where the card was, or just under the header if it would now end above it.
      const top = keep.top + box.height > keep.limit ? keep.top : keep.limit;
      if (Math.abs(box.top - top) >= 1) window.scrollBy({ top: box.top - top, behavior: "instant" });
    }
    const focus = focusAfterRender.current;
    if (!focus) return;
    focusAfterRender.current = null;
    document.getElementById(focus.cardId)?.querySelector<HTMLElement>(focus.selector)?.focus();
  });
  const characterCards = film.characters.map((c) => `character-${c.id}`);
  const sceneCards = film.scenes.map((s) => `scene-${s.id}`);
  const allCharactersEditing = characterCards.length > 0 && characterCards.every(isEditing);
  const allScenesEditing = sceneCards.length > 0 && sceneCards.every(isEditing);
  return (
    <section className="panel cutting-panel" onMouseDown={keepFocus} onKeyDown={oncePerKeyPress}>
      <div className="section-title">
        <div>
          <h2>Your film, ready to shape</h2>
          <p>Review the script, cast, and dramatic choices before production.</p>
        </div>
        <span className="subtle-tag">
          {film.scenes.length} scenes · {film.characters.length} characters ·{" "}
          {formatDuration(film.duration)}
        </span>
      </div>
      {film.factuality === "based-on-a-true-story" && (
        <div className="story-label">
          <FilmIcon size={18} />
          <div>
            <strong>Based on a true story</strong>
            <p>
              Some scenes, supporting characters, and dialogue may be dramatized.
              Documented events remain the foundation; review each assumption below.
            </p>
          </div>
        </div>
      )}
      <div className="coverage-panel">
        <div className="section-subtitle">
          <h3>What informed this film</h3>
          <span>
            {film.sources.filter((s) => referencedSources.has(s.id)).length} of{" "}
            {film.sources.length} uploaded sources linked to the draft
          </span>
        </div>
        {coverage ? (
          <>
            <p>
              {coverage.readSources} of {coverage.totalSources} source records read ·{" "}
              {coverage.textCharacters.toLocaleString()} text characters ·{" "}
              {coverage.photosRead} of {coverage.photoSources} photos read
              {coverage.notesOnlySources > 0
                ? ` · ${coverage.notesOnlySources} sources read from notes only`
                : ""}
            </p>
            {coverage.warnings?.map((warning, i) => (
              <p className="coverage-warning" key={i}>
                <AlertCircle size={16} aria-hidden="true" />
                <span>{warning}</span>
              </p>
            ))}
          </>
        ) : (
          <p>
            {film.generatedBy?.startsWith("Manual")
              ? "This manual outline uses source text. Photos have not been interpreted by AI."
              : "AI source coverage has not been verified for this draft."}{" "}
            {film.sources.filter((s) => !s.text?.trim() && !s.note?.trim()).length > 0
              ? "Add context to photographs, audio, and files with no extracted text."
              : ""}
          </p>
        )}
        {evidenceSources.length > 0 && (
          <details>
            <summary>Review source links</summary>
            <ul className="source-coverage-list">
              {evidenceSources.map((source) => (
                <li key={source.id}>
                  <span>{source.name}</span>
                  <span>
                    {referencedSources.has(source.id)
                      ? "Linked to draft"
                      : "Not linked yet"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <label className="logline-label">
        The film in one sentence
        <input
          value={film.logline}
          placeholder="The emotional thread connecting your scenes"
          onChange={(e) => update({ logline: e.target.value })}
        />
      </label>
      <div className="script-section">
      <div className="section-subtitle">
        <div>
          <h3>The people in this story <span className="count-tag">{film.characters.length}</span></h3>
          <span>
            Give the ancestor relationships, community, and a life beyond the frame.
          </span>
        </div>
        <div className="action-group">
        {film.characters.length > 0 && (
          <button
            className="button secondary small section-mode"
            aria-label={allCharactersEditing ? "Done editing all characters" : "Edit all characters"}
            onClick={changeMode((control) => setSectionMode(characterCards, !allCharactersEditing, control))}
          >
            {allCharactersEditing ? <Check size={15} /> : <Pencil size={15} />}
            {allCharactersEditing ? "Done editing" : "Edit all"}
          </button>
        )}
        <button
          className="button secondary small"
          disabled={!!busy}
          onClick={changeMode(() => {
            const id = crypto.randomUUID();
            update({
              characters: [
                ...film.characters,
                {
                  id,
                  name: "",
                  role: "Supporting character",
                  description: "",
                  basis: "invented",
                  sourceIds: [],
                },
              ],
            });
            setCardMode(`character-${id}`, true);
          })}
        >
          <Plus size={15} />
          Add character
        </button>
        </div>
      </div>
      <div className="cast-grid">
        {film.characters.map((character, index) => {
          const cardId = `character-${character.id}`;
          const edit = isEditing(cardId);
          const photo = referencePhotos.find((source) => source.id === character.referencePhotoId);
          // The mode button keeps its place in both modes, and nothing else stands beside it.
          const modeButton = (
            <button
              className="button secondary small card-mode"
              aria-label={`${edit ? "Done editing" : "Edit"} ${character.name || `character ${index + 1}`}`}
              onClick={changeMode(() => setCardMode(cardId, !edit))}
            >
              {edit ? <Check size={15} /> : <Pencil size={15} />}
              {edit ? "Done" : "Edit"}
            </button>
          );
          return (
          <article className={`cast-card ${edit ? "editing" : ""}`} key={character.id} id={cardId}>
            <div className="cast-card-heading">
              <span className={`basis-tag ${character.basis}`}>
                {character.basis === "documented"
                  ? "Documented"
                  : character.basis === "inferred"
                    ? "Inferred · review"
                    : "Invented · dramatization"}
              </span>
              <div className="action-group">{modeButton}</div>
            </div>
            {!edit && (
              <>
                <h4>{readValue(character.name, "Unnamed character")}</h4>
                <p className="cast-role">
                  {readValue(character.role, "Role or relationship: not added yet")}
                </p>
                <p className="cast-description">
                  {readValue(character.description, "Character, appearance & motivation: not added yet")}
                </p>
              </>
            )}
            {edit && (
            <>
            <label>
              Name
              <input
                value={character.name}
                onChange={(e) => changeCharacter(character.id, { name: e.target.value })}
              />
            </label>
            <label>
              Role or relationship
              <input
                value={character.role}
                onChange={(e) => changeCharacter(character.id, { role: e.target.value })}
              />
            </label>
            <label>
              Character, appearance & motivation
              <textarea
                rows={3}
                value={character.description}
                onChange={(e) =>
                  changeCharacter(character.id, { description: e.target.value })
                }
              />
            </label>
            </>
            )}
            {/* One block in both modes, so the missing-photo alert is the same element
                before and after a mode change and is announced once. */}
            <div className="cast-photo-block">
            {!edit && photo && (
              <div className="cast-read-photo">
                <SourceThumb source={photo} />
                <p>
                  <span className="read-label">Appearance reference photo</span>
                  {photo.name}
                </p>
              </div>
            )}
            {edit && (
            <div className="cast-photo">
            <label>
              Appearance reference photo
              <select aria-label={`Appearance reference photo for ${character.name || "character"}`}
                value={character.referencePhotoId || ""} disabled={!!busy}
                onChange={(event) => {
                  const referencePhotoId = event.target.value;
                  changeCharacter(character.id, { referencePhotoId: referencePhotoId || undefined,
                    sourceIds: referencePhotoId && !character.sourceIds.includes(referencePhotoId)
                      ? [...character.sourceIds, referencePhotoId] : character.sourceIds });
                  notify(referencePhotoId ? `Photo selected for ${character.name || "this character"}. Prepare a new plan to include it.`
                    : `Appearance for ${character.name || "this character"} will use the written description.`);
                }}>
                <option value="">Use written appearance description</option>
                {character.referencePhotoId && !referencePhotos.some(source => source.id === character.referencePhotoId)
                  && <option value={character.referencePhotoId}>Selected photo is missing — choose a photo</option>}
                {referencePhotos.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
              </select>
            </label>
            <p className="field-note">Choose a clear photo of this person from your sources. Production uses it to guide their appearance.
              Add known identity and age details in the description above. Review generated scenes for likeness.</p>
            {character.referencePhotoId && referencePhotos.find(source => source.id === character.referencePhotoId) &&
              <SourceThumb source={referencePhotos.find(source => source.id === character.referencePhotoId)!} />}
            </div>
            )}
            {character.referencePhotoId && !referencePhotos.some(source => source.id === character.referencePhotoId) &&
              <p className="feedback error" role="alert">Restore the selected photo or choose a replacement before preparing production.</p>}
            </div>
            {!edit && (
              <p className="field-note">
                Evidence for this character · {character.sourceIds.length} sources
              </p>
            )}
            {edit && (
            <>
            <label>
              Basis
              <select
                value={character.basis}
                onChange={(e) =>
                  changeCharacter(character.id, {
                    basis: e.target.value as FilmCharacter["basis"],
                  })
                }
              >
                <option value="documented">Documented in family evidence</option>
                <option value="inferred">Inferred from context</option>
                <option value="invented">Invented for the dramatization</option>
              </select>
            </label>
            <details className="source-picker">
              <summary>
                Evidence for this character · {character.sourceIds.length} sources
              </summary>
              {evidenceSources.map((s) => (
                <label className="check-label" key={s.id}>
                  <input
                    type="checkbox"
                    checked={character.sourceIds.includes(s.id)}
                    disabled={character.referencePhotoId === s.id}
                    onChange={(e) =>
                      changeCharacter(character.id, {
                        sourceIds: e.target.checked
                          ? [...character.sourceIds, s.id]
                          : character.sourceIds.filter((id) => id !== s.id),
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </details>
            <div className="cast-card-foot">
              <button
                className="icon-button"
                aria-label={`Remove ${character.name || "character"}`}
                disabled={!!busy}
                onClick={() =>
                  update({
                    characters: film.characters.filter((c) => c.id !== character.id),
                    scenes: film.scenes.map((s) => ({
                      ...s,
                      characterIds: s.characterIds.filter((id) => id !== character.id),
                    })),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
              {modeButton}
            </div>
            </>
            )}
          </article>
          );
        })}
      </div>
      {!film.characters.length && (
        <p className="field-note empty-note">
          No cast has been developed yet. Add the ancestor and the people who shaped their
          life.
        </p>
      )}
      </div>
      <div className="script-section">
      <div className="section-subtitle">
        <div>
          <h3>Assumptions & dramatic choices <span className="count-tag">{film.assumptions.length}</span></h3>
          <span>Review what was added, and why it belongs in the story.</span>
        </div>
        <button
          className="button secondary small"
          disabled={!!busy}
          onClick={() =>
            update({
              assumptions: [
                ...film.assumptions,
                { id: crypto.randomUUID(), description: "", reason: "" },
              ],
            })
          }
        >
          <Plus size={15} />
          Add assumption
        </button>
      </div>
      <div className="assumption-list">
        {film.assumptions.map((a, i) => (
          <article className="assumption-card" key={a.id}>
            <span className="assumption-number">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <label>
                What is inferred or invented
                <textarea
                  rows={2}
                  value={a.description}
                  onChange={(e) =>
                    update({
                      assumptions: film.assumptions.map((x) =>
                        x.id === a.id ? { ...x, description: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Why this choice makes sense
                <input
                  value={a.reason}
                  onChange={(e) =>
                    update({
                      assumptions: film.assumptions.map((x) =>
                        x.id === a.id ? { ...x, reason: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
            </div>
            <button
              className="icon-button"
              aria-label={`Remove assumption ${i + 1}`}
              onClick={() =>
                update({ assumptions: film.assumptions.filter((x) => x.id !== a.id) })
              }
            >
              <X size={15} />
            </button>
          </article>
        ))}
      </div>
      {!film.assumptions.length && (
        <p className="field-note empty-note">
          No assumptions have been listed. Review dialogue and scene details for anything
          the family evidence does not establish.
        </p>
      )}
      </div>
      <div className="script-section">
      <div className="section-subtitle">
        <div>
          <h3>Script & scene direction <span className="count-tag">{film.scenes.length}</span></h3>
          <span>Every word and scene is editable</span>
        </div>
        {film.scenes.length > 0 && (
          <button
            className="button secondary small section-mode"
            aria-label={allScenesEditing ? "Done editing all scenes" : "Edit all scenes"}
            onClick={changeMode((control) => setSectionMode(sceneCards, !allScenesEditing, control))}
          >
            {allScenesEditing ? <Check size={15} /> : <Pencil size={15} />}
            {allScenesEditing ? "Done editing" : "Edit all"}
          </button>
        )}
      </div>
      {!film.scenes.length ? (
        <div className="empty-inline">
          <FilmIcon size={30} />
          <p>Your scenes will appear here.</p>
          <button className="button primary" onClick={() => navigate(1)}>
            Develop my film
            <ArrowRight size={16} />
          </button>
        </div>
      ) : (
        <div className="scene-list">
          {film.scenes.map((scene, i) => {
            const cardId = `scene-${scene.id}`;
            const edit = isEditing(cardId);
            const sceneCast = film.characters.filter((c) => scene.characterIds.includes(c.id));
            const moveEarlier = (
              <button
                className="icon-button"
                aria-label={`Move scene ${i + 1} earlier`}
                disabled={i === 0 || !!busy}
                onClick={() => {
                  const scenes = [...film.scenes];
                  [scenes[i - 1], scenes[i]] = [scenes[i], scenes[i - 1]];
                  update({ scenes });
                  notify("Scene moved earlier.");
                }}
              >
                <ArrowUp size={16} />
              </button>
            );
            return (
            <article className={`scene-card ${edit ? "editing" : ""}`} key={scene.id} id={`scene-${scene.id}`}>
              <div className="scene-index">
                {String(i + 1).padStart(2, "0")}
                <small>{formatDuration((i * film.duration) / film.scenes.length)}</small>
              </div>
              {!edit && (
                <div className="scene-content">
                  <div className="scene-heading">
                    <h4>{readValue(scene.title, "Scene title: not added yet")}</h4>
                    <div className="action-group">
                      {moveEarlier}
                      <button
                        className="button secondary small card-mode"
                        aria-label={`Edit scene ${i + 1}`}
                        onClick={changeMode(() => setCardMode(cardId, true))}
                      >
                        <Pencil size={15} />
                        Edit
                      </button>
                    </div>
                  </div>
                  <dl className="scene-read">
                    <div>
                      <dt>Narration</dt>
                      <dd>{readValue(scene.narration)}</dd>
                    </div>
                    <div>
                      <dt>Visual direction & cinematography</dt>
                      <dd>{readValue(scene.visual)}</dd>
                    </div>
                    <div>
                      <dt>Dialogue</dt>
                      <dd>{readValue(scene.dialogue)}</dd>
                    </div>
                    <div>
                      <dt>Dramatization in this scene</dt>
                      <dd>{readValue(scene.dramatization, "Review factual basis")}</dd>
                    </div>
                    <div>
                      <dt>Characters in this scene</dt>
                      <dd>
                        {sceneCast.length
                          ? sceneCast.map((c) => c.name || "Unnamed character").join(", ")
                          : readValue(
                              "",
                              film.characters.length
                                ? undefined
                                : "Add characters above to connect them to this scene.",
                            )}
                      </dd>
                    </div>
                  </dl>
                  <p className="field-note">
                    Source evidence & reference images · {scene.sourceIds.length} sources
                  </p>
                </div>
              )}
              {edit && (
              <div className="scene-content">
                <label>
                  Scene title
                  <input
                    value={scene.title}
                    onChange={(e) => changeScene(scene.id, { title: e.target.value })}
                  />
                </label>
                <div className="scene-fields">
                  <label>
                    Narration
                    <textarea
                      rows={4}
                      value={scene.narration}
                      onChange={(e) =>
                        changeScene(scene.id, { narration: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Visual direction & cinematography
                    <textarea
                      rows={4}
                      value={scene.visual}
                      onChange={(e) => changeScene(scene.id, { visual: e.target.value })}
                    />
                  </label>
                  <label>
                    Dialogue
                    <textarea
                      rows={3}
                      value={scene.dialogue}
                      placeholder="Name: spoken line. Identify invented dialogue below."
                      onChange={(e) =>
                        changeScene(scene.id, { dialogue: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Dramatization in this scene
                    <textarea
                      rows={3}
                      value={scene.dramatization}
                      placeholder="Which details or lines are reconstructed, inferred, or invented?"
                      onChange={(e) =>
                        changeScene(scene.id, { dramatization: e.target.value })
                      }
                    />
                  </label>
                </div>
                <fieldset className="scene-cast">
                  <legend>Characters in this scene</legend>
                  {film.characters.length ? (
                    film.characters.map((c) => (
                      <label className="check-label" key={c.id}>
                        <input
                          type="checkbox"
                          checked={scene.characterIds.includes(c.id)}
                          onChange={(e) =>
                            changeScene(scene.id, {
                              characterIds: e.target.checked
                                ? [...scene.characterIds, c.id]
                                : scene.characterIds.filter((id) => id !== c.id),
                            })
                          }
                        />
                        {c.name || "Unnamed character"}
                      </label>
                    ))
                  ) : (
                    <p className="field-note">
                      Add characters above to connect them to this scene.
                    </p>
                  )}
                </fieldset>
                <details className="source-picker">
                  <summary>
                    Source evidence & reference images · {scene.sourceIds.length} sources
                  </summary>
                  {evidenceSources.map((s) => (
                    <label className="check-label" key={s.id}>
                      <input
                        type="checkbox"
                        checked={scene.sourceIds.includes(s.id)}
                        onChange={(e) =>
                          changeScene(scene.id, {
                            sourceIds: e.target.checked
                              ? [...scene.sourceIds, s.id]
                              : scene.sourceIds.filter((id) => id !== s.id),
                          })
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </details>
                <div className="scene-bottom">
                  <span className="field-note">
                    {scene.characterIds.length} characters ·{" "}
                    {scene.dramatization ? "Dramatization noted" : "Review factual basis"}
                  </span>
                  <div className="action-group">
                    {moveEarlier}
                    <button
                      className="icon-button"
                      aria-label={`Remove scene ${i + 1}`}
                      disabled={film.scenes.length <= 1 || !!busy}
                      onClick={() =>
                        update({ scenes: film.scenes.filter((s) => s.id !== scene.id) })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                    <button
                      className="button secondary small card-mode"
                      aria-label={`Done editing scene ${i + 1}`}
                      onClick={changeMode(() => setCardMode(cardId, false))}
                    >
                      <Check size={15} />
                      Done
                    </button>
                  </div>
                </div>
              </div>
              )}
            </article>
            );
          })}
        </div>
      )}
      <button
        className="text-button add-scene"
        disabled={!!busy}
        onClick={changeMode(() => {
          const id = crypto.randomUUID();
          update({
            scenes: [
              ...film.scenes,
              {
                id,
                title: "A new chapter",
                narration: "",
                visual: "",
                sourceIds: [],
                characterIds: [],
                dialogue: "",
                dramatization: "",
              },
            ],
          });
          setCardMode(`scene-${id}`, true);
        })}
      >
        <Plus size={15} />
        Add a scene
      </button>
      </div>
      <p className="field-note draft-note">
        {film.generatedBy?.startsWith("Manual") ? "Manual outline from source text" : "Your editable film draft"} · Source links identify material
        used, not independent proof that every detail is true.
      </p>
      <div className="panel-actions">
        <button className="text-button" disabled={!!busy} onClick={() => navigate(1)}>
          <ArrowLeft size={15} />
          Story development
        </button>
        <button
          className="button primary"
          disabled={!!busy || !film.scenes.length}
          onClick={() => navigate(3)}
        >
          Create & watch
          <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

type CreateProps = StepProps & {
  caps: Capabilities | null;
  checkFilm: () => Promise<void>;
  resultUrl: string;
  persistPaymentReference: (reference: FilmPaymentReference) => void;
  clearExpiredPaymentReference: (reference: FilmPaymentReference, order: FilmOrder) => void;
  onNewFilmCheckout: () => void;
  onCheckoutBusy: (message: string) => void;
  brief: () => void;
  backup: () => void;
};
export function CreateStep({
  film,
  update,
  notify,
  busy,
  caps,
  checkFilm,
  resultUrl,
  persistPaymentReference,
  clearExpiredPaymentReference,
  onNewFilmCheckout,
  onCheckoutBusy,
  brief,
  backup,
  navigate,
}: CreateProps) {
  const mediaUrl =
    film.job?.status === "completed"
      ? `/api/studio?action=media&id=${encodeURIComponent(film.job.id)}`
      : resultUrl;
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>Bring your family's world to life</h2>
          <p>Create, watch, and keep your film in Lineage Theatre.</p>
          {!film.paymentReference && !film.job && caps?.productionProvider === "kling" && <p className="field-note">New films are produced with Kling. After payment is confirmed, follow production here and open the finished film in your library.</p>}
        </div>
        <FilmIcon size={24} />
      </div>
      <div className="production-hero">
        <div className="production-mark">
          <FilmIcon size={36} />
        </div>
        <div>
          <span className="eyebrow">Your cinematic family film</span>
          <h3>{film.title || "A story worth keeping"}</h3>
          <p>
            {film.logline ||
              `A lasting portrait of ${film.ancestor || "your ancestor"}, and the people who shaped their life.`}
          </p>
          <div className="production-facts">
            <span>{formatDuration(film.duration)} target</span>
            <span>{film.scenes.length} scenes</span>
            <span>{film.characters.length} characters</span>
            <span>
              {film.factuality === "documentary"
                ? "Documentary"
                : "Based on a true story"}
            </span>
          </div>
        </div>
      </div>
      <FilmCheckout key={`checkout:${film.id}`} film={film} productionAvailable={caps?.production === true} productionProvider={caps?.productionProvider} generationAttemptAllowed={caps?.generationAttempt === true} persistPaymentReference={persistPaymentReference} clearExpiredPaymentReference={clearExpiredPaymentReference} onNewFilmCheckout={onNewFilmCheckout} onPrepared={prepared=>update({productionPreparation:prepared})} onBusyChange={onCheckoutBusy} />
      <div className="panel-actions">
        <div className="action-group">
          <button className="text-button" onClick={() => navigate(2)}>
            <ArrowLeft size={15} />
            Edit film
          </button>
          <button className="text-button" onClick={brief}>
            <Download size={15} />
            Download script
          </button>
          <button className="text-button" onClick={backup}>
            <Download size={15} />
            Project backup
          </button>
        </div>
      </div>
      {film.job && (
        <div className="render-progress" role="status" data-status={film.job.status}>
          <p>
            {film.job.status === "queued" || film.job.status === "processing" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <FilmIcon size={16} />
            )}
            Film production: {film.job.status}
          </p>
          <p>{productionStatusMessage(film.job.status)}</p>
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() => void checkFilm()}
          >
            Check production status
          </button>
        </div>
      )}
      {mediaUrl && (
        <div className="finished-film">
          <div className="section-subtitle">
            <h3>
              <CheckCircle2 size={18} />
              {film.job?.status === "completed"
                ? "Your film is ready"
                : "Your previously created film"}
            </h3>
            <a
              className="button secondary small"
              href={mediaUrl}
              download={`${film.title.replace(/[^a-z0-9 -]/gi, "").trim() || "family-film"}.${film.job || film.outputType?.includes("mp4") ? "mp4" : "webm"}`}
              onClick={() => notify("Your film download has started.")}
            >
              <Download size={16} />
              Download film
            </a>
          </div>
          <video
            controls
            src={mediaUrl}
            playsInline
            onError={() =>
              notify(
                "The saved film could not play. Try downloading it, or check production status.",
                "error",
              )
            }
          />
          <p className="field-note">
            {film.outputAt ? `Created ${new Date(film.outputAt).toLocaleString()}. ` : ""}
            Download a copy to keep and share with your family.
          </p>
        </div>
      )}
    </section>
  );
}
