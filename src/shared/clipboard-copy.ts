import { canCopyTypedResult, copyTranslation, type CopyTarget } from './typed-translation';

/**
 * Last-resort copy for the page overlay: an off-screen textarea and `execCommand('copy')`.
 *
 * The async Clipboard API refuses to run in a few places the selection popup still opens —
 * pages that are not secure contexts, or frames whose `permissions.policy` denied
 * `clipboard-write`. `execCommand` is deprecated, but it is the same path the browser's own
 * "copy" gesture takes, so it works there without any new manifest permission. The textarea
 * is created only inside a click handler, appended to the overlay's own document, and
 * removed again before the function returns.
 */
export function copyTextViaDocument(doc: Document, text: string): boolean {
  if (text.trim().length === 0) return false;
  const area = doc.createElement('textarea');
  area.value = text;
  // A readonly field avoids mobile keyboards and IME state; it copies the same.
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  const focus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  doc.documentElement.append(area);
  try {
    area.focus();
    area.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    focus?.focus();
  }
}

/**
 * Copies text from the selection popup: the Clipboard API first, the textarea fallback
 * second. Reports failure instead of throwing so the copy control can show a message.
 */
export async function copyTextToClipboard(
  text: string,
  clipboard: CopyTarget | null | undefined,
  doc: Document,
): Promise<boolean> {
  if (!canCopyTypedResult(text, false)) return false;
  if (await copyTranslation(text, clipboard)) return true;
  return copyTextViaDocument(doc, text);
}
