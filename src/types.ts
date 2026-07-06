export type ViewId = "creator" | "library" | "admin" | "publish";

export type MovieStyle = "Cinematic" | "Documentary";

export type Rating = "G" | "PG";

export type RuntimeId = "trailer" | "short" | "featurette" | "feature";

export type ProjectStatus =
  | "draft"
  | "trailer-ready"
  | "payment-pending"
  | "submitted"
  | "in-review"
  | "changes-requested"
  | "approved"
  | "full-movie-ready"
  | "published";

export type SourceKind =
  | "photo"
  | "audio"
  | "document"
  | "video"
  | "date"
  | "story"
  | "record";

export interface CustomerProfile {
  id: string;
  firstName: string;
  lastName: string;
  age: string;
  address: string;
  email: string;
  phone: string;
  consent: boolean;
  createdAt: string;
}

export interface AncestorProfile {
  name: string;
  birthDate: string;
  birthPlace: string;
  deathDate: string;
  homeland: string;
  height: string;
  build: string;
  knownRelatives: string;
  values: string;
  definingTraits: string;
  lifeSummary: string;
}

export interface SourceAsset {
  id: string;
  projectId: string;
  name: string;
  kind: SourceKind;
  type: string;
  size: number;
  addedAt: string;
  notes: string;
}

export interface CharacterSuggestion {
  id: string;
  name: string;
  role: string;
  traits: string;
  appearance: string;
  approved: boolean;
}

export interface StoryScene {
  id: string;
  title: string;
  timecode: string;
  purpose: string;
  visual: string;
  music: string;
}

export interface StoryRecommendation {
  logline: string;
  plot: string;
  climax: string;
  emotionalPromise: string;
  scenes: StoryScene[];
  characters: CharacterSuggestion[];
  musicDirection: string;
  contentNotes: string[];
  generatedAt: string;
}

export interface RuntimeOption {
  id: RuntimeId;
  label: string;
  minutes: string;
  basePrice: number;
  description: string;
}

export interface MoviePreferences {
  style: MovieStyle;
  rating: Rating;
  runtime: RuntimeId;
  realism: number;
  historicalFidelity: number;
  heroTone: number;
  publishToYoutube: boolean;
  publishToFamilyGallery: boolean;
  sendEmailLink: boolean;
  allowPublicDiscovery: boolean;
}

export interface PaymentRecord {
  id: string;
  amount: number;
  required: boolean;
  status: "not-required" | "awaiting-venmo" | "reported-paid" | "verified";
  venmoHandle: string;
  receiptEmailStatus: "not-sent" | "queued" | "sent";
  receiptNumber: string;
  updatedAt: string;
}

export interface MovieProject {
  id: string;
  customerId: string;
  title: string;
  ancestor: AncestorProfile;
  sources: SourceAsset[];
  preferences: MoviePreferences;
  story: StoryRecommendation;
  payment: PaymentRecord;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  adminNote: string;
  downloadUrl: string;
  youtubeUrl: string;
}

export interface AdminSettings {
  requireApproval: boolean;
  chargeFees: boolean;
  venmoHandle: string;
  pricing: Record<RuntimeId, number>;
  betaMessage: string;
}

export interface AppState {
  version: 1;
  activeView: ViewId;
  activeProjectId: string;
  customers: CustomerProfile[];
  projects: MovieProject[];
  adminSettings: AdminSettings;
  outbox: EmailOutboxItem[];
}

export interface EmailOutboxItem {
  id: string;
  to: string;
  subject: string;
  body: string;
  status: "queued" | "sent";
  createdAt: string;
}
