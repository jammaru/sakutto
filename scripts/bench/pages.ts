/**
 * The bench pages, in the order a run visits them. Each entry says what the page is
 * meant to stress so a result diff can be read against a real cost.
 */
export interface BenchPage {
  name: string;
  file: string;
  /** One line: the bottleneck this page isolates. */
  stresses: string;
}

export const BENCH_PAGES: readonly BenchPage[] = [
  {
    name: 'long-article',
    file: 'long-article.html',
    stresses:
      'Sustained prefill and decode over 22 prose blocks of realistic news prose, plus a sidebar. The headline page for the two summary numbers.',
  },
  {
    name: 'first-paragraph-then-long-tail',
    file: 'first-paragraph-then-long-tail.html',
    stresses:
      'A short lead followed by 16 paragraphs. Isolates the "first paragraph appears quickly while the rest is still translating" split, so a change that shortens the lead but lengthens the tail cannot hide in one average.',
  },
  {
    name: 'many-cards',
    file: 'many-cards.html',
    stresses:
      'Many short blocks: 12 cards with a kicker, heading, paragraph and meta line each. Isolates per-block overhead, batching and packing rather than raw tokens.',
  },
  {
    name: 'single-long-paragraph',
    file: 'single-long-paragraph.html',
    stresses:
      'One paragraph that splits into many chunks. Isolates the sentence splitter, chunk scheduling and a block that cannot finish until its last piece does.',
  },
  {
    name: 'model-card-sidebar',
    file: 'model-card-sidebar.html',
    stresses:
      'A main column of README prose plus a metadata sidebar of short labels. Isolates chrome/metadata prioritisation against body copy, and the sidebar the old collector dropped.',
  },
  {
    name: 'mixed-ui',
    file: 'mixed-ui.html',
    stresses:
      'Dense application UI: navigation, setting labels, help text and buttons. Isolates mixed short/long blocks where most text is small.',
  },
  {
    name: 'late-mount-spa',
    file: 'late-mount-spa.html',
    stresses:
      'Blocks that mount after first paint, then a pushState link. Isolates rescanning, the mutation observer and whether late blocks reuse a warm runtime. Declares a 4 s settle window so the late blocks count toward completion.',
  },
];

export const BENCH_PAGE_NAMES: readonly string[] = BENCH_PAGES.map((page) => page.name);

export function benchPage(name: string): BenchPage {
  const found = BENCH_PAGES.find((page) => page.name === name);
  if (!found) {
    throw new Error(`Unknown bench page "${name}". Known pages: ${BENCH_PAGE_NAMES.join(', ')}.`);
  }
  return found;
}
