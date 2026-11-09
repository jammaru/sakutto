/** A control the reader types into. The text in one is the reader's own, never page copy. */
const FIELD_SELECTORS = [
  'textarea',
  'input',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
];

const EXCLUDED_SELECTOR = [
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'script',
  'style',
  'noscript',
  ...FIELD_SELECTORS,
  'svg',
  'math',
  '[translate="no"]',
  '.notranslate',
].join(', ');

/**
 * Inline code inside a sentence. It must never be rewritten, and it must not move either.
 *
 * Dropping it from the segment split the sentence into two gaps, the translation was
 * written into the first one, and the code element ended up after the translated line: a
 * model card read `forward + reverse scan, , with a per-channel` with the identifier
 * dangling at the end. These tags become placeholders instead, so the model keeps them where
 * the sentence put them and the element itself is never rewritten — a code child is stored
 * with no text slots, so whatever the model writes inside the tag is discarded and the
 * original code stays in the DOM.
 */
const INLINE_CODE_TAGS: ReadonlySet<string> = new Set(['code', 'kbd', 'samp', 'var']);

export function isInlineCode(element: Element): boolean {
  return INLINE_CODE_TAGS.has(element.localName);
}

const BLOCK_SELECTOR = [
  'address',
  'article',
  'aside',
  'blockquote',
  'button',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'label',
  'legend',
  'li',
  'main',
  'nav',
  'p',
  'section',
  'summary',
  'td',
  'th',
].join(', ');

const BLOCK_TAGS: ReadonlySet<string> = new Set(BLOCK_SELECTOR.split(', '));

const LETTER_PATTERN = /\p{L}/u;
const URL_ONLY = /^(?:https?:\/\/|www\.)\S+$/iu;

/**
 * Screen-reader text and collapsed menus. They duplicate visible copy or hold
 * navigation that a sighted reader never sees, so translating them either makes
 * text appear from nowhere or spends a request nobody reads.
 *
 * Only exact utility class names are listed: `not-sr-only` re-enables such text and
 * must stay translatable. Tailwind's `sr-only` also sets `clip: rect(0,0,0,0)` rather
 * than `display: none`, so a computed-style check alone never catches it.
 */
const VISUALLY_HIDDEN_SELECTOR = [
  '.sr-only:not(.not-sr-only)',
  '.visually-hidden:not(.not-visually-hidden)',
  '.screen-reader-only:not(.not-screen-reader-only)',
  '.screen-reader-text:not(.not-screen-reader-text)',
  '.a11y-hidden:not(.not-a11y-hidden)',
].join(', ');

/** The clip rectangle that `sr-only` and friends use to remove a box from view. */
const CLIPPED_AWAY = /clip:\s*rect\(\s*0(?:px)?[,\s]+0(?:px)?[,\s]+0(?:px)?[,\s]+0(?:px)?\s*\)/iu;

/** Clip-path off-screen hiding, which `tailwind` uses for the same purpose. */
const CLIPPED_PATH = /clip-path:\s*inset\(\s*50%\s*\)/iu;
const OWN_UI_TAGS: ReadonlySet<string> = new Set([
  'SAKUTTO-LINE',
  'SAKUTTO-NOTE',
  'SAKUTTO-TIP',
  'SAKUTTO-POP',
  'SAKUTTO-SELECT',
  'SAKUTTO-COMPOSE',
  'SAKUTTO-WRITE',
  'SAKUTTO-PERF',
  'SAKUTTO-STATUS',
  'SAKUTTO-BAR',
]);

const FROZEN_SELECTOR = [
  'sup',
  'sub',
  'ruby',
  'rt',
  'rp',
  'audio',
  'video',
  'button',
  '.IPA',
  '.ext-phonos',
  '.mw-ref',
  '.reference',
  '[role="button"]',
].join(', ');

export function isOwnUi(element: Element): boolean {
  return OWN_UI_TAGS.has(element.tagName) || element.closest(OWN_UI_SELECTOR) !== null;
}

const EDITABLE_SELECTOR = FIELD_SELECTORS.join(', ');

/**
 * The field the reader is typing in, when the focus sits inside one.
 *
 * `document.activeElement` stops at a shadow host, so an open root has to be entered before
 * the control that holds the caret is reachable: a custom `<my-search>` element that wraps
 * its own `<input>` reports only the host. The chain of hosts is collected first, then each
 * level is asked for an editable ancestor from the inside out. Innermost wins, so a control
 * inside a root is found; stepping out afterwards covers the other shape, a host that is
 * itself dropped inside a `<div contenteditable>` and whose root holds no field. `closest`
 * cannot climb out of a shadow tree on its own, so that case needs the outer level.
 */
export function focusedEditableField(active: Element | null | undefined): Element | null {
  const chain: Element[] = [];
  let element = active ?? null;
  // Bounded to survive a pathological page; each step enters one open shadow root.
  for (let depth = 0; element && depth < 32; depth += 1) {
    chain.push(element);
    const inner = element.shadowRoot?.activeElement;
    if (!inner || inner === element) break;
    element = inner;
  }

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const field = chain[index]?.closest(EDITABLE_SELECTOR) ?? null;
    if (field) return field;
  }
  return null;
}

/** What the reader has typed into a field. Duck-typed: an iframe field is another realm. */
function fieldValue(field: Element): string {
  if ('value' in field && typeof (field as HTMLInputElement).value === 'string') {
    return (field as HTMLInputElement).value;
  }
  return field.textContent ?? '';
}

/**
 * True when a page selection is really the text the reader typed into the focused field.
 *
 * A `textarea` reports its value through `window.getSelection()` on Ctrl+A or a drag, while
 * the reported range sits on `<body>`. Without this check the value of a search box, a
 * message box or a form is queued for translation, which is text the reader never asked to
 * translate and may not expect a model to read. Only text the field actually holds is
 * dropped, so a page that keeps an empty field focused can still have its prose translated.
 *
 * The match is deliberately loose in one direction: a page selection that happens to be a
 * substring of the field value is also dropped. Sending text the reader did not offer is
 * the worse mistake, so the ambiguous case goes the other way.
 */
export function isTypedTextSelection(active: Element | null | undefined, text: string): boolean {
  const field = focusedEditableField(active);
  const wanted = text.trim();
  if (!field || wanted.length === 0) return false;

  const value = fieldValue(field);
  if (value.length === 0) return false;
  if (value.includes(wanted)) return true;
  // A password input paints a mask instead of its value, and the document selection
  // reports the mask. Only a password input is read this way: `***` in body copy is page
  // text, not a secret. `.type` is the IDL property, which lowercases `type="PASSWORD"`;
  // `getAttribute('type')` would miss that spelling.
  return (
    field.localName === 'input' &&
    (field as HTMLInputElement).type === 'password' &&
    /^[\u2022*]+$/u.test(wanted)
  );
}

const OWN_UI_SELECTOR = [...OWN_UI_TAGS].join(', ').toLowerCase();

export function isBlockElement(element: Element): boolean {
  return BLOCK_TAGS.has(element.tagName.toLowerCase());
}

export function isTranslationExcluded(element: Element): boolean {
  return isOwnUi(element) || element.closest(EXCLUDED_SELECTOR) !== null;
}

/**
 * Icons and hidden sprite text use `aria-hidden`, which is worth skipping. But the same
 * attribute marks an entire app shell while a dialog, a route transition or a portal is
 * open, and skipping that is why a page could report itself translated while most of it
 * stayed in the source language.
 *
 * A region with no block inside it is a leaf: a glyph, a shortcut hint, a decorative
 * label. A region that contains blocks is a container, so the walk descends into it and
 * drops only the leaves that are themselves aria-hidden.
 */
export function isAriaHiddenLeaf(element: Element): boolean {
  if (element.getAttribute('aria-hidden') !== 'true') return false;
  if (element.matches('.notranslate, [translate="no"]')) return false;
  return element.querySelector(BLOCK_SELECTOR) === null;
}

/**
 * Accessible-only text. `sr-only` and friends remove a box from view with clipping
 * rather than `display: none`, so a computed-style check never catches them. They
 * duplicate visible copy or hold collapsed menu contents, and on Hugging Face the
 * hidden "Use this model" panel is larger than the visible model card.
 */
export function isScreenReaderOnly(element: Element): boolean {
  return element.closest(VISUALLY_HIDDEN_SELECTOR) !== null;
}

/**
 * Text a sighted reader can actually see. Collapsed menus (`display: none`), closed
 * `<details>` bodies, `visibility: hidden` and `content-visibility: hidden` content
 * never reach the model: translating them spends requests on copy nobody reads and,
 * when the region opens later, shows text from another layout.
 *
 * Results are memoized per scan. The walk visits parents before children, so a subtree
 * behind a hidden ancestor is rejected in one lookup instead of one `getComputedStyle`
 * per node on a large app page, and an excluded ancestor is not re-matched by every
 * descendant through `closest()`.
 */
class VisibilityProbe {
  private readonly memo = new WeakMap<Element, boolean>();

  /** False for the element or any container above it that is hidden or excluded. */
  skipped(element: Element): boolean {
    const cached = this.memo.get(element);
    if (cached !== undefined) return cached;

    // Recurse from the parent first: a hidden or excluded ancestor settles the answer
    // without a style read, and a `<details>` ancestor decides its own children, so the
    // collapsed-body rule must not also be applied to the summary the reader can see.
    const parent = element.parentElement;
    const value =
      (parent !== null && this.skipped(parent)) ||
      isTranslationExcluded(element) ||
      isAriaHiddenLeaf(element) ||
      isScreenReaderOnly(element) ||
      isCollapsedDetail(element) ||
      !isRenderedHere(element);
    this.memo.set(element, value);
    return value;
  }

  visible(element: Element): boolean {
    return !this.skipped(element);
  }
}

/**
 * Everything except the `<summary>` of a closed `<details>` is not rendered. A browser
 * keeps those nodes in the DOM, so without this the collapsed half of a page costs a
 * request per paragraph and then shows translated text nobody asked to see.
 */
export function isCollapsedDetail(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.localName !== 'details' || (node as HTMLDetailsElement).open) continue;
    // The `<details>` element is a visible container; only its collapsed children hide.
    if (node === element) continue;
    const summary = node.firstElementChild;
    if (!summary || summary.localName !== 'summary') return true;
    if (summary !== element && !summary.contains(element)) return true;
  }
  return false;
}
function isRenderedHere(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return true;

  // `checkVisibility` walks the ancestor chain inside the engine and costs about a tenth
  // of one `getComputedStyle` per node, which matters on a large app page.
  //
  // `contentVisibilityAuto` stays off on purpose: a long article that uses
  // `content-visibility: auto` skips rendering below the fold, and treating that as
  // hidden would drop most of the page from the very first scan.
  const measure = element.checkVisibility?.bind(element) ?? null;
  if (measure !== null && measure({ visibilityProperty: true })) return true;

  // `checkVisibility()` is false for an element that generates no box, and a
  // `display: contents` wrapper is exactly that: its children paint, the element itself
  // does not. Frameworks wrap whole app shells this way — Hugging Face keeps its header,
  // model card and sidebar inside a `contents` div — so reading the missing box as
  // "hidden" discarded the page content inside it. Ancestors were already vetted by the
  // caller's recursion, so only the element's own style decides here.
  const own = measure === null ? null : view.getComputedStyle(element);
  if (own !== null && own.display === 'contents') {
    return (
      own.visibility !== 'hidden' &&
      own.visibility !== 'collapse' &&
      own.contentVisibility !== 'hidden'
    );
  }
  if (measure !== null) return false;

  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.contentVisibility === 'hidden') return false;
    if (CLIPPED_AWAY.test(style.cssText ?? '') || CLIPPED_PATH.test(style.cssText ?? '')) {
      return false;
    }
  }
  return true;
}

export function isVisuallyRendered(element: Element): boolean {
  return new VisibilityProbe().visible(element);
}

/**
 * Layouts that give every child its own slot. A text node between two children of such a
 * container is not "just whitespace" to the engine: it becomes an anonymous grid or flex
 * item and pushes every following child one slot along.
 *
 * That is what flattened the ranking table on srclog.com. The whole row was one segment,
 * its translation was written into the whitespace between the cells, and the row — a CSS
 * grid with one column per cell — reflowed into a vertical pile. Rows that had not been
 * translated yet still looked like a table, which is the contrast the reader noticed.
 */
const ITEM_CONTAINER_DISPLAYS: ReadonlySet<string> = new Set([
  'grid',
  'inline-grid',
  'flex',
  'inline-flex',
  'table-row',
  'table-row-group',
]);

/**
 * Display values that are cached for one scan. `getComputedStyle` is the expensive part
 * of deciding whether a container lays out in slots, and a row is asked about twice —
 * once as a container and once as a cell of the list above it.
 */
class LayoutProbe {
  private readonly displays = new WeakMap<Element, string>();

  display(element: Element): string {
    const cached = this.displays.get(element);
    if (cached !== undefined) return cached;
    const value = element.ownerDocument.defaultView?.getComputedStyle(element).display ?? '';
    this.displays.set(element, value);
    return value;
  }

  /** True when the element places each child in its own slot, so loose text reflows it. */
  itemContainer(element: Element): boolean {
    return ITEM_CONTAINER_DISPLAYS.has(this.display(element));
  }

  /** True when the element is laid out as a block of its own instead of inline in a line. */
  blockBox(element: Element): boolean {
    if (isBlockElement(element)) return true;
    const display = this.display(element);
    return display.length > 0 && display !== 'contents' && !display.startsWith('inline');
  }

  /** True when the element lays out inside its parent's line rather than in its own box. */
  inline(element: Element): boolean {
    if (isBlockElement(element)) return false;
    const display = this.display(element);
    if (display.length === 0) return true;
    return display === 'contents' || display.startsWith('inline');
  }
}

const DATA_ROW_MIN_ROWS = 3;
const DATA_ROW_MIN_CELLS = 2;
/** A record's cell holds a value; a card's cell holds a paragraph. */
const DATA_CELL_MAX_CHARS = 60;

/**
 * Elements that are copy by definition, so they are never a record row however many child
 * elements they happen to have.
 *
 * A Hugging Face model card is what this fixes. Its headings are `<h2><a><span>How it
 * works</span></a><span>…</span></h2>` and its paragraphs are prose with several `<code>`
 * children. Both have two or more short child elements, three or more of them repeat down
 * the card, and the repeated-row rule then read the whole model card as a data table: the
 * headings and those paragraphs were dropped and the page reported a large leftover count.
 */
const PROSE_ROW_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'caption',
  'figcaption',
  'summary',
  'dt',
  'dd',
  'pre',
]);

/**
 * A cell of a repeating row: a ranking row, a price list, a file table. Three or more
 * sibling rows of the same tag, each with more than one cell, is a page showing data,
 * where a cell holds a value rather than copy.
 *
 * The walk only asks this of an element it reached as a slot of such a row, so a one-word
 * paragraph inside a card grid is still translated. The ancestor walk is here because a
 * cell's content is often wrapped (`a > span > span` on a ranking row) and every wrapper
 * still belongs to the same column.
 */
export function isDataRowCell(element: Element): boolean {
  let node: Element | null = element;
  for (let depth = 0; node !== null && depth < MAX_CELL_DEPTH; depth += 1) {
    const row: Element | null = node.parentElement;
    if (!row) return false;
    if (isRepeatedRow(row)) return true;
    node = row.parentElement;
  }
  return false;
}

/** How far above a cell its wrapping markup may sit and still count as the same column. */
const MAX_CELL_DEPTH = 3;

/**
 * Three or more sibling rows of the same tag, each showing a handful of short values.
 *
 * The short-cell test is what separates a record from a card. A card grid is also a set of
 * sibling elements with the same tag, but a card holds a heading and a paragraph — copy a
 * reader wants translated — while a ranking row holds `antfu`, `Japan`, `TypeScript`. Only
 * the latter is a data row, and only there is a cell's text a value to skip.
 */
function isRepeatedRow(row: Element): boolean {
  const list = row.parentElement;
  if (!list || row.children.length < DATA_ROW_MIN_CELLS) return false;
  if (PROSE_ROW_TAGS.has(row.localName)) return false;
  if (isProseMarkup(row)) return false;

  let rows = 0;
  for (const sibling of list.children) {
    if (sibling.localName !== row.localName) continue;
    if (PROSE_ROW_TAGS.has(sibling.localName)) continue;
    if (sibling.children.length < DATA_ROW_MIN_CELLS) continue;
    if (isProseMarkup(sibling)) continue;
    if (!showsOnlyValues(sibling)) continue;
    rows += 1;
    if (rows >= DATA_ROW_MIN_ROWS) return true;
  }
  return false;
}

/**
 * A row whose cells are inline formatting rather than columns. A ranking row is
 * `<li><span>1</span><a><span>antfu</span><span>Anthony Fu</span></a><span>Japan</span></li>`:
 * it paints as a grid, and each cell is a separate box. A bullet of README prose is
 * `<li><strong>Layers:</strong> causal mask removed.</li>` — one cell beside loose text — and
 * a prose paragraph is text with an inline `<code>` in the middle. Neither is a record.
 *
 * The test is whether the row places its children in slots of their own. A record row
 * always does (a grid, a flex line, a `<tr>`); a sentence does not, so its children are
 * inline and part of the same line of text.
 */
function isProseMarkup(row: Element): boolean {
  for (const node of row.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const value = node.nodeValue ?? '';
    if (value.trim().length > 0 && LETTER_PATTERN.test(value)) return true;
  }
  const view = row.ownerDocument.defaultView;
  if (!view) return false;
  const display = view.getComputedStyle(row).display;
  if (
    display === 'flex' ||
    display === 'inline-flex' ||
    display === 'grid' ||
    display === 'inline-grid'
  ) {
    return false;
  }
  return true;
}

function showsOnlyValues(row: Element): boolean {
  for (const cell of row.children) {
    if (cellValue(cell).length > DATA_CELL_MAX_CHARS) return false;
  }
  return true;
}

/** A count, a magnitude or an amount: `44`, `1,305`, `64.4k`, `+12%`. */
const NUMERIC_VALUE =
  /^[+\-–—~<>≈]?[\d][\d.,\s]*(?:%|[kmbt]|万|億|千|件|個|円|人|回|users?|repos?|stars?|forks?)?$/iu;

/** Letters, digits, punctuation and symbols — the script of a handle, a code or a stat. */
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;

const HAS_LOWERCASE = /\p{Ll}/u;
const HAS_UPPERCASE = /\p{Lu}/u;

/** Letters, digits and the separators an identifier uses: `dai-shi`, `node.js`, `v1.2.3`. */
const IDENTIFIER = /^[\p{Script=Latin}\p{N}._+#-]+$/u;

/**
 * A value in a data row, as opposed to copy: a count, a stat line, a handle, a slug, a
 * version. Sending one to the model spends a completion to hand it back, and the model
 * often rewrites an identifier into something that is no longer the same account.
 *
 * A capitalised word stays copy: `Japan`, `TypeScript` and `Anthony Fu` are words a reader
 * may not know, and they are what the extension is for. When such a word fills a whole
 * column it is skipped as a repeated value instead, once per page rather than once per row.
 */
export function isDataValueText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (!LATIN_ONLY.test(trimmed)) return false;

  const words = trimmed.split(/\s+/u).filter((part) => LETTER_PATTERN.test(part));
  if (words.length === 0) return true;
  const numeric = words.filter((word) => NUMERIC_VALUE.test(word)).length;
  if (numeric === words.length) return true;
  // A stat line: `⭐ 64.4k · 🍴 4.1k · 👀 2.5k · 44 repos`.
  if (numeric > 0 && numeric * 2 >= words.length) return true;
  if (words.length !== 1) return false;
  if (HAS_UPPERCASE.test(trimmed)) return false;
  return IDENTIFIER.test(trimmed) && HAS_LOWERCASE.test(trimmed);
}

/**
 * Values that repeat down a data column: the same country, language, size or unit in
 * dozens of rows. Translated once each they cost one completion per row for a handful of
 * distinct strings, and every cell is a chance for the model to drift. A column is read
 * once per page scan and the repeated spellings are skipped, exactly as if they were
 * counts.
 *
 * The threshold is what makes this safe: a phrase that appears three times in the same
 * repeated row is a column value, while copy that happens to repeat stays below it and is
 * translated in every place it appears.
 */
const REPEATED_CELL_LIMIT = 3;

/**
 * The value a cell shows, with its markup removed. A language chip is `Japan` in one row
 * and `<span>Japan</span>` in the next, and both are the same column value.
 */
function cellValue(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

export function repeatedCellTexts(root: ParentNode): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const row of root.querySelectorAll('*')) {
    if (!isRepeatedRow(row)) continue;
    for (const cell of row.children) {
      const text = cellValue(cell);
      if (text.length === 0 || text.length > 60) continue;
      if (!LETTER_PATTERN.test(text)) continue;
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }

  const repeated = new Set<string>();
  for (const [text, count] of counts) {
    if (count >= REPEATED_CELL_LIMIT) repeated.add(text);
  }
  return repeated;
}

/** Text that must stay on the page unchanged: whitespace is kept, URLs and symbol runs are not. */
export function isAtomicText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (URL_ONLY.test(trimmed)) return true;
  return !LETTER_PATTERN.test(trimmed);
}

export function isSkippableText(value: string): boolean {
  return value.trim().length > 0 && isAtomicText(value);
}

/**
 * Punctuation and numbers stay in the segment so link lists keep their separators.
 * A URL that occupies the whole text node stays out of the translation.
 */
export function isKeptInlineText(value: string): boolean {
  if (value.length === 0) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return !URL_ONLY.test(trimmed);
}

/**
 * Citations, pronunciation and short foreign-language names stay in the DOM.
 * They are not sent to the model, so a bad generation cannot scramble them.
 */
export function isFrozenInline(element: Element): boolean {
  if (element.matches(FROZEN_SELECTOR)) return true;
  if (!element.hasAttribute('lang') || isBlockElement(element)) return false;
  const text = (element.textContent ?? '').trim();
  return text.length > 0 && text.length <= 40;
}

export function hasTranslatableText(element: Element): boolean {
  return hasTranslatableTextIn(element, new VisibilityProbe());
}

function hasTranslatableTextIn(element: Element, probe: VisibilityProbe): boolean {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || isSkipped(parent, probe)) continue;
    const value = node.nodeValue ?? '';
    if (isSkippableText(value)) continue;
    if (LETTER_PATTERN.test(value)) return true;
  }

  return false;
}

function hasDirectTranslatableText(
  element: Element,
  probe: VisibilityProbe,
  layout: LayoutProbe,
): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const value = child.nodeValue ?? '';
    if (isSkippableText(value)) continue;
    if (LETTER_PATTERN.test(value)) return true;
  }

  for (const child of element.children) {
    if (layout.blockBox(child) || isSkipped(child, probe)) continue;
    if (hasTranslatableTextIn(child, probe)) return true;
  }

  return false;
}

/** Everything a block walk must never descend into, given a scan-wide probe. */
function isSkipped(element: Element, probe: VisibilityProbe): boolean {
  return probe.skipped(element);
}

export function listTranslatableBlocks(root: ParentNode): Element[] {
  return [...eachTranslatableBlock(root)];
}

/**
 * What the walk is currently looking at, which decides how a translation is written back.
 *
 * - `flow`: ordinary page copy. A container may keep its own direct text, because a
 *   rewritten run of text in normal flow stays one anonymous block box on the same line.
 * - `item`: a child of a grid or flex container. It has its own slot, so its text is a
 *   segment of its own; writing into the parent's whitespace would create an extra item
 *   and push every following slot one place along.
 * - `row`: a cell of a repeating data row. Same as `item`, plus a cell whose text is a
 *   value rather than copy is not translated at all.
 */
type WalkContext = 'flow' | 'item' | 'row';

/**
 * Yields blocks in document order. One tree walk stays linear on a Wikipedia
 * article, where querySelectorAll plus closest() on every div is much heavier.
 *
 * Sidebars, metadata columns and app chrome are walked like any other container.
 * They are ranked later, not dropped: on a model card, an issue or a dashboard the
 * sidebar is often the only prose a reader wants.
 */
export function* eachTranslatableBlock(root: ParentNode): Generator<Element> {
  const start = root instanceof Document ? root.documentElement : root;
  if (!start) return;
  const probe = new VisibilityProbe();
  const layout = new LayoutProbe();
  const repeatedCells = repeatedCellTexts(start);
  if (start instanceof Element) {
    yield* visitBlock(start, probe, layout, 'flow', repeatedCells);
    return;
  }
  for (const child of start.children) {
    yield* visitBlock(child, probe, layout, 'flow', repeatedCells);
  }
}

/**
 * Walks one element of the page.
 *
 * The rule that fixes a broken table: a container that places each child in its own slot
 * (grid, flex, a table row) is never translated as one string. A translation written into
 * the container's text nodes lands *between* the cells, and each of those runs becomes an
 * anonymous grid or flex item — so every cell after it moves one slot along. That is what
 * flattened the ranking table on srclog.com: the whole row went to the model, the result
 * landed in the row's whitespace, and the row became a vertical pile while its untranslated
 * neighbours still looked like a table. Such a container is descended into, and its cells
 * are translated individually, each into its own text node.
 *
 * The same reasoning makes an inline child of such a container a segment of its own: a grid
 * item is a slot whatever its own `display` says.
 */
function* visitBlock(
  element: Element,
  probe: VisibilityProbe,
  layout: LayoutProbe,
  context: WalkContext,
  repeatedCells: ReadonlySet<string>,
): Generator<Element> {
  if (isTranslationExcluded(element) || isAriaHiddenLeaf(element)) return;

  // A repeated row's cell holds a value: a handle, a language tag, a count, a stat line.
  // Sending it to the model spends a completion to hand it back, and a translated value in
  // a narrow column is what reflows the row. Cells outside a repeated row keep their text:
  // a table header reads as UI copy, not as data.
  if (context === 'row') {
    const text = cellValue(element);
    if (isDataValueText(text) || repeatedCells.has(text)) return;
  }

  const elementItems = layout.itemContainer(element);
  if (!elementItems && context === 'flow' && layout.inline(element)) {
    // An inline or `contents` wrapper in a line of text. Every block that could hold text
    // is checked below, and a hidden wrapper hides the blocks inside it, so probing the
    // wrappers too would repeat the same ancestor walk for every level of a component tree.
    for (const child of element.children) {
      yield* visitBlock(child, probe, layout, 'flow', repeatedCells);
    }
    return;
  }
  if (probe.skipped(element)) return;

  // A repeating row of a data list is treated exactly like a grid container even when the
  // page lays it out some other way: its cells are separate units and each one gets its own
  // text node. The structure is a stronger signal than the computed display, because the
  // display can come from a stylesheet that is injected later or is not readable at all,
  // and the cost of being wrong here is the reported layout collapse.
  const repeated = isRepeatedRow(element);
  const items = elementItems || repeated;
  const rows = context === 'row' || repeated;
  if (!items && !hasSlotDescendant(element, probe, layout)) {
    if (hasTranslatableTextIn(element, probe)) yield element;
    return;
  }
  if (!items && hasDirectTranslatableText(element, probe, layout)) yield element;

  // A slot container that owns text of its own: a `<p>` or `<div>` styled `display: flex`
  // to space a label and a value, or a flex paragraph with a link in the middle. That text
  // is already an anonymous item of the container, so writing a translation into the text
  // nodes the source already had keeps the item count unchanged.
  //
  // Descending used to lose those words: every child of a flex or grid container is
  // blockified by the engine, so `hasSlotDescendant` is true for these containers and the
  // branch below never fired. The cells filled in, the text around them stayed in the source
  // language, and the page still reported itself translated.
  //
  // A repeated data row is excluded: its cells are separate columns, yielded below as usual.
  // A container with a nested block is descended into as well — the block is a segment of
  // its own, so the container is yielded for its loose text and the walk continues.
  if (items && !rows && ownsText(element)) {
    yield element;
    if (!hasBlockChild(element, probe)) return;
  }

  // A slot container with no child elements at all. Descending would find nothing to yield.
  if (items && element.children.length === 0) {
    if (hasTranslatableTextIn(element, probe)) yield element;
    return;
  }

  const childContext: WalkContext = rows ? 'row' : items ? 'item' : 'flow';
  for (const child of element.children) {
    yield* visitBlock(child, probe, layout, childContext, repeatedCells);
  }
}

/**
 * A nested block directly under this element. `buildFrame` leaves a nested block out of the
 * segment (it is a segment of its own), so a container that also owns text must keep walking
 * into them or their copy is never visited.
 *
 * Only real block elements count: a `<span>` inside a flex row is blockified by the engine,
 * but it is still folded into the parent's segment as a placeholder, so descending into it
 * would translate the same words twice.
 */
function hasBlockChild(element: Element, probe: VisibilityProbe): boolean {
  for (const child of element.children) {
    if (isSkipped(child, probe)) continue;
    if (isBlockElement(child)) return true;
  }
  return false;
}

/**
 * Whether a container's own text nodes carry words, as opposed to the indentation between
 * its children. A grid row is `<li>\n  <span/>\n  <span/>\n</li>`, and those newlines are
 * layout rather than copy: they must never force the row to be one segment.
 *
 * A container that does own text is one segment — a flex bar reading `Fluency 38.7`, a
 * paragraph with a link in the middle — and its children stay placeholders there.
 */
export function ownsText(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const value = child.nodeValue ?? '';
    if (isSkippableText(value)) continue;
    if (LETTER_PATTERN.test(value)) return true;
  }
  return false;
}

function hasSlotDescendant(element: Element, probe: VisibilityProbe, layout: LayoutProbe): boolean {
  for (const child of element.children) {
    if (isSkipped(child, probe)) continue;
    if (layout.blockBox(child)) return true;
    if (hasSlotDescendant(child, probe, layout)) return true;
  }
  return false;
}

export function countTranslatableBlocks(root: ParentNode): number {
  return listTranslatableBlocks(root).length;
}

function collectFrames(root: ParentNode, visit: (frame: HTMLIFrameElement) => void): void {
  for (const frame of root.querySelectorAll('iframe')) {
    if (frame instanceof HTMLIFrameElement) visit(frame);
  }

  for (const element of root.querySelectorAll('*')) {
    if (isOwnUi(element) || !element.shadowRoot) continue;
    collectFrames(element.shadowRoot, visit);
  }
}

export function collectDocuments(root: Document): Document[] {
  const documents: Document[] = [];
  const seen = new Set<Document>();

  const visit = (doc: Document): void => {
    if (seen.has(doc)) return;
    seen.add(doc);
    documents.push(doc);

    collectFrames(doc, (frame) => {
      try {
        const child = frame.contentDocument;
        if (child) visit(child);
      } catch {
        // Cross-origin frames are not readable and stay out of the page translation.
      }
    });
  };

  visit(root);
  return documents;
}

export function collectShadowRoots(root: ParentNode): ShadowRoot[] {
  const roots: ShadowRoot[] = [];

  for (const element of root.querySelectorAll('*')) {
    if (isOwnUi(element)) continue;
    const shadow = element.shadowRoot;
    if (!shadow) continue;
    roots.push(shadow);
    roots.push(...collectShadowRoots(shadow));
  }

  return roots;
}

export function listPageBlocks(doc: Document): Element[] {
  const blocks: Element[] = [];

  for (const document of collectDocuments(doc)) {
    blocks.push(...listTranslatableBlocks(document));
    for (const shadow of collectShadowRoots(document)) {
      blocks.push(...listTranslatableBlocks(shadow));
    }
  }

  return blocks;
}
