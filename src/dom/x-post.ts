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
