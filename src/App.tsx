import { useEffect, useMemo, useRef, useState } from "react";
import { deleteSourceFile, saveSourceFile } from "./lib/storage";

type SaveState = "saved" | "saving" | "error";
type ToastTone = "success" | "error" | "info";

interface SourceFileRecord {
  id: string;
  name: string;
  size: number;
  type: string;
}

interface FilmProject {
  id: string;
  title: string;
  ancestor: string;
  script: string;
  runtime: string;
  providerId: string;
  sources: SourceFileRecord[];
  updatedAt: string;
}

interface FilmScene {
  title: string;
  direction: string;
  narration: string;
}

interface FilmPlan {
  generatedAt: string;
  logline: string;
  scenes: FilmScene[];
}

interface ProviderOption {
  id: string;
  name: string;
  label: string;
  summary: string;
  bestFor: string;
  price: string;
  detail: string;
  website: string | null;
  accent: string;
}

interface ToastMessage {
  id: number;
  tone: ToastTone;
  message: string;
}

const STORAGE_KEY = "lineage-theater-projects-v2";

const sampleScript = `In 1919, twenty-four-year-old Thomas Wilson left the stone cottage where his family had lived for generations. He carried one photograph, a hand-written address in Baltimore, and the promise that he would send for his younger brother.

At the shipyard, Thomas learned to shape steel and found a community of newcomers building lives beside him. His letters home described the harbor lights, the sound of hammers at dawn, and the small room where he saved every spare dollar.

That journey became the first chapter of our family's American story. The courage Thomas carried forward can still be felt in the choices his descendants make today.`;

const runtimeOptions = [
  { value: "trailer", label: "Family trailer", note: "1–2 min" },
  { value: "short", label: "Short film", note: "4–8 min" },
  { value: "featurette", label: "Featurette", note: "10–20 min" },
  { value: "feature", label: "Long film", note: "20–50 min" },
];

const providerOptions: ProviderOption[] = [
  {
    id: "runway",
    name: "Runway",
    label: "Recommended",
    summary: "The strongest overall choice for directed, cinematic ancestor scenes.",
    bestFor: "Cinematic control",
    price: "From $15/mo",
    detail: "Standard includes 625 monthly credits. Generation uses credits, so final cost depends on model and scene length.",
    website: "https://runwayml.com/",
    accent: "amber",
  },
  {
    id: "imagineart",
    name: "ImagineArt",
    label: "All-in-one",
    summary: "A unified studio for cinematic video, source images, avatars, voice, music, and finishing tools.",
    bestFor: "End-to-end creation",
    price: "Ultimate ≈ $34/mo yearly",
    detail: "Displayed annual-plan equivalent checked August 31, 2026. Promotions, credits, seats, model access, and commercial terms can change.",
    website: "https://www.imagine.art/",
    accent: "violet",
  },
  {
    id: "flow",
    name: "Google Flow + Veo",
    label: "Premium shots",
    summary: "High-end generative video for polished hero moments and visual transitions.",
    bestFor: "Hero scenes",
    price: "AI Pro $19.99/mo",
    detail: "Flow access and limits vary by Google AI plan, region, and availability. Review current plan terms before rendering.",
    website: "https://labs.google/fx/tools/flow",
    accent: "violet",
  },
  {
    id: "heygen",
    name: "HeyGen",
    label: "Presenter",
    summary: "A practical choice when the film needs an on-camera family narrator or avatar.",
    bestFor: "Narration",
    price: "Creator $29/mo",
    detail: "Creator lists 600 premium credits and videos up to 30 minutes. API usage is priced separately.",
    website: "https://www.heygen.com/",
    accent: "blue",
  },
  {
    id: "magiclight",
    name: "MagicLight",
    label: "Long-form",
    summary: "A fast route from a written story to a longer first-pass video with less manual assembly.",
    bestFor: "Fast drafts",
    price: "Free trial; paid varies",
    detail: "MagicLight advertises videos up to 50 minutes. Confirm current paid plan and commercial-use terms in its studio.",
    website: "https://magiclight.ai/",
    accent: "rose",
  },
  {
    id: "lineage",
    name: "Lineage plan",
    label: "No renderer",
    summary: "Create a private scene plan and provider-ready production package in this browser.",
    bestFor: "Planning",
    price: "$0 in this app",
    detail: "Lineage Theatre prepares the project package but does not claim to render a paid provider's video.",
    website: null,
    accent: "green",
  },
];

const steps = [
  ["01", "Tell the story", "Paste a script or begin with a family memory."],
  ["02", "Add what is real", "Attach photos, letters, and sources you may use."],
  ["03", "Choose the format", "Select a short, featurette, or longer family film."],
  ["04", "Pick a studio", "Compare the right video provider for your story."],
  ["05", "Review and create", "Prepare a scene plan, then continue in that studio."],
];

const blankProject = (): FilmProject => ({
  id: crypto.randomUUID(),
  title: "Untitled family film",
  ancestor: "",
  script: "",
  runtime: "short",
  providerId: "runway",
  sources: [],
  updatedAt: new Date().toISOString(),
});

const initialProject = (): FilmProject => ({
  id: crypto.randomUUID(),
  title: "The Journey of Thomas Wilson",
  ancestor: "Thomas Wilson",
  script: sampleScript,
  runtime: "short",
  providerId: "runway",
  sources: [],
  updatedAt: new Date().toISOString(),
});

function loadProjects(): FilmProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [initialProject()];
    const parsed = JSON.parse(raw) as FilmProject[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [initialProject()];
  } catch {
    return [initialProject()];
  }
}

function formatBytes(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}

function makeFilmPlan(project: FilmProject): FilmPlan {
  const parts = project.script
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const source = parts.length > 0 ? parts : [project.script.trim()];
  const ancestor = project.ancestor.trim() || "your ancestor";
  const sceneNames = ["The world before", "The turning point", "A life in motion", "What endured", "The legacy today"];
  const directions = [
    "Establish the place and period with sourced details and a restrained cinematic opening.",
    "Show the choice or circumstance that changed the course of the story.",
    "Build the middle through work, relationships, obstacles, and everyday detail.",
    "Return to the objects, letters, and memories that carried the story forward.",
    "Connect the ancestor's choices to the family members who remember them now.",
  ];
  const scenes = sceneNames.map((title, index) => ({
    title,
    direction: directions[index],
    narration: source[index % source.length].slice(0, 420),
  }));
  return {
    generatedAt: new Date().toISOString(),
    logline: `${ancestor}'s story becomes a ${runtimeOptions.find((option) => option.value === project.runtime)?.label.toLowerCase() ?? "family film"} grounded in family evidence and memory.`,
    scenes,
  };
}

function buildProviderBrief(project: FilmProject, plan: FilmPlan | null) {
  const provider = providerOptions.find((option) => option.id === project.providerId) ?? providerOptions[0];
  const runtime = runtimeOptions.find((option) => option.value === project.runtime);
  const sceneText = plan
    ? plan.scenes.map((scene, index) => `${index + 1}. ${scene.title}\nDirection: ${scene.direction}\nNarration: ${scene.narration}`).join("\n\n")
    : "Create a scene structure from the script below before rendering.";
  return `LINEAGE THEATRE PRODUCTION BRIEF

Project: ${project.title}
Ancestor: ${project.ancestor || "Not yet named"}
Format: ${runtime?.label ?? "Short film"} (${runtime?.note ?? "4–8 min"})
Selected studio: ${provider.name}

Creative direction:
Create a respectful, cinematic family-history film. Preserve uncertainty where facts are incomplete. Do not invent quotations, dates, places, uniforms, or family relationships. Use only attached family materials for which the family has permission.

Scene plan:
${sceneText}

Approved script:
${project.script}

Source inventory:
${project.sources.length > 0 ? project.sources.map((source) => `- ${source.name}`).join("\n") : "- No source files attached yet"}

Final checks:
- Confirm likeness and media rights before upload.
- Review every generated historical detail for accuracy.
- Confirm the provider's current price and commercial-use terms before rendering.`;
}

function App() {
  const [projects, setProjects] = useState<FilmProject[]>(loadProjects);
  const [activeProjectId, setActiveProjectId] = useState(() => projects[0].id);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [plan, setPlan] = useState<FilmPlan | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(78.5);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showActionDock, setShowActionDock] = useState(false);
  const scriptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const heroVideoRef = useRef<HTMLVideoElement>(null);
  const toastTimerRef = useRef<number | null>(null);

  const project = projects.find((item) => item.id === activeProjectId) ?? projects[0];
  const selectedProvider = providerOptions.find((option) => option.id === project.providerId) ?? providerOptions[0];
  const runtime = runtimeOptions.find((option) => option.value === project.runtime) ?? runtimeOptions[1];
  const wordCount = project.script.trim() ? project.script.trim().split(/\s+/).length : 0;
  const readMinutes = Math.max(1, Math.ceil(wordCount / 135));

  useEffect(() => {
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [projects]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    const creator = document.querySelector("#create");
    const updateDockVisibility = () => {
      if (!creator) return;
      setShowActionDock(creator.getBoundingClientRect().top < window.innerHeight - 72);
    };
    updateDockVisibility();
    window.addEventListener("scroll", updateDockVisibility, { passive: true });
    window.addEventListener("resize", updateDockVisibility);
    return () => {
      window.removeEventListener("scroll", updateDockVisibility);
      window.removeEventListener("resize", updateDockVisibility);
    };
  }, []);

  const progress = useMemo(() => {
    const checks = [project.script.trim().length >= 80, project.sources.length > 0, Boolean(project.runtime), Boolean(project.providerId), Boolean(plan)];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [plan, project]);

  const notify = (message: string, tone: ToastTone = "success") => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), tone, message });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  };

  const togglePreview = async () => {
    const video = heroVideoRef.current;
    if (!video) {
      notify("The trailer is not ready yet. Please try again.", "error");
      return;
    }

    if (video.paused) {
      try {
        await video.play();
        notify("Thomas Wilson trailer playing.", "success");
      } catch {
        notify("The trailer could not start. Please try again.", "error");
      }
      return;
    }

    video.pause();
    notify("Trailer paused.", "info");
  };

  const updateProject = (patch: Partial<FilmProject>) => {
    setProjects((current) => current.map((item) => item.id === activeProjectId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item));
    if ("script" in patch || "runtime" in patch || "ancestor" in patch) setPlan(null);
  };

  const focusScript = () => {
    document.querySelector("#create")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => scriptRef.current?.focus(), 550);
    notify("The script editor is ready.", "info");
  };

  const createProject = () => {
    const next = blankProject();
    setProjects((current) => [next, ...current]);
    setActiveProjectId(next.id);
    setPlan(null);
    setMenuOpen(false);
    notify("New film project created.");
    window.setTimeout(() => scriptRef.current?.focus(), 100);
  };

  const selectProject = (id: string) => {
    setActiveProjectId(id);
    setPlan(null);
    notify("Project opened.", "info");
    document.querySelector("#create")?.scrollIntoView({ behavior: "smooth" });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const accepted: SourceFileRecord[] = [];
    const existingNames = new Set(project.sources.map((source) => source.name.toLowerCase()));
    let rejected = 0;
    for (const file of Array.from(files)) {
      if (file.size > 100 * 1024 * 1024 || existingNames.has(file.name.toLowerCase())) {
        rejected += 1;
        continue;
      }
      const record = { id: crypto.randomUUID(), name: file.name, size: file.size, type: file.type || "application/octet-stream" };
      try {
        await saveSourceFile(record.id, project.id, file);
        accepted.push(record);
        existingNames.add(file.name.toLowerCase());
      } catch {
        rejected += 1;
      }
    }
    if (accepted.length > 0) updateProject({ sources: [...project.sources, ...accepted] });
    if (accepted.length > 0 && rejected === 0) notify(`${accepted.length} source ${accepted.length === 1 ? "file" : "files"} added.`);
    else if (accepted.length > 0) notify(`${accepted.length} added; ${rejected} skipped as duplicate, oversized, or unreadable.`, "info");
    else notify("No files were added. Check for duplicates or the 100 MB limit.", "error");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeSource = async (source: SourceFileRecord) => {
    if (!window.confirm(`Remove ${source.name} from this project?`)) return;
    try {
      await deleteSourceFile(source.id);
      updateProject({ sources: project.sources.filter((item) => item.id !== source.id) });
      notify(`${source.name} removed.`);
    } catch {
      notify(`Could not remove ${source.name}.`, "error");
    }
  };

  const selectProvider = (provider: ProviderOption) => {
    updateProject({ providerId: provider.id });
    notify(`${provider.name} selected.`, "success");
  };

  const prepareFilmPlan = () => {
    if (project.script.trim().length < 80) {
      scriptRef.current?.focus();
      notify("Add at least 80 characters of story before preparing the film plan.", "error");
      return;
    }
    setIsPlanning(true);
    notify("Building a five-scene plan from your script…", "info");
    window.setTimeout(() => {
      setPlan(makeFilmPlan(project));
      setIsPlanning(false);
      notify("Film plan prepared. Review it before opening the studio.");
      window.setTimeout(() => document.querySelector("#film-plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }, 850);
  };

  const copyBrief = async () => {
    try {
      await navigator.clipboard.writeText(buildProviderBrief(project, plan));
      notify("Provider brief copied.");
    } catch {
      notify("The browser could not copy the brief. Download the project package instead.", "error");
    }
  };

  const prepareStudioHandoff = () => {
    if (!selectedProvider.website) {
      notify("The Lineage plan is ready here. Download the package when your review is complete.", "info");
      return;
    }
    navigator.clipboard.writeText(buildProviderBrief(project, plan)).then(
      () => notify(`${selectedProvider.name} is opening and the production brief was copied. Rendering and billing happen there.`),
      () => notify(`${selectedProvider.name} is opening. Download the package if you need the full brief.`, "info"),
    );
  };

  const downloadPackage = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      notice: "Review facts, rights, provider pricing, and commercial-use terms before rendering.",
      project,
      plan,
      provider: selectedProvider,
      providerBrief: buildProviderBrief(project, plan),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lineage-film"}-package.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    notify("Project package downloaded.");
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Lineage Theatre home">
          <span className="wordmark-mark" aria-hidden="true">LT</span>
          <span>Lineage Theatre</span>
        </a>
        <nav className={menuOpen ? "header-nav is-open" : "header-nav"} aria-label="Primary navigation">
          <a href="#how" onClick={() => setMenuOpen(false)}>How it works</a>
          <a href="#providers" onClick={() => setMenuOpen(false)}>Video studios</a>
          <a href="#projects" onClick={() => setMenuOpen(false)}>Projects</a>
        </nav>
        <div className="header-actions">
          <span className={`save-state ${saveState}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {saveState === "saving" ? "Saving" : saveState === "error" ? "Save failed" : "Saved locally"}
          </span>
          <button className="button button-primary button-small" type="button" onClick={createProject}>New film</button>
          <button className="menu-button" type="button" aria-label="Toggle menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Menu</button>
        </div>
      </header>

      <main id="top">
        <section className="hero page-width" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Family history, made cinematic</p>
            <h1 id="hero-title">Turn an ancestor’s story into a film.</h1>
            <p className="hero-description">Begin with the words you know. Lineage Theatre turns them into a clear scene plan, keeps your sources close, and hands the project to the video studio that fits your story.</p>
            <div className="hero-actions">
              <button className="button button-primary" type="button" onClick={focusScript}>Start with a script <span aria-hidden="true">→</span></button>
              <a className="text-link" href="#how">See the five steps <span aria-hidden="true">↓</span></a>
            </div>
            <p className="trust-line"><span aria-hidden="true">✓</span> Private browser draft <span aria-hidden="true">·</span> No card required <span aria-hidden="true">·</span> Export anytime</p>
          </div>
          <div className="hero-visual" aria-label="Finished film example: The Journey of Thomas Wilson">
            <video
              ref={heroVideoRef}
              src="/assets/the-journey-of-thomas-wilson.mp4"
              poster="/assets/the-journey-of-thomas-wilson-poster.jpg"
              preload="metadata"
              playsInline
              onClick={togglePreview}
              onLoadedMetadata={(event) => setPreviewDuration(event.currentTarget.duration || 78.5)}
              onTimeUpdate={(event) => setPreviewTime(event.currentTarget.currentTime)}
              onPlay={() => setIsPreviewPlaying(true)}
              onPause={() => setIsPreviewPlaying(false)}
              onEnded={() => {
                setIsPreviewPlaying(false);
                notify("Trailer finished. You can replay it anytime.", "success");
              }}
              aria-label="Play or pause the 78-second Thomas Wilson cinematic trailer"
            />
            <div className="visual-scrim" />
            <div className="preview-topline"><span>Finished example</span><span>1:18 · 1080p</span></div>
            <div className="preview-bottom">
              <button className="preview-play" type="button" aria-label={isPreviewPlaying ? "Pause Thomas Wilson trailer" : "Play Thomas Wilson trailer"} onClick={togglePreview}>{isPreviewPlaying ? "Ⅱ" : "▶"}</button>
              <div><span className="preview-kicker">The Journey of</span><span className="preview-title">Thomas Wilson</span></div>
              <span className="preview-time">{formatTime(previewTime)} / {formatTime(previewDuration)}</span>
            </div>
            <div
              className="preview-progress"
              role="progressbar"
              aria-label="Trailer progress"
              aria-valuemin={0}
              aria-valuemax={Math.round(previewDuration)}
              aria-valuenow={Math.round(previewTime)}
            ><span style={{ width: `${previewDuration > 0 ? Math.min(100, (previewTime / previewDuration) * 100) : 0}%` }} /></div>
          </div>
        </section>

        <section className="workflow-band" id="how" aria-labelledby="workflow-title">
          <div className="page-width">
            <div className="section-intro compact-intro">
              <p className="eyebrow">A simple path from memory to movie</p>
              <h2 id="workflow-title">Five small steps. One finished story.</h2>
            </div>
            <ol className="step-rail">
              {steps.map(([number, title, description]) => (
                <li key={number}>
                  <span className="step-number">{number}</span>
                  <div><h3>{title}</h3><p>{description}</p></div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="creator-section page-width" id="create" aria-labelledby="creator-title">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">Create your film</p>
              <h2 id="creator-title">Build the story while it is still fresh.</h2>
            </div>
            <div className="completion" aria-label={`${progress}% project ready`}>
              <span>{progress}% ready</span><span className="completion-track"><span style={{ width: `${progress}%` }} /></span>
            </div>
          </div>

          <div className="creator-frame">
            <div className="editor-panel">
              <div className="panel-section identity-grid">
                <label>Film title<input value={project.title} onChange={(event) => updateProject({ title: event.target.value })} /></label>
                <label>Ancestor’s name<input value={project.ancestor} placeholder="Who is this story about?" onChange={(event) => updateProject({ ancestor: event.target.value })} /></label>
              </div>
              <div className="panel-section script-section">
                <div className="field-heading"><label htmlFor="script">Script or family story</label><span>{wordCount} words · about {readMinutes} min narration</span></div>
                <textarea id="script" ref={scriptRef} value={project.script} placeholder="Begin with the moment that changed your ancestor’s life…" onChange={(event) => updateProject({ script: event.target.value })} />
                <p className="field-help">Tip: dates, places, letters, and sensory details make stronger scenes. Mark family lore as family lore.</p>
              </div>
              <div className="panel-section">
                <div className="field-heading"><span>Film length</span><span>Choose a target, not a hard limit</span></div>
                <div className="runtime-grid">
                  {runtimeOptions.map((option) => (
                    <button className={project.runtime === option.value ? "choice-card selected" : "choice-card"} type="button" key={option.value} aria-pressed={project.runtime === option.value} onClick={() => {
                      updateProject({ runtime: option.value });
                      notify(`${option.label} selected.`, "success");
                    }}><span>{option.label}</span><small>{option.note}</small></button>
                  ))}
                </div>
              </div>
            </div>

            <aside className="source-panel" aria-labelledby="sources-title">
              <div className="source-heading"><div><span className="panel-kicker">Source room</span><h3 id="sources-title">Keep the film grounded.</h3></div><span className="source-count">{project.sources.length}</span></div>
              <p>Add only material your family has permission to use. Files remain in this browser during this release.</p>
              <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="image/*,.pdf,.txt,.doc,.docx,audio/*,video/*" onChange={(event) => void handleFiles(event.target.files)} />
              <button className="drop-zone" type="button" onClick={() => fileInputRef.current?.click()}>
                <span className="drop-icon" aria-hidden="true">+</span>
                <span>Add photos, letters, audio, or notes</span>
                <small>Up to 100 MB per file</small>
              </button>
              {project.sources.length > 0 ? (
                <ul className="source-list">
                  {project.sources.map((source) => (
                    <li key={source.id}><span className="file-mark" aria-hidden="true">□</span><span><span>{source.name}</span><small>{formatBytes(source.size)}</small></span><button type="button" aria-label={`Remove ${source.name}`} onClick={() => void removeSource(source)}>×</button></li>
                  ))}
                </ul>
              ) : <div className="empty-sources"><span aria-hidden="true">◎</span><p>No sources attached yet.</p><small>You can still prepare a plan, then return to add evidence.</small></div>}
              <div className="privacy-note"><span aria-hidden="true">◌</span><p><span>Local for now</span><small>Supabase sync can be added after production data and access rules are approved.</small></p></div>
            </aside>
          </div>
        </section>

        <section className="providers-section" id="providers" aria-labelledby="providers-title">
          <div className="page-width">
            <div className="section-heading-row provider-heading">
              <div><p className="eyebrow">Choose the video studio</p><h2 id="providers-title">Use the right engine for this film.</h2><p>Lineage Theatre prepares the creative brief. Paid rendering, accounts, usage limits, and billing stay with the selected provider.</p></div>
              <span className="pricing-check">Pricing checked August 31, 2026</span>
            </div>
            <div className="provider-list">
              {providerOptions.map((provider) => {
                const selected = project.providerId === provider.id;
                return (
                  <button className={selected ? `provider-row selected ${provider.accent}` : `provider-row ${provider.accent}`} type="button" key={provider.id} aria-pressed={selected} onClick={() => selectProvider(provider)}>
                    <span className="provider-radio" aria-hidden="true"><span /></span>
                    <span className="provider-name"><span>{provider.name}</span><small>{provider.label}</small></span>
                    <span className="provider-summary">{provider.summary}</span>
                    <span className="provider-use"><small>Best for</small><span>{provider.bestFor}</span></span>
                    <span className="provider-price"><span>{provider.price}</span><small>{provider.detail}</small></span>
                    <span className="provider-state">{selected ? "Selected ✓" : "Choose"}</span>
                  </button>
                );
              })}
            </div>
            <p className="pricing-disclosure">Prices are provider list prices or disclosed starting points, not Lineage Theatre charges. Taxes, credits, duration, API use, and commercial terms can change; confirm the final amount in the provider’s studio.</p>
          </div>
        </section>

        {plan ? (
          <section className="plan-section page-width" id="film-plan" aria-labelledby="plan-title">
            <div className="section-heading-row">
              <div><p className="eyebrow">Film plan ready</p><h2 id="plan-title">Review before anything is rendered.</h2><p>{plan.logline}</p></div>
              <span className="success-chip"><span aria-hidden="true">✓</span> Five scenes prepared</span>
            </div>
            <div className="scene-grid">
              {plan.scenes.map((scene, index) => <article className="scene-card" key={scene.title}><span>Scene {String(index + 1).padStart(2, "0")}</span><h3>{scene.title}</h3><p>{scene.direction}</p><blockquote>{scene.narration}</blockquote></article>)}
            </div>
            <div className="plan-actions">
              <button className="button button-secondary" type="button" onClick={() => void copyBrief()}>Copy provider brief</button>
              <button className="button button-secondary" type="button" onClick={downloadPackage}>Download project package ↓</button>
              {selectedProvider.website ? <a className="button button-primary" href={selectedProvider.website} target="_blank" rel="noopener noreferrer" onClick={prepareStudioHandoff}>Open {selectedProvider.name} ↗</a> : <button className="button button-primary" type="button" onClick={downloadPackage}>Download Lineage plan ↓</button>}
            </div>
          </section>
        ) : null}

        <section className="projects-section page-width" id="projects" aria-labelledby="projects-title">
          <div className="section-heading-row">
            <div><p className="eyebrow">Your projects</p><h2 id="projects-title">Return to a family story.</h2></div>
            <button className="button button-secondary button-small" type="button" onClick={createProject}>+ New film</button>
          </div>
          <div className="project-grid">
            {projects.map((item) => (
              <button className={item.id === project.id ? "project-card current" : "project-card"} type="button" key={item.id} onClick={() => selectProject(item.id)}>
                <span className="project-thumb"><img src="/assets/ancestor-shipyard-still.png" alt="" /></span>
                <span className="project-meta"><span>{item.title}</span><small>{item.ancestor || "Ancestor not named"} · {runtimeOptions.find((option) => option.value === item.runtime)?.label}</small><small>Updated {new Date(item.updatedAt).toLocaleDateString()}</small></span>
                <span className="project-arrow" aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        </section>
      </main>

      <footer className="site-footer" data-build-commit={__BUILD_COMMIT__}>
        <div className="page-width"><div><span className="footer-mark">LT</span><p><span>Lineage Theatre</span><small>Make family history feel close again.</small></p></div><p>GitHub source · Vercel hosting · Namecheap DNS today · Supabase-ready data path · Build {__BUILD_COMMIT__.slice(0, 7)}</p></div>
      </footer>

      {showActionDock ? (
        <div className="action-dock" aria-label="Current film action">
          <div><span>Next step</span><p>{plan ? `Continue with ${selectedProvider.name}` : `Prepare ${runtime.label.toLowerCase()} for ${selectedProvider.name}`}</p></div>
          {plan && selectedProvider.website ? <a className="button button-primary" href={selectedProvider.website} target="_blank" rel="noopener noreferrer" onClick={prepareStudioHandoff}>Open {selectedProvider.name} ↗</a> : <button className="button button-primary" type="button" disabled={isPlanning} onClick={plan ? downloadPackage : prepareFilmPlan}>{isPlanning ? "Preparing your plan…" : plan ? "Download the plan ↓" : "Prepare film plan →"}</button>}
        </div>
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`} key={toast.id} role={toast.tone === "error" ? "alert" : "status"}><span aria-hidden="true">{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span><p>{toast.message}</p><button type="button" aria-label="Dismiss message" onClick={() => setToast(null)}>×</button></div> : null}
    </div>
  );
}

export default App;
