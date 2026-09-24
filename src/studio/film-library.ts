import type { Film, User } from "./model";

export type LibraryView = "active" | "archived" | "trash";
export type LibraryAction = "archive" | "trash" | "restore";
export type LibraryPayment = {
  id: string; status: string; amountCents: number; currency: "USD"; refundedCents: number;
  sandbox: boolean; requiresReview: boolean; receiptAvailable: boolean;
};
export type LibraryEntry = {
  kind: "plan" | "upload"; id: string; filmId: string; title: string; durationSeconds: number;
  createdAt: string; updatedAt: string; libraryState: LibraryView; revision: number;
  production: { status: string; completedShots: number; shotCount: number; mediaReady: boolean; needsAttention: boolean };
  payments: LibraryPayment[]; manifestHash?: string; mediaUrl?: string; downloadUrl?: string;
};
export type LibraryPage = { entries: LibraryEntry[]; cursor?: string };
export type LibraryScene = { title: string; narration: string; visual: string; dialogue: string };
export type LibraryDetail = { entry: LibraryEntry; scenes?: LibraryScene[]; sourceNames?: string[]; manifest?: Record<string, unknown> };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, max = 500): value is string => typeof value === "string" && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const states: LibraryView[] = ["active", "archived", "trash"];
const productionStates = ["prepared", "queued", "submitting", "processing", "uncertain", "failed", "completed", "uploaded"];
const paymentStates = ["submitting", "awaiting-payment", "captured", "declined", "uncertain", "refund-pending", "partially-refunded", "refunded"];
const invalid = () => new Error("Your saved film information could not be verified. Refresh the library before continuing.");
export const libraryKey = (entry: Pick<LibraryEntry, "kind" | "id">) => `${entry.kind}:${entry.id}`;
export function libraryMediaUrl(entry: Pick<LibraryEntry, "kind" | "id">, download = false): string {
  return `/api/${entry.kind === "plan" ? "studio?action=productionMedia" : "archive?action=media"}&id=${encodeURIComponent(entry.id)}${download ? "&download=1" : ""}`;
}
export function normalizeLibraryEntry(value: unknown): LibraryEntry {
  if (!object(value) || !["plan", "upload"].includes(String(value.kind)) || !uuid(value.id)
    || !text(value.filmId, 100) || !value.filmId || !text(value.title, 300)
    || !Number.isFinite(value.durationSeconds) || Number(value.durationSeconds) < 0 || Number(value.durationSeconds) > 14400
    || !date(value.createdAt) || !date(value.updatedAt) || !states.includes(value.libraryState as LibraryView) || !count(value.revision)
    || !object(value.production) || !productionStates.includes(String(value.production.status))
    || !count(value.production.completedShots) || !count(value.production.shotCount)
    || value.production.completedShots > value.production.shotCount
    || typeof value.production.mediaReady !== "boolean" || typeof value.production.needsAttention !== "boolean"
    || !Array.isArray(value.payments) || value.payments.length > 100
    || (value.kind === "plan" && !digest(value.manifestHash))) throw invalid();
  const payments = value.payments.map(payment => {
    if (!object(payment) || !digest(payment.id) || !paymentStates.includes(String(payment.status))
      || !count(payment.amountCents) || payment.amountCents < 1 || payment.currency !== "USD"
      || !count(payment.refundedCents) || payment.refundedCents > payment.amountCents
      || typeof payment.sandbox !== "boolean" || typeof payment.requiresReview !== "boolean" || typeof payment.receiptAvailable !== "boolean") throw invalid();
    return { id: payment.id, status: String(payment.status), amountCents: payment.amountCents, currency: "USD" as const,
      refundedCents: payment.refundedCents, sandbox: payment.sandbox, requiresReview: payment.requiresReview, receiptAvailable: payment.receiptAvailable };
  });
  const entry: LibraryEntry = { kind: value.kind as LibraryEntry["kind"], id: value.id, filmId: value.filmId, title: value.title,
    durationSeconds: Number(value.durationSeconds), createdAt: value.createdAt, updatedAt: value.updatedAt,
    libraryState: value.libraryState as LibraryView, revision: value.revision,
    production: { status: String(value.production.status), completedShots: value.production.completedShots,
      shotCount: value.production.shotCount, mediaReady: value.production.mediaReady, needsAttention: value.production.needsAttention }, payments,
    ...(value.kind === "plan" ? { manifestHash: value.manifestHash as string } : {}) };
  if (value.mediaUrl !== undefined || value.downloadUrl !== undefined || entry.production.mediaReady) {
    if (!entry.production.mediaReady || !["completed", "uploaded"].includes(entry.production.status)
      || value.mediaUrl !== libraryMediaUrl(entry) || value.downloadUrl !== libraryMediaUrl(entry, true)) throw invalid();
    entry.mediaUrl = value.mediaUrl as string; entry.downloadUrl = value.downloadUrl as string;
  }
  return entry;
}
export function normalizeLibraryPage(value: unknown, view: LibraryView): LibraryPage {
  if (!object(value) || !Array.isArray(value.entries) || value.entries.length > 200
    || (value.cursor !== undefined && (!text(value.cursor, 8192) || !value.cursor))) throw invalid();
  const entries = value.entries.map(normalizeLibraryEntry);
  if (entries.some(entry => entry.libraryState !== view) || new Set(entries.map(libraryKey)).size !== entries.length) throw invalid();
  return { entries, ...(value.cursor ? { cursor: value.cursor as string } : {}) };
}
export function mergeLibraryPages(current: LibraryEntry[], incoming: LibraryEntry[]): LibraryEntry[] {
  const next = new Map(current.map(entry => [libraryKey(entry), entry]));
  for (const entry of incoming) next.set(libraryKey(entry), entry);
  return [...next.values()];
}
export function libraryActionRequest(entry: LibraryEntry, action: LibraryAction) {
  if (!(["archive", "trash", "restore"] as string[]).includes(action)
    || action === "archive" && entry.libraryState !== "active"
    || action === "trash" && entry.libraryState === "trash"
    || action === "restore" && entry.libraryState === "active") throw invalid();
  return { action, kind: entry.kind, id: entry.id, expectedRevision: entry.revision };
}
export function normalizeLibraryAction(value: unknown, previous: LibraryEntry, action: LibraryAction): LibraryEntry {
  if (!object(value)) throw invalid();
  const entry = normalizeLibraryEntry(value.entry);
  const expectedState = action === "restore" ? "active" : action === "archive" ? "archived" : "trash";
  if (libraryKey(entry) !== libraryKey(previous) || entry.filmId !== previous.filmId || entry.manifestHash !== previous.manifestHash
    || entry.libraryState !== expectedState || entry.revision <= previous.revision) throw invalid();
  return entry;
}
export async function verifyLibraryDetail(value: unknown, expected: LibraryEntry): Promise<LibraryDetail> {
  if (!object(value)) throw invalid();
  const entry = normalizeLibraryEntry(value.entry);
  if (libraryKey(entry) !== libraryKey(expected) || entry.filmId !== expected.filmId || entry.manifestHash !== expected.manifestHash) throw invalid();
  if (entry.kind === "upload") return { entry };
  const wrapper = value.manifest;
  if (!object(wrapper) || wrapper.id !== entry.id || wrapper.manifestHash !== entry.manifestHash || !object(wrapper.manifest)
    || wrapper.manifest.filmId !== entry.filmId || !object(wrapper.manifest.screenplay) || !Array.isArray(wrapper.manifest.screenplay.scenes)
    || wrapper.manifest.screenplay.scenes.length > 30) throw invalid();
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(wrapper.manifest))));
  if (Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") !== entry.manifestHash) throw invalid();
  // The server bounds the screenplay, not the full manifest (shots repeat it).
  if (new TextEncoder().encode(JSON.stringify(wrapper.manifest.screenplay)).byteLength > 1_500_000) throw invalid();
  const scenes = wrapper.manifest.screenplay.scenes.map(scene => {
    if (!object(scene) || ![scene.title, scene.narration, scene.visual, scene.dialogue].every(field => text(field, 1_500_000))) throw invalid();
    return { title: scene.title as string, narration: scene.narration as string, visual: scene.visual as string, dialogue: scene.dialogue as string };
  });
  let sourceNames: string[] | undefined;
  if (wrapper.manifest.sources !== undefined) {
    if (!Array.isArray(wrapper.manifest.sources) || wrapper.manifest.sources.length > 200) throw invalid();
    sourceNames = wrapper.manifest.sources.map(source => {
      if (!object(source) || !text(source.name, 100_000)) throw invalid();
      return source.name;
    });
  }
  return { entry, scenes, ...(sourceNames ? { sourceNames } : {}), manifest: wrapper.manifest };
}
export function paymentLabel(payment: LibraryPayment): string {
  if (payment.requiresReview) return "Payment needs review";
  const labels: Record<string, string> = { captured: "Paid", "awaiting-payment": "Payment pending", submitting: "Payment pending",
    uncertain: "Payment unconfirmed", declined: "Payment declined", "refund-pending": "Refund pending", "partially-refunded": "Partly refunded", refunded: "Refunded" };
  return labels[payment.status] || "Payment status unavailable";
}
export function productionLabel(entry: LibraryEntry): string {
  if (entry.production.mediaReady) return "Ready to watch";
  const labels: Record<string, string> = { prepared: "Prepared", queued: "Queued", submitting: "Starting", processing: "Rendering",
    uncertain: "Status needs review", failed: "Failed", completed: "Delivery pending", uploaded: "Delivery pending" };
  return labels[entry.production.status] || "Status unavailable";
}
export const localLibraryState = (film: Film): LibraryView => film.trashedAt ? "trash" : film.archivedAt ? "archived" : "active";
export function localLibraryPatch(action: LibraryAction): Partial<Film> {
  const at = new Date().toISOString();
  return action === "restore" ? { archivedAt: null, trashedAt: null }
    : action === "archive" ? { archivedAt: at, trashedAt: null } : { trashedAt: at };
}
export function initialWorkspaceView(hash: string, role: User["role"]): "admin" | "create" | "library" | "media" {
  if ((role === "owner" || role === "admin") && hash.startsWith("#admin")) return "admin";
  if (hash === "#media") return "media";
  return hash === "#create" ? "create" : "library";
}
