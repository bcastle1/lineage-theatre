import type { ProductionStatus } from './film-fulfillment';
import type { FilmQuote } from './checkout-contract';

export const PRE_RENDER_FLOW = 'render-before-payment-v1';
export type PreRenderPrice = { amountCents: number; currency: 'USD'; preparedId: string; manifestHash: string };
export type PreRenderStatus = ProductionStatus & { deliveryFlow: typeof PRE_RENDER_FLOW; artifactReady: boolean; purchaseReady: boolean; paymentLocked: boolean; price: PreRenderPrice };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function normalizePreRenderStatus(value: unknown, expected: { id: string; manifestHash: string }): PreRenderStatus | null {
  if (!object(value) || value.deliveryFlow !== PRE_RENDER_FLOW) return null;
  const p = value.price;
  if (value.id !== expected.id || value.manifestHash !== expected.manifestHash
    || !['prepared', 'queued', 'submitting', 'processing', 'uncertain', 'failed', 'completed'].includes(String(value.status))
    || !Number.isSafeInteger(value.completedShots) || Number(value.completedShots) < 0
    || !Number.isSafeInteger(value.shotCount) || Number(value.shotCount) < Number(value.completedShots)
    || typeof value.artifactReady !== 'boolean' || typeof value.purchaseReady !== 'boolean' || typeof value.paymentLocked !== 'boolean'
    || value.needsAttention !== undefined && typeof value.needsAttention !== 'boolean'
    || !object(p) || p.preparedId !== expected.id || p.manifestHash !== expected.manifestHash || p.currency !== 'USD'
    || !Number.isSafeInteger(p.amountCents) || Number(p.amountCents) < 1 || Number(p.amountCents) > 100_000_000
    || value.artifactReady && (value.status !== 'completed' || value.needsAttention === true)
    || value.purchaseReady && (!value.artifactReady || !value.paymentLocked))
    throw new Error('This film’s production status could not be verified. Refresh its saved status before continuing.');
  return { id: expected.id, manifestHash: expected.manifestHash, status: String(value.status),
    completedShots: Number(value.completedShots), shotCount: Number(value.shotCount), preparationOnly: value.preparationOnly === true,
    deliveryFlow: PRE_RENDER_FLOW, artifactReady: value.artifactReady, purchaseReady: value.purchaseReady, paymentLocked: value.paymentLocked,
    price: { amountCents: Number(p.amountCents), currency: 'USD', preparedId: expected.id, manifestHash: expected.manifestHash },
    ...(typeof value.needsAttention === 'boolean' ? { needsAttention: value.needsAttention } : {}),
    ...(typeof value.workerReady === 'boolean' ? { workerReady: value.workerReady } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(value.progress ? { progress: value.progress } : {}) };
}
export function preRenderCanPurchase(status: PreRenderStatus | null, expected: { id: string; manifestHash: string }): boolean {
  return Boolean(status && status.id === expected.id && status.manifestHash === expected.manifestHash
    && status.deliveryFlow === PRE_RENDER_FLOW && status.artifactReady && status.purchaseReady && status.paymentLocked
    && status.status === 'completed' && !status.needsAttention
    && status.price?.preparedId === expected.id && status.price.manifestHash === expected.manifestHash
    && status.price.currency === 'USD' && Number.isSafeInteger(status.price.amountCents)
    && status.price.amountCents >= 1 && status.price.amountCents <= 100_000_000);
}
export function preRenderCanResume(status: PreRenderStatus | null, expected: { id: string; manifestHash: string }): boolean {
  if (!status || status.status !== 'prepared' || status.completedShots !== 0 || status.needsAttention
    || status.artifactReady || status.purchaseReady || !status.paymentLocked) return false;
  try { return Boolean(normalizePreRenderStatus(status, expected)); } catch { return false; }
}
export function preRenderRequest(preparedId: string, amountCents: number, consent: boolean) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(preparedId) || !Number.isSafeInteger(amountCents)
    || amountCents < 1 || amountCents > 100_000_000 || consent !== true) throw new Error('Review the saved film price and allow production before starting.');
  return { action: 'startPreRender', preparedId, acceptedPriceCents: amountCents, productionConsent: true };
}
export function preRenderQuoteMatches(quote: FilmQuote | null, expected: { id: string; manifestHash: string; filmId: string; price: PreRenderPrice }): boolean {
  return Boolean(quote && !quote.sandbox && quote.preparedId === expected.id && quote.manifestHash === expected.manifestHash
    && quote.filmId === expected.filmId && quote.currency === 'USD' && quote.amountCents === expected.price.amountCents
    && expected.price.preparedId === expected.id && expected.price.manifestHash === expected.manifestHash
    && expected.price.currency === 'USD' && Number.isSafeInteger(expected.price.amountCents)
    && expected.price.amountCents >= 1 && expected.price.amountCents <= 100_000_000);
}
