import { canonicalLanguage } from '@/shared/languages';
import { inferLanguage } from '@/dom/detect';
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
  const sample = blocks
    .filter(
      (block) => block.role === 'prose' || block.role === 'heading' || block.role === 'caption',
    )
    .map((block) => block.text)
    .join(' ');
  return pdfBlockLanguage(sample);
}

/** True when this block is already in the language the reader asked for. */
export function isSameLanguage(text: string, target: string, pageLanguage: string | null): boolean {
  const canonicalTarget = canonicalLanguage(target);
  if (!canonicalTarget) return false;
  const source = pdfBlockLanguage(text) ?? pageLanguage;
  return source !== null && source === canonicalTarget;
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
