import { useCallback, useEffect, useRef, useState } from "react";
import {
  Aperture,
  Video,
  Library,
  SlidersHorizontal,
  Plus,
  LogOut,
  ArrowRight,
  Check,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
  Film as FilmIcon,
  X,
  CloudOff,
  Sparkles,
} from "lucide-react";
import {
  api,
  editorialPlan,
  editorialThemes,
  formatDuration,
  newFilm,
  normalizeFilm,
  productionBrief,
  steps,
  studios,
  type Film,
  type Scene,
  type Shot,
  type Source,
  type Theme,
  type User,
} from "./model";
import {
  getSourceBlob,
  getSourceObjectUrl,
  saveSourceFile,
} from "../lib/storage";
import { imageData, importSource } from "./sources";
import { renderFilm } from "./render";
import { ArchiveStep, DirectionStep, CuttingStep, CreateStep } from "./steps";

export type Notice = { tone: "success" | "error" | "info"; text: string };
export type Capabilities = {
  story: boolean;
  runway: boolean;
  imagineart: boolean;
  connections?: {
    story?: { reason: string };
    runway?: { reason: string; credits?: number };
  };
};
export type StepProps = {
  film: Film;
  update: (patch: Partial<Film>) => void;
  notify: (text: string, tone?: Notice["tone"]) => void;
  busy: string;
  navigate: (step: number) => void;
};
export function saveDownload(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const cleanName = (name: string) =>
  name.replace(/[^a-z0-9 -]/gi, "").trim() || "family-film";

export default function Workspace({
  user,
  onLogout,
  welcome,
}: {
  user: User;
  onLogout: () => Promise<void>;
  welcome: string;
}) {
  const storageKey = `lineage-studio-v3:${user.email}`;
  const [projects, setProjects] = useState<Film[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(parsed) && parsed.length
        ? parsed.map(normalizeFilm)
        : [newFilm()];
    } catch {
      return [newFilm()];
    }
  });
  const [activeId, setActiveId] = useState(
    projects.find((p) => !p.archivedAt)?.id || projects[0].id,
  );
  const [view, setView] = useState<"create" | "library" | "studios">("create");
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState("Saved in this browser");
  const [notice, setNotice] = useState<Notice | null>(
    welcome ? { tone: "success", text: welcome } : null,
  );
  const [busy, setBusy] = useState("");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [themePage, setThemePage] = useState(0);
  const [themeOrigin, setThemeOrigin] = useState("");
  const [progress, setProgress] = useState(0);
  const [renderMessage, setRenderMessage] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [confirmRender, setConfirmRender] = useState<Scene | null>(null);
  const [consent, setConsent] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [localLegacy, setLocalLegacy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const workLock = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const film = projects.find((p) => p.id === activeId) || projects[0];
  const notify = useCallback(
    (text: string, tone: Notice["tone"] = "success") =>
      setNotice({ text, tone }),
    [],
  );
  useEffect(() => {
    if (!confirmRender) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmRender(null);
      }
      if (event.key === "Tab" && dialog) {
        const buttons = Array.from(
          dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [confirmRender]);
  const update = useCallback(
    (patch: Partial<Film>, id = activeId) =>
      setProjects((current) =>
        current.map((p) =>
          p.id === id
            ? { ...p, ...patch, updatedAt: new Date().toISOString() }
            : p,
        ),
      ),
    [activeId],
  );
  const changeScene = (id: string, patch: Partial<Scene>) =>
    setProjects((current) =>
      current.map((p) =>
        p.id === activeId
          ? {
              ...p,
              scenes: p.scenes.map((s) =>
                s.id === id ? { ...s, ...patch } : s,
              ),
            }
          : p,
      ),
    );
  useEffect(() => {
    setSaved("Saving…");
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(projects));
        setSaved("Saved in this browser");
      } catch {
        setSaved("Could not save — export a backup");
        notify(
          "Browser storage is full. Export your project backup before leaving.",
          "error",
        );
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [projects, storageKey, notify]);
  useEffect(() => {
    void api<Capabilities>("/api/studio?action=capabilities")
      .then(setCaps)
      .catch(() =>
        notify(
          "Studio connections could not be checked. Archive film export is still available.",
          "error",
        ),
      );
    try {
      setLocalLegacy(
        user.email === "erik@brocotech.ai" &&
          Boolean(localStorage.getItem("lineage-theater-projects-v2")),
      );
    } catch {}
  }, [notify, user.email]);
  useEffect(() => {
    let disposed = false;
    let url = "";
    setResultUrl("");
    if (film.outputId)
      void getSourceObjectUrl(film.outputId)
        .then((value) => {
          url = value || "";
          if (!disposed) setResultUrl(url);
          else if (url) URL.revokeObjectURL(url);
        })
        .catch(() =>
          notify(
            "The saved film could not be opened in this browser.",
            "error",
          ),
        );
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [film.outputId, notify]);
  useEffect(() => {
    if (!busy) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);
  const jobSignature = projects
    .flatMap((p) =>
      p.scenes
        .filter(
          (s) => s.shot && ["queued", "processing"].includes(s.shot.status),
        )
        .map((s) => `${p.id}:${s.id}:${s.shot!.id}`),
    )
    .join("|");
  useEffect(() => {
    if (!jobSignature) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      for (const item of jobSignature.split("|")) {
        const [projectId, sceneId, id] = item.split(":");
        try {
          const job = await api<Shot>(`/api/studio?action=status&id=${id}`);
          if (stopped) return;
          setProjects((current) =>
            current.map((p) =>
              p.id === projectId
                ? {
                    ...p,
                    scenes: p.scenes.map((s) =>
                      s.id === sceneId ? { ...s, shot: job } : s,
                    ),
                  }
                : p,
            ),
          );
          if (job.status === "completed")
            notify(
              "Your cinematic shot is ready. It will be included in your film export.",
            );
          if (job.status === "failed")
            notify(
              job.message || "The studio could not complete a shot.",
              "error",
            );
        } catch {
          if (!stopped)
            notify(
              "A render is still being tracked. Its status is temporarily unavailable; no new render has been started.",
              "info",
            );
        }
      }
      if (!stopped) timer = setTimeout(poll, 10000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobSignature, notify]);
  async function task(label: string, fn: () => Promise<void>) {
    if (workLock.current) return;
    workLock.current = true;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "The action could not be completed.",
        "error",
      );
    } finally {
      setBusy("");
      workLock.current = false;
    }
  }
  function navigate(next: number) {
    if (busy) return;
    setStep(next);
    setView("create");
    notify(`${steps[next]} opened.`, "info");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function create() {
    const project = newFilm();
    setProjects((p) => [project, ...p]);
    setActiveId(project.id);
    setStep(0);
    setView("create");
    setConsent(false);
    notify("A new family film is ready to develop.");
  }
  async function upload(files: FileList | File[]) {
    const id = film.id;
    await task("Reading your sources…", async () => {
      const added: Source[] = [];
      const failures: string[] = [];
      for (const file of Array.from(files)) {
        try {
          added.push(await importSource(file, id));
        } catch (e) {
          failures.push(
            e instanceof Error ? e.message : `Could not add ${file.name}`,
          );
        }
      }
      setProjects((current) =>
        current.map((p) =>
          p.id === id
            ? {
                ...p,
                sources: [...p.sources, ...added],
                updatedAt: new Date().toISOString(),
              }
            : p,
        ),
      );
      notify(
        `${added.length} source${added.length === 1 ? "" : "s"} added.${failures.length ? " " + failures.join(" ") : " Readable document text is now available to the story studio."}`,
        failures.length ? "error" : "success",
      );
    });
  }
  function enoughStory() {
    if (!film.title.trim() || !film.ancestor.trim()) {
      notify(
        "Add a film title and the person or family at the heart of the story.",
        "error",
      );
      setStep(0);
      return false;
    }
    if (
      [film.script, ...film.sources.map((s) => s.text || s.note || "")]
        .join("")
        .trim().length < 80
    ) {
      notify(
        "Add at least a few sentences of family history, or a readable document, before developing the story.",
        "error",
      );
      setStep(0);
      return false;
    }
    return true;
  }
  async function suggest() {
    if (!enoughStory()) return;
    if (caps?.story && !aiConsent) {
      notify(
        "Confirm that the story studio may read your family story and extracted document text.",
        "error",
      );
      return;
    }
    await task("Finding ten story directions…", async () => {
      if (caps?.story) {
        try {
          const result = await api<{
            themes: Omit<Theme, "id">[];
            generatedBy: string;
          }>("/api/studio", {
            action: "themes",
            project: film,
            exclude: film.themes.map((t) => t.title),
          });
          update({
            themes: result.themes.map((t) => ({
              ...t,
              id: crypto.randomUUID(),
            })),
            generatedBy: result.generatedBy,
          });
          setThemeOrigin(
            "Ten AI suggestions grounded in your family materials",
          );
          notify("Ten new AI story directions are ready. Choose up to three.");
          return;
        } catch (e) {
          notify(
            `${e instanceof Error ? e.message : "AI suggestions were unavailable."} Editorial directions are shown below.`,
            "error",
          );
        }
      } else
        notify(
          "Ten editorial directions are ready. The AI studio is not connected.",
          "info",
        );
      update({ themes: editorialThemes(film, themePage) });
      setThemePage((p) => p + 1);
      setThemeOrigin("Editorial suggestions · review against your sources");
    });
  }
  async function plan() {
    if (!enoughStory()) return;
    if (!film.selectedThemes.length) {
      notify("Choose at least one story direction first.", "error");
      setStep(1);
      return;
    }
    if (caps?.story && !aiConsent) {
      notify(
        "Confirm that the story studio may read your family materials, or use the editable archive plan.",
        "error",
      );
      return;
    }
    await task("Developing your scene plan…", async () => {
      if (caps?.story) {
        try {
          const r = await api<{
            scenes: Omit<Scene, "id">[];
            logline: string;
            generatedBy: string;
          }>("/api/studio", { action: "plan", project: film });
          update({
            scenes: r.scenes.map((s) => ({
              ...s,
              id: crypto.randomUUID(),
              sourceIds: (s.sourceIds || []).filter((id) =>
                film.sources.some((x) => x.id === id),
              ),
            })),
            logline: r.logline,
            generatedBy: r.generatedBy,
          });
          setStep(2);
          notify(
            "Your AI scene plan is ready for review. Every scene is editable.",
          );
          return;
        } catch (e) {
          notify(
            `${e instanceof Error ? e.message : "AI development failed."} An editable archive plan is ready instead.`,
            "error",
          );
        }
      } else notify("Your editable archive plan is ready.");
      update({
        scenes: editorialPlan(film),
        logline: `${film.ancestor} — ${film.selectedThemes.map((t) => t.title).join(", ")}.`,
        generatedBy: "Editorial archive plan",
      });
      setStep(2);
    });
  }
  function selectTheme(theme: Theme) {
    const selected = film.selectedThemes.some((t) => t.id === theme.id);
    if (!selected && film.selectedThemes.length >= 3) {
      notify(
        "Choose up to three themes. Deselect one to add another.",
        "error",
      );
      return;
    }
    update({
      selectedThemes: selected
        ? film.selectedThemes.filter((t) => t.id !== theme.id)
        : [...film.selectedThemes, theme],
    });
    notify(
      selected
        ? `${theme.title} removed.`
        : `${theme.title} selected. Its plot and climax will guide your film.`,
    );
  }
  async function generate(scene: Scene) {
    setConfirmRender(null);
    await task("Submitting your cinematic shot…", async () => {
      const source = film.sources.find(
        (s) => scene.sourceIds.includes(s.id) && s.type.startsWith("image"),
      );
      const blob = source ? await getSourceBlob(source.id) : null;
      const requestId = crypto.randomUUID();
      const shot: Shot = {
        id: requestId,
        provider: film.providerId,
        status: "submitting",
      };
      changeScene(scene.id, { shot });
      try {
        const job = await api<Shot>("/api/studio", {
          action: "generate",
          requestId,
          provider: film.providerId,
          prompt: `${film.style === "Cinematic" ? "Photorealistic cinematic reenactment" : "Documentary illustrative reconstruction"}. ${scene.visual}. Family period: ${film.era || "use source context"}. Natural movement, realistic textures, consistent likeness, no invented written text.`,
          ...(blob ? { image: await imageData(blob) } : {}),
        });
        changeScene(scene.id, { shot: job });
        notify(
          job.status === "uncertain"
            ? job.message!
            : "Your shot was accepted by the studio. You can continue editing while it renders.",
          job.status === "uncertain" ? "info" : "success",
        );
      } catch (e) {
        changeScene(scene.id, {
          shot: {
            ...shot,
            status: "uncertain",
            message:
              "Submission could not be confirmed. Check status before creating another take.",
          },
        });
        throw e;
      }
    });
  }
  async function checkShot(scene: Scene) {
    if (!scene.shot) return;
    await task("Checking shot…", async () => {
      const job = await api<Shot>(
        `/api/studio?action=status&id=${scene.shot!.id}`,
      );
      changeScene(scene.id, { shot: job });
      notify(
        job.message || `Shot status: ${job.status}.`,
        job.status === "failed" ? "error" : "info",
      );
    });
  }
  async function exportFilm() {
    if (!consent) {
      notify(
        "Confirm the family materials and scene plan are ready for this film.",
        "error",
      );
      return;
    }
    if (!canvasRef.current) return;
    if (!film.scenes.length) {
      notify("Create your scene plan first.", "error");
      return;
    }
    if (
      film.scenes.some(
        (s) =>
          s.shot &&
          ["queued", "processing", "submitting", "uncertain"].includes(
            s.shot.status,
          ),
      )
    ) {
      notify(
        "Wait for your cinematic shots to finish, or remove those takes from the scenes before exporting.",
        "error",
      );
      return;
    }
    const id = film.id;
    await task("Creating your film…", async () => {
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        const blob = await renderFilm(
          film,
          canvasRef.current!,
          abort.signal,
          (value, message) => {
            setProgress(value);
            setRenderMessage(message);
          },
        );
        const outputId = crypto.randomUUID();
        const ext = blob.type.includes("mp4") ? "mp4" : "webm";
        await saveSourceFile(
          outputId,
          id,
          new File([blob], `${cleanName(film.title)}.${ext}`, {
            type: blob.type,
          }),
        );
        update(
          {
            outputId,
            outputType: blob.type,
            outputAt: new Date().toISOString(),
          },
          id,
        );
        notify(
          "Your film was created and saved in this browser. Watch it below or download your master.",
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          notify(
            "Export cancelled. Your sources and scene plan are saved.",
            "info",
          );
          return;
        }
        throw e;
      } finally {
        abortRef.current = null;
        setRenderMessage("");
      }
    });
  }
  function brief() {
    saveDownload(
      new Blob([productionBrief(film)], { type: "text/plain" }),
      `${cleanName(film.title)}-production-brief.txt`,
    );
    notify("Your production brief download has started.");
  }
  function backup() {
    saveDownload(
      new Blob([JSON.stringify(film, null, 2)], { type: "application/json" }),
      `${cleanName(film.title)}-project.json`,
    );
    notify(
      "Project backup downloaded. Original media files are stored separately.",
    );
  }
  const studio = studios.find((s) => s.id === film.providerId) || studios[0];
  const nav = [
    { id: "create" as const, label: "Create a film", icon: Video },
    { id: "library" as const, label: "Film library", icon: Library },
    { id: "studios" as const, label: "Studios", icon: SlidersHorizontal },
  ];
  const props: StepProps = { film, update, notify, busy, navigate };
  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Lineage Theatre home">
          <Aperture size={44} strokeWidth={1.1} />
          <span>
            Lineage
            <br />
            Theatre
          </span>
        </a>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "nav-item selected" : "nav-item"}
              disabled={!!busy}
              onClick={() => {
                setView(n.id);
                notify(`${n.label} opened.`, "info");
              }}
            >
              <n.icon size={18} strokeWidth={1.5} />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <p>
            Real people.
            <br />
            Extraordinary stories.
          </p>
          <span>
            Lives remembered.
            <br />
            Stories kept.
          </span>
        </div>
      </aside>
      <div className="studio-main">
        <header className="topbar">
          <div className="project-switch">
            <FilmIcon size={17} />
            <select
              aria-label="Current film"
              value={film.id}
              disabled={!!busy}
              onChange={(e) => {
                setActiveId(e.target.value);
                setConsent(false);
                notify("Film opened.");
              }}
            >
              {projects
                .filter((p) => !p.archivedAt)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || "Untitled family film"}
                  </option>
                ))}
            </select>
          </div>
          <span
            className={`save-state ${saved.startsWith("Could") ? "error-text" : ""}`}
            role="status"
          >
            <CloudOff size={14} />
            {saved}
          </span>
          <div className="user-menu">
            <span>{user.name}</span>
            <button
              className="icon-button"
              aria-label="Sign out"
              disabled={!!busy}
              onClick={() =>
                void onLogout().catch(() =>
                  notify("Sign-out failed. Please try again.", "error"),
                )
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="workspace">
          {view === "create" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Your family. A lasting film.</h1>
                  <p>
                    Turn the people, places, and moments that matter into a
                    beautiful film.
                  </p>
                </div>
                <button
                  className="button small secondary"
                  disabled={!!busy}
                  onClick={create}
                >
                  <Plus size={16} />
                  New film
                </button>
              </div>
              <nav className="stepper" aria-label="Film creation steps">
                {steps.map((label, i) => (
                  <button
                    key={label}
                    aria-current={step === i ? "step" : undefined}
                    disabled={!!busy}
                    onClick={() => navigate(i)}
                    className={step === i ? "step active" : "step"}
                  >
                    <span>{i + 1}</span>
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
              <div className={`creation-layout ${step > 0 ? "wide" : ""}`}>
                <div className="editor-area">
                  {step === 0 && (
                    <ArchiveStep
                      {...props}
                      upload={upload}
                      next={() => {
                        if (enoughStory()) navigate(1);
                      }}
                    />
                  )}
                  {step === 1 && (
                    <DirectionStep
                      {...props}
                      aiConsent={aiConsent}
                      setAiConsent={setAiConsent}
                      themeOrigin={themeOrigin}
                      suggest={suggest}
                      selectTheme={selectTheme}
                      plan={plan}
                      editorial={() => {
                        update({ themes: editorialThemes(film, themePage) });
                        setThemePage((p) => p + 1);
                        setThemeOrigin(
                          "Editorial suggestions · review against your sources",
                        );
                        notify("Ten editorial directions are ready.");
                      }}
                      archivePlan={() => {
                        if (enoughStory()) {
                          update({
                            scenes: editorialPlan(film),
                            generatedBy: "Editorial archive plan",
                          });
                          navigate(2);
                          notify(
                            "Editable archive plan created from your source text.",
                          );
                        }
                      }}
                    />
                  )}
                  {step === 2 && (
                    <CuttingStep {...props} changeScene={changeScene} />
                  )}
                  {step === 3 && (
                    <CreateStep
                      {...props}
                      caps={caps}
                      changeScene={changeScene}
                      checkShot={checkShot}
                      confirmShot={setConfirmRender}
                      consent={consent}
                      setConsent={setConsent}
                      canvasRef={canvasRef}
                      progress={progress}
                      renderMessage={renderMessage}
                      resultUrl={resultUrl}
                      exportFilm={exportFilm}
                      cancel={() => abortRef.current?.abort()}
                      brief={brief}
                      backup={backup}
                    />
                  )}
                </div>
                <aside className="inspiration">
                  <img
                    src="/assets/family-archive.webp"
                    alt="Illustrative family portrait and handwritten letters on an oak table"
                  />
                  <div>
                    <p>
                      Every great film begins
                      <br />
                      with something real.
                    </p>
                    <span>
                      Preserve the evidence.
                      <br />
                      Find the human story.
                    </span>
                  </div>
                </aside>
              </div>
            </>
          )}
          {view === "library" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Your family film library</h1>
                  <p>
                    Private projects saved under your account in this browser.
                  </p>
                </div>
                <button className="button primary" onClick={create}>
                  <Plus size={16} />
                  New film
                </button>
              </div>
              <div className="library-list">
                {projects.map((p) => (
                  <article
                    className={`library-item ${p.archivedAt ? "archived" : ""}`}
                    key={p.id}
                  >
                    <div className="library-art">
                      <FilmIcon size={28} strokeWidth={1.2} />
                    </div>
                    <div>
                      <h2>{p.title || "Untitled family film"}</h2>
                      <p>
                        {p.ancestor || "Add a family story"} · {p.style} ·{" "}
                        {formatDuration(p.duration)}
                      </p>
                      <small>
                        {p.archivedAt
                          ? "Archived"
                          : p.outputId
                            ? "Film created"
                            : p.scenes.length
                              ? "In the cutting room"
                              : "In development"}{" "}
                        · {p.sources.length} sources ·{" "}
                        {new Date(p.updatedAt).toLocaleDateString()}
                      </small>
                    </div>
                    <div className="action-group">
                      <button
                        className="button secondary small"
                        onClick={() => {
                          if (p.archivedAt) update({ archivedAt: null }, p.id);
                          setActiveId(p.id);
                          setView("create");
                          setStep(p.outputId ? 3 : 0);
                          notify("Film opened.");
                        }}
                      >
                        {p.archivedAt ? "Restore & open" : "Open film"}
                        <ArrowRight size={14} />
                      </button>
                      {!p.archivedAt && (
                        <button
                          className="text-button"
                          disabled={
                            projects.filter((x) => !x.archivedAt).length <= 1
                          }
                          onClick={() => {
                            update(
                              { archivedAt: new Date().toISOString() },
                              p.id,
                            );
                            if (activeId === p.id)
                              setActiveId(
                                projects.find(
                                  (x) => x.id !== p.id && !x.archivedAt,
                                )!.id,
                              );
                            notify("Film archived. You can restore it here.");
                          }}
                        >
                          Archive
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {localLegacy && (
                <div className="legacy-box">
                  <p>
                    Your earlier Lineage Theatre projects are still in this
                    browser.
                  </p>
                  <button
                    className="button secondary"
                    onClick={() => {
                      try {
                        const old = JSON.parse(
                          localStorage.getItem("lineage-theater-projects-v2") ||
                            "[]",
                        );
                        const imported = old
                          .map(normalizeFilm)
                          .filter(
                            (p: Film) => !projects.some((x) => x.id === p.id),
                          );
                        setProjects((p) => [...p, ...imported]);
                        setLocalLegacy(false);
                        notify(
                          `${imported.length} earlier projects imported. Originals were preserved.`,
                        );
                      } catch {
                        notify(
                          "Earlier projects could not be read. Their original data is preserved.",
                          "error",
                        );
                      }
                    }}
                  >
                    Import earlier projects
                  </button>
                </div>
              )}
            </>
          )}
          {view === "studios" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>A studio for every story</h1>
                  <p>
                    Choose an in-app renderer or carry your production brief
                    into another studio.
                  </p>
                </div>
              </div>
              <div className="studios-list">
                {studios.map((s) => (
                  <article className="studio-option" key={s.id}>
                    <div className="studio-icon">
                      <FilmIcon size={23} strokeWidth={1.3} />
                    </div>
                    <div>
                      <div className="studio-title">
                        <h2>{s.name}</h2>
                        <span className="subtle-tag">
                          {s.id === "runway"
                            ? caps?.runway
                              ? caps.connections?.runway?.credits === 0
                                ? "Add API credits"
                                : "Connected in app"
                              : "Connection required"
                            : s.id === "imagineart"
                              ? caps?.imagineart
                                ? "Configured in app"
                                : "Connection required"
                              : s.tag}
                        </span>
                      </div>
                      <p>{s.description}</p>
                      <small>{s.detail}</small>
                    </div>
                    <button
                      className="button secondary small"
                      onClick={() => {
                        update({ providerId: s.id });
                        notify(
                          `${s.name} selected for ${film.title || "your film"}.`,
                        );
                        setView("create");
                        setStep(3);
                      }}
                    >
                      Choose studio
                      <ArrowRight size={14} />
                    </button>
                  </article>
                ))}
              </div>
              <p className="field-note">
                Provider pricing, credits, and availability are shown in each
                official studio. External studios require their own accounts.
                Gemini assists with story development when connected.
              </p>
            </>
          )}
        </main>
        <footer className="workspace-footer">
          <span>Lineage Theatre · Lives remembered. Stories kept.</span>
          <a href="/assets/the-journey-of-thomas-wilson.mp4" target="_blank" rel="noreferrer">Sample trailer</a>
          <a href="/privacy.html">Privacy</a>
          <a href="mailto:admin@brocotech.ai">Help</a>
          <span className="build-id">{__BUILD_COMMIT__.slice(0, 7)}</span>
        </footer>
      </div>
      {notice && (
        <div
          className={`toast ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.tone === "error" ? (
            <AlertCircle size={19} />
          ) : notice.tone === "success" ? (
            <CheckCircle2 size={19} />
          ) : (
            <Check size={19} />
          )}
          <p>{notice.text}</p>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {busy && !renderMessage && (
        <div className="busy-strip" role="status">
          <Loader2 size={16} className="spin" />
          {busy}
        </div>
      )}
      {confirmRender && (
        <div className="modal-backdrop" onClick={() => setConfirmRender(null)}>
          <section
            ref={dialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="render-confirm"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="render-confirm">Generate a cinematic take</h2>
            <p>
              {confirmRender.title} · {studio.name} · 5 seconds
            </p>
            <p className="muted">
              This sends the scene’s visual direction and selected reference
              photo to {studio.name}. It uses the connected account’s paid API
              credits. One request creates one take.
            </p>
            <p className="field-note">
              {film.providerId === "runway"
                ? `Runway estimate: ${confirmRender.sourceIds.some((id) => film.sources.some((s) => s.id === id && s.type.startsWith("image"))) ? "25 credits (Gen-4 Turbo)" : "60 credits (Gen-4.5)"}. Check current provider pricing if needed.`
                : "ImagineArt bills its connected API account for this take."}
            </p>
            <div className="action-group">
              <button
                className="button secondary"
                onClick={() => setConfirmRender(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                onClick={() => void generate(confirmRender)}
              >
                <Sparkles size={16} />
                Generate this take
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
