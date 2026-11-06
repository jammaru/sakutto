import {
  isAriaHiddenLeaf,
  isBlockElement,
  isCollapsedDetail,
  isDataRowCell,
  isDataValueText,
  isFrozenInline,
  isKeptInlineText,
  isScreenReaderOnly,
  isTranslationExcluded,
  ownsText,
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
  const frozen = isDataRowCell(block);
  const built = buildFrame(
    block,
    () => {
      nextId += 1;
      return `i${String(nextId)}`;
    },
    frozen,
  );
  const source = collapseSource(built.source);

  if (!/[^\s<>]/.test(source) || !/\p{L}/u.test(source)) return null;

  return {
    block,
    gaps: built.gaps,
    children: built.children,
    source,
    placeholder: built.children.length > 0,
    order: built.order,
  };
}

/**
 * An inline element whose whole text is an identifier: a handle, a slug, a version. Only
 * consulted inside a data row, where such a value is the column's content rather than copy.
 */
function isIdentifierInline(element: Element): boolean {
  if (element.children.length > 0) return false;
  const text = (element.textContent ?? '').trim();
  if (text.length === 0 || text.length > 40) return false;
  return isDataValueText(text);
}

/**
 * Whether an element paints inside its parent's line. Anything that generates a block box
 * — a table cell, a grid item, a card — is laid out in its own slot, and folding its text
 * into the parent's segment rewrites the parent in a way the layout did not expect.
 *
 * `display: contents` is the exception: it has no box of its own and its children are laid
 * out by the grandparent, so its text really is part of the surrounding line.
 */
function isLaidOutInline(element: Element): boolean {
  const display = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? '';
  if (display.length === 0) return true;
  if (display === 'contents') return true;
  return display.startsWith('inline') || display === 'ruby' || display === 'ruby-text';
}

function buildFrame(element: Element, allocateId: () => string, freezeValues = false): BuiltFrame {
  // A container that owns text of its own is one segment, and a child that paints as its
  // own box — a flex item is blockified even as a `<span>` — has to fold in as a
  // placeholder: dropping it merges the words on either side and reorders them. A container
  // whose own text is only the indentation between its cells folds nothing, so a grid row
  // can never become one segment.
  const foldChildren = ownsText(element);
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
      source += LINE_BREAK;
      continue;
    }
    if (isFrozenInline(child)) continue;
    // Inside a cell of a repeating data row, an identifier is left in the DOM: a handle,
    // a slug or a version is not a word, and a placeholder keeps it out of the model's
    // reach while the rest of the cell still translates.
    if (freezeValues && isIdentifierInline(child)) continue;

    // Nested blocks are translated as their own segments, including direct text around them.
    if (isBlockElement(child)) continue;
    // An element that paints as a block of its own — a table cell, a card, a grid item — is
    // a segment or a container of segments, never inline text of its parent. Folding it in
    // rebuilt the parent's text with the child's words inside, and the grid the child sat in
    // reflowed as soon as the parent was rewritten.
    //
    // Unless this container owns text of its own. Then the container *is* one segment
    // (`Fluency <span>38.7</span>`, a flex paragraph with a link), and a child that paints
    // as a box has to stay a placeholder: dropping it merges the words on either side and
    // reorders them.
    if (!foldChildren && !isLaidOutInline(child)) continue;
    if (child.shadowRoot && child.childNodes.length === 0) continue;

    const inner = buildFrame(child, allocateId, freezeValues);
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

/**
 * The mark used to keep a real `<br>` apart from the document's own indentation while the
 * source is normalized. A private-use character cannot appear in page text by accident.
 */
const LINE_BREAK = '\uE000';

/**
 * Page markup carries the indentation of the document: a row cell is often three hundred
 * characters of newlines and spaces around four words. That formatting is layout, not
 * text — the model has no use for it, and it inflated every prompt, made every short block
 * look long enough to be kept out of a packed request, and (through the newline rule) put
 * a whole table row in a request of its own.
 *
 * Runs of whitespace inside a text slot collapse to a single space, and the whole source is
 * trimmed. A real `<br>` keeps its newline, because that break is content: a batch is joined
 * at newlines, so a block that spans lines must stay in a request of its own. The slot nodes
 * keep their original bytes, so restoring the page is unaffected.
 */
function collapseSource(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .replace(new RegExp(`\\s*${LINE_BREAK}\\s*`, 'gu'), '\n')
    .trim();
}
