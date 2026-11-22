/**
 * Quality metrics shared by the offline PDF quality bench.
 *
 * These are deliberately independent of the product's own acceptance metrics: a page can pass
 * the layout gates and still show half a paragraph in English, or a word torn in two by the
 * text extractor. The numbers here describe what a reader sees, and are kept in bench code so
 * they stay comparable across product iterations.
 */

/** Box in top-left PDF point space, as the reader uses it. */
export interface QualityBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QualityEntry {
  source: string;
  translation: string;
  role: string;
  box: QualityBox;
  painted: boolean;
  overflow: boolean;
  delivered: boolean;
  /** Placeholder tags that survived into the visible output. */
  placeholders: number;
  /** True when a native text block was left in the source language with no marker. */
  untranslated: boolean;
  /** True when the translation switches between Japanese and English inside one block. */
  mixedLanguage: boolean;
  /** Counted in the prose denominator; skipped prose can carry a `code` role. */
  prose?: boolean;
  /** Suspicious source/translation tokens in this block. */
  garbled: string[];
  /** Fitted size / source size for a painted block. */
  scale: number;
}

export interface QualityPage {
  fixture: string;
  /** Where this page's text came from; scan.pdf's committed fixture is simulated, not OCR. */
  textSource: 'native' | 'simulated-ocr';
  page: number;
  entries: QualityEntry[];
  /** Painted-box overlap pairs from the renderer's own metric. */
  overlapPairs: number;
  /** Painted boxes that run off the page. */
  overflow: number;
  /** Painted prose whose font fell below 75% of the source size. */
  shrunk: number;
  /** Prose blocks with no visible translation and no marker. */
  untranslatedProse: number;
  proseBlocks: number;
  /** Skipped blocks with natural-language prose, including those misclassified as code. */
  skippedProse: number;
  /** Correctly ordered adjacent pairs / all adjacent pairs, 0-1. */
  readingOrder: number;
  twoColumn: boolean;
  /** Milliseconds from the start of the run until this page's first block arrived. */
  firstBlockMs: number;
  pageMs: number;
}

export interface QualitySummary {
  pages: number;
  proseBlocks: number;
  /** Prose blocks that were skipped by the layout, including misclassified code. */
  skippedProseBlocks: number;
  untranslatedProseRate: number;
  mixedLanguageRate: number;
  garbledTokenRate: number;
  overlapRate: number;
  overflowRate: number;
  readingOrderAccuracy: number;
  twoColumnPages: number;
  firstTranslatedBlockMs: number;
  fullDocumentMs: number;
  /** Mean painted font size / source font size, where a translation was painted. */
  meanScale: number;
}

/** Ligatures pdf.js can hand back as a single code point. */
const LIGATURES: Record<string, string> = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
};

/** Expands ligatures and invisible spacing so garbling can be scored on real words. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\ufb00-\ufb06]/gu, (character) => LIGATURES[character] ?? character)
    .replace(/[\u00ad\u200b\u2060]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Tokens produced by a broken text layer: split words, ligature remains, stray punctuation. */
export function garbledTokens(text: string): string[] {
  const normalized = normalizeText(text);
  const found: string[] = [];
  const push = (value: string): void => {
    found.push(value);
  };
  // A ligature or soft hyphen that survived extraction is a source-side defect.
  for (const match of text.match(/[\ufb00-\ufb06\u00ad]/gu) ?? []) push(match);
  // "l,rge", "e'sembles": punctuation or a quote inside a word.
  for (const match of normalized.match(/[A-Za-z][,;:\u2019\u00b7][A-Za-z]{1,}/gu) ?? [])
    push(match);
  // A line-break hyphen that was not joined back to its word: "English- to-German".
  for (const match of normalized.match(/\p{L}-\s+\p{Ll}/gu) ?? []) push(match);
  // A whole English clause left inside a Japanese translation: the visible symptom of lines
  // from two columns being joined into one prompt.
  if (CJK_CHAR.test(normalized)) {
    for (const match of normalized.match(
      /(?<![A-Za-z])[A-Za-z]{3,}(?:\s+[A-Za-z]{3,}){3,}(?![A-Za-z])/gu,
    ) ?? []) {
      push(match.slice(0, 48));
    }
  }
  // Doubled punctuation from two adjacent runs that were joined without repair.
  for (const match of normalized.match(/[,.:;]{2,}/gu) ?? []) push(match);
  // A character the engine could not decode, or a protection tag that was not restored.
  for (const match of normalized.match(/\uFFFD|<\/?i\d+>/gu) ?? []) push(match);
  return found;
}

/**
 * Garbling is scored on the raw extraction strings: normalizeText expands ligatures and drops
 * soft hyphens, so passing only normalized text would hide exactly those source-side defects.
 */
export function entryGarbledTokens(
  rawSource: string,
  rawTranslation: string,
  delivered: boolean,
): string[] {
  return [...garbledTokens(rawSource), ...(delivered ? garbledTokens(rawTranslation) : [])];
}

const LATIN_WORD = /[A-Za-z]{3,}/gu;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
export const PROSE_ROLE = /^(prose|heading|caption|cell)$/u;

/**
 * True when skipped text is a natural-language sentence rather than source code or notation.
 *
 * The OCR layout can misclassify a prose line that shares a row with a listing as `code`. Such
 * a block is still untranslated prose on the page; hiding it behind its role would report 0%
 * untranslated while the reader sees English. Require several words and prose function words,
 * and reject punctuation-heavy listings unless a prose marker (Section/Figure/Table) is present.
 */
export function isProseLike(text: string): boolean {
  const normalized = normalizeText(text);
  const words = normalized.match(LATIN_WORD) ?? [];
  if (words.length === 0) return false;
  const hasSectionMarker = /\b(?:section|figure|table)\b/iu.test(normalized);
  // A listing line is code regardless of how English its keywords look. The leading number is
  // optional: "for block in page:" is as much a listing as "1 for block in page:". A prose
  // sentence that merely quotes Section/Figure/Table is still prose.
  if (
    !hasSectionMarker &&
    /^(?:\d+[.)]?\s+)*(?:for|if|while|return|emit|continue|def|let|const|var|import|from|class|try|except|finally|switch|case|else|elif|do|break|pass|yield|raise|with|lambda|print|function|foreach)\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  // A bare lowercase clause ending in a colon is a code statement or a field label, not a
  // natural-language sentence.
  if (!hasSectionMarker && /^[a-z][\p{L}\s]*[:{]\s*$/u.test(normalized)) return false;
  const codeMarkers = (normalized.match(/[{}();:=]/gu) ?? []).length;
  if (codeMarkers >= 3 && !hasSectionMarker) return false;
  // Short headings ("References", "Abstract", "We win.") used to vanish from the prose
  // denominator because this helper demanded three words and two function words. A short
  // alphabetic line with no code punctuation is a heading or a sentence, not a label.
  if (
    /^[\p{L}][\p{L}\s'’&.,:-]*$/u.test(normalized) &&
    normalized.length <= 80 &&
    words.length <= 8 &&
    !(words.length === 1 && (normalized.length > 14 || /[a-z][A-Z]/u.test(normalized)))
  ) {
    return true;
  }
  if (words.length < 3) return false;
  const functionWords =
    normalized.match(
      /\b(?:the|and|of|is|are|we|this|that|these|those|which|with|for|from|by|as|in|on|to|it|its|be|was|were|has|have|can|then|when|where|section|figure|table|describes|shows|proposes|reports|uses|used)\b/giu,
    ) ?? [];
  if (functionWords.length < 2) return false;
  return true;
}

/** Role-based fallback keeps previously recorded reports comparable. */
export function countsAsProse(entry: Pick<QualityEntry, 'role' | 'prose'>): boolean {
  return entry.prose ?? PROSE_ROLE.test(entry.role);
}

/** True when one block contains both real Japanese text and a run of English words. */
export function isMixedLanguage(text: string): boolean {
  let cjk = 0;
  for (const character of text) if (CJK_CHAR.test(character)) cjk += 1;
  if (cjk < 6) return false;
  // Two isolated technical tokens (an email, a model name such as PLaMo 3 Translate, or
  // 0.8-billion-parameter) are not a language switch. Require a contiguous run of ordinary
  // English words, and ignore all-capital acronyms inside that run.
  const runs = text.match(/(?<![A-Za-z])[A-Za-z]{3,}(?:\s+[A-Za-z]{3,})+(?![A-Za-z])/gu) ?? [];
  return runs.some((run) =>
    run.split(/\s+/u).some((word) => !/^[A-Z]{2,}$/u.test(word) && word.length >= 3),
  );
}

/** Kendall-style adjacent agreement between emitted order and geometric reading order. */
export function orderAccuracy(emitted: readonly string[], expected: readonly string[]): number {
  if (emitted.length < 2 || expected.length < 2) return 1;
  const position = new Map<string, number>();
  expected.forEach((key, index) => {
    if (!position.has(key)) position.set(key, index);
  });
  const ranks = emitted
    .map((key) => position.get(key))
    .filter((rank): rank is number => rank !== undefined);
  if (ranks.length < 2) return 1;
  let correct = 0;
  for (let index = 1; index < ranks.length; index += 1) {
    const previous = ranks[index - 1];
    const current = ranks[index];
    if (previous !== undefined && current !== undefined && previous <= current) correct += 1;
  }
  return correct / (ranks.length - 1);
}

/**
 * Independent two-column ground truth: full-width blocks first in y order, then left column
 * top to bottom, then right column. Used only to score reading order; the product's own layout
 * is not consulted for the expected sequence.
 */
export function expectedReadingOrder(
  boxes: readonly { text: string; box: QualityBox }[],
  pageWidth: number,
): { keys: string[]; twoColumn: boolean } {
  const mid = pageWidth / 2;
  const entries = boxes.filter((entry) => entry.text.trim().length > 0);
  const twoColumn =
    entries.filter((entry) => entry.box.x + entry.box.width < mid * 1.05).length >= 3 &&
    entries.filter((entry) => entry.box.x > mid * 0.95).length >= 3;
  const key = (index: number): string => 'k' + String(index);
  const decorated = entries.map((entry, index) => {
    const center = entry.box.x + entry.box.width / 2;
    const fullWidth = entry.box.width > pageWidth * 0.62;
    return {
      key: key(index),
      ...entry,
      column: !twoColumn || fullWidth ? 0 : center < mid ? 1 : 2,
    };
  });
  if (!twoColumn) {
    decorated.sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
    return { keys: decorated.map((entry) => entry.key), twoColumn };
  }
  // Full-width blocks delimit reading bands: a title and an abstract come before the two
  // body columns, and a trailing References heading comes after both of them. Sorting all
  // spanning blocks first (or all left-column blocks first) scores a correct reader as wrong.
  const spanning = decorated
    .filter((entry) => entry.box.width > pageWidth * 0.6)
    .sort((left, right) => left.box.y - right.box.y);
  const ordered: typeof decorated = [];
  const emitted = new Set<string>();
  for (const block of spanning) {
    ordered.push(
      ...decorated
        .filter((entry) => !emitted.has(entry.key) && entry.box.y < block.box.y)
        .sort((left, right) => left.column - right.column || left.box.y - right.box.y),
    );
    ordered.push(block);
    for (const entry of ordered) emitted.add(entry.key);
  }
  ordered.push(
    ...decorated
      .filter((entry) => !emitted.has(entry.key))
      .sort((left, right) => left.column - right.column || left.box.y - right.box.y),
  );
  return { keys: ordered.map((entry) => entry.key), twoColumn };
}

/** Aggregates page measurements into the rates printed in the PR table. */
export function summarize(
  pages: readonly QualityPage[],
  firstMs: number,
  totalMs: number,
): QualitySummary {
  const entries = pages.flatMap((page) => page.entries);
  const prose = entries.filter(countsAsProse);
  const skippedProse = prose.filter((entry) => !PROSE_ROLE.test(entry.role));
  const sources = entries.flatMap((entry) => [
    entry.source,
    entry.delivered ? entry.translation : '',
  ]);
  const garbled = sources.reduce((sum, text) => sum + garbledTokens(text).length, 0);
  const tokens = sources.reduce(
    (sum, text) => sum + Math.max(1, normalizeText(text).split(' ').length),
    0,
  );
  const delivered = entries.filter((entry) => entry.delivered);
  const scales = pages
    .flatMap((page) => page.entries)
    .filter((entry) => entry.painted)
    .map((entry) => entry.scale);
  const twoColumn = pages.filter((page) => page.twoColumn);
  return {
    pages: pages.length,
    proseBlocks: prose.length,
    skippedProseBlocks: skippedProse.length,
    untranslatedProseRate:
      prose.length === 0 ? 0 : prose.filter((entry) => entry.untranslated).length / prose.length,
    mixedLanguageRate:
      delivered.length === 0
        ? 0
        : delivered.filter((entry) => entry.mixedLanguage).length / delivered.length,
    garbledTokenRate: tokens === 0 ? 0 : garbled / tokens,
    overlapRate:
      entries.length === 0
        ? 0
        : pages.reduce((sum, page) => sum + page.overlapPairs, 0) / Math.max(1, entries.length),
    overflowRate:
      entries.length === 0
        ? 0
        : pages.reduce((sum, page) => sum + page.overflow, 0) / Math.max(1, entries.length),
    readingOrderAccuracy:
      pages.length === 0
        ? 1
        : pages.reduce((sum, page) => sum + page.readingOrder, 0) / pages.length,
    twoColumnPages: twoColumn.length,
    firstTranslatedBlockMs: firstMs,
    fullDocumentMs: totalMs,
    meanScale:
      scales.length === 0 ? 1 : scales.reduce((sum, value) => sum + value, 0) / scales.length,
  };
}
