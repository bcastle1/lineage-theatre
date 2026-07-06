import type { RuntimeOption } from "../types";

export const ADMIN_ACCESS_CODE = "patriot";
export const ADMIN_EMAIL = "info@lineagetheater.com";
export const SITE_DOMAIN = "lineagetheater.com";
export const SITE_URL = "https://lineagetheater.com";
export const PUBLIC_LAUNCH_MODE =
  "Public static preview: no real customer records, payments, or admin data are stored on a server yet.";

export const runtimeOptions: RuntimeOption[] = [
  {
    id: "trailer",
    label: "1-3 min trailer",
    minutes: "1-3",
    basePrice: 0,
    description: "A moving preview with logline, source montage, and one emotional turn.",
  },
  {
    id: "short",
    label: "5-15 min short",
    minutes: "5-15",
    basePrice: 79,
    description: "A complete short film with three acts and a family-ready ending.",
  },
  {
    id: "featurette",
    label: "30-45 min featurette",
    minutes: "30-45",
    basePrice: 249,
    description: "A deeper documentary or cinematic story with character arcs.",
  },
  {
    id: "feature",
    label: "60-90 min feature",
    minutes: "60-90",
    basePrice: 699,
    description: "A long-form ancestor film plan prepared for premium rendering.",
  },
];

export const musicMoods = [
  {
    title: "Heritage Theme",
    tone: "Warm strings, piano, and restrained brass for family identity.",
  },
  {
    title: "Quiet Courage",
    tone: "Low cello, soft percussion, and hopeful harmonic lift.",
  },
  {
    title: "Homecoming",
    tone: "Acoustic textures and choir-like pads without lyrics.",
  },
  {
    title: "Turning Point",
    tone: "Rising orchestral pulse for decisive, PG-safe drama.",
  },
  {
    title: "Legacy",
    tone: "Expansive finale theme written as original app/user music.",
  },
];

export const sourceKindLabels = {
  photo: "Photo",
  audio: "Audio",
  document: "Document",
  video: "Video",
  date: "Date",
  story: "Story",
  record: "Record",
};

export function createId(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function inferSourceKind(file: File): keyof typeof sourceKindLabels {
  if (file.type.startsWith("image/")) return "photo";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.includes("pdf") || file.type.includes("document") || file.type.includes("text")) {
    return "document";
  }
  return "record";
}
