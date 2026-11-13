import { canonicalLanguage } from '@/shared/languages';
import { contradictsScript, inferLanguage } from '@/dom/detect';
import type { LayoutBlock } from './layout';

const ENGLISH_WORD =
  /\b(?:the|and|of|to|in|for|with|that|this|from|are|was|were|have|has|not|but|as|on|by|an|or|be|at|it|is)\b/giu;

/**
 * Language of a PDF block, as far as a script heuristic can tell.
 *
 * CJK and other non-Latin scripts use the same detector the page translator uses. Latin text
 * is English when it carries English function words; other Latin languages are left
 * undecided so a French page can still be translated into English.
 */
export function pdfBlockLanguage(text: string): string | null {
  const inferred = inferLanguage(text);
  if (inferred) return inferred;
  if (looksLikeEnglish(text)) return 'en';
  return null;
}

export function pdfPageLanguage(blocks: readonly LayoutBlock[]): string | null {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.role !== 'prose' && block.role !== 'heading' && block.role !== 'caption') continue;
    const language = pdfBlockLanguage(block.text);
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + Math.max(1, block.text.length));
  }
  let best: string | null = null;
  let score = 0;
  for (const [language, count] of counts) {
    if (count > score) {
      score = count;
      best = language;
    }
  }
  return best;
}

/** True when this block is already in the language the reader asked for. */
export function isSameLanguage(text: string, target: string, pageLanguage: string | null): boolean {
  const canonicalTarget = canonicalLanguage(target);
  if (!canonicalTarget) return false;
  const own = pdfBlockLanguage(text);
  if (own !== null) return own === canonicalTarget;
  // Short English labels (`Data quality`, `Table 2`) inherit an English page. They must still
  // be translated into another language: `contradictsScript` needs 24 letters, so without this
  // they would follow the page and be marked done.
  if (pageLanguage === 'en' && isShortLatinLabel(text)) return canonicalTarget === 'en';
  // A Latin paragraph on a page whose running header is Japanese is still English. The page
  // language is a hint for short labels, not a licence to skip the body and mark it done.
  if (pageLanguage !== null && contradictsScript(pageLanguage, text)) return false;
  return pageLanguage !== null && pageLanguage === canonicalTarget;
}

/** A brief Latin caption or table tag, too short for `looksLikeEnglish`. */
function isShortLatinLabel(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 24) return false;
  let latin = 0;
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
    else if (code > 0x7f && /\p{L}/u.test(character)) return false;
  }
  return latin > 0;
}

function looksLikeEnglish(text: string): boolean {
  let latin = 0;
  let letters = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin += 1;
      letters += 1;
    } else if (code > 0x7f && /\p{L}/u.test(character)) {
      letters += 1;
    }
  }
  if (letters < 24 || latin * 2 < letters) return false;
  const hits = text.match(ENGLISH_WORD)?.length ?? 0;
  return hits >= 3;
}
