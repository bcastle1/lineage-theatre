export type GenerationIdentity = { preparedId: string; manifestHash: string; filmId: string; orderId: string };
const diagnosticCodes = ["MAGICLIGHT_TIMEOUT", "MAGICLIGHT_HTTP_REJECTED", "MAGICLIGHT_INVALID_RESPONSE", "MAGICLIGHT_RESPONSE_TOO_LARGE",
  "MAGICLIGHT_TRANSPORT_FAILED", "MAGICLIGHT_PROVIDER_REJECTED", "MAGICLIGHT_INVALID_TEXT", "MAGICLIGHT_INVALID_URL", "GENERATION_RESULT_UNCONFIRMED"] as const;
const diagnosticStages = ["transport", "response", "body", "envelope", "provider", "task"] as const;
export type GenerationDiagnostic = { code: typeof diagnosticCodes[number]; providerCode?: number; httpStatus?: number; stage?: typeof diagnosticStages[number] };
export type GenerationAttempt = GenerationIdentity & {
  status: "submitting" | "processing" | "verifying" | "failed" | "uncertain";
  submittedAt: string; checkedAt?: string | null; elapsedSeconds: number; estimateAvailable: false;
  diagnostic?: GenerationDiagnostic;
  recovery?: { kind: "provider-review-required"; canRetry: false }
    | { kind: "replacement-available"; canRetry: true; expectedChangeId: string };
};
const invalidStatus = () => new Error("The generation status could not be verified.");
function normalizeDiagnostic(value: unknown): GenerationDiagnostic | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStatus();
  const record = value as Record<string, unknown>;
  if (!diagnosticCodes.includes(record.code as GenerationDiagnostic["code"])
    || record.providerCode !== undefined && !Number.isSafeInteger(record.providerCode)
    || record.stage !== undefined && !diagnosticStages.includes(record.stage as NonNullable<GenerationDiagnostic["stage"]>)
    || record.httpStatus !== undefined && (!Number.isSafeInteger(record.httpStatus) || Number(record.httpStatus) < 100 || Number(record.httpStatus) > 599)) throw invalidStatus();
  return { code: record.code as GenerationDiagnostic["code"],
    ...(record.stage !== undefined ? { stage: record.stage as NonNullable<GenerationDiagnostic["stage"]> } : {}),
    ...(record.providerCode !== undefined ? { providerCode: Number(record.providerCode) } : {}),
    ...(record.httpStatus !== undefined ? { httpStatus: Number(record.httpStatus) } : {}) };
}
export function normalizeGenerationAttempt(value: unknown, expected: GenerationIdentity): GenerationAttempt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStatus();
  const record = value as Record<string, unknown>;
  if (Object.entries(expected).some(([key, item]) => record[key] !== item)
    || !["submitting", "processing", "verifying", "failed", "uncertain"].includes(String(record.status))
    || typeof record.submittedAt !== "string" || !Number.isFinite(Date.parse(record.submittedAt))
    || (record.checkedAt != null && (typeof record.checkedAt !== "string" || !Number.isFinite(Date.parse(record.checkedAt))))
    || !Number.isSafeInteger(record.elapsedSeconds) || Number(record.elapsedSeconds) < 0 || record.estimateAvailable !== false)
    throw invalidStatus();
  const diagnostic = normalizeDiagnostic(record.diagnostic);
  let recovery: GenerationAttempt["recovery"];
  if (record.recovery !== undefined) {
    if (!record.recovery || typeof record.recovery !== "object" || Array.isArray(record.recovery)) throw invalidStatus();
    const request = record.recovery as Record<string, unknown>;
    if (request.kind === "provider-review-required" && request.canRetry === false) recovery = { kind: request.kind, canRetry: false };
    else if (record.status === "uncertain" && request.kind === "replacement-available" && request.canRetry === true
      && typeof request.expectedChangeId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.expectedChangeId))
      recovery = { kind: request.kind, canRetry: true, expectedChangeId: request.expectedChangeId };
    else throw invalidStatus();
  }
  return { ...expected, status: record.status as GenerationAttempt["status"], submittedAt: record.submittedAt,
    checkedAt: record.checkedAt as string | null | undefined, elapsedSeconds: Number(record.elapsedSeconds), estimateAvailable: false,
    ...(diagnostic ? { diagnostic } : {}), ...(recovery ? { recovery } : {}) };
}
export function generationStatusLabel(attempt: GenerationAttempt): string {
  if (attempt.recovery) return "Generation request needs review";
  return { submitting: "Submitting generation request", processing: "Generation requested", verifying: "Checking generated video",
    failed: "Generation needs attention", uncertain: "Generation request needs review" }[attempt.status];
}
export function generationReplacementRequest(attempt: GenerationAttempt | null, expected: GenerationIdentity, consent: boolean) {
  if (consent !== true || attempt?.status !== "uncertain" || attempt.recovery?.kind !== "replacement-available"
    || attempt.recovery.canRetry !== true || Object.entries(expected).some(([key, value]) => attempt[key as keyof GenerationIdentity] !== value)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attempt.recovery.expectedChangeId)) return null;
  return { action: "replaceFilmGeneration" as const, preparedId: expected.preparedId, orderId: expected.orderId,
    expectedChangeId: attempt.recovery.expectedChangeId, consent: true as const, acknowledgePossibleDuplicate: true as const };
}
export function generationAttemptExplanation(attempt: GenerationAttempt): string {
  if (attempt.status === "verifying") return "A video result was returned. Watch film unlocks after its technical checks and content review are complete.";
  if (attempt.status === "failed") return "The generation provider reported that this request failed. Your payment and saved screenplay are preserved. Review this request before authorizing any replacement.";
  if (attempt.status === "uncertain" || attempt.recovery) return "Generation has not been confirmed. This saved request needs review; time since the request does not indicate production progress. Your payment is recorded.";
  if (attempt.status === "submitting") return "The generation request is being checked. Acceptance has not yet been confirmed. No additional request will be sent automatically.";
  return "The generation provider accepted the saved request. This page checks that same request for a result. You can return to this film in your library.";
}
export function generationDiagnosticExplanation(attempt: GenerationAttempt): string | null {
  if (!["uncertain", "failed"].includes(attempt.status) && !attempt.recovery) return null;
  if (attempt.status === "failed" && !attempt.diagnostic && !attempt.recovery) return null;
  if (!attempt.diagnostic) return "A detailed response was not saved for this request. We cannot tell whether the generation provider accepted it.";
  const explanations: Record<GenerationDiagnostic["code"], string> = {
    MAGICLIGHT_TIMEOUT: "The request timed out before its outcome could be confirmed. It may have been accepted.",
    MAGICLIGHT_HTTP_REJECTED: "The generation service returned an unsuccessful HTTP response. This alone does not confirm whether a job was created.",
    MAGICLIGHT_INVALID_RESPONSE: "The generation service response could not be verified, so its outcome remains unconfirmed.",
    MAGICLIGHT_RESPONSE_TOO_LARGE: "The generation service response exceeded the response limit. Its outcome remains unconfirmed.",
    MAGICLIGHT_TRANSPORT_FAILED: "The connection failed before the request outcome could be confirmed. It may have been accepted.",
    MAGICLIGHT_PROVIDER_REJECTED: "The generation service returned a response code that does not confirm acceptance. The code needs provider review.",
    MAGICLIGHT_INVALID_TEXT: "The screenplay did not meet the submission format requirements.",
    MAGICLIGHT_INVALID_URL: "An address did not meet the generation request requirements.",
    GENERATION_RESULT_UNCONFIRMED: "The generation request outcome could not be confirmed.",
  };
  return explanations[attempt.diagnostic.code];
}
