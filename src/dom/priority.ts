export type VisibilityBand = 'visible' | 'near' | 'far';

export type ContentKind = 'prose' | 'chrome';

const PROSE_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'figcaption',
  'dd',
  'dt',
  'li',
]);

const CHROME_SELECTOR = [
  'nav',
  'header',
  'footer',
  'aside',
  'button',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="button"]',
  '[role="menu"]',
].join(', ');

const METADATA_SELECTOR = [
  '.hatnote',
  '.shortdescription',
  '.coordinates',
  '#coordinates',
  '.infobox',
  '.navbox',
  '.vertical-navbox',
  '.sidebar',
  '.sistersitebox',
  '.metadata',
  '.reflist',
  '.mw-references-wrap',
  'ol.references',
  '#catlinks',
  '.mw-authority-control',
  '.side-box',
].join(', ');

/**
 * Navigation, sidebars and controls wait behind the article. A paragraph inside
 * `<main>` or `<article>` stays prose even when the page header is chrome.
 */
export function isChromeBlock(block: Element): boolean {
  const host = block.closest(CHROME_SELECTOR);
  if (!host) return false;
  const main = block.closest('main, article, [role="main"]');
  if (main && !main.contains(host)) return false;
  return true;
}

/** Hatnotes, coordinates, infoboxes and reference lists wait behind the article body. */
export function isMetadataBlock(block: Element): boolean {
  return block.closest(METADATA_SELECTOR) !== null;
}

export function contentKind(block: Element): ContentKind {
  if (isChromeBlock(block) || isMetadataBlock(block)) return 'chrome';
  const tag = block.tagName.toLowerCase();
  if (PROSE_TAGS.has(tag)) return 'prose';
  const length = (block.textContent ?? '').trim().length;
  if (length >= 80 && (tag === 'div' || tag === 'section' || tag === 'td')) return 'prose';
  return 'chrome';
}

export function bandForRect(
  rect: Pick<DOMRect, 'top' | 'bottom' | 'width' | 'height'>,
  viewportHeight: number,
): VisibilityBand {
  if (rect.width === 0 && rect.height === 0) return 'far';
  const height = viewportHeight > 0 ? viewportHeight : 800;
  if (rect.bottom > 0 && rect.top < height) return 'visible';
  if (rect.bottom > -height && rect.top < height * 2) return 'near';
  return 'far';
}

/**
 * Lower values run first. Selection is 0. Article prose in every band stays
 * ahead of navigation, infoboxes and reference lists, so a tall Wikipedia
 * sidebar cannot take the model before the next paragraph.
 */
export function translationPriority(
  band: VisibilityBand | 'selection',
  index: number,
  kind: ContentKind | 'selection',
): number {
  if (band === 'selection' || kind === 'selection') return 0;

  const bandRank = band === 'visible' ? 0 : band === 'near' ? 1 : 2;
  const kindBase = kind === 'prose' ? 10 : 50;
  const order = Math.min(Math.max(index, 0), 2000) * 0.004;
  return Math.max(-100, Math.min(100, Number((kindBase + bandRank * 12 + order).toFixed(2))));
}

/**
 * How many viewport heights ahead the page asks PLaMo to translate. This is prefetch for
 * the model itself: text that is about to scroll into view is queued before it is visible,
 * so scrolling finds a finished translation instead of waiting for a cold request.
 */
export function lookaheadScreens(
  tier: 'g' | 'c8' | 'c4' | null,
  pace: 'fast' | 'quality' = 'quality',
): number {
  const base = tier === 'g' ? 2 : tier === 'c4' ? 0.5 : 1;
  return pace === 'fast' ? base + 1 : base;
}

export function translationConcurrency(tier: 'g' | 'c8' | 'c4' | null): number {
  return tier === 'g' ? 2 : 1;
}
