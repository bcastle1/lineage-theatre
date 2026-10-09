export type FilmProductionProgressInput = {
  paid: boolean; ready: boolean; available?: boolean; status?: string | null; completedShots?: number; shotCount?: number;
  reportedPercent?: number | null; progress?: unknown; needsAttention?: boolean; now?: number;
};
type Stage = "waiting" | "queued" | "creating" | "finishing" | "ready" | "attention";
type Timing = "learning" | "available" | "delayed" | "stale" | "paused" | "complete";
export type FilmProgressSnapshot = { version: 1; stage: Stage; percent: number | null;
  basis: "confirmed-work" | "measured-estimate"; timing: Timing; asOf: string; observedAt: string | null;
  completedScenes: number; totalScenes: number;
  estimate: { earliestAt: string; latestAt: string; sampleCount: number } | null };
export type FilmProductionProgressView = { percent: number | null; label: string; stage: string; stageKey: Stage;
  explanation: string; timing: Timing; remaining: string; estimate: FilmProgressSnapshot["estimate"]; updatedAt: string | null };
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

// Invalid telemetry never invents a percentage, deadline or completion.
// Watch and download remain independently verified by the caller.
export function normalizeFilmProgress(value: unknown): FilmProgressSnapshot | null {
  if (!object(value) || value.version !== 1 || !["waiting", "queued", "creating", "finishing", "ready", "attention"].includes(String(value.stage))
    || !["learning", "available", "delayed", "stale", "paused", "complete"].includes(String(value.timing))
    || !["confirmed-work", "measured-estimate"].includes(String(value.basis)) || !date(value.asOf)
    || value.observedAt !== null && !date(value.observedAt)
    || value.percent !== null && (!count(value.percent) || value.percent > 100)
    || !count(value.completedScenes) || !count(value.totalScenes) || value.completedScenes > value.totalScenes) return null;
  let estimate: FilmProgressSnapshot["estimate"] = null;
  if (value.estimate !== null) {
    if (!object(value.estimate) || value.timing !== "available" || !["creating", "finishing"].includes(String(value.stage))
      || !date(value.estimate.earliestAt) || !date(value.estimate.latestAt)
      || Date.parse(value.estimate.latestAt) < Date.parse(value.estimate.earliestAt)
      || !count(value.estimate.sampleCount) || value.estimate.sampleCount < 5 || value.estimate.sampleCount > 30) return null;
    estimate = { earliestAt: value.estimate.earliestAt, latestAt: value.estimate.latestAt, sampleCount: value.estimate.sampleCount };
  } else if (value.timing === "available") return null;
  return { version: 1, stage: value.stage as Stage, percent: value.percent as number | null, basis: value.basis as FilmProgressSnapshot["basis"],
    timing: value.timing as Timing, asOf: value.asOf, observedAt: value.observedAt as string | null,
    completedScenes: value.completedScenes, totalScenes: value.totalScenes, estimate };
}
const titles: Record<Stage, string> = { waiting: "Preparing production", queued: "Your film is queued", creating: "Creating your film",
  finishing: "Finishing and checking your video", ready: "Ready to watch", attention: "Your film needs attention" };
const remainingText: Record<Timing, string> = { learning: "Calculating your delivery estimate", available: "", delayed: "Taking longer than expected",
  stale: "Waiting for a fresh update", paused: "Delivery estimate paused", complete: "Ready now" };

export function filmProductionProgress(input: FilmProductionProgressInput): FilmProductionProgressView {
  const snapshot = normalizeFilmProgress(input.progress), now = input.now ?? Date.now();
  let stageKey: Stage = snapshot?.stage ?? (["failed", "uncertain"].includes(input.status || "") ? "attention"
    : ["completed", "uploaded", "verifying", "awaiting-assembly"].includes(input.status || "") ? "finishing"
      : ["processing", "submitting", "submitted"].includes(input.status || "") ? "creating" : input.status === "queued" ? "queued" : "waiting");
  if (input.needsAttention) stageKey = "attention";
  if (stageKey === "ready" && !input.ready) stageKey = "finishing";
  if (input.paid && input.ready) stageKey = "ready";
  if (input.paid && stageKey === "waiting" && input.available === false) return {
    percent: 0, label: "Production progress", stageKey, stage: "Production has not started",
    explanation: "Film production is currently unavailable. Your payment and saved film are safe; you do not need to pay again.",
    timing: "paused", remaining: "Delivery estimate unavailable", estimate: null, updatedAt: snapshot?.observedAt ?? null,
  };
  let percent: number | null = snapshot?.percent ?? (stageKey === "creating" ? 10 : stageKey === "finishing" ? 90 : stageKey === "queued" ? 5 : 0);
  if (!snapshot && stageKey === "creating" && count(input.completedShots) && count(input.shotCount) && input.shotCount > 0 && input.completedShots <= input.shotCount)
    percent = 10 + Math.floor(input.completedShots / input.shotCount * 75);
  if (!snapshot && typeof input.reportedPercent === "number" && Number.isFinite(input.reportedPercent) && input.reportedPercent >= 0 && input.reportedPercent <= 100)
    percent = Math.round(input.reportedPercent);
  let timing: Timing = snapshot?.timing ?? "learning", estimate = snapshot?.estimate ?? null;
  if (snapshot && now - Date.parse(snapshot.asOf) > 600_000 && ["creating", "finishing"].includes(stageKey)) timing = "stale";
  if (estimate && Date.parse(estimate.latestAt) <= now) timing = "delayed";
  if (!input.paid) { percent = null; timing = "learning"; stageKey = "waiting"; }
  else if (stageKey === "ready") { percent = 100; timing = "complete"; }
  else if (stageKey === "attention") { percent = null; timing = "paused"; }
  else { percent = Math.min(99, percent); if (timing === "complete") timing = "learning"; }
  if (timing !== "available") estimate = null;
  let remaining = remainingText[timing];
  if (estimate) {
    const low = Math.max(0, Math.ceil((Date.parse(estimate.earliestAt) - now) / 60_000));
    const high = Math.max(1, Math.ceil((Date.parse(estimate.latestAt) - now) / 60_000));
    remaining = low === 0 ? `Up to ${high} ${high === 1 ? "minute" : "minutes"} remaining`
      : low === high ? `About ${high} ${high === 1 ? "minute" : "minutes"} remaining` : `About ${low}–${high} minutes remaining`;
  }
  const explanation = timing === "available" ? "Estimated from recent films with the same production settings. The window updates as your film progresses."
    : timing === "delayed" ? "Your film is taking longer than the measured delivery window. Your progress is saved; we will update the estimate when it can be confirmed."
      : timing === "stale" ? "The last confirmed progress is shown. We are waiting for an update before adjusting the estimate."
        : timing === "paused" ? "The Lineage Theatre team needs to check this film. Your payment and saved version are safe; you do not need to pay again."
          : timing === "complete" ? "Your finished film is available to watch and download in your library."
            : "Progress follows confirmed production stages. A delivery window appears when enough measured timing is available.";
  return { percent, label: stageKey === "ready" ? "Production complete" : "Estimated progress", stageKey, stage: input.paid ? titles[stageKey] : "Waiting for payment confirmation",
    explanation, timing, remaining, estimate, updatedAt: snapshot?.observedAt ?? null };
}
