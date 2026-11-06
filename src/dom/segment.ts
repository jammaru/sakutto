import {
  isAriaHiddenLeaf,
  isBlockElement,
  isCollapsedDetail,
  isFrozenInline,
  isKeptInlineText,
  isScreenReaderOnly,
  isTranslationExcluded,
} from './blocks';

export interface TextSlot {
  node: Text;
  original: string;
}

export interface InlineFrame {
  id: string;
  element: Element;
  gaps: TextSlot[][];
  children: InlineFrame[];
  order: readonly ChildNode[];
}

export interface SegmentModel {
  block: Element;
  gaps: TextSlot[][];
  children: InlineFrame[];
  source: string;
  placeholder: boolean;
  order: readonly ChildNode[];
}

interface BuiltFrame {
  gaps: TextSlot[][];
  children: InlineFrame[];
  source: string;
  order: readonly ChildNode[];
}

export function placeholderIds(model: Pick<SegmentModel, 'children'>): Set<string> {
  const ids = new Set<string>();

  const visit = (children: readonly InlineFrame[]): void => {
    for (const child of children) {
      ids.add(child.id);
      visit(child.children);
    }
  };

  visit(model.children);
  return ids;
}

export function allSlots(frame: { gaps: TextSlot[][]; children: InlineFrame[] }): TextSlot[] {
  const slots = frame.gaps.flat();
  for (const child of frame.children) slots.push(...allSlots(child));
  return slots;
}

export function visibleOriginal(block: Element): string {
  const parts: string[] = [];
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent?.closest('script, style, noscript, svg')) parts.push(node.nodeValue ?? '');
  }
  return joinOriginalParts(parts);
}

function joinOriginalParts(parts: readonly string[]): string {
  let output = '';
  for (const part of parts) {
    if (part.length === 0) continue;
    if (output.length > 0 && needsOriginalSpace(output, part)) output += ' ';
    output += part;
  }
  return output.replace(/[ \t]{2,}/g, ' ').trim();
}

function needsOriginalSpace(left: string, right: string): boolean {
  const end = left.at(-1) ?? '';
  const start = right[0] ?? '';
  if (!end || !start || /\s/u.test(end) || /\s/u.test(start)) return false;
  return /\p{L}|\p{N}/u.test(end) && /\p{L}|\p{N}/u.test(start);
}

export function buildSegment(block: Element): SegmentModel | null {
  let nextId = 0;
  const built = buildFrame(block, () => {
    nextId += 1;
    return `i${String(nextId)}`;
  });

  if (!/[^\s<>]/.test(built.source) || !/\p{L}/u.test(built.source)) return null;

  return {
    block,
    gaps: built.gaps,
    children: built.children,
    source: built.source,
    placeholder: built.children.length > 0,
    order: built.order,
  };
}

function buildFrame(element: Element, allocateId: () => string): BuiltFrame {
  const order = [...element.childNodes];
  const gaps: TextSlot[][] = [[]];
  const children: InlineFrame[] = [];
  let source = '';

  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const value = child.nodeValue ?? '';
      if (!isKeptInlineText(value)) continue;
      const current = gaps[gaps.length - 1];
      if (!current) continue;
      current.push({ node: child as Text, original: value });
      source += value;
      continue;
    }

    if (!(child instanceof Element) || isTranslationExcluded(child)) continue;
    // Screen-reader-only text and collapsed panels are not translated on their own, so
    // they must not be folded into a parent's segment either: the model would translate
    // a label the reader cannot see, and its text would then change behind their back.
    if (isScreenReaderOnly(child) || isCollapsedDetail(child)) continue;
    // An `aria-hidden` inline is decorative: an icon glyph, a spinner, a separator, or an
    // icon-font ligature such as `material-symbols-outlined`'s `search`. Sending it to the
    // model turns the ligature into a translated word, and the icon then paints that word
    // as a glyph — blank, or the wrong picture. It stays in the DOM, untranslated, between
    // the surrounding text nodes, which still get their own placeholders on either side.
    if (isAriaHiddenLeaf(child)) continue;
    if (child.tagName === 'BR') {
      source += '\n';
      continue;
    }
    if (isFrozenInline(child)) continue;

    // Nested blocks are translated as their own segments, including direct text around them.
    if (isBlockElement(child)) continue;
    if (child.shadowRoot && child.childNodes.length === 0) continue;

    const inner = buildFrame(child, allocateId);
    if (inner.source.trim().length === 0) continue;

    const id = allocateId();
    children.push({
      id,
      element: child,
      gaps: inner.gaps,
      children: inner.children,
      order: inner.order,
    });
    gaps.push([]);
    source += `<${id}>${inner.source}</${id}>`;
  }

  return { gaps, children, source, order };
}
