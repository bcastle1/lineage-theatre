export type FilmProductionProgressInput = {
  paid: boolean;
  // Set only after the saved film's private playback and download are verified.
  ready: boolean;
  status?: string | null;
  completedShots?: number;
  shotCount?: number;
  // Only a validated percentage supplied by the production status response.
  reportedPercent?: number | null;
};
export type FilmProductionProgressView = {
  percent: number | null;
  label: "Estimated progress" | "Reported progress" | "Production progress";
  stage: string;
  explanation: string;
};
const estimatedExplanation = "A frame-by-frame production percentage is not available. This estimate changes only when a production stage is confirmed.";
export function filmProductionProgress(input: FilmProductionProgressInput): FilmProductionProgressView {
  if (!input.paid) return { percent: null, label: "Production progress", stage: "Waiting for payment confirmation", explanation: "Film creation progress will appear after payment is confirmed." };
  if (input.ready) return { percent: 100, label: "Production progress", stage: "Complete — ready to watch", explanation: "Your finished video is available to watch and download." };
  if (["failed", "uncertain"].includes(input.status || "")) return { percent: null, label: "Production progress", stage: "Needs attention", explanation: "Progress cannot be confirmed. Your saved request needs review; your video is not ready to watch." };
  const stages: Record<string, { percent: number; stage: string }> = {
    prepared: { percent: 0, stage: "Not started" }, "not-started": { percent: 0, stage: "Not started" },
    queued: { percent: 10, stage: "Queued" }, submitted: { percent: 10, stage: "Request submitted" }, submitting: { percent: 10, stage: "Submitting request" },
    processing: { percent: 20, stage: "Creating your film" },
    verifying: { percent: 85, stage: "Checking finished video" }, completed: { percent: 85, stage: "Checking finished video" }, uploaded: { percent: 85, stage: "Checking finished video" },
  };
  const stage = stages[input.status || ""];
  if (!stage) return { percent: null, label: "Production progress", stage: "Checking status", explanation: "A progress estimate is not available until the production stage is confirmed." };
  if (typeof input.reportedPercent === "number" && Number.isFinite(input.reportedPercent) && input.reportedPercent >= 0 && input.reportedPercent <= 100) {
    return { percent: Math.min(99, Math.round(input.reportedPercent)), label: "Reported progress", stage: stage.stage,
      explanation: "Reported production progress. Completion is confirmed only when your finished video is ready to watch." };
  }
  if (input.status === "processing" && Number.isSafeInteger(input.shotCount) && Number(input.shotCount) > 0
    && Number.isSafeInteger(input.completedShots) && Number(input.completedShots) >= 0 && Number(input.completedShots) <= Number(input.shotCount)) {
    return { percent: 20 + Math.floor(Number(input.completedShots) / Number(input.shotCount) * 60), label: "Estimated progress",
      stage: `Creating your film · ${input.completedShots} of ${input.shotCount} shots complete`, explanation: estimatedExplanation };
  }
  return { ...stage, label: "Estimated progress", explanation: estimatedExplanation };
}
