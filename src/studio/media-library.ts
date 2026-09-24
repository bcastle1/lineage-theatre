import { api } from "./model";
export type MediaItem = {
  id: string;
  ownerEmail: string;
  name: string;
  originalName: string;
  contentType: string;
  size: number;
  status: "pending" | "ready" | "deleting";
  customerState: "active" | "archived" | "trash";
  adminArchivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  project: { id: string; title: string } | null;
  mediaUrl?: string;
};
export type MediaPage = { items: MediaItem[]; cursor?: string };
export const mediaAccept =
  ".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.txt,.md,.ged,.csv,.mp3,.wav,.m4a,.ogg,.mp4,.mov,.webm";
export async function uploadMedia(
  file: File,
  id: string = crypto.randomUUID(),
  project?: { id: string; title: string },
  progress?: (percent: number) => void,
) {
  const reserved = await api<{
    item: MediaItem;
    resumed: boolean;
    upload?: { pathname: string; clientPayload: string; contentType: string };
  }>("/api/media", {
    action: "reserve",
    id,
    name: file.name,
    size: file.size,
    project,
    retentionAccepted: true,
  });
  if (!reserved.upload) return reserved.item;
  // Retries verify an already-uploaded object before requesting another immutable upload.
  if (reserved.resumed) {
    try {
      return (
        await api<{ item: MediaItem }>("/api/media", { action: "finalize", id })
      ).item;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("status" in error) ||
        error.status !== 409
      )
        throw error;
    }
  }
  const { upload } = await import("@vercel/blob/client");
  await upload(reserved.upload.pathname, file, {
    access: "private",
    handleUploadUrl: "/api/media",
    clientPayload: reserved.upload.clientPayload,
    contentType: reserved.upload.contentType,
    multipart: file.size > 4 * 1024 * 1024,
    onUploadProgress: (event) => progress?.(Math.round(event.percentage)),
  });
  return (
    await api<{ item: MediaItem }>("/api/media", { action: "finalize", id })
  ).item;
}
export async function downloadMediaFile(item: MediaItem): Promise<File> {
  if (!item.mediaUrl) throw new Error("This upload has not finished yet.");
  const response = await fetch(item.mediaUrl, { credentials: "same-origin" });
  if (!response.ok)
    throw new Error(
      "This source could not be opened. Refresh the library and try again.",
    );
  return new File([await response.blob()], item.name, {
    type: item.contentType,
  });
}
