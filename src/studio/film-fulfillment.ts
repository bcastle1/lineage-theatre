import type { FilmOrder } from "./checkout-contract";
import type { FilmPaymentReference } from "./model";
import type { LibraryEntry } from "./film-library";

export type ProductionStatus = { id: string; manifestHash: string; status: string; completedShots: number; shotCount: number; preparationOnly: boolean; mediaReady?: boolean; needsAttention?: boolean };

// A job's completed flag alone is not delivery. The library verifies stored
// media and payment access before returning these exact private playback URLs.
export function filmReadyToWatch(entry: LibraryEntry | null, reference: FilmPaymentReference | null, filmId: string): boolean {
  return Boolean(entry && reference && entry.kind === "plan" && entry.id === reference.preparedId && entry.filmId === filmId
    && entry.manifestHash === reference.manifestHash && entry.production.status === "completed" && entry.production.mediaReady
    && entry.mediaUrl === `/api/studio?action=productionMedia&id=${reference.preparedId}`
    && entry.downloadUrl === `/api/studio?action=productionMedia&id=${reference.preparedId}&download=1`);
}

export function filmFulfillmentProgress(order: FilmOrder | null, production: ProductionStatus | null, productionAvailable: boolean, ready: boolean) {
  const paid = order?.status === "captured" && order.charged === true && order.receiptAvailable && !order.requiresReview && order.refundedCents === 0;
  const payment = paid ? order.sandbox ? "Test payment recorded" : "Payment received" : order?.requiresReview ? "Needs review" : "Awaiting confirmation";
  if (!paid) return { payment, paid: false, production: "Waiting for payment", watch: "Not ready yet", ready: false };
  if (ready) return { payment, paid: true, production: "Completed", watch: "Ready to watch", ready: true };
  const creation = !production ? "Checking status" : production.needsAttention || ["failed", "uncertain"].includes(production.status)
    ? "Needs attention" : production.status === "completed" ? "Verifying finished video"
      : production.status === "queued" ? "Queued" : ["submitting", "processing"].includes(production.status)
        ? "Creating your film" : productionAvailable ? "Ready to start" : "Not started";
  return { payment, paid: true, production: creation, watch: "Not ready yet", ready: false };
}

export function generationTimeEstimate(ready: boolean, productionAvailable?: boolean): string {
  if (ready) return "Complete — ready to watch.";
  if (productionAvailable === false) return "Unavailable while film creation is not enabled. Rendering has no confirmed start time.";
  return "Not yet available. A reliable time estimate requires verified generation timing.";
}
