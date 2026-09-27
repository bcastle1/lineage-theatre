export type GenerationIdentity = { preparedId: string; manifestHash: string; filmId: string; orderId: string };
export type GenerationAttempt = GenerationIdentity & {
  status: "submitting" | "processing" | "verifying" | "failed" | "uncertain";
  submittedAt: string; checkedAt?: string | null; elapsedSeconds: number; estimateAvailable: false;
};
export function normalizeGenerationAttempt(value: unknown, expected: GenerationIdentity): GenerationAttempt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The generation status could not be verified.");
  const record = value as Record<string, unknown>;
  if (Object.entries(expected).some(([key, item]) => record[key] !== item)
    || !["submitting", "processing", "verifying", "failed", "uncertain"].includes(String(record.status))
    || typeof record.submittedAt !== "string" || !Number.isFinite(Date.parse(record.submittedAt))
    || (record.checkedAt != null && (typeof record.checkedAt !== "string" || !Number.isFinite(Date.parse(record.checkedAt))))
    || !Number.isSafeInteger(record.elapsedSeconds) || Number(record.elapsedSeconds) < 0 || record.estimateAvailable !== false)
    throw new Error("The generation status could not be verified.");
  return { ...expected, status: record.status as GenerationAttempt["status"], submittedAt: record.submittedAt,
    checkedAt: record.checkedAt as string | null | undefined, elapsedSeconds: Number(record.elapsedSeconds), estimateAvailable: false };
}
export function generationStatusLabel(attempt: GenerationAttempt): string {
  return { submitting: "Submitting generation request", processing: "Generation requested", verifying: "Checking generated video",
    failed: "Generation needs attention", uncertain: "Generation request needs review" }[attempt.status];
}
