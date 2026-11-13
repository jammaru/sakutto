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

/** A word long enough to be prose rather than a label, unit or notation mark. */
const PROSE_WORD = /\p{L}{3,}/gu;
const PROSE_WORDS = 3;

/**
 * True when a block carries enough real words to be prose. Short labels (`Data quality`),
 * table rows (`48`, `1.9 s`), running headers (`INTRODUCTION`) and notation (`α = β`) are
 * typesetting, not sentences; when the model returns them unchanged the reader should keep
 * the page as drawn instead of retrying them as failed translations.
 */
export function hasSourceProse(text: string): boolean {
  return (text.match(PROSE_WORD)?.length ?? 0) >= PROSE_WORDS;
}

function normalizedText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Languages written with Latin letters. `pdfBlockLanguage` can only say "English" for a
 * Latin run, so comparing an English-looking output with an English-looking source would
 * reject a correct German or French translation. For these targets the reliable echo test is
 * the text itself: identical, or opening with the same long prefix.
 */
const LATIN_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set([
  'az',
  'ca',
  'ceb',
  'de',
  'en',
  'es',
  'et',
  'eu',
  'fr',
  'hr',
  'hu',
  'id',
  'it',
  'jv',
  'lt',
  'lv',
  'ms',
  'nl',
  'pl',
  'sk',
  'sl',
  'sw',
  'tl',
  'uz',
  'vi',
]);

function isLatinScriptTarget(language: string | null): boolean {
  return language !== null && LATIN_SCRIPT_LANGUAGES.has(language);
}

/** True when the output is the source text, or starts with the same long opening. */
export function translationRepeatsSource(source: string, output: string): boolean {
  const trimmedOut = normalizedText(output);
  const trimmedSrc = normalizedText(source);
  if (trimmedOut.length > 0 && trimmedOut === trimmedSrc) return true;
  if (trimmedSrc.length >= 32 && trimmedOut.length >= 32) {
    const prefix = trimmedSrc.slice(0, Math.min(48, trimmedSrc.length));
    if (trimmedOut.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * True when a prose output stayed in the source language, without needing the requested
 * target. The cache uses this to refuse to store an echo even though it sees only a segment.
 */
export function translationStaysInSourceLanguage(
  source: string,
  output: string,
  target = '',
): boolean {
  const trimmedOut = normalizedText(output);
  const trimmedSrc = normalizedText(source);
  if (!hasSourceProse(trimmedSrc)) return false;
  if (trimmedOut.length === 0 || translationRepeatsSource(trimmedSrc, trimmedOut)) return true;
  const canonicalTarget = canonicalLanguage(target);
  if (isLatinScriptTarget(canonicalTarget)) return false;
  const outLang = pdfBlockLanguage(trimmedOut);
  const srcLang = pdfBlockLanguage(trimmedSrc);
  return outLang !== null && srcLang !== null && outLang === srcLang;
}

/**
 * True when the model output is still the source (or the same language as the source) while
 * the reader asked for another language. Only real prose counts: a short label that comes
 * back unchanged is intentionally kept by the session, not a failed translation.
 */
export function translationEchoesSource(source: string, output: string, target: string): boolean {
  const canonicalTarget = canonicalLanguage(target);
  if (!canonicalTarget) return false;
  const trimmedOut = normalizedText(output);
  const trimmedSrc = normalizedText(source);
  // The bench fake engine prefixes every translated segment so fixtures can see that work ran.
  // Outside that build the prefix is ordinary source text and must not buy an exemption.
  if (__SAKUTTO_FAKE_ENGINE__ && trimmedOut.startsWith(`§${canonicalTarget}§`)) return false;
  // A label, a number, a header or a formula cannot be an echo of prose. Treating it as one
  // failed a row of table numbers and retried it forever.
  if (!hasSourceProse(trimmedSrc)) return false;
  if (trimmedOut.length === 0) return true;
  // Latin targets cannot be compared by script: a correct German translation may still look
  // English to the heuristic. Only the text itself can prove that nothing was translated.
  if (isLatinScriptTarget(canonicalTarget)) {
    return translationRepeatsSource(trimmedSrc, trimmedOut);
  }
  if (trimmedOut === trimmedSrc) return true;
  const outLang = pdfBlockLanguage(trimmedOut);
  const srcLang = pdfBlockLanguage(trimmedSrc);
  if (outLang !== null && srcLang !== null && outLang === srcLang && outLang !== canonicalTarget) {
    return true;
  }
  return translationRepeatsSource(trimmedSrc, trimmedOut);
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
