import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Aperture,
  Video,
  Library,
  Plus,
  LogOut,
  ArrowRight,
  Check,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Film as FilmIcon,
  X,
  CloudOff,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  customerProjectBackup,
  editorialPlan,
  editorialThemes,
  formatDuration,
  newFilm,
  normalizeFilm,
  normalizePaymentReference,
  productionBrief,
  productionStatusMessage,
  steps,
  type Film,
  type FilmPaymentReference,
  type Scene,
  type Shot,
  type Source,
  type Theme,
  type User,
} from "./model";
import { getSourceBlob, getSourceObjectUrl } from "../lib/storage";
import { importSource } from "./sources";

import { ArchiveStep, DirectionStep, CuttingStep, CreateStep } from "./steps";
import CloudArchivePanel from "./CloudArchivePanel";
const Admin = lazy(() => import("../admin/Admin"));
const AccountSecurity = lazy(() => import("../AccountSecurity"));

export type Notice = { tone: "success" | "error" | "info"; text: string };
export type Capabilities = {
  story: boolean;
  production: boolean;
  billing: boolean;
  pricing?: {
    currency: "USD";
    estimate: {
      status: "unavailable";
      amountCents: null;
      reason: string;
    };
    chargeReady: false;
  };
  quality?: { label: string; verified: boolean };
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
  onUserChange,
  welcome,
}: {
  user: User;
  onLogout: () => Promise<void>;
  onUserChange: (user: User) => void;
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
  const [view, setView] = useState<"create" | "library" | "admin">(() =>
    (user.role === "owner" || user.role === "admin") && window.location.hash.startsWith("#admin/payments") ? "admin" : "create",
  );
  useEffect(() => {
    const openPayments = () => {
      if ((user.role === "owner" || user.role === "admin") && window.location.hash.startsWith("#admin/payments")) setView("admin");
    };
    window.addEventListener("hashchange", openPayments);
    return () => window.removeEventListener("hashchange", openPayments);
  }, [user.role]);
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState("Saved in this browser");
  const [notice, setNotice] = useState<Notice | null>(
    welcome ? { tone: "success", text: welcome } : null,
  );
  const [busy, setBusy] = useState("");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [themePage, setThemePage] = useState(0);
  const [themeOrigin, setThemeOrigin] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [localLegacy, setLocalLegacy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);

  const workLock = useRef(false);

  const film = projects.find((p) => p.id === activeId) || projects[0];
  const notify = useCallback(
    (text: string, tone: Notice["tone"] = "success") => setNotice({ text, tone }),
    [],
  );
  const update = useCallback(
    (patch: Partial<Film>, id = activeId) =>
      setProjects((current) =>
        current.map((p) =>
          p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p,
        ),
      ),
    [activeId],
  );
  function persistPaymentReference(reference: FilmPaymentReference) {
    const safe = normalizePaymentReference(reference);
    if (!safe) throw new Error("The payment recovery reference is invalid. No payment request was sent.");
    const next = projects.map(project => project.id === film.id ? { ...project, paymentReference: safe, updatedAt: new Date().toISOString() } : project);
    const serialized = JSON.stringify(next);
    try {
      localStorage.setItem(storageKey, serialized);
      if (localStorage.getItem(storageKey) !== serialized) throw new Error();
    } catch {
      throw new Error("Your payment recovery reference could not be saved. Make space in browser storage before paying. No payment request was sent.");
    }
    setProjects(next);
    setSaved("Saved in this browser");
  }
  const changeScene = (id: string, patch: Partial<Scene>) =>
    setProjects((current) =>
      current.map((p) =>
        p.id === activeId
          ? {
              ...p,
              scenes: p.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
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
          "Film creation availability could not be checked. You can keep editing your story.",
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
          notify("The saved film could not be opened in this browser.", "error"),
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
    .filter(
      (p) =>
        p.job?.provider === "magiclight" &&
        ["queued", "processing"].includes(p.job.status),
    )
    .map((p) => `${p.id}:${p.job!.id}`)
    .join("|");
  useEffect(() => {
    if (!jobSignature) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      for (const item of jobSignature.split("|")) {
        const [projectId, id] = item.split(":");
        try {
          const job = await api<Shot>(
            `/api/studio?action=status&id=${encodeURIComponent(id)}`,
          );
          if (stopped) return;
          setProjects((current) =>
            current.map((p) => (p.id === projectId ? { ...p, job } : p)),
          );
          if (job.status === "completed")
            notify("Your film is ready to watch in Lineage Theatre.");
          if (job.status === "failed")
            notify(productionStatusMessage(job.status), "error");
        } catch {
          if (!stopped)
            notify(
              "Film status is temporarily unavailable. Your existing production request is preserved.",
              "info",
            );
        }
      }
      if (!stopped) timer = setTimeout(poll, 15000);
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
          failures.push(e instanceof Error ? e.message : `Could not add ${file.name}`);
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
      [film.script, ...film.sources.map((s) => s.text || s.note || "")].join("").trim()
        .length < 80
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
  function allowStory() {
    if (!enoughStory()) return false;
    if (!caps?.story) {
      notify(
        "Story development is temporarily unavailable. You can keep editing your archive or start a manual outline.",
        "info",
      );
      return false;
    }
    if (!aiConsent) {
      notify(
        "Allow Lineage Theatre's AI tools to read your family material before developing the film.",
        "error",
      );
      return false;
    }
    return true;
  }
  async function storyImages() {
    const references: { sourceId: string; dataUrl: string }[] = [];
    for (const source of film.sources
      .filter((s) => s.type.startsWith("image"))
      .slice(0, 8)) {
      const blob = await getSourceBlob(source.id);
      if (!blob) continue;
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        let quality = 0.8;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length >= 250000 && quality > 0.3) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        if (dataUrl.length < 250000) references.push({ sourceId: source.id, dataUrl });
      } catch {
        // Source coverage reports photos without a usable reference.
      }
    }
    return references;
  }
  async function suggest() {
    if (!allowStory()) return;
    await task("Finding story directions for your film…", async () => {
      const result = await api<{ themes: Omit<Theme, "id">[]; generatedBy: string }>(
        "/api/studio",
        {
          action: "themes",
          project: film,
          storyConsent: true,
          imageReferences: await storyImages(),
          exclude: film.themes.map((t) => t.title),
        },
      );
      update({
        themes: result.themes.map((t) => ({ ...t, id: crypto.randomUUID() })),
        generatedBy: result.generatedBy,
      });
      setThemeOrigin("AI story ideas · grounded in the material read");
      notify(
        "Your story ideas are ready. Choose a favorite, or let the film develop automatically.",
      );
    });
  }
  async function plan() {
    if (!allowStory()) return;
    await task(
      "Developing your script, cast, and scenes…",
      async () => {
        const selectedThemes = film.selectedThemes.length
          ? film.selectedThemes
          : film.themes.slice(0, 1);
        const r = await api<
          Pick<Film, "characters" | "assumptions" | "logline" | "sourceCoverage"> & {
            scenes: Omit<Scene, "id">[];
            generatedBy: string;
            selectedThemes?: Omit<Theme, "id">[];
          }
        >("/api/studio", {
          action: "plan",
          project: {
            ...film,
            selectedThemes,
            providerId: "magiclight",
            quality: "highest",
          },
          storyConsent: true,
          imageReferences: await storyImages(),
        });
        const isKnownSource = (id: string) =>
          (id === "@family-narrative" && !!film.script.trim()) ||
          film.sources.some((s) => s.id === id);
        const characters = (r.characters || []).map((c) => ({
          ...c,
          id: c.id || crypto.randomUUID(),
          sourceIds: (c.sourceIds || []).filter(isKnownSource),
        }));
        const resolvedThemes = selectedThemes.length
          ? selectedThemes
          : (r.selectedThemes || []).map((t) => ({ ...t, id: crypto.randomUUID() }));
        update({
          scenes: r.scenes.map((s) => ({
            ...s,
            id: crypto.randomUUID(),
            dialogue: s.dialogue || "",
            dramatization: s.dramatization || "",
            characterIds: (s.characterIds || []).filter((id) =>
              characters.some((c) => c.id === id),
            ),
            sourceIds: (s.sourceIds || []).filter(isKnownSource),
          })),
          characters,
          assumptions: (r.assumptions || []).map((a) => ({
            ...a,
            id: a.id || crypto.randomUUID(),
          })),
          selectedThemes: resolvedThemes,
          themes: film.themes.length ? film.themes : resolvedThemes,
          logline: r.logline,
          generatedBy: r.generatedBy,
          sourceCoverage: r.sourceCoverage,
        });
        setStep(2);
        notify(
          "Your film draft is ready. Review the script, supporting cast, and clearly labeled assumptions.",
        );
      },
    );
  }
  function selectTheme(theme: Theme) {
    const selected = film.selectedThemes.some((t) => t.id === theme.id);
    if (!selected && film.selectedThemes.length >= 3) {
      notify("Choose up to three themes. Deselect one to add another.", "error");
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
  async function checkFilm() {
    if (!film.job) return;
    await task("Checking film production…", async () => {
      const job = await api<Shot>(
        `/api/studio?action=status&id=${encodeURIComponent(film.job!.id)}`,
      );
      update({ job });
      notify(
        productionStatusMessage(job.status),
        job.status === "failed" ? "error" : "info",
      );
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
      new Blob([JSON.stringify(customerProjectBackup(film), null, 2)], { type: "application/json" }),
      `${cleanName(film.title)}-project.json`,
    );
    notify("Project backup downloaded. Original media files are stored separately.");
  }

  const nav = [
    { id: "create" as const, label: "Create a film", icon: Video },
    { id: "library" as const, label: "Film library", icon: Library },
    ...(user.role === "owner" || user.role === "admin"
      ? [{ id: "admin" as const, label: "Administration", icon: ShieldCheck }]
      : []),
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
            <button className="text-button" aria-label="Account security" disabled={!!busy || accountBusy} onClick={() => setAccountOpen(true)}>{user.name}</button>
            <button
              className="icon-button"
              aria-label="Sign out"
              disabled={!!busy || accountBusy}
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
          {accountOpen ? <Suspense fallback={<div className="panel" role="status">Opening account settings…</div>}>
            <AccountSecurity user={user} onUserChange={onUserChange} onClose={() => setAccountOpen(false)} onBusyChange={setAccountBusy} />
          </Suspense> : <>
          {view === "admin" && (user.role === "owner" || user.role === "admin") && (
            <Suspense
              fallback={
                <div className="panel" role="status">
                  <Loader2 className="spin" size={20} /> Opening administration…
                </div>
              }
            >
              <Admin
                user={user}
                notify={notify}
                onPricingChanged={async () => {
                  const current = await api<Capabilities>(
                    "/api/studio?action=capabilities",
                  );
                  setCaps(current);
                }}
              />
            </Suspense>
          )}
          {view === "create" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Your family. A lasting film.</h1>
                  <p>
                    Turn the people, places, and moments that matter into a beautiful
                    film.
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
                      caps={caps}
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
                            generatedBy: "Manual outline from source text",
                            characters: [],
                            assumptions: [],
                            sourceCoverage: undefined,
                          });
                          navigate(2);
                          notify(
                            "Manual outline created from your source text. Add the cast and dramatic details in the review step.",
                          );
                        }
                      }}
                    />
                  )}
                  {step === 2 && <CuttingStep {...props} changeScene={changeScene} />}
                  {step === 3 && (
                    <CreateStep
                      {...props}
                      caps={caps}
                      checkFilm={checkFilm}
                      consent={consent}
                      setConsent={setConsent}
                      resultUrl={resultUrl}
                      persistPaymentReference={persistPaymentReference}
                      onCheckoutBusy={setBusy}
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
                  <p>Private projects saved under your account in this browser.</p>
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
                          disabled={projects.filter((x) => !x.archivedAt).length <= 1}
                          onClick={() => {
                            update({ archivedAt: new Date().toISOString() }, p.id);
                            if (activeId === p.id)
                              setActiveId(
                                projects.find((x) => x.id !== p.id && !x.archivedAt)!.id,
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
                  <p>Your earlier Lineage Theatre projects are still in this browser.</p>
                  <button
                    className="button secondary"
                    onClick={() => {
                      try {
                        const old = JSON.parse(
                          localStorage.getItem("lineage-theater-projects-v2") || "[]",
                        );
                        const imported = old
                          .map(normalizeFilm)
                          .filter((p: Film) => !projects.some((x) => x.id === p.id));
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
          {view === "library" && <CloudArchivePanel projects={projects} />}
          </>}
        </main>
        <footer className="workspace-footer">
          <span>Lineage Theatre · Lives remembered. Stories kept.</span>
          <a
            href="/assets/the-journey-of-thomas-wilson.mp4"
            target="_blank"
            rel="noreferrer"
          >
            Sample trailer
          </a>
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
      {busy && (
        <div className="busy-strip" role="status">
          <Loader2 size={16} className="spin" />
          {busy}
        </div>
      )}
    </div>
  );
}
