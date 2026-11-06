const EXCLUDED_SELECTOR = [
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'script',
  'style',
  'noscript',
  'textarea',
  'input',
  'select',
  'svg',
  'math',
  '[contenteditable]:not([contenteditable="false"])',
  '[translate="no"]',
  '.notranslate',
].join(', ');

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

function hasDirectTranslatableText(element: Element, probe: VisibilityProbe): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const value = child.nodeValue ?? '';
    if (isSkippableText(value)) continue;
    if (LETTER_PATTERN.test(value)) return true;
  }

  for (const child of element.children) {
    if (isBlockElement(child) || isSkipped(child, probe)) continue;
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
  if (start instanceof Element) {
    yield* visitBlock(start, probe);
    return;
  }
  for (const child of start.children) yield* visitBlock(child, probe);
}

function* visitBlock(element: Element, probe: VisibilityProbe): Generator<Element> {
  if (!isBlockElement(element)) {
    // Containers are not probed for layout. Every block that could hold text is checked
    // below, and a hidden wrapper hides the blocks inside it, so probing the wrappers too
    // would repeat the same ancestor walk for each level of a deep component tree.
    if (isTranslationExcluded(element) || isAriaHiddenLeaf(element)) return;
    for (const child of element.children) yield* visitBlock(child, probe);
    return;
  }
  if (probe.skipped(element)) return;
  if (hasBlockDescendant(element, probe)) {
    if (hasDirectTranslatableText(element, probe)) yield element;
    for (const child of element.children) yield* visitBlock(child, probe);
    return;
  }
  if (hasTranslatableTextIn(element, probe)) yield element;
}

function hasBlockDescendant(element: Element, probe: VisibilityProbe): boolean {
  for (const child of element.children) {
    if (isSkipped(child, probe)) continue;
    if (isBlockElement(child) || hasBlockDescendant(child, probe)) return true;
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
