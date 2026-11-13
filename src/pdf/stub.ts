/**
 * A deterministic stand-in for the model, used to measure layout rather than meaning.
 *
 * Japanese set from English is typically a little shorter in characters and a little wider
 * per character. The stub aims at a visual expansion of about 15% so a layout test sees the
 * overflow a longer translation would cause, without waiting for the model. Numbers, short
 * symbols and placeholder tags are copied through unchanged: those are the strings a real
 * translation must also leave alone.
 */

const CJK_CYCLE = 'これは翻訳された文章ですレイアウトを測る';

/** Visual width of Japanese relative to the Latin source, as a multiple. */
export const STUB_EXPANSION = 1.15;

/**
 * True when a string is notation rather than prose: a number, a unit, a short symbol run.
 * The stub copies these through, because shrinking them would invent a defect the model
 * would not produce and expanding them would punish a table of values.
 */
export function isNotation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (/^<i\d+>$/u.test(trimmed)) return true;
  if ((trimmed.match(/\p{L}{3,}/gu) ?? []).length === 0) return true;
  return false;
}

/**
 * Builds a Japanese-shaped string whose measured width is about `factor` times the source.
 *
 * The fallback measurer treats a CJK character as one em and a Latin character as half an
 * em, so the stub asks for `sourceLatinChars * factor * 0.5` CJK characters. Placeholder
 * tags are kept in place so an inline formula survives the round-trip the real engine uses.
 */
export function stubExpand(
  text: string,
  factor: number = STUB_EXPANSION,
  target: 'ja' | 'en' | 'other' = 'ja',
): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  if (target !== 'ja') {
    const extra = Math.max(0, Math.round(trimmed.length * (factor - 1)));
    return extra === 0 ? trimmed : `${trimmed}${'x'.repeat(extra)}`;
  }
  if (isNotation(trimmed)) return trimmed;

  const parts = trimmed.split(/(<i\d+>)/u);
  let latin = 0;
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) continue;
    latin += part.replace(/\s+/gu, '').length;
  }
  const needed = Math.max(1, Math.round(latin * factor * 0.5));
  let filled = 0;
  const chunks: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) {
      chunks.push(part);
      continue;
    }
    if (part.trim().length === 0) {
      chunks.push(part);
      continue;
    }
    const share =
      latin === 0
        ? needed
        : Math.max(1, Math.round((part.replace(/\s+/gu, '').length / latin) * needed));
    chunks.push(cjkRun(share, filled));
    filled += share;
  }
  if (filled < needed) chunks.push(cjkRun(needed - filled, filled));
  return chunks.join('');
}

function cjkRun(length: number, offset: number): string {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += CJK_CYCLE[(offset + index) % CJK_CYCLE.length];
  }
  return output;
}
