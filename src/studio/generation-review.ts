import type { GenerationIdentity } from "./generation-attempt";

export type GenerationReview = GenerationIdentity & ({
  status: "awaiting-review" | "approved"; artifactSha256: string; durationSeconds: number;
  width: number; height: number; hasAudio: true; previewReady: true; previewUrl: string;
} | { status: "needs-attention"; message: string });
export function normalizeGenerationReview(value: unknown, expected: GenerationIdentity): GenerationReview | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The generated film review could not be verified.");
  const record = value as Record<string, unknown>;
  const previewUrl = `/api/studio?action=reviewVideo&id=${expected.preparedId}&artifact=${record.artifactSha256}`;
  if (Object.entries(expected).some(([key, item]) => record[key] !== item)) throw new Error("The generated film review could not be verified.");
  if (record.status === "needs-attention") return { ...expected, status: "needs-attention", message: "The returned video could not pass verification. Your payment and saved film remain recorded." };
  if (!["awaiting-review", "approved"].includes(String(record.status))
    || typeof record.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.artifactSha256)
    || typeof record.durationSeconds !== "number" || !Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0 || record.durationSeconds > 600
    || !Number.isSafeInteger(record.width) || Number(record.width) < 1 || !Number.isSafeInteger(record.height) || Number(record.height) < 1
    || record.hasAudio !== true || record.previewReady !== true || record.previewUrl !== previewUrl)
    throw new Error("The generated film review could not be verified.");
  return { ...expected, status: record.status as "awaiting-review" | "approved", artifactSha256: record.artifactSha256,
    durationSeconds: record.durationSeconds, width: Number(record.width), height: Number(record.height), hasAudio: true, previewReady: true, previewUrl };
}
