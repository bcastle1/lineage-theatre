import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  CreditCard,
  Download,
  Eye,
  FileText,
  Film,
  Image as ImageIcon,
  Library,
  LockKeyhole,
  Mail,
  Mic2,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UploadCloud,
  UserRound,
  UsersRound,
  WandSparkles,
  X,
  Youtube,
} from "lucide-react";
import type {
  AdminSettings,
  AppState,
  CharacterSuggestion,
  CustomerProfile,
  MoviePreferences,
  MovieProject,
  ProjectStatus,
  RuntimeId,
  SourceAsset,
  ViewId,
} from "./types";
import {
  ADMIN_ACCESS_CODE,
  ADMIN_EMAIL,
  MAX_SOURCE_FILE_SIZE_BYTES,
  PUBLIC_LAUNCH_MODE,
  SITE_DOMAIN,
  createId,
  formatCurrency,
  formatFileSize,
  inferSourceKind,
  isAllowedSourceFile,
  musicMoods,
  nowIso,
  runtimeOptions,
  sourceKindLabels,
} from "./lib/runtime";
import { buildStoryRecommendation, estimateProjectFee, runtimeLabel, statusCopy } from "./lib/storyEngine";
import { deleteSourceFile, getSourceObjectUrl, loadState, resetState, saveSourceFile, saveState } from "./lib/storage";
import { localEmailAdapter, localPublishAdapter, venmoLocalAdapter } from "./services/productionAdapters";

const trailerStill = "/assets/ancestor-shipyard-still.png";
const trailerPreviewSeconds = 24;

type ProjectUpdater = (project: MovieProject) => MovieProject;

function makeBlankProject(customerId: string): MovieProject {
  const id = createId("project");
  const project: MovieProject = {
    id,
    customerId,
    title: "Untitled Ancestor Film",
    ancestor: {
      name: "",
      birthDate: "",
      birthPlace: "",
      deathDate: "",
      homeland: "",
      height: "",
      build: "",
      knownRelatives: "",
      values: "",
      definingTraits: "",
      lifeSummary: "",
    },
    sources: [],
    preferences: {
      style: "Cinematic",
      rating: "G",
      runtime: "trailer",
      realism: 90,
      historicalFidelity: 85,
      heroTone: 92,
      publishToYoutube: false,
      publishToFamilyGallery: false,
      sendEmailLink: true,
      allowPublicDiscovery: false,
    },
    story: {
      logline: "",
      plot: "",
      climax: "",
      emotionalPromise: "",
      scenes: [],
      characters: [],
      musicDirection: "",
      contentNotes: [],
      generatedAt: nowIso(),
    },
    payment: {
      id: createId("payment"),
      amount: 0,
      required: false,
      status: "not-required",
      venmoHandle: "@ERik-Castle-1",
      receiptEmailStatus: "not-sent",
      receiptNumber: `LT-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000 + 1000)}`,
      updatedAt: nowIso(),
    },
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    adminNote: "",
    downloadUrl: "",
    youtubeUrl: "",
  };
  return { ...project, story: buildStoryRecommendation(project) };
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminSection, setAdminSection] = useState("Approval Queue");
  const [uploadNotice, setUploadNotice] = useState("");

  useEffect(() => {
    saveState(state);
  }, [state]);

  const activeProject = useMemo(
    () => state.projects.find((project) => project.id === state.activeProjectId) ?? state.projects[0],
    [state.activeProjectId, state.projects]
  );

  const activeCustomer = useMemo(
    () => state.customers.find((customer) => customer.id === activeProject?.customerId) ?? state.customers[0],
    [activeProject?.customerId, state.customers]
  );

  const setActiveView = useCallback((view: ViewId) => {
    setState((previous) => ({ ...previous, activeView: view }));
  }, []);

  const updateProject = useCallback((projectId: string, updater: ProjectUpdater) => {
    setState((previous) => ({
      ...previous,
      projects: previous.projects.map((project) =>
        project.id === projectId ? { ...updater(project), updatedAt: nowIso() } : project
      ),
    }));
  }, []);

  const updateActiveProject = useCallback(
    (updater: ProjectUpdater) => {
      if (!activeProject) return;
      updateProject(activeProject.id, updater);
    },
    [activeProject, updateProject]
  );

  const updateCustomer = useCallback((customerId: string, patch: Partial<CustomerProfile>) => {
    setState((previous) => ({
      ...previous,
      customers: previous.customers.map((customer) =>
        customer.id === customerId ? { ...customer, ...patch } : customer
      ),
    }));
  }, []);

  const updateAdminSettings = useCallback((patch: Partial<AdminSettings>) => {
    setState((previous) => ({
      ...previous,
      adminSettings: { ...previous.adminSettings, ...patch },
    }));
  }, []);

  const createProject = useCallback(() => {
    const customerId = activeCustomer?.id ?? createId("customer");
    const project = makeBlankProject(customerId);
    setState((previous) => ({
      ...previous,
      projects: [project, ...previous.projects],
      activeProjectId: project.id,
      activeView: "creator",
    }));
  }, [activeCustomer?.id]);

  const selectProject = useCallback((projectId: string) => {
    setState((previous) => ({ ...previous, activeProjectId: projectId }));
  }, []);

  const addFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || !activeProject) return;
      const sourceFiles = Array.from(files);
      const sources: SourceAsset[] = [];
      const skipped: string[] = [];

      for (const file of sourceFiles) {
        if (!isAllowedSourceFile(file)) {
          skipped.push(file.name);
          continue;
        }
        const id = createId("source");
        await saveSourceFile(id, activeProject.id, file);
        sources.push({
          id,
          projectId: activeProject.id,
          name: file.name,
          kind: inferSourceKind(file),
          type: file.type || "application/octet-stream",
          size: file.size,
          addedAt: nowIso(),
          notes: "",
        });
      }

      if (skipped.length > 0) {
        setUploadNotice(
          `${skipped.length} file(s) were skipped. Use common image, audio, video, PDF, document, JSON, or text files under ${Math.round(
            MAX_SOURCE_FILE_SIZE_BYTES / 1024 / 1024
          )} MB each.`
        );
      } else {
        setUploadNotice("");
      }

      if (sources.length === 0) return;

      updateActiveProject((project) => {
        const merged: MovieProject = {
          ...project,
          sources: [...sources, ...project.sources],
        };
        return { ...merged, story: buildStoryRecommendation(merged) };
      });
    },
    [activeProject, updateActiveProject]
  );

  const removeSource = useCallback(
    async (sourceId: string) => {
      await deleteSourceFile(sourceId);
      updateActiveProject((project) => {
        const merged = {
          ...project,
          sources: project.sources.filter((source) => source.id !== sourceId),
        };
        return { ...merged, story: buildStoryRecommendation(merged) };
      });
    },
    [updateActiveProject]
  );

  const regenerateStory = useCallback(() => {
    updateActiveProject((project) => ({ ...project, story: buildStoryRecommendation(project) }));
  }, [updateActiveProject]);

  const generateTrailer = useCallback(() => {
    updateActiveProject((project) => {
      const story = buildStoryRecommendation(project);
      return {
        ...project,
        story,
        status: "trailer-ready",
        payment: {
          ...project.payment,
          required: false,
          amount: 0,
          status: "not-required",
          updatedAt: nowIso(),
        },
      };
    });
  }, [updateActiveProject]);

  const requestFullMovie = useCallback(() => {
    updateActiveProject((project) => {
      const story = buildStoryRecommendation(project);
      const amount = estimateProjectFee(project, state.adminSettings);
      const nextStatus: ProjectStatus =
        amount > 0 ? "payment-pending" : state.adminSettings.requireApproval ? "in-review" : "full-movie-ready";
      return {
        ...project,
        story,
        status: nextStatus,
        payment: {
          ...project.payment,
          amount,
          required: amount > 0,
          status: amount > 0 ? "awaiting-venmo" : "not-required",
          venmoHandle: state.adminSettings.venmoHandle,
          updatedAt: nowIso(),
        },
      };
    });
  }, [state.adminSettings, updateActiveProject]);

  const reportPayment = useCallback(async () => {
    if (!activeProject || !activeCustomer) return;
    const email = await localEmailAdapter.sendReceipt(activeProject, activeCustomer.email);
    setState((previous) => ({
      ...previous,
      outbox: [email, ...previous.outbox],
      projects: previous.projects.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              status: previous.adminSettings.requireApproval ? "in-review" : "full-movie-ready",
              payment: {
                ...project.payment,
                status: "reported-paid",
                receiptEmailStatus: "queued",
                updatedAt: nowIso(),
              },
              updatedAt: nowIso(),
            }
          : project
      ),
    }));
  }, [activeCustomer, activeProject]);

  const adminUpdateProjectStatus = useCallback(
    (projectId: string, status: ProjectStatus, adminNote?: string) => {
      updateProject(projectId, (project) => ({
        ...project,
        status,
        adminNote: adminNote ?? project.adminNote,
      }));
    },
    [updateProject]
  );

  const markPaymentVerified = useCallback(
    (projectId: string) => {
      updateProject(projectId, (project) => ({
        ...project,
        status: state.adminSettings.requireApproval ? "in-review" : "full-movie-ready",
        payment: {
          ...project.payment,
          status: "verified",
          receiptEmailStatus: "sent",
          updatedAt: nowIso(),
        },
      }));
    },
    [state.adminSettings.requireApproval, updateProject]
  );

  const publishProject = useCallback(async () => {
    if (!activeProject) return;
    const result = await localPublishAdapter.publish(activeProject);
    updateActiveProject((project) => ({
      ...project,
      status: "published",
      youtubeUrl: result.youtubeUrl ?? project.youtubeUrl,
      downloadUrl: result.familyGalleryUrl ?? project.downloadUrl,
    }));
  }, [activeProject, updateActiveProject]);

  const resetLocalDemo = useCallback(() => {
    setState(resetState());
    setAdminUnlocked(false);
  }, []);

  if (!activeProject || !activeCustomer) {
    return (
      <div className="empty-boot">
        <p>Lineage Theatre could not load a project.</p>
        <button onClick={resetLocalDemo}>Restore demo state</button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopNav activeView={state.activeView} onViewChange={setActiveView} adminUnlocked={adminUnlocked} />
      <main>
        {state.activeView === "creator" && (
          <CreatorWorkspace
            state={state}
            project={activeProject}
            customer={activeCustomer}
            onCreateProject={createProject}
            onSelectProject={selectProject}
            onUpdateProject={updateActiveProject}
            onUpdateCustomer={updateCustomer}
            onAddFiles={addFiles}
            onRemoveSource={removeSource}
            uploadNotice={uploadNotice}
            onRegenerateStory={regenerateStory}
            onGenerateTrailer={generateTrailer}
            onRequestFullMovie={requestFullMovie}
            onReportPayment={reportPayment}
          />
        )}
        {state.activeView === "library" && (
          <LibraryView
            projects={state.projects}
            customers={state.customers}
            onSelectProject={(id) => {
              selectProject(id);
              setActiveView("creator");
            }}
          />
        )}
        {state.activeView === "admin" && (
          <AdminConsole
            state={state}
            adminUnlocked={adminUnlocked}
            adminSection={adminSection}
            onUnlock={setAdminUnlocked}
            onSectionChange={setAdminSection}
            onUpdateSettings={updateAdminSettings}
            onProjectStatus={adminUpdateProjectStatus}
            onMarkPaymentVerified={markPaymentVerified}
            onResetLocalDemo={resetLocalDemo}
          />
        )}
        {state.activeView === "publish" && (
          <PublishPanel
            project={activeProject}
            customer={activeCustomer}
            settings={state.adminSettings}
            onUpdateProject={updateActiveProject}
            onRequestFullMovie={requestFullMovie}
            onReportPayment={reportPayment}
            onPublish={publishProject}
          />
        )}
      </main>
    </div>
  );
}

function TopNav({
  activeView,
  onViewChange,
  adminUnlocked,
}: {
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
  adminUnlocked: boolean;
}) {
  const nav = [
    { id: "creator" as const, label: "Creator", icon: Film },
    { id: "library" as const, label: "Library", icon: Library },
    { id: "admin" as const, label: "Admin", icon: ShieldCheck },
    { id: "publish" as const, label: "Publish", icon: Send },
  ];

  return (
    <header className="top-nav">
      <button className="brand-mark" onClick={() => onViewChange("creator")} aria-label="Open Creator">
        <span className="brand-glyph">LT</span>
        <span>
          <strong>Lineage Theatre</strong>
          <small>Local-first ancestor movie studio</small>
        </span>
      </button>
      <nav aria-label="Primary navigation">
        {nav.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={activeView === item.id ? "nav-item active" : "nav-item"}
              onClick={() => onViewChange(item.id)}
            >
              <Icon size={18} />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="nav-status">
        <span className="local-dot" />
        <span>Local-first</span>
        <span>{SITE_DOMAIN}</span>
        {adminUnlocked ? <ShieldCheck size={17} /> : <LockKeyhole size={17} />}
      </div>
    </header>
  );
}

function CreatorWorkspace({
  state,
  project,
  customer,
  onCreateProject,
  onSelectProject,
  onUpdateProject,
  onUpdateCustomer,
  onAddFiles,
  onRemoveSource,
  uploadNotice,
  onRegenerateStory,
  onGenerateTrailer,
  onRequestFullMovie,
  onReportPayment,
}: {
  state: AppState;
  project: MovieProject;
  customer: CustomerProfile;
  onCreateProject: () => void;
  onSelectProject: (projectId: string) => void;
  onUpdateProject: (updater: ProjectUpdater) => void;
  onUpdateCustomer: (customerId: string, patch: Partial<CustomerProfile>) => void;
  onAddFiles: (files: FileList | null) => void;
  onRemoveSource: (sourceId: string) => void;
  uploadNotice: string;
  onRegenerateStory: () => void;
  onGenerateTrailer: () => void;
  onRequestFullMovie: () => void;
  onReportPayment: () => void;
}) {
  const fee = estimateProjectFee(project, state.adminSettings);
  const sourceCounts = useMemo(() => {
    return project.sources.reduce<Record<string, number>>((acc, source) => {
      acc[source.kind] = (acc[source.kind] ?? 0) + 1;
      return acc;
    }, {});
  }, [project.sources]);

  return (
    <section className="creator-layout">
      <aside className="project-rail">
        <div className="rail-head">
          <div>
            <h2>Projects</h2>
            <p>{state.projects.length} local records</p>
          </div>
          <button className="icon-button" onClick={onCreateProject} aria-label="Create project">
            <Plus size={18} />
          </button>
        </div>
        <div className="project-list">
          {state.projects.map((item) => (
            <button
              key={item.id}
              className={item.id === project.id ? "project-row active" : "project-row"}
              onClick={() => onSelectProject(item.id)}
            >
              <span>{item.title}</span>
              <small>{statusCopy(item.status)}</small>
            </button>
          ))}
        </div>
        <CustomerRegistration customer={customer} onUpdateCustomer={onUpdateCustomer} />
      </aside>

      <section className="studio-surface">
        <div className="studio-heading">
          <div>
            <h1>Ancestor Movie Studio</h1>
            <p>
              Build a family-safe film from records, photos, audio, dates, and lived memory.
            </p>
          </div>
          <StatusBadge status={project.status} />
        </div>

        <div className="studio-grid">
          <div className="main-column">
            <AncestorPanel project={project} onUpdateProject={onUpdateProject} />
            <SourceVault
              project={project}
              sourceCounts={sourceCounts}
              onAddFiles={onAddFiles}
              onRemoveSource={onRemoveSource}
              uploadNotice={uploadNotice}
            />
            <StoryTimeline project={project} />
          </div>

          <aside className="inspector-column">
            <TrailerPreview project={project} />
            <StoryEnginePanel
              project={project}
              fee={fee}
              settings={state.adminSettings}
              onUpdateProject={onUpdateProject}
              onRegenerateStory={onRegenerateStory}
              onGenerateTrailer={onGenerateTrailer}
              onRequestFullMovie={onRequestFullMovie}
              onReportPayment={onReportPayment}
            />
            <CharacterPanel project={project} onUpdateProject={onUpdateProject} />
          </aside>
        </div>
      </section>
    </section>
  );
}

function CustomerRegistration({
  customer,
  onUpdateCustomer,
}: {
  customer: CustomerProfile;
  onUpdateCustomer: (customerId: string, patch: Partial<CustomerProfile>) => void;
}) {
  return (
    <section className="registration-panel">
      <h3>Customer Record</h3>
      <div className="compact-grid">
        <TextInput
          label="First name"
          value={customer.firstName}
          onChange={(firstName) => onUpdateCustomer(customer.id, { firstName })}
        />
        <TextInput
          label="Last name"
          value={customer.lastName}
          onChange={(lastName) => onUpdateCustomer(customer.id, { lastName })}
        />
        <TextInput
          label="Age"
          value={customer.age}
          onChange={(age) => onUpdateCustomer(customer.id, { age })}
        />
        <TextInput
          label="Email"
          value={customer.email}
          onChange={(email) => onUpdateCustomer(customer.id, { email })}
        />
      </div>
      <TextInput
        label="Address"
        value={customer.address}
        onChange={(address) => onUpdateCustomer(customer.id, { address })}
      />
      <label className="check-row">
        <input
          type="checkbox"
          checked={customer.consent}
          onChange={(event) => onUpdateCustomer(customer.id, { consent: event.target.checked })}
        />
        <span>Customer confirms rights to uploaded family material</span>
      </label>
    </section>
  );
}

function AncestorPanel({
  project,
  onUpdateProject,
}: {
  project: MovieProject;
  onUpdateProject: (updater: ProjectUpdater) => void;
}) {
  const updateAncestor = (field: keyof MovieProject["ancestor"], value: string) => {
    onUpdateProject((current) => ({
      ...current,
      ancestor: { ...current.ancestor, [field]: value },
      title:
        field === "name" && current.title === "Untitled Ancestor Film"
          ? `${value || "Ancestor"}: A Lineage Film`
          : current.title,
    }));
  };

  return (
    <section className="panel ancestor-panel">
      <div className="section-title">
        <UserRound size={20} />
        <div>
          <h2>Ancestor Profile</h2>
          <p>Best-light portrayal anchored to sourced family evidence.</p>
        </div>
      </div>
      <div className="field-grid three">
        <TextInput label="Movie title" value={project.title} onChange={(title) => onUpdateProject((p) => ({ ...p, title }))} />
        <TextInput label="Ancestor name" value={project.ancestor.name} onChange={(value) => updateAncestor("name", value)} />
        <TextInput label="Homeland / migration" value={project.ancestor.homeland} onChange={(value) => updateAncestor("homeland", value)} />
      </div>
      <div className="field-grid four">
        <TextInput label="Birth date" type="date" value={project.ancestor.birthDate} onChange={(value) => updateAncestor("birthDate", value)} />
        <TextInput label="Birth place" value={project.ancestor.birthPlace} onChange={(value) => updateAncestor("birthPlace", value)} />
        <TextInput label="Death date" type="date" value={project.ancestor.deathDate} onChange={(value) => updateAncestor("deathDate", value)} />
        <TextInput label="Known relatives" value={project.ancestor.knownRelatives} onChange={(value) => updateAncestor("knownRelatives", value)} />
      </div>
      <div className="field-grid two">
        <TextInput label="Height" value={project.ancestor.height} onChange={(value) => updateAncestor("height", value)} />
        <TextInput label="Build / presence" value={project.ancestor.build} onChange={(value) => updateAncestor("build", value)} />
      </div>
      <div className="field-grid two">
        <TextArea label="Values" value={project.ancestor.values} onChange={(value) => updateAncestor("values", value)} />
        <TextArea label="Defining traits" value={project.ancestor.definingTraits} onChange={(value) => updateAncestor("definingTraits", value)} />
      </div>
      <TextArea
        label="Written stories and life summary"
        value={project.ancestor.lifeSummary}
        onChange={(value) => updateAncestor("lifeSummary", value)}
        tall
      />
    </section>
  );
}

function SourceVault({
  project,
  sourceCounts,
  onAddFiles,
  onRemoveSource,
  uploadNotice,
}: {
  project: MovieProject;
  sourceCounts: Record<string, number>;
  onAddFiles: (files: FileList | null) => void;
  onRemoveSource: (sourceId: string) => void;
  uploadNotice: string;
}) {
  const sourceUrls = useSourceUrls(project.sources);

  return (
    <section className="panel source-panel">
      <div className="section-title">
        <UploadCloud size={20} />
        <div>
          <h2>Source Vault</h2>
          <p>Photos, audio, stories, records, video, dates, and research notes stay in this browser first.</p>
        </div>
      </div>
      <div className="public-safety-note">
        <AlertCircle size={18} />
        <span>
          Public preview: source files stay in this browser. Do not upload sensitive real records until production
          authentication and encrypted storage are connected.
        </span>
      </div>
      <label className="drop-zone">
        <UploadCloud size={28} />
        <span>Upload ancestor sources</span>
        <small>Images, audio, video, PDFs, text, and scanned documents</small>
        <input
          type="file"
          multiple
          accept="image/*,audio/*,video/*,.pdf,.txt,.json,.doc,.docx"
          onChange={(event) => onAddFiles(event.target.files)}
        />
      </label>
      {uploadNotice ? <div className="upload-notice">{uploadNotice}</div> : null}
      <div className="source-stats">
        {Object.entries(sourceKindLabels).map(([kind, label]) => (
          <span key={kind}>
            {label}: <strong>{sourceCounts[kind] ?? 0}</strong>
          </span>
        ))}
      </div>
      <div className="source-list">
        {project.sources.map((source, index) => (
          <article className="source-row" key={source.id}>
            <SourceIcon source={source} imageUrl={sourceUrls[source.id] ?? (index === 0 ? trailerStill : "")} />
            <div>
              <strong>{source.name}</strong>
              <small>
                {sourceKindLabels[source.kind]} · {formatFileSize(source.size)}
              </small>
            </div>
            <button className="icon-button subtle" onClick={() => onRemoveSource(source.id)} aria-label={`Remove ${source.name}`}>
              <Trash2 size={16} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function SourceIcon({ source, imageUrl }: { source: SourceAsset; imageUrl: string }) {
  if (source.kind === "photo" && imageUrl) {
    return <img className="source-thumb" src={imageUrl} alt="" />;
  }
  const icons = {
    photo: ImageIcon,
    audio: Mic2,
    document: FileText,
    video: Film,
    date: CalendarDays,
    story: FileText,
    record: Library,
  };
  const Icon = icons[source.kind];
  return (
    <span className="source-icon">
      <Icon size={18} />
    </span>
  );
}

function useSourceUrls(sources: SourceAsset[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const ids = sources.map((source) => source.id).join("|");

  useEffect(() => {
    let alive = true;
    const objectUrls: string[] = [];

    Promise.all(
      sources
        .filter((source) => source.kind === "photo")
        .map(async (source) => {
          const url = await getSourceObjectUrl(source.id);
          if (url) objectUrls.push(url);
          return [source.id, url] as const;
        })
    ).then((entries) => {
      if (!alive) return;
      setUrls(
        entries.reduce<Record<string, string>>((acc, [id, url]) => {
          if (url) acc[id] = url;
          return acc;
        }, {})
      );
    });

    return () => {
      alive = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [ids, sources]);

  return urls;
}

function StoryTimeline({ project }: { project: MovieProject }) {
  return (
    <section className="panel timeline-panel">
      <div className="section-title">
        <Film size={20} />
        <div>
          <h2>Storyboard Timeline</h2>
          <p>Scene beats generated from the current sources and runtime.</p>
        </div>
      </div>
      <div className="filmstrip">
        {project.story.scenes.map((scene, index) => (
          <article key={scene.id} className="scene-card">
            <span className="scene-number">{String(index + 1).padStart(2, "0")}</span>
            <h3>{scene.title}</h3>
            <small>{scene.timecode}</small>
            <p>{scene.purpose}</p>
            <em>{scene.music}</em>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatPreviewTime(seconds: number) {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function buildTrailerPreviewBeats(project: MovieProject) {
  const sourceScenes = project.story.scenes.slice(0, 3).map((scene) => ({
    title: scene.title,
    subtitle: scene.purpose,
    caption: scene.music,
  }));

  return [
    {
      title: project.ancestor.name || project.title,
      subtitle: project.story.logline || "A life rebuilt from family memory.",
      caption: "Opening title",
    },
    ...sourceScenes,
    {
      title: "The moment that carries forward",
      subtitle: project.story.climax || project.story.emotionalPromise,
      caption: "Climax and legacy",
    },
  ];
}

function TrailerPreview({ project }: { project: MovieProject }) {
  const beats = useMemo(() => buildTrailerPreviewBeats(project), [project]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const beatDuration = trailerPreviewSeconds / beats.length;
  const activeBeatIndex = Math.min(beats.length - 1, Math.floor(elapsed / beatDuration));
  const activeBeat = beats[activeBeatIndex];
  const progress = Math.min(100, (elapsed / trailerPreviewSeconds) * 100);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      setElapsed((current) => {
        const next = current + 0.1;
        if (next >= trailerPreviewSeconds) {
          setIsPlaying(false);
          return trailerPreviewSeconds;
        }
        return next;
      });
    }, 100);

    return () => window.clearInterval(timer);
  }, [isPlaying]);

  const togglePlayback = () => {
    setIsPlaying((currentlyPlaying) => {
      if (currentlyPlaying) return false;
      if (elapsed >= trailerPreviewSeconds) setElapsed(0);
      return true;
    });
  };

  return (
    <section className={isPlaying ? "preview-panel is-playing" : "preview-panel"}>
      <div className="preview-frame trailer-player">
        <img className="trailer-still" src={trailerStill} alt="Cinematic historical ancestor preview" />
        <div className="trailer-grain" aria-hidden="true" />
        <div className="preview-overlay">
          <span className="true-story-chip">Based on a true story</span>
          <div className="trailer-scene" key={activeBeatIndex}>
            <small>
              Scene {activeBeatIndex + 1} / {beats.length}
            </small>
            <strong>{activeBeat.title}</strong>
            <p>{activeBeat.subtitle}</p>
            <em>{activeBeat.caption}</em>
          </div>
          <button className="play-button" onClick={togglePlayback} aria-label={isPlaying ? "Pause trailer preview" : "Play trailer preview"}>
            {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
          </button>
        </div>
      </div>
      <div className="trailer-progress" role="progressbar" aria-valuemin={0} aria-valuemax={trailerPreviewSeconds} aria-valuenow={Math.round(elapsed)}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="preview-controls">
        <button className="preview-control-button" onClick={togglePlayback}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          {isPlaying ? "Pause" : elapsed >= trailerPreviewSeconds ? "Replay" : "Play"}
        </button>
        <span>
          <Clock3 size={16} />
          {formatPreviewTime(elapsed)} / {formatPreviewTime(trailerPreviewSeconds)}
        </span>
        <span>{runtimeLabel(project.preferences.runtime)}</span>
        <span>{project.preferences.rating}</span>
        <span>{project.preferences.style}</span>
      </div>
    </section>
  );
}

function StoryEnginePanel({
  project,
  fee,
  settings,
  onUpdateProject,
  onRegenerateStory,
  onGenerateTrailer,
  onRequestFullMovie,
  onReportPayment,
}: {
  project: MovieProject;
  fee: number;
  settings: AdminSettings;
  onUpdateProject: (updater: ProjectUpdater) => void;
  onRegenerateStory: () => void;
  onGenerateTrailer: () => void;
  onRequestFullMovie: () => void;
  onReportPayment: () => void;
}) {
  const setPreference = <K extends keyof MoviePreferences>(key: K, value: MoviePreferences[K]) => {
    onUpdateProject((current) => {
      const merged = { ...current, preferences: { ...current.preferences, [key]: value } };
      return { ...merged, story: buildStoryRecommendation(merged) };
    });
  };

  return (
    <section className="panel inspector-panel">
      <div className="section-title compact">
        <WandSparkles size={19} />
        <div>
          <h2>Story Engine</h2>
          <p>Plot, climax, characters, and music direction.</p>
        </div>
      </div>
      <Segmented
        label="Style"
        value={project.preferences.style}
        options={["Cinematic", "Documentary"]}
        onChange={(value) => setPreference("style", value)}
      />
      <Segmented
        label="Rating"
        value={project.preferences.rating}
        options={["G", "PG"]}
        onChange={(value) => setPreference("rating", value)}
      />
      <label className="field-label">
        Runtime
        <select
          value={project.preferences.runtime}
          onChange={(event) => setPreference("runtime", event.target.value as RuntimeId)}
        >
          {runtimeOptions.map((runtime) => (
            <option key={runtime.id} value={runtime.id}>
              {runtime.label}
            </option>
          ))}
        </select>
      </label>
      <RangeControl
        label="Realism"
        value={project.preferences.realism}
        onChange={(value) => setPreference("realism", value)}
      />
      <RangeControl
        label="Historical fidelity"
        value={project.preferences.historicalFidelity}
        onChange={(value) => setPreference("historicalFidelity", value)}
      />
      <RangeControl
        label="Heroic best-light tone"
        value={project.preferences.heroTone}
        onChange={(value) => setPreference("heroTone", value)}
      />
      <div className="recommendation-box">
        <strong>{project.story.logline}</strong>
        <p>{project.story.plot}</p>
        <div className="climax-note">
          <Sparkles size={16} />
          <span>{project.story.climax}</span>
        </div>
      </div>
      <div className="fee-box">
        <div>
          <span>Current estimate</span>
          <strong>{formatCurrency(fee)}</strong>
        </div>
        <small>{settings.chargeFees ? `Payment via Venmo ${settings.venmoHandle}` : settings.betaMessage}</small>
      </div>
      <div className="action-stack">
        <button className="secondary-action" onClick={onRegenerateStory}>
          <RefreshCw size={17} />
          Regenerate Story Plan
        </button>
        <button className="primary-action" onClick={onGenerateTrailer}>
          <Play size={17} />
          Generate Trailer
        </button>
        <button className="primary-action gold" onClick={onRequestFullMovie}>
          <Film size={17} />
          Request Full Movie
        </button>
        {project.payment.status === "awaiting-venmo" && (
          <button className="secondary-action" onClick={onReportPayment}>
            <CreditCard size={17} />
            I paid Venmo
          </button>
        )}
      </div>
    </section>
  );
}

function CharacterPanel({
  project,
  onUpdateProject,
}: {
  project: MovieProject;
  onUpdateProject: (updater: ProjectUpdater) => void;
}) {
  const toggleCharacter = (characterId: string) => {
    onUpdateProject((current) => ({
      ...current,
      story: {
        ...current.story,
        characters: current.story.characters.map((character) =>
          character.id === characterId ? { ...character, approved: !character.approved } : character
        ),
      },
    }));
  };

  return (
    <section className="panel character-panel">
      <div className="section-title compact">
        <UsersRound size={19} />
        <div>
          <h2>Characters</h2>
          <p>Approve or adjust the cast before full rendering.</p>
        </div>
      </div>
      <div className="character-list">
        {project.story.characters.map((character) => (
          <CharacterRow key={character.id} character={character} onToggle={() => toggleCharacter(character.id)} />
        ))}
      </div>
    </section>
  );
}

function CharacterRow({ character, onToggle }: { character: CharacterSuggestion; onToggle: () => void }) {
  return (
    <article className="character-row">
      <span className={character.approved ? "approved-avatar" : "pending-avatar"}>
        {character.approved ? <Check size={16} /> : <Eye size={16} />}
      </span>
      <div>
        <strong>{character.name}</strong>
        <small>{character.role}</small>
        <p>{character.appearance}</p>
      </div>
      <button className="icon-button subtle" onClick={onToggle} aria-label={`Toggle approval for ${character.name}`}>
        {character.approved ? <X size={16} /> : <Check size={16} />}
      </button>
    </article>
  );
}

function LibraryView({
  projects,
  customers,
  onSelectProject,
}: {
  projects: MovieProject[];
  customers: CustomerProfile[];
  onSelectProject: (projectId: string) => void;
}) {
  return (
    <section className="library-view">
      <div className="library-header">
        <div>
          <h1>Movie Library</h1>
          <p>Customer projects, trailers, full movies, payments, and approval status.</p>
        </div>
        <div className="library-kpis">
          <Metric icon={Film} label="Projects" value={String(projects.length)} />
          <Metric icon={CheckCircle2} label="Approved" value={String(projects.filter((project) => project.status === "approved" || project.status === "published").length)} />
          <Metric icon={CreditCard} label="Paid" value={String(projects.filter((project) => project.payment.status === "verified").length)} />
        </div>
      </div>
      <div className="library-grid">
        {projects.map((project) => {
          const customer = customers.find((item) => item.id === project.customerId);
          return (
            <article key={project.id} className="library-card">
              <img src={trailerStill} alt="" />
              <div className="library-card-body">
                <StatusBadge status={project.status} />
                <h2>{project.title}</h2>
                <p>{project.story.logline}</p>
                <div className="library-meta">
                  <span>{customer ? `${customer.firstName} ${customer.lastName}` : "Unknown customer"}</span>
                  <span>{runtimeLabel(project.preferences.runtime)}</span>
                  <span>{project.preferences.rating}</span>
                </div>
                <button className="secondary-action" onClick={() => onSelectProject(project.id)}>
                  <SlidersHorizontal size={17} />
                  Open Project
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AdminConsole({
  state,
  adminUnlocked,
  adminSection,
  onUnlock,
  onSectionChange,
  onUpdateSettings,
  onProjectStatus,
  onMarkPaymentVerified,
  onResetLocalDemo,
}: {
  state: AppState;
  adminUnlocked: boolean;
  adminSection: string;
  onUnlock: (value: boolean) => void;
  onSectionChange: (section: string) => void;
  onUpdateSettings: (patch: Partial<AdminSettings>) => void;
  onProjectStatus: (projectId: string, status: ProjectStatus, adminNote?: string) => void;
  onMarkPaymentVerified: (projectId: string) => void;
  onResetLocalDemo: () => void;
}) {
  const [code, setCode] = useState("");
  const adminSections = ["Approval Queue", "Customer Records", "Payment Ledger", "Movie Library", "Music Library", "Settings"];

  if (!adminUnlocked) {
    return (
      <section className="admin-lock">
        <div className="admin-lock-card">
          <ShieldCheck size={34} />
          <h1>Admin Console</h1>
          <p>Enter the access code to manage approvals, fee mode, payments, projects, and release settings.</p>
      <div className="access-row">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              type="password"
              placeholder="Access code"
            />
            <button
              className="primary-action"
              onClick={() => {
                if (code === ADMIN_ACCESS_CODE) onUnlock(true);
              }}
            >
              <LockKeyhole size={17} />
              Unlock
            </button>
          </div>
          {code && code !== ADMIN_ACCESS_CODE ? <small className="error-text">Access code not recognized.</small> : null}
          <small className="security-note">
            {PUBLIC_LAUNCH_MODE} Admin contact: {ADMIN_EMAIL}
          </small>
        </div>
      </section>
    );
  }

  return (
    <section className="admin-layout">
      <aside className="admin-rail">
        <h1>Admin Console</h1>
        {adminSections.map((section) => (
          <button
            key={section}
            className={adminSection === section ? "admin-nav active" : "admin-nav"}
            onClick={() => onSectionChange(section)}
          >
            {section}
          </button>
        ))}
      </aside>
      <div className="admin-main">
        <div className="admin-topline">
          <div>
            <h2>{adminSection}</h2>
          <p>Approval rules, customer records, Venmo status, movie assets, and beta controls.</p>
          <small className="security-note">{PUBLIC_LAUNCH_MODE}</small>
        </div>
          <button className="secondary-action danger" onClick={onResetLocalDemo}>
            <RefreshCw size={17} />
            Reset Demo
          </button>
        </div>
        {adminSection === "Approval Queue" && (
          <ApprovalQueue
            projects={state.projects}
            customers={state.customers}
            settings={state.adminSettings}
            onProjectStatus={onProjectStatus}
            onMarkPaymentVerified={onMarkPaymentVerified}
          />
        )}
        {adminSection === "Customer Records" && <CustomerRecords projects={state.projects} customers={state.customers} />}
        {adminSection === "Payment Ledger" && <PaymentLedger projects={state.projects} customers={state.customers} onMarkPaymentVerified={onMarkPaymentVerified} />}
        {adminSection === "Movie Library" && <AdminMovieLibrary projects={state.projects} customers={state.customers} />}
        {adminSection === "Music Library" && <MusicLibrary />}
        {adminSection === "Settings" && (
          <AdminSettingsPanel settings={state.adminSettings} onUpdateSettings={onUpdateSettings} />
        )}
      </div>
    </section>
  );
}

function ApprovalQueue({
  projects,
  customers,
  settings,
  onProjectStatus,
  onMarkPaymentVerified,
}: {
  projects: MovieProject[];
  customers: CustomerProfile[];
  settings: AdminSettings;
  onProjectStatus: (projectId: string, status: ProjectStatus, adminNote?: string) => void;
  onMarkPaymentVerified: (projectId: string) => void;
}) {
  return (
    <div className="table-shell">
      <div className="settings-strip">
        <span>Require approval before release: <strong>{settings.requireApproval ? "On" : "Off"}</strong></span>
        <span>Charge fees during beta: <strong>{settings.chargeFees ? "On" : "Off"}</strong></span>
        <span>Venmo {settings.venmoHandle}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Movie</th>
            <th>Customer</th>
            <th>Runtime</th>
            <th>Rating</th>
            <th>Status</th>
            <th>Fee</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => {
            const customer = customers.find((item) => item.id === project.customerId);
            return (
              <tr key={project.id}>
                <td>
                  <strong>{project.title}</strong>
                  <small>{project.ancestor.name || "Ancestor pending"}</small>
                </td>
                <td>{customer ? `${customer.firstName} ${customer.lastName}` : "Unknown"}</td>
                <td>{runtimeLabel(project.preferences.runtime)}</td>
                <td>{project.preferences.rating}</td>
                <td><StatusBadge status={project.status} /></td>
                <td>{formatCurrency(project.payment.amount)}</td>
                <td>
                  <div className="table-actions">
                    <button onClick={() => onProjectStatus(project.id, "approved", "Approved by admin.")}>
                      Approve
                    </button>
                    <button onClick={() => onProjectStatus(project.id, "changes-requested", "Admin requested source or story changes.")}>
                      Request Changes
                    </button>
                    {project.payment.status !== "verified" && (
                      <button onClick={() => onMarkPaymentVerified(project.id)}>Verify Paid</button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CustomerRecords({ projects, customers }: { projects: MovieProject[]; customers: CustomerProfile[] }) {
  return (
    <div className="record-grid">
      {customers.map((customer) => (
        <article className="record-card" key={customer.id}>
          <h3>{customer.firstName} {customer.lastName}</h3>
          <p>{customer.email}</p>
          <p>{customer.address}</p>
          <div className="record-card-row">
            <span>Age {customer.age || "n/a"}</span>
            <span>{customer.consent ? "Consent on file" : "Consent needed"}</span>
            <span>{projects.filter((project) => project.customerId === customer.id).length} project(s)</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function PaymentLedger({
  projects,
  customers,
  onMarkPaymentVerified,
}: {
  projects: MovieProject[];
  customers: CustomerProfile[];
  onMarkPaymentVerified: (projectId: string) => void;
}) {
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Customer</th>
            <th>Project</th>
            <th>Amount</th>
            <th>Venmo</th>
            <th>Email</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => {
            const customer = customers.find((item) => item.id === project.customerId);
            return (
              <tr key={project.id}>
                <td>{project.payment.receiptNumber}</td>
                <td>{customer?.email ?? "No email"}</td>
                <td>{project.title}</td>
                <td>{formatCurrency(project.payment.amount)}</td>
                <td>{project.payment.status}</td>
                <td>{project.payment.receiptEmailStatus}</td>
                <td>
                  {project.payment.status !== "verified" ? (
                    <button onClick={() => onMarkPaymentVerified(project.id)}>Mark verified</button>
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdminMovieLibrary({ projects, customers }: { projects: MovieProject[]; customers: CustomerProfile[] }) {
  return (
    <div className="record-grid">
      {projects.map((project) => {
        const customer = customers.find((item) => item.id === project.customerId);
        return (
          <article key={project.id} className="record-card movie-record">
            <img src={trailerStill} alt="" />
            <div>
              <StatusBadge status={project.status} />
              <h3>{project.title}</h3>
              <p>{project.story.emotionalPromise}</p>
              <div className="record-card-row">
                <span>{customer?.email ?? "No customer email"}</span>
                <span>{project.sources.length} source(s)</span>
                <span>{project.story.scenes.length} scene(s)</span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function MusicLibrary() {
  return (
    <div className="music-grid">
      {musicMoods.map((mood, index) => (
        <article key={mood.title} className="music-card">
          <Music2 size={20} />
          <span>0{index + 1}</span>
          <h3>{mood.title}</h3>
          <p>{mood.tone}</p>
        </article>
      ))}
    </div>
  );
}

function SettingsSaveBar({
  hasUnsavedChanges,
  savedNotice,
  onDiscard,
  onSave,
  placement = "top",
}: {
  hasUnsavedChanges: boolean;
  savedNotice: string;
  onDiscard: () => void;
  onSave: () => void;
  placement?: "top" | "bottom";
}) {
  return (
    <div className={placement === "bottom" ? "settings-savebar settings-savebar-bottom" : "settings-savebar"}>
      <span
        className={hasUnsavedChanges ? "settings-status dirty" : "settings-status saved"}
        aria-live="polite"
      >
        {hasUnsavedChanges ? "Unsaved changes" : savedNotice}
      </span>
      <div className="settings-save-actions">
        <button type="button" className="secondary-action" onClick={onDiscard} disabled={!hasUnsavedChanges}>
          Discard
        </button>
        <button type="button" className="primary-action" onClick={onSave} disabled={!hasUnsavedChanges}>
          <Check size={17} />
          Save changes
        </button>
      </div>
    </div>
  );
}

function AdminSettingsPanel({
  settings,
  onUpdateSettings,
}: {
  settings: AdminSettings;
  onUpdateSettings: (patch: Partial<AdminSettings>) => void;
}) {
  const [draftSettings, setDraftSettings] = useState<AdminSettings>(settings);
  const [savedNotice, setSavedNotice] = useState("Saved locally");

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(draftSettings) !== JSON.stringify(settings),
    [draftSettings, settings]
  );

  const updateDraftSettings = (patch: Partial<AdminSettings>) => {
    setDraftSettings((current) => ({ ...current, ...patch }));
    setSavedNotice("Unsaved changes");
  };

  const saveSettings = () => {
    onUpdateSettings(draftSettings);
    setSavedNotice("Saved locally");
  };

  const discardSettings = () => {
    setDraftSettings(settings);
    setSavedNotice("Saved locally");
  };

  return (
    <section className="settings-panel">
      <SettingsSaveBar
        hasUnsavedChanges={hasUnsavedChanges}
        savedNotice={savedNotice}
        onDiscard={discardSettings}
        onSave={saveSettings}
      />
      <label className="toggle-row">
        <span>
          <strong>Require approval before release</strong>
          <small>Generated movies wait for admin approval before publishing or download.</small>
        </span>
        <input
          type="checkbox"
          checked={draftSettings.requireApproval}
          onChange={(event) => updateDraftSettings({ requireApproval: event.target.checked })}
        />
      </label>
      <label className="toggle-row">
        <span>
          <strong>Charge fees during beta</strong>
          <small>When off, requests stay free while the app is being tested.</small>
        </span>
        <input
          type="checkbox"
          checked={draftSettings.chargeFees}
          onChange={(event) => updateDraftSettings({ chargeFees: event.target.checked })}
        />
      </label>
      <TextInput
        label="Venmo handle"
        value={draftSettings.venmoHandle}
        onChange={(venmoHandle) => updateDraftSettings({ venmoHandle })}
      />
      <TextArea
        label="Beta message"
        value={draftSettings.betaMessage}
        onChange={(betaMessage) => updateDraftSettings({ betaMessage })}
      />
      <div className="pricing-grid">
        {runtimeOptions.map((option) => (
          <label key={option.id} className="price-control">
            <span>{option.label}</span>
            <input
              type="number"
              value={draftSettings.pricing[option.id]}
              onChange={(event) =>
                updateDraftSettings({
                  pricing: { ...draftSettings.pricing, [option.id]: Number(event.target.value) },
                })
              }
            />
          </label>
        ))}
      </div>
      <SettingsSaveBar
        hasUnsavedChanges={hasUnsavedChanges}
        savedNotice={savedNotice}
        onDiscard={discardSettings}
        onSave={saveSettings}
        placement="bottom"
      />
    </section>
  );
}

function PublishPanel({
  project,
  customer,
  settings,
  onUpdateProject,
  onRequestFullMovie,
  onReportPayment,
  onPublish,
}: {
  project: MovieProject;
  customer: CustomerProfile;
  settings: AdminSettings;
  onUpdateProject: (updater: ProjectUpdater) => void;
  onRequestFullMovie: () => void;
  onReportPayment: () => void;
  onPublish: () => void;
}) {
  const setPreference = <K extends keyof MoviePreferences>(key: K, value: MoviePreferences[K]) => {
    onUpdateProject((current) => ({
      ...current,
      preferences: { ...current.preferences, [key]: value },
    }));
  };

  return (
    <section className="publish-view">
      <div className="publish-hero">
        <img src={trailerStill} alt="" />
        <div>
          <StatusBadge status={project.status} />
          <h1>{project.title}</h1>
          <p>{project.story.emotionalPromise}</p>
          <div className="publish-actions">
            <button className="primary-action" onClick={onRequestFullMovie}>
              <Film size={17} />
              Request Full Movie
            </button>
            <button className="secondary-action" onClick={onPublish}>
              <Send size={17} />
              Publish / Prepare Links
            </button>
          </div>
        </div>
      </div>

      <div className="publish-grid">
        <section className="panel">
          <div className="section-title">
            <CreditCard size={20} />
            <div>
              <h2>Payment</h2>
              <p>Trailer remains available while a full movie waits for fee and approval rules.</p>
            </div>
          </div>
          <div className="payment-card">
            <strong>{formatCurrency(project.payment.amount)}</strong>
            <span>{settings.chargeFees ? `Pay by Venmo ${settings.venmoHandle}` : "Beta mode: no fee required"}</span>
            <small>Receipt {project.payment.receiptNumber} · {project.payment.receiptEmailStatus}</small>
            {project.payment.status === "awaiting-venmo" ? (
              <button className="primary-action" onClick={onReportPayment}>
                <CreditCard size={17} />
                I paid Venmo
              </button>
            ) : null}
            <a className="secondary-action as-link" href="https://venmo.com/ERik-Castle-1" target="_blank" rel="noreferrer">
              Open Venmo
            </a>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">
            <Youtube size={20} />
            <div>
              <h2>Release Options</h2>
              <p>Choose where the approved movie should go when production services are connected.</p>
            </div>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={project.preferences.sendEmailLink}
              onChange={(event) => setPreference("sendEmailLink", event.target.checked)}
            />
            <span>Email private link to {customer.email || "customer email"}</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={project.preferences.publishToYoutube}
              onChange={(event) => setPreference("publishToYoutube", event.target.checked)}
            />
            <span>Publish through customer YouTube account</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={project.preferences.publishToFamilyGallery}
              onChange={(event) => setPreference("publishToFamilyGallery", event.target.checked)}
            />
            <span>Add to family gallery</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={project.preferences.allowPublicDiscovery}
              onChange={(event) => setPreference("allowPublicDiscovery", event.target.checked)}
            />
            <span>Allow public discovery after approval</span>
          </label>
        </section>

        <section className="panel">
          <div className="section-title">
            <Download size={20} />
            <div>
              <h2>Delivery</h2>
              <p>Production delivery records are stored with the project for admin tracking.</p>
            </div>
          </div>
          <div className="delivery-list">
            <span>Download URL: {project.downloadUrl || "Prepared after render"}</span>
            <span>YouTube URL: {project.youtubeUrl || "Connect OAuth in production"}</span>
            <span>Approval: {settings.requireApproval ? "Required" : "Automatic"}</span>
          </div>
        </section>
      </div>
    </section>
  );
}

function TextInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="field-label">
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} type={type} />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  tall,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  tall?: boolean;
}) {
  return (
    <label className="field-label">
      {label}
      <textarea
        className={tall ? "tall" : ""}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-wrap">
      <span>{label}</span>
      <div className="segmented">
        {options.map((option) => (
          <button
            key={option}
            className={value === option ? "active" : ""}
            onClick={() => onChange(option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function RangeControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span>
        {label}
        <strong>{value}</strong>
      </span>
      <input type="range" min="0" max="100" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  return <span className={`status-badge ${status}`}>{statusCopy(status)}</span>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Film; label: string; value: string }) {
  return (
    <div className="metric">
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
