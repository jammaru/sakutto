const PROSE_WORD = /\p{L}{3,}/gu;
const PROSE_WORDS = 3;
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SECTION_MARKER = /^\d+(?:\.\d+)*[.．]?\s*/u;

/** True when a block carries enough real words to count as prose. */
export function hasSourceProse(text: string): boolean {
  return (text.match(PROSE_WORD)?.length ?? 0) >= PROSE_WORDS;
}

/**
 * OCR can emit stray detector boxes (an arrow head read as "V", a punctuation fragment) and a
 * wrapped sentence tail can become its own one- or two-glyph block. Such blocks must not spend a
 * translation request or paint a hallucinated cover; the original glyphs stay visible instead.
 *
 * Genuine short headings are exempt: numbered sections, CJK labels such as "概要", and role
 * headings/captions still reach the engine.
 */
export function isNoiseBlockText(text: string, role: string = 'prose'): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  const content = trimmed.replace(/[\s\p{P}\p{S}\p{N}]/gu, '');
  if (content.length === 0) return true;
  if (SECTION_MARKER.test(trimmed) && content.length > 1) return false;
  // "る。" / "V" / "X": a one- or two-glyph fragment left by a line break or a figure arrow.
  if (content.length === 1 && !CJK_LETTER.test(content)) return true;
  // A one-to-three-glyph CJK tail ("る。", "ある。", "がある。") is the wrapped end of the
  // paragraph above it, not a sentence a translator can translate on its own.
  if (CJK_LETTER.test(content) && content.length <= 3 && /[。．.!?]$/u.test(trimmed)) return true;
  // Real short headings and labels are deliberately kept or translated elsewhere; only
  // free-standing prose debris is filtered here.
  if (['heading', 'caption', 'label', 'cell', 'figure-label', 'furniture'].includes(role)) {
    return false;
  }
  // A two-glyph Latin fragment is a wrapped tail or an arrow read as a letter. A short
  // sentence such as "I need it." or "We can do it." is real prose, however few long words
  // it contains: word length is not evidence that a whole sentence should stay untranslated.
  return !CJK_LETTER.test(content) && content.length <= 2;
}
