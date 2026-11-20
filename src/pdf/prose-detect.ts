/** A word long enough to be prose rather than a label, unit or notation mark. */
const PROSE_WORD = /\p{L}{3,}/gu;
/**
 * CJK scripts pack a sentence into a few characters and often write it without spaces, so a
 * two-sentence paragraph matches {@link PROSE_WORD} only twice. Counting the characters of
 * those runs keeps short Japanese, Chinese and Korean prose prose, which the echo guard and
 * the copy cache need: a CJK paragraph that comes back unchanged is still an echo.
 */
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const PROSE_WORDS = 3;
/** About one short CJK sentence. A two- or three-character label stays a label. */
const PROSE_CJK_CHARS = 6;

/** True when a block carries enough real words to count as prose. */
export function hasSourceProse(text: string): boolean {
  if ((text.match(PROSE_WORD)?.length ?? 0) >= PROSE_WORDS) return true;
  return (text.match(CJK_LETTER)?.length ?? 0) >= PROSE_CJK_CHARS;
}
