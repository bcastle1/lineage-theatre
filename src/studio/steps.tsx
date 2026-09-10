import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  Film as FilmIcon,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Music2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
  CheckCircle2,
} from "lucide-react";
import {
  type Source,
  type Scene,
  type Theme,
  studios,
  formatDuration,
} from "./model";
import { getSourceObjectUrl } from "../lib/storage";
import { supportedMime } from "./render";
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
  next,
}: StepProps & {
  upload: (files: FileList | File[]) => Promise<void>;
  next: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState("");
  return (
    <section className="panel archive-panel">
      <div className="section-title">
        <div>
          <h2>Let’s start with the basics</h2>
          <p>Add a few details from your family archive.</p>
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
            maxLength={50000}
            placeholder="Begin with what you know. Names, dates, places, small details, turning points…"
            onChange={(e) => update({ script: e.target.value })}
          />
        </label>
      </div>
      <div className="field-row">
        <span className="field-note">
          Distinguish verified records from family lore.
        </span>
        <span className="field-note">
          {film.script.trim() ? film.script.trim().split(/\s+/).length : 0}{" "}
          words
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
          {busy.startsWith("Reading")
            ? busy
            : "Drop files here or click to upload"}
        </span>
        <small>
          Photos, PDF, Word, text, GEDCOM, audio & video · 100 MB per file
        </small>
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
                      {expanded === source.id ? "Hide" : "Review"} extracted
                      text
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
                    ...(film.audioId === source.id
                      ? { audioId: undefined }
                      : {}),
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
        <span className="field-note">Sources stay in this browser.</span>
        <button className="button primary" disabled={!!busy} onClick={next}>
          Choose story direction
          <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

type DirectionProps = StepProps & {
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
  notify,
  busy,
  navigate,
  aiConsent,
  setAiConsent,
  themeOrigin,
  suggest,
  selectTheme,
  plan,
  editorial,
  archivePlan,
}: DirectionProps) {
  const [expanded, setExpanded] = useState("");
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>Find the heart of your story</h2>
          <p>Choose the treatment, running time, and emotional arc.</p>
        </div>
        <Sparkles size={21} />
      </div>
      <div className="choice-row" role="group" aria-label="Film treatment">
        {(["Documentary", "Cinematic"] as const).map((style) => (
          <button
            key={style}
            className={`choice ${film.style === style ? "chosen" : ""}`}
            aria-pressed={film.style === style}
            disabled={!!busy}
            onClick={() => {
              update({ style });
              notify(
                `${style} selected. ${style === "Documentary" ? "The film will center on evidence and testimony." : "The film will use a dramatized cinematic treatment."}`,
              );
            }}
          >
            <span>
              {style === "Documentary" ? (
                <FileText size={19} />
              ) : (
                <FilmIcon size={19} />
              )}{" "}
              {style}
              {film.style === style && <Check size={16} />}
            </span>
            <small>
              {style === "Documentary"
                ? "Archival images, records, and testimony."
                : "Dramatic structure, reenactments, and a resonant climax."}
            </small>
          </button>
        ))}
      </div>
      <div className="duration-row">
        <label>
          Running time
          <select
            value={film.duration}
            onChange={(e) => {
              update({ duration: Number(e.target.value) });
              notify(
                `Running time set to ${formatDuration(Number(e.target.value))}. Rebuild the scene plan to adjust narration.`,
              );
            }}
          >
            {[15, 30, 60, 120, 300, 600].map((s) => (
              <option key={s} value={s}>
                {formatDuration(s)} ·{" "}
                {s === 15
                  ? "Screen test"
                  : s === 30
                    ? "Teaser"
                    : s === 60
                      ? "Family trailer"
                      : s === 120
                        ? "Short portrait"
                        : s === 300
                          ? "Short film"
                          : "Featurette"}
              </option>
            ))}
          </select>
        </label>
        <p className="field-note">
          Your finished export follows this duration.
          <br />
          Need a longer cut? Send the brief to an external studio.
        </p>
      </div>
      <div className="ai-consent">
        <label className="check-label">
          <input
            type="checkbox"
            checked={aiConsent}
            onChange={(e) => {
              setAiConsent(e.target.checked);
              notify(
                e.target.checked
                  ? "AI story assistance enabled for this session."
                  : "AI story assistance turned off.",
                "info",
              );
            }}
          />
          Allow Gemini to read this family story and extracted document text to
          suggest themes and scenes.
        </label>
        <small>
          Original source files stay in this browser. Only the story, source
          text, and captions are sent when you request AI assistance.
        </small>
      </div>
      <div className="section-subtitle">
        <div>
          <h3>Choose up to three story directions</h3>
          <span>
            {themeOrigin || "Explore the plot and climax before choosing."}
          </span>
        </div>
        <button
          className="button secondary small"
          disabled={!!busy}
          onClick={() => void suggest()}
        >
          {busy.includes("directions") ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}{" "}
          {film.themes.length ? "Refresh 10 ideas" : "Suggest 10 ideas"}
        </button>
      </div>
      {film.selectedThemes.length > 0 && (
        <div className="selected-themes">
          {film.selectedThemes.map((t) => (
            <button
              key={t.id}
              className="theme-chip"
              onClick={() => selectTheme(t)}
            >
              <Check size={13} />
              {t.title}
              <X size={13} />
            </button>
          ))}
        </div>
      )}
      {film.themes.length === 0 ? (
        <div className="empty-inline">
          <Sparkles size={28} strokeWidth={1.2} />
          <p>Ten possible paths through your family story.</p>
          <span>
            Request suggestions, or start with our editable editorial
            directions.
          </span>
          <button className="text-button" onClick={editorial}>
            Explore editorial directions
            <ArrowRight size={14} />
          </button>
        </div>
      ) : (
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
                  aria-label={`Select ${theme.title}`}
                  aria-pressed={selected}
                  disabled={!!busy}
                  onClick={() => selectTheme(theme)}
                >
                  <span className="theme-number">
                    {selected ? (
                      <Check size={16} />
                    ) : (
                      String(i + 1).padStart(2, "0")
                    )}
                  </span>
                  <div>
                    <h4>{theme.title}</h4>
                    <p>{theme.plot}</p>
                  </div>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Details for ${theme.title}`}
                  aria-expanded={expanded === theme.id || selected}
                  onClick={() => {
                    setExpanded(expanded === theme.id ? "" : theme.id);
                    notify("Story direction details updated.", "info");
                  }}
                >
                  <ChevronDown size={17} />
                </button>
                {(selected || expanded === theme.id) && (
                  <div className="theme-detail">
                    <p>
                      <span>Proposed climax</span>
                      {theme.climax}
                    </p>
                    <p>
                      <span>Why this direction</span>
                      {theme.reason}
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <div className="panel-actions">
        <button
          className="text-button"
          disabled={!!busy}
          onClick={() => navigate(0)}
        >
          <ArrowLeft size={15} />
          Family archive
        </button>
        <div className="action-group">
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={archivePlan}
          >
            Use archive plan
          </button>
          <button
            className="button primary"
            disabled={!!busy}
            onClick={() => void plan()}
          >
            {busy.includes("scene") ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}
            Develop scene plan
          </button>
        </div>
      </div>
    </section>
  );
}

export function CuttingStep({
  film,
  update,
  notify,
  busy,
  navigate,
  changeScene,
}: StepProps & { changeScene: (id: string, patch: Partial<Scene>) => void }) {
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>The cutting room</h2>
          <p>
            Review the words, choose the source images, and direct every scene.
          </p>
        </div>
        <span className="subtle-tag">
          {film.scenes.length} scenes · {formatDuration(film.duration)}
        </span>
      </div>
      {film.scenes.length === 0 ? (
        <div className="empty-inline">
          <FilmIcon size={30} />
          <p>Your scenes will appear here.</p>
          <button className="button primary" onClick={() => navigate(1)}>
            Choose story direction
            <ArrowRight size={16} />
          </button>
        </div>
      ) : (
        <>
          <label className="logline-label">
            Film logline
            <input
              value={film.logline}
              placeholder="The emotional thread connecting your scenes"
              onChange={(e) => update({ logline: e.target.value })}
            />
          </label>
          <div className="timeline">
            {film.scenes.map((scene, i) => (
              <button
                key={scene.id}
                onClick={() => {
                  document
                    .getElementById(`scene-${scene.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                  notify(`Scene ${i + 1}: ${scene.title}`, "info");
                }}
              >
                <span>{String(i + 1).padStart(2, "0")}</span>
                <span>{scene.title}</span>
                <small>
                  {formatDuration((i * film.duration) / film.scenes.length)}
                </small>
              </button>
            ))}
          </div>
          <div className="scene-list">
            {film.scenes.map((scene, i) => (
              <article
                className="scene-card"
                key={scene.id}
                id={`scene-${scene.id}`}
              >
                <div className="scene-index">
                  {String(i + 1).padStart(2, "0")}
                  <small>
                    {formatDuration((i * film.duration) / film.scenes.length)}
                  </small>
                </div>
                <div className="scene-content">
                  <label>
                    Scene title
                    <input
                      value={scene.title}
                      onChange={(e) =>
                        changeScene(scene.id, { title: e.target.value })
                      }
                    />
                  </label>
                  <div className="scene-fields">
                    <label>
                      Narration & captions
                      <textarea
                        rows={3}
                        value={scene.narration}
                        onChange={(e) =>
                          changeScene(scene.id, { narration: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Visual direction
                      <textarea
                        rows={3}
                        value={scene.visual}
                        onChange={(e) =>
                          changeScene(scene.id, { visual: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div className="scene-bottom">
                    <label>
                      Picture or footage
                      <select
                        value={
                          scene.sourceIds.find((id) =>
                            film.sources.some(
                              (s) =>
                                s.id === id && /^(image|video)\//.test(s.type),
                            ),
                          ) || ""
                        }
                        onChange={(e) => {
                          changeScene(scene.id, {
                            sourceIds: e.target.value ? [e.target.value] : [],
                          });
                          notify("Scene source updated.");
                        }}
                      >
                        <option value="">
                          Automatic from archive / title sequence
                        </option>
                        {film.sources
                          .filter((s) => /^(image|video)\//.test(s.type))
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div className="action-group">
                      <button
                        className="icon-button"
                        aria-label={`Move scene ${i + 1} earlier`}
                        disabled={i === 0 || !!busy}
                        onClick={() => {
                          const scenes = [...film.scenes];
                          [scenes[i - 1], scenes[i]] = [
                            scenes[i],
                            scenes[i - 1],
                          ];
                          update({ scenes });
                          notify("Scene moved earlier.");
                        }}
                      >
                        <ArrowLeft size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Remove scene ${i + 1}`}
                        disabled={film.scenes.length <= 1 || !!busy}
                        onClick={() => {
                          update({
                            scenes: film.scenes.filter(
                              (s) => s.id !== scene.id,
                            ),
                          });
                          notify("Scene removed.");
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <button
            className="text-button"
            onClick={() => {
              update({
                scenes: [
                  ...film.scenes,
                  {
                    id: crypto.randomUUID(),
                    title: "A new chapter",
                    narration: "",
                    visual: "",
                    sourceIds: [],
                  },
                ],
              });
              notify("A new scene was added.");
            }}
          >
            <Plus size={15} />
            Add a scene
          </button>
          <p className="field-note">
            {film.generatedBy || "Your scene plan"} · Review names, dates, and
            proposed dramatizations before creating the film.
          </p>
        </>
      )}
      <div className="panel-actions">
        <button
          className="text-button"
          disabled={!!busy}
          onClick={() => navigate(1)}
        >
          <ArrowLeft size={15} />
          Story direction
        </button>
        <button
          className="button primary"
          disabled={!film.scenes.length || !!busy}
          onClick={() => navigate(3)}
        >
          Choose studio & create
          <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

type CreateProps = StepProps & {
  caps: Capabilities | null;
  changeScene: (id: string, patch: Partial<Scene>) => void;
  checkShot: (s: Scene) => Promise<void>;
  confirmShot: (s: Scene) => void;
  consent: boolean;
  setConsent: (v: boolean) => void;
  canvasRef: RefObject<HTMLCanvasElement>;
  progress: number;
  renderMessage: string;
  resultUrl: string;
  exportFilm: () => Promise<void>;
  cancel: () => void;
  brief: () => void;
  backup: () => void;
};
export function CreateStep({
  film,
  update,
  notify,
  busy,
  caps,
  changeScene,
  checkShot,
  confirmShot,
  consent,
  setConsent,
  canvasRef,
  progress,
  renderMessage,
  resultUrl,
  exportFilm,
  cancel,
  brief,
  backup,
}: CreateProps) {
  const studio = studios.find((s) => s.id === film.providerId) || studios[0];
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>From family archive to final cut</h2>
          <p>
            Choose how to create your film, then watch and download it here.
          </p>
        </div>
        <FilmIcon size={23} />
      </div>
      <label>
        Production studio
        <select
          value={film.providerId}
          disabled={!!busy}
          onChange={(e) => {
            update({ providerId: e.target.value });
            notify(
              `${studios.find((s) => s.id === e.target.value)?.name} selected.`,
            );
          }}
        >
          {studios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {["magiclight", "heygen", "flow"].includes(s.id)
                ? " · external studio"
                : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="studio-description">
        {studio.description}
        <br />
        <span>{studio.detail}</span>
      </p>
      {["runway", "imagineart"].includes(film.providerId) && (
        <div className="shot-production">
          <div className="section-subtitle">
            <h3>Cinematic shot queue</h3>
            <span>Generate only the scenes you choose</span>
          </div>
          <p className="field-note">
            Each take is a 5-second generated shot. It plays as a loop within
            its scene; the rest of your film uses the family archive.
            Reenactments are labeled in the finished film.
          </p>
          {film.providerId === "runway" &&
            caps &&
            (!caps.runway || caps.connections?.runway?.credits === 0) && (
              <div className="feedback info">
                {caps.runway
                  ? "Runway is connected, but its API account has no credits. An administrator must add Runway API credits before generating shots. Archive film export is available now."
                  : caps.connections?.runway?.reason ||
                    "Runway is not connected."}
              </div>
            )}
          {film.providerId === "imagineart" && !caps?.imagineart && (
            <div className="feedback info">
              ImagineArt’s API is not connected. Choose Runway, create an
              archive film, or{" "}
              <a
                href="https://www.imagine.art/"
                target="_blank"
                rel="noreferrer"
              >
                open ImagineArt’s studio
              </a>
              .
            </div>
          )}
          {film.scenes.map((scene, i) => (
            <div className="shot-row" key={scene.id}>
              <div>
                <span>
                  {String(i + 1).padStart(2, "0")} · {scene.title}
                </span>
                <small>
                  {scene.shot?.status === "completed"
                    ? "Shot ready · included in export"
                    : scene.shot?.message ||
                      scene.shot?.status ||
                      "Uses your archive until you generate a take"}
                </small>
              </div>
              <div className="action-group">
                {scene.shot && (
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => void checkShot(scene)}
                  >
                    Check status
                  </button>
                )}
                {scene.shot && (
                  <button
                    className="icon-button"
                    aria-label={`Use archive for ${scene.title}`}
                    disabled={
                      !!busy ||
                      ["queued", "processing", "submitting"].includes(
                        scene.shot.status,
                      )
                    }
                    onClick={() => {
                      changeScene(scene.id, { shot: undefined });
                      notify("This scene will use your archive.");
                    }}
                  >
                    <X size={15} />
                  </button>
                )}
                <button
                  className="button secondary small"
                  disabled={
                    !!busy ||
                    (!!scene.shot &&
                      [
                        "queued",
                        "processing",
                        "submitting",
                        "uncertain",
                      ].includes(scene.shot.status)) ||
                    !(film.providerId === "runway"
                      ? caps?.runway && caps.connections?.runway?.credits !== 0
                      : caps?.imagineart)
                  }
                  onClick={() => confirmShot(scene)}
                >
                  {scene.shot?.status === "completed"
                    ? "New take"
                    : "Generate shot"}
                  <Sparkles size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {["magiclight", "flow", "heygen"].includes(film.providerId) ? (
        <div className="external-handoff">
          <ExternalLink size={27} />
          <h3>Continue in {studio.name}</h3>
          <p>
            Download the production brief, open the studio, and upload your
            source files there. Its account and rendering charges are separate.
          </p>
          <div className="action-group">
            <button className="button secondary" onClick={brief}>
              <Download size={16} />
              Download brief
            </button>
            <a
              className="button primary"
              href={studio.url}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                notify(
                  `${studio.name} opened in a new tab. Upload the brief and source files there.`,
                  "info",
                )
              }
            >
              Open {studio.name}
              <ExternalLink size={16} />
            </a>
          </div>
          <button
            className="text-button"
            onClick={() => {
              update({ providerId: "archive" });
              notify(
                "Archive film selected. You can create and download it here.",
              );
            }}
          >
            Create an archive film here instead
          </button>
        </div>
      ) : (
        <>
          <div className="audio-settings">
            <label>
              Soundtrack
              <select
                value={film.audioId || ""}
                disabled={!!busy}
                onChange={(e) => {
                  update({ audioId: e.target.value || undefined });
                  notify(
                    e.target.value
                      ? "Recording selected as the film soundtrack."
                      : "Captioned film selected without a voice recording.",
                  );
                }}
              >
                <option value="">Captions only · no voice recording</option>
                {film.sources
                  .filter((s) => s.type.startsWith("audio"))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={film.music}
                disabled={!!busy}
                onChange={(e) => {
                  update({ music: e.target.checked });
                  notify(
                    e.target.checked
                      ? "Gentle ambient score enabled."
                      : "Ambient score turned off.",
                  );
                }}
              />
              Gentle ambient score
            </label>
          </div>
          <p className="field-note">
            Narration text appears as on-screen captions. Add a voice recording
            in Family archive to include spoken narration. The recording plays
            once from the start.
          </p>
          <label className="check-label consent-final">
            <input
              type="checkbox"
              checked={consent}
              disabled={!!busy}
              onChange={(e) => {
                setConsent(e.target.checked);
                notify(
                  e.target.checked
                    ? "Film approved for creation."
                    : "Film approval cleared.",
                  "info",
                );
              }}
            />
            I have permission to use these materials and have reviewed the
            scenes, facts, and dramatizations.
          </label>
          <div className="export-summary">
            <span>
              <Video size={17} />
              1080p · {formatDuration(film.duration)} ·{" "}
              {supportedMime().includes("mp4") ? "MP4" : "WebM"}
            </span>
            <span>
              {film.scenes.length} scenes ·{" "}
              {film.sources.filter((s) => s.type.startsWith("image")).length}{" "}
              photos
            </span>
          </div>
          {renderMessage && (
            <div className="render-progress" role="status">
              <p>
                <Loader2 className="spin" size={16} />
                {renderMessage}
              </p>
              <progress max={100} value={progress} />
              <p className="field-note">
                Keep this tab visible. Export takes about the film’s running
                time.
              </p>
              <button className="text-button" onClick={cancel}>
                Cancel export
              </button>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className={renderMessage ? "render-canvas" : "render-canvas hidden"}
            aria-label="Film export preview"
          />
          {!renderMessage && (
            <div className="panel-actions">
              <div className="action-group">
                <button className="text-button" onClick={brief}>
                  <Download size={15} />
                  Brief
                </button>
                <button className="text-button" onClick={backup}>
                  <Download size={15} />
                  Backup
                </button>
              </div>
              <button
                className="button primary"
                disabled={!!busy || !film.scenes.length}
                onClick={() => void exportFilm()}
              >
                <FilmIcon size={17} />
                {film.outputId ? "Create a new cut" : "Create my film"}
              </button>
            </div>
          )}
          {resultUrl && (
            <div className="finished-film">
              <div className="section-subtitle">
                <h3>
                  <CheckCircle2 size={18} />
                  Your film is ready
                </h3>
                <a
                  className="button secondary small"
                  href={resultUrl}
                  download={`${film.title.replace(/[^a-z0-9 -]/gi, "").trim() || "family-film"}.${film.outputType?.includes("mp4") ? "mp4" : "webm"}`}
                  onClick={() => notify("Your film download has started.")}
                >
                  <Download size={16} />
                  Download film
                </a>
              </div>
              <video
                controls
                src={resultUrl}
                playsInline
                onError={() =>
                  notify(
                    "The saved film could not play in this browser. Try downloading it.",
                    "error",
                  )
                }
              />
              <p className="field-note">
                Created{" "}
                {film.outputAt ? new Date(film.outputAt).toLocaleString() : ""}.
                Download a copy to keep or share with your family.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
