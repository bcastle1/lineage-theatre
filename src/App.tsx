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

type ImagineRenderStatus = "submitting" | "queued" | "processing" | "completed" | "failed";

interface ImagineRender {
  provider: "imagineart";
  jobId: string | null;
  status: ImagineRenderStatus;
  model: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  submittedAt: string;
  updatedAt: string;
  error: string | null;
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
  archivedAt: string | null;
  greenlitAt: string | null;
  readinessGaps: string[];
  render: ImagineRender | null;
}

type ReadinessKey = "title" | "ancestor" | "script" | "sources" | "runtime" | "provider";

interface ReadinessGap {
  key: ReadinessKey;
  label: string;
  detail: string;
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
    label: "Automated in app",
    summary: "Greenlight a premium cinematic preview and follow its production without leaving Lineage Theatre.",
    bestFor: "In-app production",
    price: "API usage billed separately",
    detail: "The connected Imagine API account pays per generation. Model cost and available balance can change.",
    website: null,
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
  ["04", "Pick a studio", "Choose ImagineArt for automatic in-app production, or compare another provider."],
  ["05", "Greenlight and watch", "Confirm the details, begin production, and follow the finished video here."],
];

const blankProject = (): FilmProject => ({
  id: crypto.randomUUID(),
  title: "",
  ancestor: "",
  script: "",
  runtime: "short",
  providerId: "imagineart",
  sources: [],
  updatedAt: new Date().toISOString(),
  archivedAt: null,
  greenlitAt: null,
  readinessGaps: [],
  render: null,
});

const initialProject = (): FilmProject => ({
  id: crypto.randomUUID(),
  title: "The Journey of Thomas Wilson",
  ancestor: "Thomas Wilson",
  script: sampleScript,
  runtime: "short",
  providerId: "imagineart",
  sources: [],
  updatedAt: new Date().toISOString(),
  archivedAt: null,
  greenlitAt: null,
  readinessGaps: [],
  render: null,
});

function normalizeProject(project: FilmProject): FilmProject {
  const rawRender = project.render;
  const render = rawRender && rawRender.provider === "imagineart" ? {
    provider: "imagineart" as const,
    jobId: typeof rawRender.jobId === "string" ? rawRender.jobId : null,
    status: (["submitting", "queued", "processing", "completed", "failed"] as ImagineRenderStatus[]).includes(rawRender.status) ? rawRender.status : "failed",
    model: typeof rawRender.model === "string" ? rawRender.model : "luma-dream-machine-ray-2",
    videoUrl: typeof rawRender.videoUrl === "string" ? rawRender.videoUrl : null,
    thumbnailUrl: typeof rawRender.thumbnailUrl === "string" ? rawRender.thumbnailUrl : null,
    submittedAt: typeof rawRender.submittedAt === "string" ? rawRender.submittedAt : "",
    updatedAt: typeof rawRender.updatedAt === "string" ? rawRender.updatedAt : "",
    error: typeof rawRender.error === "string" ? rawRender.error : null,
  } : null;
  return {
    ...project,
    title: typeof project.title === "string" ? project.title : "",
    ancestor: typeof project.ancestor === "string" ? project.ancestor : "",
    script: typeof project.script === "string" ? project.script : "",
    runtime: project.runtime || "short",
    providerId: project.providerId === "magiclight" ? "imagineart" : project.providerId || "imagineart",
    sources: Array.isArray(project.sources) ? project.sources : [],
    archivedAt: project.archivedAt ?? null,
    greenlitAt: project.greenlitAt ?? null,
    readinessGaps: Array.isArray(project.readinessGaps) ? project.readinessGaps : [],
    render,
  };
}

function loadProjects(): FilmProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [initialProject()];
    const parsed = JSON.parse(raw) as FilmProject[];
    if (!Array.isArray(parsed) || parsed.length === 0) return [initialProject()];
    const normalized = parsed.map(normalizeProject);
    return normalized.some((project) => !project.archivedAt) ? normalized : [blankProject(), ...normalized];
  } catch {
    return [initialProject()];
  }
}

function getReadinessGaps(project: FilmProject): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  if (!project.title.trim()) gaps.push({ key: "title", label: "Film title", detail: "Name the film so the production package and saved project are easy to identify." });
  if (!project.ancestor.trim()) gaps.push({ key: "ancestor", label: "Ancestor's name", detail: "Identify the person at the center of the family story." });
  if (project.script.trim().length < 80) gaps.push({ key: "script", label: "Script or family story", detail: project.script.trim() ? "Add more story detail so the production plan has enough material." : "Add the story, narration, or script that the film will follow." });
  if (project.sources.length === 0) gaps.push({ key: "sources", label: "Source material", detail: "Add at least one photo, letter, recording, or note to help ground the film." });
  if (!project.runtime) gaps.push({ key: "runtime", label: "Film length", detail: "Choose the intended running time for the film." });
  if (!project.providerId) gaps.push({ key: "provider", label: "Video studio", detail: "Choose the studio that should receive the production package." });
  return gaps;
}

function getProjectStatus(project: FilmProject) {
  if (project.archivedAt) return "Archived";
  if (project.render?.status === "completed") return "Film ready";
  if (["submitting", "queued", "processing"].includes(project.render?.status ?? "")) return "In production";
  if (project.render?.status === "failed") return "Production needs attention";
  if (project.greenlitAt && project.readinessGaps.length > 0) return "Greenlit with gaps";
  if (project.greenlitAt) return "Greenlit";
  return "In development";
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

Project: ${project.title.trim() || "Untitled family film"}
Ancestor: ${project.ancestor || "Not yet named"}
Format: ${runtime?.label ?? "Short film"} (${runtime?.note ?? "4–8 min"})
Selected studio: ${provider.name}
Production status: ${getProjectStatus(project)}
Readiness gaps: ${project.readinessGaps.length > 0 ? project.readinessGaps.join(", ") : "None recorded"}

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

function buildImaginePrompt(project: FilmProject, plan: FilmPlan) {
  const sceneDirection = plan.scenes
    .map((scene, index) => `Scene ${index + 1}, ${scene.title}: ${scene.direction} Visual story detail: ${scene.narration}`)
    .join("\n");
  const prompt = `Create a premium, realistic cinematic family-history film preview in 16:9 widescreen about ${project.ancestor.trim() || "an ancestor"}. Use natural human movement, historically plausible environments, restrained camera motion, warm filmic light, realistic texture, subtle depth of field, and emotionally grounded visual storytelling. Avoid fantasy imagery, modern objects that do not belong in the period, invented written quotations, logos, subtitles, title cards, and on-screen text. Preserve uncertainty rather than inventing facts.

Film: ${project.title.trim() || "Untitled family film"}
Creative structure:
${sceneDirection}

Approved family story:
${project.script.trim()}`;
  return prompt.slice(0, 4_000);
}

function App() {
  const [projects, setProjects] = useState<FilmProject[]>(loadProjects);
  const [activeProjectId, setActiveProjectId] = useState(() => projects.find((project) => !project.archivedAt)?.id ?? projects[0].id);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [plan, setPlan] = useState<FilmPlan | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(78.5);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showActionDock, setShowActionDock] = useState(false);
  const [readinessReview, setReadinessReview] = useState<ReadinessGap[] | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const ancestorRef = useRef<HTMLInputElement>(null);
  const scriptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceButtonRef = useRef<HTMLButtonElement>(null);
  const readinessDialogRef = useRef<HTMLElement>(null);
  const heroVideoRef = useRef<HTMLVideoElement>(null);
  const toastTimerRef = useRef<number | null>(null);

  const activeProjects = projects.filter((item) => !item.archivedAt);
  const archivedProjects = projects.filter((item) => Boolean(item.archivedAt));
  const project = projects.find((item) => item.id === activeProjectId && !item.archivedAt) ?? activeProjects[0] ?? projects[0];
  const selectedProvider = providerOptions.find((option) => option.id === project.providerId) ?? providerOptions[0];
  const runtime = runtimeOptions.find((option) => option.value === project.runtime) ?? runtimeOptions[1];
  const wordCount = project.script.trim() ? project.script.trim().split(/\s+/).length : 0;
  const readMinutes = wordCount > 0 ? Math.max(1, Math.ceil(wordCount / 135)) : 0;

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
    if (!readinessReview) return;
    window.setTimeout(() => readinessDialogRef.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReadinessReview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [readinessReview]);

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
    const checks = [Boolean(project.title.trim()), Boolean(project.ancestor.trim()), project.script.trim().length >= 80, project.sources.length > 0, Boolean(project.runtime), Boolean(project.providerId), Boolean(plan)];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [plan, project]);

  const notify = (message: string, tone: ToastTone = "success") => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), tone, message });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  };

  useEffect(() => {
    const render = project.render;
    if (!render?.jobId || render.status === "failed") return;

    let stopped = false;
    let timer: number | null = null;
    let failures = 0;

    const poll = async () => {
      try {
        const response = await fetch(`/api/imagineart/status?id=${encodeURIComponent(render.jobId as string)}`, {
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({})) as {
          status?: ImagineRenderStatus;
          videoUrl?: string | null;
          thumbnailUrl?: string | null;
          message?: string | null;
        };
        if (!response.ok) throw new Error(payload.message || "ImagineArt could not report production status.");
        if (stopped) return;

        failures = 0;
        const nextStatus = payload.status ?? "processing";
        const now = new Date().toISOString();
        setProjects((current) => current.map((item) => item.id === activeProjectId && item.render?.jobId === render.jobId ? {
          ...item,
          render: {
            ...item.render,
            status: nextStatus,
            videoUrl: payload.videoUrl ?? item.render.videoUrl,
            thumbnailUrl: payload.thumbnailUrl ?? item.render.thumbnailUrl,
            error: payload.message ?? null,
            updatedAt: now,
          },
          updatedAt: now,
        } : item));

        if (nextStatus === "completed") {
          if (render.status !== "completed") {
            notify("ImagineArt finished the cinematic film preview. It is ready to watch here.");
            window.setTimeout(() => document.querySelector("#render-status")?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
          }
          return;
        }
        if (nextStatus === "failed") {
          notify(payload.message || "ImagineArt could not complete this production.", "error");
          return;
        }
        timer = window.setTimeout(poll, 5_000);
      } catch (error) {
        if (stopped) return;
        failures += 1;
        if (failures >= 3) {
          const message = error instanceof Error ? error.message : "Production status could not be checked.";
          const now = new Date().toISOString();
          setProjects((current) => current.map((item) => item.id === activeProjectId && item.render?.jobId === render.jobId ? {
            ...item,
            render: { ...item.render, status: "failed", error: message, updatedAt: now },
            updatedAt: now,
          } : item));
          notify(`${message} You can retry from the production panel.`, "error");
          return;
        }
        timer = window.setTimeout(poll, 5_000);
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeProjectId, project.render?.jobId]);

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
    const resetsProduction = ["title", "ancestor", "script", "runtime", "providerId", "sources"].some((key) => key in patch);
    setProjects((current) => current.map((item) => item.id === activeProjectId ? {
      ...item,
      ...patch,
      greenlitAt: null,
      readinessGaps: [],
      render: resetsProduction ? null : item.render,
      updatedAt: new Date().toISOString(),
    } : item));
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
    setReadinessReview(null);
    notify("A clear development slate is ready.");
    document.querySelector("#create")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => titleRef.current?.focus(), 450);
  };

  const selectProject = (id: string) => {
    setActiveProjectId(id);
    setPlan(null);
    setReadinessReview(null);
    notify("Film opened for development.", "info");
    document.querySelector("#create")?.scrollIntoView({ behavior: "smooth" });
  };

  const clearField = (field: "title" | "ancestor" | "script", label: string) => {
    const value = project[field];
    if (!value) {
      notify(`${label} is already clear.`, "info");
      return;
    }
    if (!window.confirm(`Clear ${label.toLowerCase()}? This text will be removed from the current film.`)) return;
    updateProject({ [field]: "" });
    const target = field === "title" ? titleRef.current : field === "ancestor" ? ancestorRef.current : scriptRef.current;
    window.setTimeout(() => target?.focus(), 0);
    notify(`${label} cleared.`);
  };

  const clearDevelopmentSlate = async () => {
    if (!window.confirm("Clear every development field and remove all source files from this film? This cannot be undone.")) return;
    const results = await Promise.allSettled(project.sources.map((source) => deleteSourceFile(source.id)));
    const failed = results.filter((result) => result.status === "rejected").length;
    setProjects((current) => current.map((item) => item.id === activeProjectId ? {
      ...item,
      title: "",
      ancestor: "",
      script: "",
      runtime: "short",
      providerId: "imagineart",
      sources: [],
      greenlitAt: null,
      readinessGaps: [],
      render: null,
      updatedAt: new Date().toISOString(),
    } : item));
    setPlan(null);
    setReadinessReview(null);
    window.setTimeout(() => titleRef.current?.focus(), 0);
    notify(failed > 0 ? `Development fields cleared, but ${failed} stored source ${failed === 1 ? "file could" : "files could"} not be removed.` : "Development slate cleared.", failed > 0 ? "info" : "success");
  };

  const archiveProject = (item: FilmProject) => {
    const remaining = activeProjects.filter((candidate) => candidate.id !== item.id);
    const archivedAt = new Date().toISOString();
    if (item.id === activeProjectId && remaining.length === 0) {
      const next = blankProject();
      setProjects((current) => [next, ...current.map((candidate) => candidate.id === item.id ? { ...candidate, archivedAt } : candidate)]);
      setActiveProjectId(next.id);
      setPlan(null);
      notify(`${item.title.trim() || "Untitled family film"} archived. A clear development slate is ready.`);
      return;
    }
    setProjects((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, archivedAt } : candidate));
    if (item.id === activeProjectId) {
      setActiveProjectId(remaining[0].id);
      setPlan(null);
    }
    notify(`${item.title.trim() || "Untitled family film"} archived. You can restore it below.`);
  };

  const restoreProject = (item: FilmProject) => {
    setProjects((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, archivedAt: null, updatedAt: new Date().toISOString() } : candidate));
    setActiveProjectId(item.id);
    setPlan(null);
    notify(`${item.title.trim() || "Untitled family film"} restored to development.`);
    window.setTimeout(() => document.querySelector("#create")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  const deleteArchivedProject = async (item: FilmProject) => {
    const name = item.title.trim() || "Untitled family film";
    if (!window.confirm(`Permanently delete ${name}? Its saved details and source files cannot be recovered.`)) return;
    const results = await Promise.allSettled(item.sources.map((source) => deleteSourceFile(source.id)));
    const failed = results.filter((result) => result.status === "rejected").length;
    setProjects((current) => current.filter((candidate) => candidate.id !== item.id));
    notify(failed > 0 ? `${name} deleted, but ${failed} stored source ${failed === 1 ? "file could" : "files could"} not be removed.` : `${name} permanently deleted.`, failed > 0 ? "info" : "success");
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
    if (project.providerId === provider.id) {
      notify(`${provider.name} is already selected.`, "info");
      return;
    }
    updateProject({ providerId: provider.id });
    notify(`${provider.name} selected.`, "success");
  };

  const prepareFilmPlan = () => {
    if (project.script.trim().length < 80) {
      scriptRef.current?.focus();
      notify("Add at least 80 characters of story before creating the shooting plan.", "error");
      return;
    }
    setIsPlanning(true);
    notify("Creating a five-scene shooting plan from your script…", "info");
    window.setTimeout(() => {
      setPlan(makeFilmPlan(project));
      setIsPlanning(false);
      notify("Shooting plan created. Review it, then greenlight the film.");
      window.setTimeout(() => document.querySelector("#film-plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }, 850);
  };

  const startImagineRender = async (productionProject: FilmProject, productionPlan: FilmPlan) => {
    if (productionProject.providerId !== "imagineart") return;

    const attemptAt = new Date().toISOString();
    const baseRender: ImagineRender = {
      provider: "imagineart",
      jobId: null,
      status: "submitting",
      model: "luma-dream-machine-ray-2",
      videoUrl: null,
      thumbnailUrl: null,
      submittedAt: attemptAt,
      updatedAt: attemptAt,
      error: null,
    };

    if (productionProject.script.trim().length < 80) {
      const message = "Add at least 80 characters of script before ImagineArt production can begin.";
      setProjects((current) => current.map((item) => item.id === productionProject.id ? {
        ...item,
        render: { ...baseRender, status: "failed", error: message },
        updatedAt: attemptAt,
      } : item));
      notify(message, "error");
      return;
    }

    setProjects((current) => current.map((item) => item.id === productionProject.id ? {
      ...item,
      render: baseRender,
      updatedAt: attemptAt,
    } : item));
    notify("ImagineArt production is starting. Keep this page open to follow its progress.", "info");

    try {
      const response = await fetch("/api/imagineart/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": `${productionProject.id}:${productionProject.greenlitAt ?? attemptAt}:${attemptAt}`,
        },
        body: JSON.stringify({
          projectId: productionProject.id,
          title: productionProject.title,
          ancestor: productionProject.ancestor,
          runtime: productionProject.runtime,
          prompt: buildImaginePrompt(productionProject, productionPlan),
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        jobId?: string;
        status?: ImagineRenderStatus;
        model?: string;
        submittedAt?: string;
        message?: string;
      };
      if (!response.ok || !payload.jobId) throw new Error(payload.message || "ImagineArt did not start this production.");

      const now = new Date().toISOString();
      setProjects((current) => current.map((item) => item.id === productionProject.id ? {
        ...item,
        render: {
          ...baseRender,
          jobId: payload.jobId as string,
          status: payload.status === "processing" ? "processing" : "queued",
          model: payload.model || baseRender.model,
          submittedAt: payload.submittedAt || attemptAt,
          updatedAt: now,
        },
        updatedAt: now,
      } : item));
      notify("ImagineArt accepted the film. The cinematic preview is now rendering.");
      window.setTimeout(() => document.querySelector("#render-status")?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ImagineArt production could not begin.";
      const now = new Date().toISOString();
      setProjects((current) => current.map((item) => item.id === productionProject.id ? {
        ...item,
        render: { ...baseRender, status: "failed", error: message, updatedAt: now },
        updatedAt: now,
      } : item));
      notify(`${message} No ImagineArt page was opened.`, "error");
    }
  };

  const retryImagineRender = () => {
    const productionPlan = plan ?? makeFilmPlan(project);
    if (!plan) setPlan(productionPlan);
    void startImagineRender(project, productionPlan);
  };

  const focusReadinessGap = (gap: ReadinessGap) => {
    setReadinessReview(null);
    const targets: Record<ReadinessKey, HTMLElement | null> = {
      title: titleRef.current,
      ancestor: ancestorRef.current,
      script: scriptRef.current,
      sources: sourceButtonRef.current,
      runtime: document.querySelector("#film-length button"),
      provider: document.querySelector("#providers .provider-row"),
    };
    const target = targets[gap.key];
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => target?.focus(), 420);
    notify(`${gap.label} is ready to finish.`, "info");
  };

  const finalizeGreenlight = (gaps: ReadinessGap[]) => {
    const nextPlan = plan ?? (project.script.trim().length >= 80 ? makeFilmPlan(project) : null);
    if (nextPlan) setPlan(nextPlan);
    const greenlitAt = new Date().toISOString();
    const greenlitProject = {
      ...project,
      greenlitAt,
      readinessGaps: gaps.map((gap) => gap.label),
      updatedAt: greenlitAt,
    };
    setProjects((current) => current.map((item) => item.id === activeProjectId ? greenlitProject : item));
    setReadinessReview(null);
    notify(gaps.length > 0 ? `Film greenlit with ${gaps.length} acknowledged ${gaps.length === 1 ? "gap" : "gaps"}.` : project.providerId === "imagineart" ? "Film greenlit. ImagineArt production is beginning here." : "Film greenlit and ready for production.", gaps.length > 0 ? "info" : "success");
    if (nextPlan && project.providerId === "imagineart") void startImagineRender(greenlitProject, nextPlan);
    if (nextPlan) window.setTimeout(() => document.querySelector("#film-plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  };

  const greenlightFilm = () => {
    const gaps = getReadinessGaps(project);
    if (gaps.length > 0) {
      setReadinessReview(gaps);
      notify(`${gaps.length} production ${gaps.length === 1 ? "detail needs" : "details need"} review before greenlight.`, "info");
      return;
    }
    finalizeGreenlight([]);
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

  const isImagineArtProduction = selectedProvider.id === "imagineart";
  const render = project.render;
  const renderIsActive = render ? ["submitting", "queued", "processing"].includes(render.status) : false;
  const renderProgress = render?.status === "completed" ? 100 : render?.status === "processing" ? 68 : render?.status === "queued" ? 32 : render?.status === "submitting" ? 14 : 0;
  const renderHeading = render?.status === "completed"
    ? "Your cinematic preview is ready."
    : render?.status === "failed"
      ? "Production needs attention."
      : render?.status === "processing"
        ? "ImagineArt is rendering the film."
        : render?.status === "queued"
          ? "The film is in the production queue."
          : "Connecting the production stage.";
  const renderDetail = render?.status === "completed"
    ? "Watch the finished ImagineArt video here or download the MP4 while its delivery link is active."
    : render?.status === "failed"
      ? render.error || "ImagineArt could not complete this production. You can retry without leaving Lineage Theatre."
      : "The story and scene direction were sent securely through the Lineage Theatre production service. This page checks progress automatically.";

  const renderAction = (small = false) => {
    const className = small ? "button button-primary button-small" : "button button-primary";
    if (renderIsActive) return <button className={className} type="button" disabled>Producing in ImagineArt…</button>;
    if (render?.status === "completed") return <button className={className} type="button" onClick={() => document.querySelector("#render-status")?.scrollIntoView({ behavior: "smooth", block: "center" })}>Watch finished film ↓</button>;
    return <button className={className} type="button" onClick={retryImagineRender}>{render?.status === "failed" ? "Retry ImagineArt production →" : "Start ImagineArt production →"}</button>;
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
          <button className="button button-primary button-small" type="button" onClick={createProject}>Develop a film</button>
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
              <p className="eyebrow">Film development</p>
              <h2 id="creator-title">Shape the story while it is still fresh.</h2>
            </div>
            <div className="completion" aria-label={`${progress}% project ready`}>
              <span>{progress}% ready</span><span className="completion-track"><span style={{ width: `${progress}%` }} /></span>
            </div>
          </div>

          <div className="creator-frame">
            <div className="editor-panel">
              <div className="panel-section identity-grid">
                <div className="field-block">
                  <div className="field-label-row"><label htmlFor="film-title">Film title</label><button type="button" onClick={() => clearField("title", "Film title")}>Clear</button></div>
                  <input id="film-title" ref={titleRef} value={project.title} placeholder="Name this film" onChange={(event) => updateProject({ title: event.target.value })} />
                </div>
                <div className="field-block">
                  <div className="field-label-row"><label htmlFor="ancestor-name">Ancestor’s name</label><button type="button" onClick={() => clearField("ancestor", "Ancestor's name")}>Clear</button></div>
                  <input id="ancestor-name" ref={ancestorRef} value={project.ancestor} placeholder="Who is this story about?" onChange={(event) => updateProject({ ancestor: event.target.value })} />
                </div>
              </div>
              <div className="panel-section script-section">
                <div className="field-heading"><label htmlFor="script">Script or family story</label><div className="field-heading-actions"><span>{wordCount} words · about {readMinutes} min narration</span><button type="button" onClick={() => clearField("script", "Script")}>Clear</button></div></div>
                <textarea id="script" ref={scriptRef} value={project.script} placeholder="Begin with the moment that changed your ancestor’s life…" onChange={(event) => updateProject({ script: event.target.value })} />
                <p className="field-help">Tip: dates, places, letters, and sensory details make stronger scenes. Mark family lore as family lore.</p>
              </div>
              <div className="panel-section" id="film-length">
                <div className="field-heading"><span>Film length</span><span>Choose a target, not a hard limit</span></div>
                <div className="runtime-grid">
                  {runtimeOptions.map((option) => (
                    <button className={project.runtime === option.value ? "choice-card selected" : "choice-card"} type="button" key={option.value} aria-pressed={project.runtime === option.value} onClick={() => {
                      if (project.runtime === option.value) {
                        notify(`${option.label} is already selected.`, "info");
                        return;
                      }
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
              <button ref={sourceButtonRef} className="drop-zone" type="button" onClick={() => fileInputRef.current?.click()}>
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
              ) : <div className="empty-sources"><span aria-hidden="true">◎</span><p>No sources attached yet.</p><small>You can still create a shooting plan, then return to add evidence.</small></div>}
              <div className="privacy-note"><span aria-hidden="true">◌</span><p><span>Local for now</span><small>Supabase sync can be added after production data and access rules are approved.</small></p></div>
            </aside>
          </div>
          <div className="development-controls">
            <div><span>Production decision</span><p>{isImagineArtProduction ? "Greenlight securely sends the approved story and scene direction to ImagineArt, uses the connected API balance, and keeps the production experience on this page." : "Greenlight confirms the development package is ready to move into production with the selected studio."}</p></div>
            <button className="button button-secondary" type="button" onClick={() => void clearDevelopmentSlate()}>Clear development slate</button>
            <button className="button button-primary" type="button" disabled={Boolean(project.greenlitAt)} onClick={greenlightFilm}>{project.greenlitAt ? `${getProjectStatus(project)} ✓` : isImagineArtProduction ? "Greenlight & produce →" : "Greenlight film →"}</button>
          </div>
        </section>

        <section className="providers-section" id="providers" aria-labelledby="providers-title">
          <div className="page-width">
            <div className="section-heading-row provider-heading">
              <div><p className="eyebrow">Choose the video studio</p><h2 id="providers-title">Use the right engine for this film.</h2><p>ImagineArt can produce a cinematic preview directly inside Lineage Theatre. Other studios still use a provider-ready production package.</p></div>
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
              <div><p className="eyebrow">Shooting plan ready</p><h2 id="plan-title">Review the production blueprint.</h2><p>{plan.logline}</p></div>
              <span className="success-chip"><span aria-hidden="true">✓</span> {project.greenlitAt ? getProjectStatus(project) : "Ready for greenlight"}</span>
            </div>
            <div className="scene-grid">
              {plan.scenes.map((scene, index) => <article className="scene-card" key={scene.title}><span>Scene {String(index + 1).padStart(2, "0")}</span><h3>{scene.title}</h3><p>{scene.direction}</p><blockquote>{scene.narration}</blockquote></article>)}
            </div>
            {render ? (
              <section className={`render-panel ${render.status}`} id="render-status" aria-labelledby="render-title" aria-live="polite">
                <div className="render-copy">
                  <p className="panel-kicker">ImagineArt production</p>
                  <h3 id="render-title">{renderHeading}</h3>
                  <p>{renderDetail}</p>
                  <div className="render-meter" role="progressbar" aria-label="ImagineArt production progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={renderProgress}>
                    <span style={{ width: `${renderProgress}%` }} />
                  </div>
                  <div className="render-meta"><span>{render.status === "completed" ? "Finished" : render.status === "failed" ? "Action needed" : `${renderProgress}% production stage`}</span><span>Luma Ray 2 · 16:9</span></div>
                  {render.status === "failed" ? <div className="render-inline-action">{renderAction(true)}</div> : null}
                </div>
                <div className="render-screen">
                  {render.status === "completed" && render.videoUrl ? (
                    <video controls playsInline preload="metadata" poster={render.thumbnailUrl ?? undefined} src={render.videoUrl}>Your browser does not support video playback.</video>
                  ) : (
                    <div className="render-placeholder" aria-hidden="true"><span>{render.status === "failed" ? "!" : "▶"}</span><small>{render.status === "failed" ? "Production paused" : "Film rendering"}</small></div>
                  )}
                </div>
                {render.status === "completed" && render.videoUrl ? <a className="button button-secondary button-small render-download" href={render.videoUrl} download={`${project.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lineage-film"}-imagineart.mp4`}>Download MP4 ↓</a> : null}
              </section>
            ) : null}
            <div className="plan-actions">
              <button className="button button-secondary" type="button" onClick={() => void copyBrief()}>Copy provider brief</button>
              <button className="button button-secondary" type="button" onClick={downloadPackage}>Download project package ↓</button>
              {!project.greenlitAt ? <button className="button button-primary" type="button" onClick={greenlightFilm}>{isImagineArtProduction ? "Greenlight & produce →" : "Greenlight film →"}</button> : isImagineArtProduction ? renderAction() : selectedProvider.website ? <a className="button button-primary" href={selectedProvider.website} target="_blank" rel="noopener noreferrer" onClick={prepareStudioHandoff}>Send to {selectedProvider.name} ↗</a> : <button className="button button-primary" type="button" onClick={downloadPackage}>Download Lineage plan ↓</button>}
            </div>
          </section>
        ) : null}

        <section className="projects-section page-width" id="projects" aria-labelledby="projects-title">
          <div className="section-heading-row">
            <div><p className="eyebrow">Your films</p><h2 id="projects-title">Return to a family story.</h2></div>
            <button className="button button-secondary button-small" type="button" onClick={createProject}>+ Develop a film</button>
          </div>
          <div className="project-grid">
            {activeProjects.map((item) => (
              <article className={item.id === project.id ? "project-card current" : "project-card"} key={item.id}>
                <button className="project-open" type="button" onClick={() => selectProject(item.id)}>
                  <span className="project-thumb"><img src="/assets/ancestor-shipyard-still.png" alt="" /></span>
                  <span className="project-meta"><span>{item.title.trim() || "Untitled family film"}</span><small>{item.ancestor || "Ancestor not named"} · {runtimeOptions.find((option) => option.value === item.runtime)?.label}</small><small><span className="project-status">{getProjectStatus(item)}</span> · Updated {new Date(item.updatedAt).toLocaleDateString()}</small></span>
                  <span className="project-arrow" aria-hidden="true">→</span>
                </button>
                <button className="project-archive" type="button" onClick={() => archiveProject(item)}>Archive</button>
              </article>
            ))}
          </div>
          {archivedProjects.length > 0 ? (
            <section className="archive-library" aria-labelledby="archive-title">
              <div className="archive-heading"><div><span>Archive</span><h3 id="archive-title">Archived films</h3></div><span>{archivedProjects.length}</span></div>
              <div className="archive-list">
                {archivedProjects.map((item) => (
                  <article className="archive-card" key={item.id}>
                    <div><span>{item.title.trim() || "Untitled family film"}</span><small>{item.ancestor || "Ancestor not named"} · Archived {new Date(item.archivedAt as string).toLocaleDateString()}</small></div>
                    <div><button className="button button-secondary button-small" type="button" onClick={() => restoreProject(item)}>Restore</button><button className="button button-danger button-small" type="button" onClick={() => void deleteArchivedProject(item)}>Delete permanently</button></div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </section>
      </main>

      <footer className="site-footer" data-build-commit={__BUILD_COMMIT__}>
        <div className="page-width"><div><span className="footer-mark">LT</span><p><span>Lineage Theatre</span><small>Make family history feel close again.</small></p></div><p>GitHub source · Vercel hosting · Namecheap DNS today · Supabase-ready data path · Build {__BUILD_COMMIT__.slice(0, 7)}</p></div>
      </footer>

      {showActionDock ? (
        <div className="action-dock" aria-label="Current film action">
          <div><span>Next production step</span><p>{project.greenlitAt && isImagineArtProduction ? render?.status === "completed" ? "Watch the finished cinematic preview" : render?.status === "failed" ? "Retry ImagineArt production" : "ImagineArt is producing the film here" : project.greenlitAt ? `Send the greenlit film to ${selectedProvider.name}` : plan ? "Review and greenlight the shooting plan" : `Create the ${runtime.label.toLowerCase()} shooting plan`}</p></div>
          {project.greenlitAt && isImagineArtProduction ? renderAction() : project.greenlitAt && selectedProvider.website ? <a className="button button-primary" href={selectedProvider.website} target="_blank" rel="noopener noreferrer" onClick={prepareStudioHandoff}>Send to {selectedProvider.name} ↗</a> : project.greenlitAt ? <button className="button button-primary" type="button" onClick={downloadPackage}>Download production package ↓</button> : plan ? <button className="button button-primary" type="button" onClick={greenlightFilm}>{isImagineArtProduction ? "Greenlight & produce →" : "Greenlight film →"}</button> : <button className="button button-primary" type="button" disabled={isPlanning} onClick={prepareFilmPlan}>{isPlanning ? "Creating shooting plan…" : "Create shooting plan →"}</button>}
        </div>
      ) : null}

      {readinessReview ? (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReadinessReview(null); }}>
          <section className="readiness-dialog" ref={readinessDialogRef} role="dialog" aria-modal="true" aria-labelledby="readiness-title" aria-describedby="readiness-description" tabIndex={-1}>
            <div className="dialog-heading"><div><span>Production readiness review</span><h2 id="readiness-title">Finish the details—or greenlight with gaps.</h2></div><button type="button" aria-label="Close production readiness review" onClick={() => setReadinessReview(null)}>×</button></div>
            <p id="readiness-description">The following fields are not complete. You can return directly to any field, or acknowledge the gaps and continue.</p>
            <ul className="readiness-list">
              {readinessReview.map((gap) => <li key={gap.key}><div><span>{gap.label}</span><p>{gap.detail}</p></div><button className="button button-secondary button-small" type="button" onClick={() => focusReadinessGap(gap)}>Finish field</button></li>)}
            </ul>
            <div className="dialog-actions"><button className="button button-secondary" type="button" onClick={() => setReadinessReview(null)}>Return to development</button><button className="button button-primary" type="button" onClick={() => finalizeGreenlight(readinessReview)}>Greenlight with gaps</button></div>
          </section>
        </div>
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`} key={toast.id} role={toast.tone === "error" ? "alert" : "status"}><span aria-hidden="true">{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span><p>{toast.message}</p><button type="button" aria-label="Dismiss message" onClick={() => setToast(null)}>×</button></div> : null}
    </div>
  );
}

export default App;
