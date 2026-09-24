import { canStartFilmProduction, type FilmOrder } from "./checkout-contract";
import { productionInputHash, type FilmPaymentReference } from "./model";

type Request = (path: string, body?: unknown) => Promise<unknown>;
type PlanScene = { title: string; narration: string; visual: string; dialogue: string };
export type PaidFilmPlan = {
  orderId: string; quoteId: string; preparedId: string; manifestHash: string; filmId: string; sandbox: boolean;
  title: string; durationSeconds: number; scenes: PlanScene[];
  download: { id: string; manifestHash: string; manifest: Record<string, unknown> };
};
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === "string";
const unavailable = () => new Error("The saved version for this payment could not be verified. Your payment remains recorded. Check payment status or contact the administrator; do not pay again.");

// The browser draft and its local preparation may have changed or be absent.
// Only the immutable payment/order identity selects the paid server version.
export function paidOrderMatches(reference: FilmPaymentReference | null | undefined, order: FilmOrder | null, filmId: string): boolean {
  return Boolean(reference && order && order.id === reference.orderId && order.quoteId === reference.quoteId
    && order.preparedId === reference.preparedId && order.filmId === filmId && order.sandbox === reference.sandbox);
}
export function paidPlanMatches(plan: PaidFilmPlan | null, reference: FilmPaymentReference | null | undefined, order: FilmOrder | null, filmId: string): boolean {
  return Boolean(plan && reference && paidOrderMatches(reference, order, filmId) && plan.orderId === reference.orderId
    && plan.quoteId === reference.quoteId && plan.preparedId === reference.preparedId && plan.manifestHash === reference.manifestHash
    && plan.filmId === filmId && plan.sandbox === reference.sandbox);
}

export async function loadPaidFilmPlan({ request, reference, order, filmId }: {
  request: Request; reference: FilmPaymentReference; order: FilmOrder; filmId: string;
}): Promise<PaidFilmPlan> {
  if (!paidOrderMatches(reference, order, filmId)) throw unavailable();
  const value = await request(`/api/studio?action=manifest&id=${encodeURIComponent(reference.preparedId)}`);
  if (!object(value) || value.id !== reference.preparedId || value.manifestHash !== reference.manifestHash
    || !object(value.manifest) || value.manifest.filmId !== filmId || !text(value.manifest.title)
    || value.manifest.title.length > 200 || !Number.isFinite(value.manifest.targetDurationSeconds)
    || Number(value.manifest.targetDurationSeconds) < 15 || Number(value.manifest.targetDurationSeconds) > 600
    || !object(value.manifest.screenplay) || !Array.isArray(value.manifest.screenplay.scenes)
    || !value.manifest.screenplay.scenes.length || value.manifest.screenplay.scenes.length > 30) throw unavailable();
  const serialized = JSON.stringify(value.manifest);
  // The server caps screenplay size, while the full manifest also repeats its
  // scenes in shots. Verify the exact saved content without a smaller new cap.
  if (await productionInputHash(serialized) !== reference.manifestHash) throw unavailable();
  const scenes = value.manifest.screenplay.scenes.map((scene: unknown) => {
    if (!object(scene) || ![scene.title, scene.narration, scene.visual, scene.dialogue].every(text)) throw unavailable();
    return { title: scene.title as string, narration: scene.narration as string, visual: scene.visual as string, dialogue: scene.dialogue as string };
  });
  return { orderId: reference.orderId, quoteId: reference.quoteId, preparedId: reference.preparedId,
    manifestHash: reference.manifestHash, filmId, sandbox: reference.sandbox, title: value.manifest.title,
    durationSeconds: Number(value.manifest.targetDurationSeconds), scenes,
    download: { id: reference.preparedId, manifestHash: reference.manifestHash, manifest: structuredClone(value.manifest) } };
}

export function paidFilmStartRequest({ plan, reference, order, filmId, productionAvailable }: {
  plan: PaidFilmPlan | null; reference: FilmPaymentReference; order: FilmOrder | null; filmId: string; productionAvailable: boolean;
}) {
  if (!canStartFilmProduction(order, productionAvailable, paidPlanMatches(plan, reference, order, filmId))) {
    throw new Error("Review the saved paid version and check production availability before starting. Your payment remains recorded.");
  }
  // Never send the current draft or rebind its plan to this payment.
  return { action: "startProduction", preparedId: reference.preparedId, orderId: reference.orderId, productionConsent: true };
}
