import { scriptTextVariants, type ScriptPosition } from '@/shared/scripts';
import { splitForTranslation } from '@/engine/text/sentences';
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

export const LINE_TAG = 'sakutto-line';
/**
 * Older builds painted a "quick translation" badge beside every Chrome draft. The badge
 * is gone, but a block translated by an older build can still hold one, so the cleanup
 * paths keep stripping it.
 */
const LEGACY_NOTE_TAG = 'sakutto-note';

interface Frame {
  element: Element;
  gaps: TextSlot[][];
  children: InlineFrame[];
  script?: ScriptPosition;
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
  rebalanceLines(root);
}

export function restoreSegment(model: SegmentModel, created: Text[]): void {
  restoreStructure(model, created);
  removeTranslationUi(model.block);
  model.block.removeAttribute('data-sakutto-pending');
  model.block.removeAttribute('data-sakutto-id');
  model.block.removeAttribute('data-sakutto-engine');
  // Mail adapters mark their translated body with a provider-specific attribute. Removing it
  // here keeps a direct `restoreSegment` call byte-identical to the page's original markup,
  // not only the controller path that knows the adapter's attribute name.
  for (const name of [...model.block.getAttributeNames()]) {
    if (name.startsWith('data-sakutto-') && name.endsWith('-translated')) {
      model.block.removeAttribute(name);
    }
  }
}

export function restoreStructure(model: SegmentModel, created: Text[]): void {
  discardCreated(created);
  removeTranslationUi(model.block);
  restoreChildOrder(ordered(model));
  for (const slot of allSlots(model)) {
    if (slot.node.nodeValue !== slot.original) slot.node.nodeValue = slot.original;
  }
}

export function paintPlain(model: SegmentModel, translation: string, created: Text[]): void {
  writeFlat(model, visibleTranslation(translation), created);
  rebalanceLines({ element: model.block, gaps: model.gaps, children: model.children });
}

/**
 * Adds the second, translated line under the original. The line holds the translation and
 * nothing else: no badge and no engine caption, whatever translated it.
 */
export function showBilingual(model: SegmentModel, translation: string, created: Text[]): void {
  restoreStructure(model, created);

  const line = ensureChild(model.block, LINE_TAG);
  line.replaceChildren();
  line.setAttribute('translate', 'no');
  const chunks = bilingualChunks(model, translation);
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0) line.append(model.block.ownerDocument.createElement('br'));
    line.append(model.block.ownerDocument.createTextNode(chunks[index] ?? ''));
  }
}

export function removeTranslationUi(block: Element): void {
  removeLine(block);
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
  const current = [...parent.childNodes];
  const offset = current.length - frame.order.length;
  if (offset >= 0 && frame.order.every((node, index) => current[offset + index] === node)) {
    return;
  }
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
    // A script marker is content. If the model emptied the tag but the source held a short
    // glyph, the marker keeps its original text instead of disappearing from the formula.
    if (frame.script !== undefined && value.trim().length === 0 && slots.length > 0) {
      writeSlots(slots, slots.map((slot) => slot.original).join(''));
      continue;
    }
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

interface LineGroup {
  slots: TextSlot[];
  source: string;
}

/** Which direct line of its frame each text slot sits on, counted from the real `<br>`s. */
function slotLines(element: Element): Map<Text, number> {
  const lines = new Map<Text, number>();
  let line = 0;
  for (const child of element.childNodes) {
    if (child instanceof Element && child.localName === 'br') {
      line += 1;
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE) lines.set(child as Text, line);
  }
  return lines;
}

/**
 * The slot runs a gap paints on each line. A gap may cover several lines because `<br>` is
 * source text rather than a placeholder, and its slots are the text nodes on either side.
 * Empty lines have no slots, so they stay out of the distribution and the real `<br>`s keep
 * painting them.
 */
function gapLineGroups(
  gap: readonly TextSlot[],
  lineBySlot: ReadonlyMap<Text, number>,
): LineGroup[] {
  const indexed: { slot: TextSlot; line: number }[] = [];
  for (const slot of gap) {
    const line = lineBySlot.get(slot.node);
    if (line === undefined) return [];
    indexed.push({ slot, line });
  }
  if (indexed.length === 0) return [];

  let first = Number.POSITIVE_INFINITY;
  let last = -1;
  for (const entry of indexed) {
    if (entry.line < first) first = entry.line;
    if (entry.line > last) last = entry.line;
  }

  const groups: LineGroup[] = Array.from({ length: last - first + 1 }, () => ({
    slots: [],
    source: '',
  }));
  for (const entry of indexed) {
    const group = groups[entry.line - first];
    if (!group) continue;
    group.slots.push(entry.slot);
    group.source += entry.slot.original;
  }
  return groups;
}

/** Sentence ends, located in the original string so whitespace and punctuation are kept. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let cursor = 0;
  for (const sentence of splitForTranslation(text, {
    sentenceThreshold: 1,
    maxChunkChars: Math.max(text.length, 1),
  })) {
    const start = text.indexOf(sentence, cursor);
    if (start < 0) continue;
    const end = start + sentence.length;
    if (end > 0 && end < text.length) ends.push(end);
    cursor = end;
  }
  return ends;
}

/** Whole sentences, sliced from the original text so joining them loses no whitespace. */
function sentenceChunks(text: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  for (const end of sentenceEnds(text)) {
    const chunk = text.slice(cursor, end);
    if (chunk.length > 0) chunks.push(chunk);
    cursor = end;
  }
  const rest = text.slice(cursor);
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function wordChunks(text: string): string[] {
  const chunks = text.match(/\S+\s*/gu);
  return chunks ?? (text.length > 0 ? [text] : []);
}

const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Scripts and punctuation that never take an inserted Latin word space. */
const SPACELESS_TEXT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\u3000-\u303f\uff00-\uffef]/u;

/**
 * Whether two chunks of a flattened translation are two Latin words (or a sentence end and
 * the next word) that a model ran together. CJK text and space-less scripts are joined as-is.
 */
function needsUnitSpace(left: string, right: string): boolean {
  const tail = left.at(-1) ?? '';
  const head = right[0] ?? '';
  if (!tail || !head || /\s/u.test(tail) || /\s/u.test(head)) return false;
  if (SPACELESS_TEXT.test(tail) || SPACELESS_TEXT.test(head)) return false;
  if (/[.!?,;:)\]}"'\u201d\u2019\u2026]/u.test(tail)) return /[\p{L}\p{N}]/u.test(head);
  return /[\p{L}\p{N}]/u.test(tail) && /[\p{L}\p{N}]/u.test(head);
}

/** Joins whole units, restoring the Latin space a trimmed sentence split discarded. */
function joinUnits(units: readonly string[], bilingual: boolean): string {
  if (!bilingual) return units.join('');
  let output = '';
  for (const unit of units) {
    if (unit.length === 0) continue;
    if (output.length > 0 && needsUnitSpace(output, unit)) output += ' ';
    output += unit;
  }
  return output;
}

/**
 * A flattened model output can run two Latin sentences together (\`Welcome to Osaka!This is\`).
 * The sentence splitter only accepts a terminator followed by whitespace, so give it one.
 * URLs and email addresses keep their dots; unchanged text is returned as-is.
 */
function separateGluedSentences(text: string): string {
  const ranges: Array<[number, number]> = [];
  for (const pattern of [
    /(?:https?:\/\/|www\.)[^\s<>"'）)】」』]+/giu,
    /(?<=^|[\s<>()"'])[^\s<>()"']+@[^\s<>()"']+\.[a-z]{2,}/giu,
  ]) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    output += character;
    if (!/[.!?]/u.test(character) || !/[A-Za-z]/u.test(text[index + 1] ?? '')) continue;
    if (!/[A-Za-z0-9]/u.test(text[index - 1] ?? '')) continue;
    if (ranges.some(([start, end]) => index >= start && index < end)) continue;
    output += ' ';
  }
  return output;
}

/**
 * Starts of label-like tokens (`コメント：`, `Comments:`) after the first one. A label with a
 * colon is a line boundary even when the translation contains no sentence terminator, which
 * is how an AMO approval mail's `Approved versions` and `Comments` lines were merged into one.
 */
function labelCuts(text: string): number[] {
  const cuts: number[] = [];
  for (const match of text.matchAll(/([^\s:：]{1,40})([:：])/gu)) {
    if (match.index === undefined) continue;
    const token = match[1] ?? '';
    const colon = match.index + token.length;
    // `https:` is not a label. URL schemes otherwise look exactly like one.
    if (text.slice(colon + 1, colon + 3) === '//') continue;

    // The token immediately before the colon may be only the last word of a multi-word
    // label (`Approved versions:`) or a value running into a CJK label (`1.6.2コメント：`).
    let start = match.index;
    if (!/^\p{L}/u.test(token)) {
      const tail = /([\p{L}][\p{L}\p{M}_-]*)$/u.exec(token);
      if (!tail || tail.index === undefined) continue;
      start += tail.index;
    }

    for (let words = 1; words < 5; words += 1) {
      let space = start;
      while (space > 0 && /\s/u.test(text[space - 1] ?? '')) space -= 1;
      if (space === start || space === 0) break;
      let previous = space;
      while (previous > 0 && !/\s/u.test(text[previous - 1] ?? '')) previous -= 1;
      const word = text.slice(previous, space);
      if (word.length > 30 || !/^\p{L}+$/u.test(word)) break;
      start = previous;
    }

    if (start > 0) cuts.push(start);
  }
  return cuts;
}

/** A version, number or URL at the end of a source line is likely to survive translation. */
function trailingAnchor(source: string): string | null {
  const token = /\S+$/u.exec(source.trim())?.[0]?.replace(/[.,;:!?]+$/u, '') ?? '';
  if (token.length < 2 || !/\d/u.test(token)) return null;
  return token;
}

/**
 * Safe cut points for a line-count-preserving split: sentence ends, label starts, and the
 * trailing versions of the source lines themselves. Text is sliced only at these points, so
 * a sentence or a label/value pair is never cut in the middle.
 */
function safeChunks(text: string, sources: readonly string[]): string[] {
  const cuts = new Set<number>(sentenceEnds(text));
  for (const cut of labelCuts(text)) cuts.add(cut);

  let cursor = 0;
  for (let index = 0; index < sources.length - 1; index += 1) {
    const anchor = trailingAnchor(sources[index] ?? '');
    if (!anchor) continue;
    const at = text.indexOf(anchor, cursor);
    if (at < 0) continue;
    const end = at + anchor.length;
    if (end > 0 && end < text.length) cuts.add(end);
    cursor = end;
  }

  const points = [...cuts]
    .filter((point) => point > 0 && point < text.length)
    .sort((a, b) => a - b);
  const chunks: string[] = [];
  let start = 0;
  for (const point of points) {
    if (point <= start) continue;
    const chunk = text.slice(start, point);
    if (chunk.trim().length > 0) chunks.push(chunk);
    start = point;
  }
  const rest = text.slice(start);
  if (rest.trim().length > 0) chunks.push(rest);
  return chunks.map((chunk) => chunk.trim());
}

/**
 * Groups whole sentence (or word) units into the source lines without cutting inside one.
 * If there are fewer units than lines, the first lines take one each and the rest stay empty;
 * that is the merge case that used to leave one stray character on every blank `<br>` line.
 */
function groupUnits(
  units: readonly string[],
  sources: readonly string[],
  bilingual = false,
): string[] {
  const count = sources.length;
  if (count <= 1) return [units.join('')];

  const weights = sources.map((source) => Math.max(1, source.trim().length));
  const chunks: string[] = [];
  let index = 0;

  for (let line = 0; line < count; line += 1) {
    const remainingUnits = units.length - index;
    if (remainingUnits <= 0) {
      chunks.push('');
      continue;
    }

    const remainingLines = count - line - 1;
    if (remainingUnits <= remainingLines) {
      chunks.push(joinUnits([units[index] ?? ''], bilingual));
      index += 1;
      continue;
    }

    const remainingWeight = weights.slice(line).reduce((sum, weight) => sum + weight, 0);
    let take =
      line === count - 1
        ? remainingUnits
        : Math.round((remainingUnits * (weights[line] ?? 1)) / remainingWeight);
    take = Math.max(1, Math.min(take, remainingUnits - remainingLines));
    chunks.push(joinUnits(units.slice(index, index + take), bilingual));
    index += take;
  }
  return chunks.map((chunk) => chunk.trim());
}

/**
 * Distributes text the model returned as one paragraph over the source lines. CJK text is
 * split only at sentence ends; when there are fewer sentences than lines, several source
 * lines stay empty instead of receiving a fragment. Space-delimited text may fall back to
 * word boundaries only when there are not enough sentence boundaries to fill the lines.
 * There is deliberately no per-code-point fallback in this replacement path: that put
 * `あ` / `り` / `がとう` on the whitespace-only lines between Gmail's `<br>`s. The bilingual
 * line has its own fallback below, because its gaps are painted without source `<br>`s.
 */
function splitByWeights(text: string, sources: readonly string[], bilingual = false): string[] {
  const count = sources.length;
  const trimmed = text.trim();
  if (count <= 1) return [trimmed];
  if (trimmed.length === 0) return Array.from({ length: count }, () => '');

  const safe = safeChunks(trimmed, sources);
  if (safe.length >= count) return groupUnits(safe, sources, bilingual);

  const sentences = sentenceChunks(trimmed).filter((chunk) => chunk.trim().length > 0);
  if (sentences.length >= count) return groupUnits(sentences, sources, bilingual);

  if (CJK_TEXT.test(trimmed)) {
    const chunks = sentences.slice(0, count);
    while (chunks.length < count) chunks.push('');
    return chunks.map((chunk) => chunk.trim());
  }

  const words = wordChunks(trimmed);
  if (words.length >= count) return groupUnits(words, sources, bilingual);
  const chunks = words.slice(0, count);
  while (chunks.length < count) chunks.push('');
  return chunks.map((chunk) => chunk.trim());
}

function lineChunks(text: string, groups: readonly LineGroup[], bilingual = false): string[] {
  if (groups.length <= 1) return [text];

  const leading = /^\s*/u.exec(text)?.[0] ?? '';
  const trailing = /\s*$/u.exec(text)?.[0] ?? '';
  let chunks: string[];
  const parts = text.split('\n');
  const nonEmpty = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  if (nonEmpty.length === groups.length) {
    chunks = nonEmpty;
  } else {
    const sources = groups.map((group) => group.source);
    chunks = splitByWeights(text, sources, bilingual);
    // The replacement renderer deliberately leaves blank lines empty when the output has
    // fewer sentence ends than the source has lines. A bilingual line has no real `<br>`s
    // of its own, so flattening every paragraph into its first chunk would read as one
    // run-on block. This last resort applies to flat output in any language; the replacement
    // path is unchanged.
    if (bilingual && chunks.filter((chunk) => chunk.trim().length > 0).length < groups.length) {
      chunks = distributeFlatParagraphs(text.trim(), sources);
    }
  }

  // Spaces at the edges of a gap sit beside an inline placeholder, not a line break. Keep
  // them so `See <a>link</a> here` does not become `See<a>link</a>here`.
  if (chunks.length > 0) {
    chunks[0] = leading + (chunks[0] ?? '');
    const last = chunks.length - 1;
    chunks[last] = (chunks[last] ?? '') + trailing;
  }
  return chunks;
}

/**
 * Last-resort split for a flattened translation, in any target language, that has fewer
 * sentence boundaries than the source has paragraphs. CJK cuts land on code points; Latin
 * cuts land between words, with their spaces restored. Every unit stays in exactly one
 * chunk. The source text is still right above the bilingual line, so an imperfect cut is
 * less harmful than one run-on block.
 */
function distributeFlatParagraphs(text: string, sources: readonly string[]): string[] {
  const cjk = CJK_TEXT.test(text);
  const points = cjk ? Array.from(text) : wordChunks(text);
  const weights = sources.map((source) =>
    Math.max(1, cjk ? Array.from(source.trim()).length : wordChunks(source.trim()).length),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const chunks: string[] = [];
  let cursor = 0;

  for (let index = 0; index < sources.length - 1; index += 1) {
    const remainingPoints = points.length - cursor;
    const remainingGroups = sources.length - index - 1;
    const preferred = Math.round((points.length * (weights[index] ?? 1)) / totalWeight);
    // Leave enough units for the paragraphs that follow. A translation shorter than the
    // paragraph count simply leaves the trailing paragraphs empty.
    const take = Math.min(Math.max(0, preferred), Math.max(0, remainingPoints - remainingGroups));
    const part = points.slice(cursor, cursor + take);
    chunks.push(cjk ? part.join('') : joinUnits(part, true));
    cursor += take;
  }
  const rest = points.slice(cursor);
  chunks.push(cjk ? rest.join('') : joinUnits(rest, true));
  return chunks;
}

/** Mirror the source's real line breaks without rewriting its React-owned text nodes. */
function bilingualChunks(model: SegmentModel, translation: string): string[] {
  const sources = model.source.split('\n');
  const groups = sources
    .filter((source) => source.trim().length > 0)
    .map((source) => ({ slots: [], source }));
  const chunks = lineChunks(separateGluedSentences(visibleTranslation(translation)), groups, true);
  let index = 0;
  return sources.map((source) => {
    if (source.trim().length === 0) return '';
    const chunk = chunks[index] ?? '';
    index += 1;
    return chunk;
  });
}

/**
 * Writes a translation back over the line runs the source already had. The first fix for
 * Gmail wrapped each line in a span; that mutated the page, split one mail into a request
 * per line and left markup behind on restore. This pass uses the existing text nodes: after
 * placeholders are applied, each gap holds the translated text for all of its lines, and it
 * is redistributed over those lines so the `<br>` nodes keep painting the message layout.
 */
function rebalanceLines(frame: Frame): void {
  const lineBySlot = slotLines(frame.element);
  for (const gap of frame.gaps) {
    const groups = gapLineGroups(gap, lineBySlot);
    if (groups.length === 0) continue;

    const text = gap.map((slot) => slot.node.nodeValue ?? '').join('');
    const usable: LineGroup[] = [];
    for (const group of groups) {
      // A text node holding only the newline or space between two `<br>`s is layout, not a
      // source line. Counting it as a target split short translations into one character per
      // blank visual line; its original bytes are restored below instead.
      const slots = group.slots.filter((slot) => slot.original.trim().length > 0);
      if (slots.length > 0) usable.push({ slots, source: group.source });
    }

    if (usable.length > 0 && text.trim().length > 0) {
      const chunks = usable.length === 1 ? [text] : lineChunks(text, usable);
      for (let index = 0; index < usable.length; index += 1) {
        writeSlots(usable[index]?.slots ?? [], chunks[index] ?? '');
      }
    }

    for (const group of groups) {
      for (const slot of group.slots) {
        if (slot.original.trim().length === 0) slot.node.nodeValue = slot.original;
      }
    }
  }
  for (const child of frame.children) rebalanceLines(child);
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
    node instanceof Element &&
    (node.tagName === 'SAKUTTO-LINE' || node.tagName === LEGACY_NOTE_TAG.toUpperCase())
  );
}

function writeFlat(model: SegmentModel, value: string, created: Text[]): void {
  const scripts = scriptFrames(model.children);
  if (scripts.length > 0) {
    writeFlatWithScripts(model, value, created, scripts);
    return;
  }

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

type FlatAnchor =
  | { kind: 'slot'; node: Text; slot: TextSlot }
  | { kind: 'script'; node: Element; frame: InlineFrame };

function scriptFrames(children: readonly InlineFrame[]): InlineFrame[] {
  const frames: InlineFrame[] = [];
  const visit = (list: readonly InlineFrame[]): void => {
    for (const child of list) {
      if (child.script !== undefined) frames.push(child);
      visit(child.children);
    }
  };
  visit(children);
  return frames;
}

function flatAnchors(model: SegmentModel, scripts: readonly InlineFrame[]): FlatAnchor[] {
  const anchors: FlatAnchor[] = allSlots(model).map((slot) => ({
    kind: 'slot',
    node: slot.node,
    slot,
  }));
  for (const frame of scripts) {
    anchors.push({ kind: 'script', node: frame.element, frame });
  }
  return anchors.sort((left, right) => {
    if (left.node === right.node) return 0;
    const position = left.node.compareDocumentPosition(right.node);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
    return 0;
  });
}

/**
 * Splits plain fallback text at every script glyph the model kept. The glyph itself is
 * removed from the split, because the original element already carries it.
 */
function splitFlatText(
  value: string,
  scripts: readonly InlineFrame[],
): { chunks: string[]; found: Set<string> } {
  const chunks: string[] = [];
  const found = new Set<string>();
  let cursor = 0;

  for (const frame of scripts) {
    if (frame.script === undefined) continue;
    const glyph = (frame.element.textContent ?? '').trim();
    if (glyph.length === 0) continue;

    let index = -1;
    let length = 0;
    for (const variant of scriptTextVariants(glyph, frame.script)) {
      if (variant.length === 0) continue;
      const next = value.indexOf(variant, cursor);
      if (next < 0) continue;
      if (index < 0 || next < index || (next === index && variant.length > length)) {
        index = next;
        length = variant.length;
      }
    }

    if (index < 0) {
      // The model dropped the digit as well as the tag. The words on either side of the
      // original element still locate where it belonged (the `CH` and `OH` of `CH3OH`).
      const boundary = contextBoundary(frame.element, value, cursor);
      if (!boundary) continue;
      index = boundary;
      length = 0;
    }

    chunks.push(value.slice(cursor, index));
    cursor = index + length;
    found.add(frame.id);
  }

  chunks.push(value.slice(cursor));
  return { chunks, found };
}

/** The run of visible characters at the end of the text just before a script element. */
function previousRun(element: Element): string {
  for (let node = element.previousSibling; node !== null; node = node.previousSibling) {
    if (node.nodeType !== Node.TEXT_NODE) return '';
    const match = (node.nodeValue ?? '').match(/([\p{L}\p{N}\p{P}\p{S}]{1,12})\s*$/u);
    if (match?.[1]) return match[1];
  }
  return '';
}

/** The run of visible characters at the start of the text just after a script element. */
function nextRun(element: Element): string {
  for (let node = element.nextSibling; node !== null; node = node.nextSibling) {
    if (node.nodeType !== Node.TEXT_NODE) return '';
    const match = (node.nodeValue ?? '').match(/^\s*([\p{L}\p{N}\p{P}\p{S}]{1,12})/u);
    if (match?.[1]) return match[1];
  }
  return '';
}

function contextBoundary(element: Element, value: string, cursor: number): number | null {
  const before = previousRun(element);
  const after = nextRun(element);
  if (before.length > 0 && after.length > 0) {
    const joined = value.indexOf(`${before}${after}`, cursor);
    if (joined >= 0) return joined + before.length;
  }
  if (before.length > 0) {
    const found = value.indexOf(before, cursor);
    if (found >= 0) return found + before.length;
  }
  if (after.length > 0) {
    const found = value.indexOf(after, cursor);
    if (found >= 0) return found;
  }
  return null;
}

/**
 * Plain fallback for a block with atomic scripts. The translation is written into the text
 * slots on either side of each script, and the original element keeps its place in between,
 * so a dropped placeholder cannot leave the digit dangling at the end of the block.
 */
function writeFlatWithScripts(
  model: SegmentModel,
  value: string,
  created: Text[],
  scripts: readonly InlineFrame[],
): void {
  discardCreated(created);
  const { chunks, found } = splitFlatText(value, scripts);
  const anchors = flatAnchors(model, scripts);
  let chunk = 0;
  let written = false;

  const writeSlot = (slot: TextSlot): void => {
    const next = chunks[chunk] ?? '';
    if (written) {
      slot.node.nodeValue = '';
      return;
    }
    slot.node.nodeValue = next;
    written = next.length > 0;
  };

  for (const anchor of anchors) {
    if (anchor.kind === 'slot') {
      writeSlot(anchor.slot);
      continue;
    }
    if (!found.has(anchor.frame.id)) continue;
    if (!written) {
      const next = chunks[chunk] ?? '';
      const parent = anchor.node.parentNode;
      if (next.length > 0 && parent !== null) {
        const node = model.block.ownerDocument.createTextNode(next);
        parent.insertBefore(node, anchor.node);
        created.push(node);
      }
      written = true;
    }
    chunk += 1;
    written = false;
  }

  const rest = chunks[chunk] ?? '';
  if (!written && rest.length > 0) {
    const last = anchors.at(-1);
    const parent = last?.node.parentNode ?? model.block;
    const node = model.block.ownerDocument.createTextNode(rest);
    parent.insertBefore(node, last?.node.nextSibling ?? null);
    created.push(node);
  }
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
  removeLegacyNote(block);
}

/**
 * Strips the badge an older build painted beside Chrome drafts. Nothing creates one any
 * more; this only clears a block that an earlier version already painted.
 */
function removeLegacyNote(block: Element): void {
  for (const child of [...block.children]) {
    if (child.tagName === LEGACY_NOTE_TAG.toUpperCase()) child.remove();
  }
}

/**
 * Removes every leftover badge under a root. The per-block cleanup only reaches blocks
 * this session paints, and a block an older build already translated into the target
 * language is never repainted, so a stale 「簡易訳」 would otherwise stay on screen.
 */
export function stripLegacyNotes(root: ParentNode): void {
  for (const note of [...root.querySelectorAll(LEGACY_NOTE_TAG)]) note.remove();
}
