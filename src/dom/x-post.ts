import { isProsePre } from './blocks';

/**
 * The body of a post in x.com's guest (logged-out) DOM. X stopped shipping
 * `data-testid="tweetText"` there: the copy is a `div[lang][dir=auto]` with a
 * Tailwind-style pre-wrap class, inside the post's `<article>`. The class name is
 * the unstable part, so the article ancestor keeps a stray `lang` div elsewhere
 * on the page from being treated as post copy.
 */
const X_POST_BODY_SELECTOR = 'div[lang][dir="auto"][class*="whitespace-pre-wrap"]';

/** How many ancestors may sit between the body and its post `article`. */
const POST_ARTICLE_DEPTH = 6;

export function isXPostBody(element: Element): boolean {
  if (!element.matches(X_POST_BODY_SELECTOR)) return false;
  let parent = element.parentElement;
  for (let level = 0; parent !== null && level < POST_ARTICLE_DEPTH; level += 1) {
    if (parent.localName === 'article') return true;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Elements whose raw newlines are real line breaks, not markup indentation. A logged-in X
 * post still ships `data-testid="tweetText"` and a language tag, but paints its paragraph
 * breaks the same way the guest body does: raw newlines in the text nodes and
 * `white-space: pre-wrap`. X renames the utility class (`r-whitespace-pre-wrap`, generated
 * `css-*` names), so the computed style is the primary signal and the class is the fallback
 * for documents that do not resolve X's styles (fixtures, snapshot HTML). A board comment in
 * a bare `<pre>` keeps its breaks the same way and passes the same pipeline.
 */
export function shouldPreserveNewlines(element: Element): boolean {
  // arca-style comment bodies are text-only `<pre>`s whose newlines are the line breaks.
  if (isProsePre(element)) return true;
  if (isXPostBody(element)) return true;
  if (!element.matches('[data-testid="tweetText"]') || !element.hasAttribute('lang')) {
    return false;
  }
  const whitespace = element.ownerDocument.defaultView?.getComputedStyle(element).whiteSpace;
  if (whitespace === 'pre-wrap' || whitespace === 'pre-line') return true;
  return /pre-wrap|pre-line/iu.test(element.className);
}
