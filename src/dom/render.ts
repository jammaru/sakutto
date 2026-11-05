import {
  parsePlaceholders,
  stripPlaceholderTokens,
  visibleTranslation,
  type PlaceholderPart,
} from './placeholders';
import {
  allSlots,
  placeholderIds,
  type InlineFrame,
  type SegmentModel,
  type TextSlot,
} from './segment';

const LINE_TAG = 'sakutto-line';
const NOTE_TAG = 'sakutto-note';

interface Frame {
  element: Element;
  gaps: TextSlot[][];
  children: InlineFrame[];
}

export function applyTranslation(model: SegmentModel, translation: string, created: Text[]): void {
  discardCreated(created);
  const parts = parsePlaceholders(translation, placeholderIds(model));
  const root: Frame = { element: model.block, gaps: model.gaps, children: model.children };
  if (!parts || !applyFrame(root, parts, created)) {
    restoreChildOrder(ordered(model));
    discardCreated(created);
    writeFlat(model, stripPlaceholderTokens(translation), created);
  }
}

export function restoreSegment(model: SegmentModel, created: Text[]): void {
  restoreStructure(model, created);
  removeTranslationUi(model.block);
  model.block.removeAttribute('data-sakutto-pending');
  model.block.removeAttribute('data-sakutto-id');
  model.block.removeAttribute('data-sakutto-engine');
}

export function restoreStructure(model: SegmentModel, created: Text[]): void {
  discardCreated(created);
  removeTranslationUi(model.block);
  restoreChildOrder(ordered(model));
  for (const slot of allSlots(model)) slot.node.nodeValue = slot.original;
}

export function paintPlain(model: SegmentModel, translation: string, created: Text[]): void {
  writeFlat(model, visibleTranslation(translation), created);
}

export function showBilingual(
  model: SegmentModel,
  translation: string,
  engine: 'plamo' | 'chrome' | null,
  simpleLabel: string,
  created: Text[],
): void {
  restoreStructure(model, created);
  removeReplaceNote(model.block);

  const line = ensureChild(model.block, LINE_TAG);
  line.replaceChildren();
  line.setAttribute('translate', 'no');
  line.append(model.block.ownerDocument.createTextNode(visibleTranslation(translation)));

  if (engine === 'chrome') {
    const note = model.block.ownerDocument.createElement(NOTE_TAG);
    note.dataset.mode = 'bilingual';
    note.setAttribute('translate', 'no');
    note.textContent = simpleLabel;
    line.append(note);
  }
}

export function showReplaceNote(
  block: Element,
  engine: 'plamo' | 'chrome' | null,
  simpleLabel: string,
): void {
  removeLine(block);
  if (engine !== 'chrome') {
    removeReplaceNote(block);
    return;
  }

  const note = ensureChild(block, NOTE_TAG);
  note.dataset.mode = 'replace';
  note.setAttribute('translate', 'no');
  note.textContent = simpleLabel;
}

export function removeTranslationUi(block: Element): void {
  removeLine(block);
  removeReplaceNote(block);
}

function discardCreated(created: Text[]): void {
  for (const node of created) node.remove();
  created.length = 0;
}

interface OrderedFrame {
  element: Element;
  children: readonly InlineFrame[];
  order: readonly ChildNode[];
}

function ordered(model: SegmentModel): OrderedFrame {
  return { element: model.block, children: model.children, order: model.order };
}

function restoreChildOrder(frame: OrderedFrame): void {
  for (const child of frame.children) restoreChildOrder(child);
  const parent = frame.element;
  for (const node of frame.order) {
    if (node.parentNode === parent) parent.appendChild(node);
  }
}

function applyFrame(frame: Frame, parts: readonly PlaceholderPart[], created: Text[]): boolean {
  const gapTexts: string[] = [];
  const tags: { id: string; children: PlaceholderPart[] }[] = [];
  let buffer = '';

  for (const part of parts) {
    if (part.type === 'text') {
      buffer += part.value;
      continue;
    }
    gapTexts.push(buffer);
    buffer = '';
    tags.push({ id: part.id, children: part.children });
  }
  gapTexts.push(buffer);

  if (tags.length !== frame.children.length) return false;

  const byId = new Map(frame.children.map((child) => [child.id, child]));
  for (const tag of tags) {
    const child = byId.get(tag.id);
    if (!child) return false;
    if (!applyFrame(child, tag.children, created)) return false;
  }

  const sameOrder = tags.every((tag, index) => tag.id === frame.children[index]?.id);
  if (!sameOrder && hasUnrelatedChildren(frame)) {
    writeGapsInPlace(frame, gapTexts, created);
    return true;
  }

  if (!sameOrder) {
    reorder(frame, tags, gapTexts, byId, created);
    return true;
  }

  writeGapsInPlace(frame, gapTexts, created);
  return true;
}

function writeGapsInPlace(frame: Frame, gapTexts: readonly string[], created: Text[]): void {
  for (let index = 0; index < frame.gaps.length; index += 1) {
    const slots = frame.gaps[index] ?? [];
    const value = gapTexts[index] ?? '';
    if (slots.length === 0) {
      if (value.length === 0) continue;
      const anchor = frame.children[index]?.element ?? null;
      const node = frame.element.ownerDocument.createTextNode(value);
      frame.element.insertBefore(node, anchor);
      created.push(node);
      continue;
    }
    writeSlots(slots, value);
  }
}

/**
 * Moves the original inline elements into the translated order. Nodes are not cloned, and
 * restore puts the previous child order back before rewriting node values.
 */
function reorder(
  frame: Frame,
  tags: readonly { id: string }[],
  gapTexts: readonly string[],
  byId: ReadonlyMap<string, InlineFrame>,
  created: Text[],
): void {
  const pool = frame.gaps.flat();
  let cursor = 0;

  const takeText = (value: string): Text => {
    const slot = pool[cursor];
    cursor += 1;
    if (slot) {
      slot.node.nodeValue = value;
      return slot.node;
    }
    const node = frame.element.ownerDocument.createTextNode(value);
    created.push(node);
    return node;
  };

  const desired: Node[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    desired.push(takeText(gapTexts[index] ?? ''));
    const inline = byId.get(tags[index]?.id ?? '');
    if (inline) desired.push(inline.element);
  }
  desired.push(takeText(gapTexts[tags.length] ?? ''));

  while (cursor < pool.length) {
    const extra = pool[cursor];
    cursor += 1;
    if (!extra) continue;
    extra.node.nodeValue = '';
    desired.push(extra.node);
  }

  for (const node of desired) frame.element.appendChild(node);
}

function hasUnrelatedChildren(frame: Frame): boolean {
  const managed = new Set<Node>();
  for (const slot of frame.gaps.flat()) managed.add(slot.node);
  for (const child of frame.children) managed.add(child.element);

  for (const node of frame.element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').trim().length === 0) continue;
    if (!managed.has(node) && !isTranslationChrome(node)) return true;
  }

  return false;
}

function isTranslationChrome(node: Node): boolean {
  return (
    node instanceof Element && (node.tagName === 'SAKUTTO-LINE' || node.tagName === 'SAKUTTO-NOTE')
  );
}

function writeFlat(model: SegmentModel, value: string, created: Text[]): void {
  const slots = allSlots(model);
  if (slots.length === 0) {
    const existing = created[0];
    if (existing) {
      existing.nodeValue = value;
      return;
    }
    if (value.length === 0) return;
    const node = model.block.ownerDocument.createTextNode(value);
    model.block.insertBefore(node, model.block.firstChild);
    created.push(node);
    return;
  }

  writeSlots(slots, value);
}

function writeSlots(slots: readonly TextSlot[], value: string): void {
  const first = slots[0];
  if (!first) return;
  first.node.nodeValue = value;
  for (const slot of slots.slice(1)) slot.node.nodeValue = '';
}

function ensureChild(block: Element, tag: string): HTMLElement {
  for (const child of block.children) {
    if (child.tagName === tag.toUpperCase() && child.parentElement === block)
      return child as HTMLElement;
  }
  const element = block.ownerDocument.createElement(tag);
  block.append(element);
  return element;
}

function removeLine(block: Element): void {
  for (const child of [...block.children]) {
    if (child.tagName === 'SAKUTTO-LINE') child.remove();
  }
}

function removeReplaceNote(block: Element): void {
  for (const child of [...block.children]) {
    if (child.tagName === 'SAKUTTO-NOTE') child.remove();
  }
}
