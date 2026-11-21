import { browser } from 'wxt/browser';

/** Popup opens recorded while all-sites access is off. */
export const ALL_SITES_PROMO_OPEN_COUNT_KEY = 'allSitesPromoOpenCount';

export type AllSitesPromoPlacement = 'top' | 'bottom' | 'hidden';

export interface AllSitesPromoPlacementInput {
  /** Popup opens while all-sites access was off, including the current one. */
  openCount: number;
  allSitesGranted: boolean;
  showHint: boolean;
}

/**
 * The first all-sites hint stays where it has always been, under the page settings.
 * Once the reader has opened the popup again it moves below the typed-text button,
 * shortcuts, and caption toggle, so it remains visible without crowding the page
 * controls. Returning
 * 'hidden' keeps both markup slots behind one placement decision.
 */
export function resolveAllSitesPromoPlacement({
  openCount,
  allSitesGranted,
  showHint,
}: AllSitesPromoPlacementInput): AllSitesPromoPlacement {
  if (allSitesGranted || !showHint) return 'hidden';
  return Number.isFinite(openCount) && openCount >= 2 ? 'bottom' : 'top';
}

function normalizeOpenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function readAllSitesPromoOpenCount(): Promise<number> {
  const stored = await browser.storage.local
    .get(ALL_SITES_PROMO_OPEN_COUNT_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return normalizeOpenCount(stored[ALL_SITES_PROMO_OPEN_COUNT_KEY]);
}

export async function saveAllSitesPromoOpenCount(count: number): Promise<void> {
  await browser.storage.local
    .set({ [ALL_SITES_PROMO_OPEN_COUNT_KEY]: normalizeOpenCount(count) })
    .catch(() => undefined);
}
