import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  Clapperboard,
  Download,
  FileText,
  FolderInput,
  FolderOpen,
  Image,
  Loader2,
  Music,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Undo2,
  Video,
  X,
} from "lucide-react";
import { api, type Film } from "./model";
import { listProjectSourceFiles } from "../lib/storage";
import {
  mediaAccept,
  uploadMedia,
  type MediaItem,
  type MediaPage,
} from "./media-library";
import "./media-library.css";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This media action could not complete.";
const sizeLabel = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
const category = (item: MediaItem) =>
  item.contentType.startsWith("image/")
    ? "Photos"
    : item.contentType.startsWith("audio/")
      ? "Audio"
      : item.contentType.startsWith("video/")
        ? "Video"
        : "Documents";

export default function MediaLibrary({
  admin = false,
  projects = [],
  onUse,
  onBusyChange,
}: {
  admin?: boolean;
  projects?: Film[];
  onUse?: (item: MediaItem) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [view, setView] = useState(admin ? "all" : "active");
  const [page, setPage] = useState<MediaPage>({ items: [] });
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("All types");
  const [dialog, setDialog] = useState<{
    item: MediaItem;
    action: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState(""),
    [name, setName] = useState("");
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const input = useRef<HTMLInputElement>(null),
    sequence = useRef(0),
    lock = useRef(false);
  const modal = useRef<HTMLElement | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(Boolean(busy));
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!dialog && !preview) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !lock.current) {
        setDialog(null);
        setPreview(null);
      }
      if (event.key !== "Tab") return;
      const nodes = focusable(),
        first = nodes[0],
        last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [dialog, preview]);
  const refresh = useCallback(
    async (cursor?: string) => {
      const request = ++sequence.current;
      setLoading(true);
      setError("");
      try {
        const result = await api<MediaPage>(
          `/api/media?scope=${admin ? "admin" : "customer"}&view=${view}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (request !== sequence.current) return;
        setPage((old) => ({
          ...result,
          items: cursor
            ? [
                ...old.items,
                ...result.items.filter(
                  (item) =>
                    !old.items.some(
                      (previous) =>
                        previous.id === item.id &&
                        previous.ownerEmail === item.ownerEmail,
                    ),
                ),
              ]
            : result.items,
        }));
      } catch (cause) {
        if (request === sequence.current) setError(message(cause));
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [admin, view],
  );
  useEffect(() => {
    setPage({ items: [] });
    void refresh();
  }, [refresh]);
  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      if (active.current) setError(message(cause));
    } finally {
      lock.current = false;
      if (active.current) setBusy("");
    }
  }
  async function add(files: File[]) {
    await run("Uploading media…", async () => {
      let count = 0;
      const errors: string[] = [];
      for (const file of files) {
        try {
          setBusy(`Uploading ${file.name}…`);
          await uploadMedia(file, undefined, undefined, (percent) =>
            setBusy(`Uploading ${file.name} · ${percent}%`),
          );
          count++;
        } catch (cause) {
          errors.push(`${file.name}: ${message(cause)}`);
        }
      }
      await refresh();
      setNotice(
        `${count} file${count === 1 ? "" : "s"} saved to your private media library.`,
      );
      if (errors.length) setError(errors.join(" "));
    });
  }
  async function copyLegacy() {
    await run("Copying browser sources…", async () => {
      let copied = 0;
      const errors: string[] = [];
      const local = await listProjectSourceFiles(
        projects.map((project) => project.id),
      );
      const present = new Set(local.map((source) => source.id));
      const missing = new Set(
        projects
          .flatMap((project) => project.sources)
          .filter((source) => !present.has(source.id))
          .map((source) => source.id),
      ).size;
      for (const stored of local) {
        const project = projects.find(
          (project) => project.id === stored.projectId,
        )!;
        const source = project.sources.find(
          (source) => source.id === stored.id,
        );
        try {
          setBusy(`Saving ${stored.name}…`);
          await uploadMedia(
            new File([stored.file], source?.name || stored.name, {
              type: source?.type || stored.type,
            }),
            stored.id,
            { id: project.id, title: project.title || "Untitled family film" },
          );
          copied++;
        } catch (cause) {
          errors.push(`${stored.name}: ${message(cause)}`);
        }
      }
      await refresh();
      setNotice(
        `${copied} browser source${copied === 1 ? "" : "s"} saved or already present.${missing ? ` ${missing} original file${missing === 1 ? " is" : "s are"} no longer in this browser; add the originals to recover them.` : ""}`,
      );
      if (errors.length) setError(errors.join(" "));
    });
  }
  async function act(
    item: MediaItem,
    action: string,
    fields: Record<string, string> = {},
  ) {
    await run(
      action === "purge"
        ? "Permanently deleting media…"
        : "Saving media changes…",
      async () => {
        await api("/api/media", {
          action,
          id: item.id,
          owner: item.ownerEmail,
          revision: item.revision,
          ...fields,
        });
        setDialog(null);
        setPreview(null);
        await refresh();
        setNotice(
          action === "purge"
            ? "Media permanently deleted from server storage. Previously downloaded copies are not affected."
            : action === "trash"
              ? "Moved to your trash. Administrators retain the original file."
              : action === "archive" || action === "admin-archive"
                ? "Media archived. You can restore it from the archive."
                : action === "rename"
                  ? "Media renamed."
                  : "Media restored.",
        );
      },
    );
  }
  const filtered = page.items.filter(
    (item) =>
      (kind === "All types" || category(item) === kind) &&
      `${item.name} ${item.ownerEmail} ${item.project?.title || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const locked = Boolean(busy) || loading;
  const tabs = admin
    ? [
        ["all", "All media"],
        ["active", "Unarchived"],
        ["archived", "Administrator archive"],
      ]
    : [
        ["active", "My media"],
        ["archived", "Archive"],
        ["trash", "Trash"],
      ];
  /* Presentation only: a class suffix and a type glyph for covers and dialogs. */
  const kindClass = (item: MediaItem) =>
    category(item) === "Photos"
      ? "photo"
      : category(item) === "Audio"
        ? "audio"
        : category(item) === "Video"
          ? "video"
          : "document";
  const kindIcon = (item: MediaItem, size: number) =>
    category(item) === "Audio" ? (
      <Music size={size} aria-hidden="true" />
    ) : category(item) === "Video" ? (
      <Video size={size} aria-hidden="true" />
    ) : category(item) === "Photos" ? (
      <Image size={size} aria-hidden="true" />
    ) : (
      <FileText size={size} aria-hidden="true" />
    );
  const filtering = Boolean(query) || kind !== "All types";
  return (
    <section
      className={`media-library${admin ? " media-library-admin" : ""}`}
      aria-label={admin ? "Administrator media library" : "Your media library"}
    >
      <div className="media-heading">
        <div>
          <span className="media-eyebrow">
            {admin
              ? "Originals & source files · all customers"
              : "Your originals, together"}
          </span>
          <h1>{admin ? "All customer media" : "Media library"}</h1>
          <p>
            {admin
              ? "Customer archives and deletions stay visible here. Only administrators can permanently delete originals from the administrator archive."
              : "Photos, documents, recordings, footage, and the sources behind your films. Saved privately and available when you sign in on another device."}
          </p>
        </div>
        <div className="media-actions">
          <button
            className="button secondary"
            disabled={locked}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </button>
          {!admin && (
            <button
              className="button primary"
              disabled={locked}
              onClick={() => input.current?.click()}
            >
              <Plus size={16} aria-hidden="true" />
              Add media
            </button>
          )}
        </div>
      </div>
      {!admin && (
        <>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept={mediaAccept}
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              if (files.length) void add(files);
            }}
          />
          <div className="media-notes">
            <p className="media-retention">
              <ShieldCheck size={20} aria-hidden="true" />
              <span>
                Uploads are saved with administrator access. Archiving or moving
                a file to trash hides it from your active library;
                administrators retain it until they permanently delete it. Up to
                100 MB per file.
              </span>
            </p>
            {projects.length > 0 && (
              <div className="media-legacy">
                <FolderInput size={20} aria-hidden="true" />
                <div>
                  <span>Sources from earlier films</span>
                  <p>
                    Copy originals still stored in this browser to your private
                    media library, with administrator access. Sources from other
                    browsers must be copied there.
                  </p>
                </div>
                <button
                  className="button secondary small"
                  disabled={locked}
                  onClick={() => void copyLegacy()}
                >
                  Copy browser sources
                </button>
              </div>
            )}
          </div>
        </>
      )}
      <div className="media-toolbar">
        <nav className="media-tabs" aria-label="Media views">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              disabled={locked}
              aria-pressed={view === id}
              className={view === id ? "selected" : ""}
              onClick={() => {
                setView(id);
                setNotice("");
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="media-filters">
          <label>
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="Search media"
              placeholder={
                admin
                  ? "Search loaded files, customers, or films"
                  : "Search loaded files or films"
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="Media type"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            {["All types", "Photos", "Documents", "Audio", "Video"].map(
              (value) => (
                <option key={value}>{value}</option>
              ),
            )}
          </select>
        </div>
      </div>
      {busy && (
        <p className="media-feedback feedback info" role="status">
          <Loader2 size={18} className="spin" aria-hidden="true" />
          <span>{busy}</span>
        </p>
      )}
      {notice && (
        <p className="media-feedback feedback success" role="status">
          <CircleCheck size={18} aria-hidden="true" />
          <span>{notice}</span>
        </p>
      )}
      {error && (
        <p className="media-feedback feedback error error-text" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <span>{error}</span>{" "}
          <button
            className="text-button"
            disabled={locked}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Refresh library
          </button>
        </p>
      )}
      <p className="media-count">
        {filtered.length} shown · {page.items.length} loaded
        {page.cursor
          ? " · More files available below. Search and filters apply to loaded files."
          : ""}
      </p>
      {loading && (
        <p role="status" className="media-loading">
          <Loader2 size={18} className="spin" aria-hidden="true" />
          Loading media…
        </p>
      )}
      {loading && !page.items.length && (
        <div className="media-skeleton" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <div className="media-skeleton-card" key={index}>
              <div className="media-skeleton-cover" />
              <div className="media-skeleton-line" />
              <div className="media-skeleton-line short" />
            </div>
          ))}
        </div>
      )}
      {!loading && !filtered.length && !error && (
        <div className="media-empty">
          <span className="media-empty-icon" aria-hidden="true">
            {filtering ? <Search size={28} /> : <FolderOpen size={28} />}
          </span>
          <h2>
            {query || kind !== "All types"
              ? "No matching files"
              : "No media in this view yet"}
          </h2>
          <p>
            {admin
              ? "Uploaded originals will appear here, including media customers have archived or moved to trash."
              : "Add media here, upload sources while creating a film, or copy your earlier browser sources."}
          </p>
          {!admin && !filtering && view === "active" && (
            <button
              className="button primary"
              disabled={locked}
              onClick={() => input.current?.click()}
            >
              <Plus size={16} aria-hidden="true" />
              Add media
            </button>
          )}
        </div>
      )}
      <div className="media-grid">
        {filtered.map((item) => (
          <article
            className={`media-card${item.status !== "ready" ? " media-card-attention" : ""}`}
            key={`${item.ownerEmail}:${item.id}`}
          >
            <button
              className={`media-cover media-cover-${kindClass(item)}`}
              aria-label={`Preview ${item.name}`}
              disabled={locked || !item.mediaUrl}
              onClick={() => setPreview(item)}
            >
              {item.contentType.startsWith("image/") && item.mediaUrl ? (
                <img src={item.mediaUrl} alt="" loading="lazy" />
              ) : category(item) === "Audio" ? (
                <Music size={32} />
              ) : category(item) === "Video" ? (
                <Video size={32} />
              ) : category(item) === "Photos" ? (
                <Image size={32} />
              ) : (
                <FileText size={32} />
              )}
              <span>{category(item)}</span>
            </button>
            <div className="media-card-body">
              <div className="media-card-text">
              <h2 title={item.name}>{item.name}</h2>
              <p className="media-meta">
                {sizeLabel(item.size)} ·{" "}
                {new Date(item.createdAt).toLocaleDateString()}
              </p>
              {item.project && (
                <p className="media-film">From: {item.project.title}</p>
              )}
              {admin && (
                <>
                  <p className="media-owner">{item.ownerEmail}</p>
                  <p className="media-badge">
                    Customer:{" "}
                    {item.customerState === "trash"
                      ? "deleted to trash"
                      : item.customerState}
                    {item.adminArchivedAt ? " · Administrator archived" : ""}
                  </p>
                </>
              )}
              {item.status !== "ready" && (
                <p className="media-badge media-badge-warning">
                  <TriangleAlert size={16} aria-hidden="true" />
                  <span>
                    {item.status === "deleting"
                      ? "Deletion incomplete — retry from archive"
                      : "Upload incomplete"}
                  </span>
                </p>
              )}
              </div>
              <div className="media-card-actions">
                {!admin &&
                  onUse &&
                  item.status === "ready" &&
                  item.customerState === "active" && (
                    <button
                      className="button secondary small media-card-key"
                      disabled={locked}
                      onClick={() =>
                        void run("Adding source to your film…", async () => {
                          await onUse(item);
                        })
                      }
                    >
                      <Clapperboard size={16} aria-hidden="true" />
                      Use in current film
                    </button>
                  )}
                {!admin && item.customerState !== "active" && (
                  <button
                    className="button secondary small media-card-key"
                    disabled={locked}
                    onClick={() => void act(item, "restore")}
                  >
                    <Undo2 size={16} aria-hidden="true" />
                    Restore
                  </button>
                )}
                {!admin && item.status === "pending" && (
                  <button
                    className="button secondary small media-card-key"
                    disabled={locked}
                    onClick={() =>
                      void run("Verifying upload…", async () => {
                        await api("/api/media", {
                          action: "finalize",
                          id: item.id,
                        });
                        await refresh();
                        setNotice("Upload verified.");
                      })
                    }
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    Verify upload
                  </button>
                )}
                {admin && (
                  <button
                    className="button secondary small media-card-key"
                    disabled={locked || item.status === "deleting"}
                    onClick={() =>
                      void act(
                        item,
                        item.adminArchivedAt
                          ? "admin-restore"
                          : "admin-archive",
                      )
                    }
                  >
                    {item.adminArchivedAt ? (
                      <Undo2 size={16} aria-hidden="true" />
                    ) : (
                      <Archive size={16} aria-hidden="true" />
                    )}
                    {item.adminArchivedAt
                      ? "Restore from archive"
                      : "Archive for administrator"}
                  </button>
                )}
                <div className="media-card-links">
                  {item.mediaUrl && (
                    <>
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() => setPreview(item)}
                      >
                        Preview
                      </button>
                      <a
                        className="text-button"
                        href={`${item.mediaUrl}&download=1`}
                      >
                        Download
                      </a>
                    </>
                  )}
                  {!admin && item.status === "ready" && (
                    <button
                      className="text-button"
                      disabled={locked}
                      onClick={() => {
                        setName(item.name);
                        setDialog({ item, action: "rename" });
                      }}
                    >
                      Rename
                    </button>
                  )}
                  {!admin && item.customerState === "active" && (
                    <button
                      className="text-button"
                      disabled={locked}
                      onClick={() => void act(item, "archive")}
                    >
                      Archive
                    </button>
                  )}
                  {!admin && item.customerState !== "trash" && (
                    <button
                      className="text-button media-link-danger"
                      disabled={locked}
                      onClick={() => setDialog({ item, action: "trash" })}
                    >
                      Move to trash
                    </button>
                  )}
                  {admin && view === "archived" && item.adminArchivedAt && (
                    <button
                      className="text-button error-text media-link-danger"
                      disabled={locked}
                      onClick={() => {
                        setConfirmation("");
                        setDialog({ item, action: "purge" });
                      }}
                    >
                      Permanently delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
      {page.cursor && (
        <button
          className="button secondary media-more"
          disabled={locked}
          onClick={() => void refresh(page.cursor)}
        >
          Load more media
        </button>
      )}
      {preview && (
        <div className="media-backdrop">
          <section
            ref={modal}
            className={`media-dialog media-dialog-preview media-dialog-${kindClass(preview)}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="media-preview-title"
          >
            <button
              className="icon-button media-close"
              aria-label="Close preview"
              onClick={() => setPreview(null)}
            >
              <X size={20} aria-hidden="true" />
            </button>
            <h2 id="media-preview-title">{preview.name}</h2>
            <p className="media-dialog-meta">
              {category(preview)} · {sizeLabel(preview.size)} ·{" "}
              {new Date(preview.createdAt).toLocaleDateString()}
            </p>
            <div className="media-stage">
              {preview.contentType.startsWith("image/") ? (
                <img
                  className="media-full-image"
                  src={preview.mediaUrl}
                  alt={preview.name}
                />
              ) : preview.contentType.startsWith("video/") ? (
                <video controls src={preview.mediaUrl} />
              ) : preview.contentType.startsWith("audio/") ? (
                <>
                  <span className="media-stage-icon" aria-hidden="true">
                    {kindIcon(preview, 28)}
                  </span>
                  <audio controls src={preview.mediaUrl} />
                </>
              ) : (
                <>
                  <span className="media-stage-icon" aria-hidden="true">
                    {kindIcon(preview, 28)}
                  </span>
                  <p>
                    Open or download the original document to read its full
                    contents.
                  </p>
                </>
              )}
            </div>
            <div className="media-actions">
              <a
                className="button secondary"
                href={preview.mediaUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open original
              </a>
              <a
                className="button primary"
                href={`${preview.mediaUrl}&download=1`}
              >
                <Download size={16} aria-hidden="true" />
                Download original
              </a>
            </div>
          </section>
        </div>
      )}
      {dialog && (
        <div className="media-backdrop">
          <form
            ref={(element) => {
              modal.current = element;
            }}
            className={`media-dialog media-dialog-action${dialog.action === "rename" ? "" : " media-dialog-danger"}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="media-action-title"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                dialog.item,
                dialog.action,
                dialog.action === "rename" ? { name } : { confirmation },
              );
            }}
          >
            <span className="media-dialog-icon" aria-hidden="true">
              {dialog.action === "rename" ? (
                <Pencil size={22} />
              ) : (
                <Trash2 size={22} />
              )}
            </span>
            <h2 id="media-action-title">
              {dialog.action === "purge"
                ? "Permanently delete this original?"
                : dialog.action === "rename"
                  ? "Rename media"
                  : "Move this file to trash?"}
            </h2>
            <p className="media-dialog-file">{dialog.item.name}</p>
            {dialog.action === "purge" ? (
              <>
                <p>
                  This removes the server original for the customer and all
                  administrators. It cannot be restored. Previously downloaded
                  copies and film drafts are not erased.
                </p>
                <label>
                  Type DELETE to confirm
                  <input
                    autoFocus
                    aria-label="Permanent deletion confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              </>
            ) : dialog.action === "rename" ? (
              <label>
                File name
                <input
                  autoFocus
                  maxLength={240}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            ) : (
              <p>
                You can restore it from Trash. Administrators retain access to
                the original. Sources already added to film drafts stay in those
                drafts.
              </p>
            )}
            {error && (
              <p role="alert" className="error-text feedback error">
                <CircleAlert size={18} aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
            <div className="media-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                onClick={() => {
                  setDialog(null);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button
                className={`button primary${dialog.action === "rename" ? "" : " danger"}`}
                disabled={
                  !!busy ||
                  (dialog.action === "purge" && confirmation !== "DELETE")
                }
              >
                {busy ||
                  (dialog.action === "purge"
                    ? "Permanently delete"
                    : dialog.action === "rename"
                      ? "Save name"
                      : "Move to trash")}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
