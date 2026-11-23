import { normalizeCheckoutConfiguration, normalizeFilmQuote, quoteMatchesConfiguration } from './checkout-contract';
import { normalizeLibraryEntry, type LibraryEntry } from './film-library';
import { preRenderQuoteMatches } from './film-prerender';

export async function prepareSavedFilmCheckout({ entry, quoteKey, request, now = Date.now }: {
  entry: LibraryEntry; quoteKey: string; request: (path: string, body?: unknown) => Promise<unknown>; now?: () => number;
}) {
  const detail = await request(`/api/library?action=detail&kind=plan&id=${entry.id}`) as { entry?: unknown };
  const current = normalizeLibraryEntry(detail?.entry);
  if (current.kind !== 'plan' || current.id !== entry.id || current.manifestHash !== entry.manifestHash || current.filmId !== entry.filmId
    || !current.production.artifactReady || !current.production.purchaseReady || !current.production.paymentLocked
    || !current.production.price || current.payments.length) throw new Error('This film’s checkout state changed. Refresh its saved status before continuing.');
  const config = normalizeCheckoutConfiguration(await request('/api/studio', { action: 'prepareCheckout' }));
  if (!config.available) throw new Error('Checkout is temporarily unavailable. Your finished film remains saved.');
  const quote = normalizeFilmQuote(await request('/api/studio', { action: 'quote', preparedId: entry.id, idempotencyKey: quoteKey }));
  if (!quote || !preRenderQuoteMatches(quote, { ...current, manifestHash: current.manifestHash!, price: current.production.price })
    || !quoteMatchesConfiguration(quote, config) || Date.parse(quote.expiresAt) <= now())
    throw new Error('The checkout price did not match this finished film. No invoice was requested.');
  return quote;
}
