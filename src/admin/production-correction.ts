export type ProductionCorrectionInput = {
  originalOrderId: string; preparedId: string; manifestHash: string; budget: string; reason: string; confirmed: boolean;
};
export function productionCorrectionRequest(input: ProductionCorrectionInput) {
  const originalOrderId = input.originalOrderId.trim(), preparedId = input.preparedId.trim(), manifestHash = input.manifestHash.trim(), reason = input.reason.trim();
  const cents = /^\d+(?:\.\d{1,2})?$/.test(input.budget.trim()) ? Math.round(Number(input.budget) * 100) : NaN;
  if (!/^[a-f0-9]{64}$/.test(originalOrderId)) throw new Error("Enter the original payment's full order reference.");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(preparedId)) throw new Error("Enter the corrected film's saved plan ID.");
  if (!/^[a-f0-9]{64}$/.test(manifestHash)) throw new Error("Enter the corrected saved plan's full manifest hash.");
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 1980) throw new Error("Enter a production budget from $0.01 to $19.80.");
  if (reason.length < 10 || reason.length > 500) throw new Error("Describe the correction in 10 to 500 characters.");
  if (!input.confirmed) throw new Error("Confirm this single correction and its production budget before continuing.");
  return { action: "createProductionCorrection" as const, originalOrderId, preparedId, manifestHash, maximumCostCents: cents,
    reason, confirmed: true as const };
}
export type ProductionCorrection = {
  correctionId: string; originalOrderId: string; preparedId: string; manifestHash: string; maximumCostCents: number;
  status: "authorized"; customerChargeCents: 0;
};
export function verifyProductionCorrection(value: unknown, expected: ReturnType<typeof productionCorrectionRequest>): ProductionCorrection {
  const result = value && typeof value === "object" ? (value as { correction?: unknown }).correction : null;
  if (!result || typeof result !== "object") throw new Error("The correction result could not be verified. Check the saved film status before trying again.");
  const correction = result as ProductionCorrection;
  if (!/^[a-f0-9]{64}$/.test(correction.correctionId) || correction.status !== "authorized" || correction.customerChargeCents !== 0
    || (["originalOrderId", "preparedId", "manifestHash", "maximumCostCents"] as const).some(key => correction[key] !== expected[key])) {
    throw new Error("The correction result could not be verified. Check the saved film status before trying again.");
  }
  return { correctionId: correction.correctionId, originalOrderId: correction.originalOrderId, preparedId: correction.preparedId,
    manifestHash: correction.manifestHash, maximumCostCents: correction.maximumCostCents, status: "authorized", customerChargeCents: 0 };
}
