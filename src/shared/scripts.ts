/** The Unicode glyphs a raised or lowered run can be drawn with. */
export type ScriptPosition = 'sub' | 'super';

export const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
};

export const SUBSCRIPT: Readonly<Record<string, string>> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  o: 'ₒ',
  x: 'ₓ',
};

/**
 * The same text with every character that has a Unicode script form replaced. Characters
 * without a form stay as they are, so `[1]` remains a citation instead of turning into a
 * different symbol.
 */
export function formatScriptText(text: string, script: ScriptPosition): string {
  const map = script === 'super' ? SUPERSCRIPT : SUBSCRIPT;
  let output = '';
  for (const character of text) output += map[character] ?? character;
  return output;
}

/**
 * Spellings a model may return for a script glyph: the Unicode form first, then the
 * original text. A model that keeps the raised glyph and one that normalizes it to plain
 * digits both still have a match.
 */
export function scriptTextVariants(text: string, script: ScriptPosition): string[] {
  const formatted = formatScriptText(text, script);
  return formatted === text ? [text] : [formatted, text];
}
