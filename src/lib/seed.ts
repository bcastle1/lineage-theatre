import type { AppState, MovieProject, StoryRecommendation } from "../types";
import { ADMIN_EMAIL, createId, nowIso } from "./runtime";

const customerId = createId("customer");
const projectId = createId("project");

const seedStory: StoryRecommendation = {
  logline:
    "A determined dockworker leaves uncertainty behind and builds a future his descendants can still feel.",
  plot:
    "The film opens with fragments of home, follows the ancestor through a demanding crossing, and resolves with the quiet proof that sacrifice became shelter for future generations.",
  climax:
    "The turning point centers on a moment of moral courage: choosing family duty over personal comfort when the next generation needs him most.",
  emotionalPromise:
    "The ancestor is portrayed as honorable, capable, resilient, and deeply human, with a family-friendly tone.",
  musicDirection:
    "Original cinematic orchestration with warm strings, piano, low percussion, and a legacy theme that remains unique to the project.",
  contentNotes: [
    "Keep all scenes G/PG and mark uncertain details as dramatized.",
    "Use 'Based on a true story' language for generated material.",
    "Favor dignity and best-light character portrayal without inventing harmful claims.",
  ],
  generatedAt: nowIso(),
  characters: [
    {
      id: createId("character"),
      name: "Thomas Whitcomb",
      role: "Ancestor hero",
      traits: "Determined, protective, physically capable, quietly funny",
      appearance:
        "Athletic build, kind eyes, period work coat, clean heroic silhouette based on family source material when available.",
      approved: true,
    },
    {
      id: createId("character"),
      name: "Eliza Whitcomb",
      role: "Spouse and emotional anchor",
      traits: "Insightful, practical, brave under pressure",
      appearance: "Elegant period clothing, expressive face, warm presence.",
      approved: true,
    },
  ],
  scenes: [
    {
      id: createId("scene"),
      title: "Origins",
      timecode: "00:00",
      purpose: "Establish family roots and the promise of a life worth remembering.",
      visual: "Old map, home exterior, hands over letters, morning light.",
      music: "Heritage Theme",
    },
    {
      id: createId("scene"),
      title: "Crossing",
      timecode: "00:42",
      purpose: "Show sacrifice, movement, and hope through a historical journey.",
      visual: "Shipyard, weathered wood, packed trunk, careful farewell.",
      music: "Quiet Courage",
    },
    {
      id: createId("scene"),
      title: "Trial",
      timecode: "01:18",
      purpose: "Reveal the obstacle that makes the ancestor's choices meaningful.",
      visual: "Storm clouds, workplace pressure, family waiting by lamplight.",
      music: "Turning Point",
    },
    {
      id: createId("scene"),
      title: "Legacy",
      timecode: "02:14",
      purpose: "Connect the ancestor's effort to the living family today.",
      visual: "Generations of portraits, sunrise over a modern family table.",
      music: "Legacy",
    },
  ],
};

const seedProject: MovieProject = {
  id: projectId,
  customerId,
  title: "The Whitcomb Crossing",
  ancestor: {
    name: "Thomas Whitcomb",
    birthDate: "1867-04-12",
    birthPlace: "Portsmouth, England",
    deathDate: "1934-09-03",
    homeland: "England to Massachusetts",
    height: "About 5 ft 10 in",
    build: "Strong, athletic, broad shoulders",
    knownRelatives: "Eliza Whitcomb, Samuel Whitcomb, Anna Whitcomb",
    values: "Faith, courage, loyalty, craftsmanship, family duty",
    definingTraits: "Hardworking, warm with children, brave in uncertain moments",
    lifeSummary:
      "Family stories say Thomas crossed the Atlantic as a young man, worked near shipyards, and helped establish a home that gave later generations stability.",
  },
  sources: [
    {
      id: createId("source"),
      projectId,
      name: "shipyard-family-photo.jpg",
      kind: "photo",
      type: "image/jpeg",
      size: 482100,
      addedAt: nowIso(),
      notes: "Seed sample. Replace with real family photos, records, audio, and written memories.",
    },
  ],
  preferences: {
    style: "Cinematic",
    rating: "PG",
    runtime: "trailer",
    realism: 92,
    historicalFidelity: 88,
    heroTone: 94,
    publishToYoutube: false,
    publishToFamilyGallery: true,
    sendEmailLink: true,
    allowPublicDiscovery: false,
  },
  story: seedStory,
  payment: {
    id: createId("payment"),
    amount: 0,
    required: false,
    status: "not-required",
    venmoHandle: "@ERik-Castle-1",
    receiptEmailStatus: "not-sent",
    receiptNumber: "LT-BETA-0001",
    updatedAt: nowIso(),
  },
  status: "trailer-ready",
  createdAt: nowIso(),
  updatedAt: nowIso(),
  adminNote: "Seed project ready for local testing.",
  downloadUrl: "",
  youtubeUrl: "",
};

export function createSeedState(): AppState {
  return {
    version: 1,
    activeView: "creator",
    activeProjectId: seedProject.id,
    customers: [
      {
        id: customerId,
        firstName: "Erik",
        lastName: "Castle",
        age: "42",
        address: "Local beta record",
        email: ADMIN_EMAIL,
        phone: "",
        consent: true,
        createdAt: nowIso(),
      },
    ],
    projects: [seedProject],
    adminSettings: {
      requireApproval: true,
      chargeFees: false,
      venmoHandle: "@ERik-Castle-1",
      betaMessage:
        "Beta mode is local-first. Fees can be turned on in Admin when you are ready to charge.",
      pricing: {
        trailer: 0,
        short: 79,
        featurette: 249,
        feature: 699,
      },
    },
    outbox: [],
  };
}
