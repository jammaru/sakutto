import { CAPTION_OVERLAY_HOST } from './overlay';
import { captionTextIsTargetLanguage, stripTargetLanguageFromCaption } from './youtube';

const CAPTION_NODE_SELECTOR = [
  '[class*="caption" i]',
  '[class*="subtitle" i]',
  '[class*="subtitles" i]',
  '[data-testid*="caption" i]',
  '[data-testid*="subtitle" i]',
].join(',');

/**
 * One visible caption line from a generic player. Never joins multiple nodes (that
 * mixed YouTube auto-translate into the source). Drops target-language text.
 */
export function readGenericCaptionDom(
  root: ParentNode,
  options: { targetLanguage?: string } = {},
): string {
  const target = options.targetLanguage ?? '';
  const nodes = queryCaptionNodes(root);
  const candidates = nodes
    .map((node) => stripTargetLanguageFromCaption(node.textContent ?? '', target))
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && !captionTextIsTargetLanguage(text, target));
  return candidates[0] ?? '';
}

function queryCaptionNodes(root: ParentNode): Element[] {
  if (!('querySelectorAll' in root)) return [];
  return [...root.querySelectorAll(CAPTION_NODE_SELECTOR)].filter((node) => {
    if (node.closest(CAPTION_OVERLAY_HOST)) return false;
    if (node.closest('button, a, input, textarea, select, nav')) return false;
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 240) return false;
    return true;
  });
}
