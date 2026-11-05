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
  '[aria-hidden="true"]',
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
const OWN_UI_TAGS: ReadonlySet<string> = new Set([
  'SAKUTTO-LINE',
  'SAKUTTO-NOTE',
  'SAKUTTO-TIP',
  'SAKUTTO-POP',
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
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || isTranslationExcluded(parent)) continue;
    const value = node.nodeValue ?? '';
    if (isSkippableText(value)) continue;
    if (LETTER_PATTERN.test(value)) return true;
  }

  return false;
}

function hasDirectTranslatableText(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const value = child.nodeValue ?? '';
    if (isSkippableText(value)) continue;
    if (LETTER_PATTERN.test(value)) return true;
  }

  for (const child of element.children) {
    if (isBlockElement(child) || isTranslationExcluded(child)) continue;
    if (hasTranslatableText(child)) return true;
  }

  return false;
}

export function listTranslatableBlocks(root: ParentNode): Element[] {
  return [...eachTranslatableBlock(root)];
}

/**
 * Yields blocks in document order. One tree walk stays linear on a Wikipedia
 * article, where querySelectorAll plus closest() on every div is much heavier.
 */
export function* eachTranslatableBlock(root: ParentNode): Generator<Element> {
  const start = root instanceof Document ? root.documentElement : root;
  if (!start) return;
  if (start instanceof Element) {
    yield* visitBlock(start);
    return;
  }
  for (const child of start.children) yield* visitBlock(child);
}

function* visitBlock(element: Element): Generator<Element> {
  if (isTranslationExcluded(element)) return;
  if (!isBlockElement(element)) {
    for (const child of element.children) yield* visitBlock(child);
    return;
  }
  if (hasBlockDescendant(element)) {
    if (hasDirectTranslatableText(element)) yield element;
    for (const child of element.children) yield* visitBlock(child);
    return;
  }
  if (hasTranslatableText(element)) yield element;
}

function hasBlockDescendant(element: Element): boolean {
  for (const child of element.children) {
    if (isTranslationExcluded(child)) continue;
    if (isBlockElement(child) || hasBlockDescendant(child)) return true;
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
