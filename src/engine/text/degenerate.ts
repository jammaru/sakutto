/**
 * True while `value` is still only copies of one 1–8 character unit, including
 * a copy that has not finished (`,3,3,` is still `,3`). A string that has
 * broken every such unit is safe to show.
 */
export function isRepeatInProgress(value: string): boolean {
  const text = value.replace(/\s+/gu, '');
  if (text.length === 0) return false;
  const longest = Math.min(8, text.length);
  for (let size = 1; size <= longest; size += 1) {
    const unit = text.slice(0, size);
    let index = 0;
    let copies = 0;
    while (index + size <= text.length && text.startsWith(unit, index)) {
      copies += 1;
      index += size;
    }
    const rest = text.slice(index);
    if (rest.length > 0 && !unit.startsWith(rest)) continue;
    if (copies >= 2 || (copies === 1 && rest.length > 0)) return true;
  }
  return false;
}

/**
 * A broken WebGPU kernel can collapse every logit onto one id. Greedy sampling
 * then repeats that token until the budget ends, and the bar still says the
 * page was translated. A real sentence is not eight copies of the same short
 * piece covering most of the string.
 */
export function isDegenerateOutput(value: string): boolean {
  const text = value.replace(/\s+/gu, '');
  if (text.length < 16) return false;

  const need = Math.ceil(text.length * 0.8);
  for (let size = 1; size <= 8; size += 1) {
    for (let offset = 0; offset < size; offset += 1) {
      let run = 0;
      let previous = '';
      for (let index = offset; index + size <= text.length; index += size) {
        const unit = text.slice(index, index + size);
        if (unit === previous) {
          run += size;
        } else {
          previous = unit;
          run = size;
        }
        if (run >= need && run / size >= 8) return true;
      }
    }
  }
  return false;
}
