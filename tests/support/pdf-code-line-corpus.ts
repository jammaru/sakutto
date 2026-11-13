/**
 * Synthetic prose vs listing lines reported across PDF layout rounds 16–20.
 * Used by one table-driven test so a later keyword tweak cannot drop an old case.
 */

export type CodeLineCase = {
  text: string;
  code: boolean;
  /** Role when this line is the only block on a synthetic page. */
  role: 'code' | 'prose' | 'heading' | 'label';
  tag: string;
};

function prose(text: string, tag: string, role: CodeLineCase['role'] = 'prose'): CodeLineCase {
  return { text, code: false, role, tag };
}

function code(text: string, tag: string): CodeLineCase {
  return { text, code: true, role: 'code', tag };
}

/** Round 17: parenthetical references plus if/while/let. */
export const PARENTHETICAL_PROSE: CodeLineCase[] = [
  prose('Translation quality improves (Table 2) if the model sees the heading.', 'r17-table-if'),
  prose('The queue grows (Figure 2) while the reader keeps scrolling down.', 'r17-figure-while'),
  prose('The update is written (Eq. 2) if the step is accepted.', 'r17-eq-if'),
  prose('The appendix cites the result (Section 3) while the body continues.', 'r17-section-while'),
  prose(
    'A later paragraph cites the same table (Table 2) if the reader asks for it.',
    'r17-table-if-2',
  ),
  prose(
    'The appendix points at the figure (Section 3) while the body continues.',
    'r17-section-while-2',
  ),
  prose('The fitted cover is compared (Eq. 2) if the block still overflows.', 'r17-eq-if-2'),
  prose('The collector walks the document rather than selecting tags.', 'r16-collector'),
  prose('For each module the reader records a score.', 'r16-for-each-prose'),
];

/** Round 18: English return/break/continue/yield with a parenthetical. */
export const DISCUSSION_PROSE: CodeLineCase[] = [
  prose(
    'We return to the fitting question (Section 4) after describing the scheduler.',
    'r18-return-section',
  ),
  prose(
    'We continue the discussion of memory (Figure 7) with the eviction policy.',
    'r18-continue-figure',
  ),
  prose(
    'We break ties between two equally visible pages (Section 3.1) by their top edge.',
    'r18-break-section',
  ),
  prose(
    'The measurement yields a bound on repaints (Theorem 1) for every input we tested.',
    'r18-yields-theorem',
  ),
  prose(
    'The generator will yield a bound on repaints (Theorem 1) for every input we tested.',
    'r18-yield-theorem',
  ),
  prose(
    'A later paragraph returns to that bound (Table 2) after the queue is drained.',
    'r18-returns-table',
  ),
  prose(
    'The reader will continue from the last visible page (Figure 2) once it is ready.',
    'r18-continue-figure-2',
  ),
  prose(
    'Nothing should break the column measure (Section 2) when a heading is skipped.',
    'r18-break-section-2',
  ),
  prose('The next pass will yield the same cover (Eq. 2) if the tokens still fit.', 'r18-yield-eq'),
  prose(
    'We return the unused budget (Section 5) once the last line of the block is set.',
    'r18-return-section-5',
  ),
  prose(
    'The scheduler will continue to the far page (Figure 4) after the focused one.',
    'r18-continue-figure-4',
  ),
  prose(
    'Two covers break even (Section 3.2) when both sit inside the viewport band.',
    'r18-break-even',
  ),
  prose(
    'The check yields no overflow (Theorem 2) for a short English caption.',
    'r18-yields-theorem-2',
  ),
  prose(
    'We return here only after the listing (Algorithm 1) has been classified.',
    'r18-return-algorithm',
  ),
  prose(
    'The body will continue in English (Table 3) until the model is loaded.',
    'r18-continue-table',
  ),
  prose(
    'A gap should not break a wrapped sentence (Section 1) across two columns.',
    'r18-break-wrap',
  ),
  prose('Each trial yields one number (Figure 1) and a short note under it.', 'r18-yields-figure'),
  prose(
    'We return a marker (Section 6) rather than clip a line that still overflows.',
    'r18-return-marker',
  ),
  prose(
    'The compare pane will continue to share scroll (Figure 8) with the original.',
    'r18-continue-compare',
  ),
  prose(
    'The rule must not break ordinary discussion (Section 4.1) into a listing.',
    'r18-break-discussion',
  ),
  prose(
    'The probe yields a content type (Appendix B) without reading the whole file.',
    'r18-yields-appendix',
  ),
  prose(
    'We return to the original canvas (Figure 9) when compare is turned off.',
    'r18-return-canvas',
  ),
  prose(
    'The queue will continue to drain (Section 7) after a visible page is aborted.',
    'r18-continue-drain',
  ),
  prose(
    'Layout must not break a heading (Table 4) that happens to mention return.',
    'r18-break-heading',
  ),
  prose(
    'The run yields a translated page (Section 8) whose status matches the boxes.',
    'r18-yields-run',
  ),
];

/** Longer body sentences used as a page-level prose sweep. */
export const BIG_PROSE: CodeLineCase[] = [
  prose('Opening a long report partway through does not wait for the pages before it.', 'big-open'),
  prose(
    'A paragraph is set inside its own column and may grow only into the space below it.',
    'big-column',
  ),
  prose('A heading, a caption and a table cell are fitted to their own box.', 'big-heading'),
  prose('Text that is not prose is left exactly where it is on the page.', 'big-left'),
  prose(
    'Selecting text on a page and pressing one button translates just that part.',
    'big-select',
  ),
  prose('Source text is selectable, so a phrase can be copied from a translated box.', 'big-copy'),
  prose('The toolbar reports how many parts were deliberately left untranslated.', 'big-toolbar'),
  prose('A last paragraph may grow into empty space below it when the column is free.', 'big-grow'),
  prose('A translation that still does not fit is offered on a marker instead.', 'big-marker'),
  prose('Every placed token is width-checked and broken when it is too wide.', 'big-wrap'),
  prose(
    'A glyph wider than the column still occupies one line and never emits an empty one.',
    'big-glyph',
  ),
  prose('Far canvases are released, and a resize redraws the pages that are visible.', 'big-far'),
  prose('Translation focus is the page whose box covers the actual viewport.', 'big-focus'),
  prose('Cancelling a page render bumps the draw generation and is not a failure.', 'big-cancel'),
  prose(
    'A page that was evicted, cancelled, or failed is drawn again when it returns.',
    'big-redraw',
  ),
  prose('Empty chunks fail rather than finishing as if the page were done.', 'big-empty'),
  prose('Equal glossary contents do not retranslate the document a second time.', 'big-glossary'),
  prose('Failures are counted separately from overflow and shown as their own note.', 'big-fail'),
  prose(
    'A boxed listing set in the body face stays one code block from start to end.',
    'big-listing',
  ),
  prose(
    'Short node labels inside a drawing stay untranslated so they cannot overflow.',
    'big-nodes',
  ),
  prose('Page language is voted from heading, prose and caption blocks on that page.', 'big-lang'),
  prose(
    'A Latin body is never skipped as Japanese because a running header is Japanese.',
    'big-latin',
  ),
  prose(
    'Short English labels on an English page still translate into another language.',
    'big-labels',
  ),
  prose('The original canvas is copied only while compare is on in the toolbar.', 'big-compare'),
  prose('Same-origin fetch uses credentials so a cookie-gated file still opens.', 'big-cookie'),
  prose('An oversized file reports too-large, including a local file over the limit.', 'big-size'),
  prose(
    'Reloading the reader tab deletes the stored copy and asks for the file again.',
    'big-reload',
  ),
];

/** Round 19: lowercase and capitalized enumerated prose, headings, bibliography. */
export const LC_NUMBERED_PROSE: CodeLineCase[] = [
  prose('1 for example, a reader who opens a long report sees that page first.', 'r19-for-example'),
  prose('2 for instance, the focused page is translated before the rest.', 'r19-for-instance'),
  prose('3 for simplicity we ignore tokens that already fit the cover.', 'r19-for-simplicity'),
  prose('7 for each of the three backends we report the median.', 'r19-for-each-of'),
  prose('1 if so, the block is left as the page drew it.', 'r19-if-so'),
  prose('4 while reading, the queue sorts remaining pages by distance.', 'r19-while-reading'),
  prose('1 for example (Table 2), the reader sees the heading first.', 'r19-for-example-table'),
  prose('2 if so: the block stays.', 'r19-if-so-colon'),
  prose('1 repeat the measurement three times.', 'r19-repeat-measure'),
  prose('12 while useful, a parenthetical (Table 2) must not make a listing.', 'r19-while-useful'),
];

export const NUMBERED_PROSE: CodeLineCase[] = [
  ...LC_NUMBERED_PROSE,
  prose(
    '1 For example, a heading that names the algorithm stays a heading.',
    'r19-For-example',
    'heading',
  ),
  prose(
    '2 For the visible page, the cover is copied only while compare is on.',
    'r19-For-visible',
    'heading',
  ),
  prose('1 Introduction', 'r19-introduction', 'heading'),
  prose('5. Conclusions and next steps for the study', 'r16-conclusions', 'heading'),
  prose(
    '[3] A. Author. “wllama: WebAssembly bindings for llama.cpp.” Software, 2024–2026.',
    'r16-bib',
  ),
  prose('1 for the first experiment the reader keeps the canvas.', 'r18-for-the'),
  prose('2 if the model sees the heading the cover stays.', 'r18-if-the'),
  prose('3 while the reader scrolls the queue grows.', 'r18-while-the'),
  prose('6 for completeness the bench reports overlap and orphans.', 'r19-for-completeness'),
  prose('8 if needed the marker holds the line that still overflows.', 'r19-if-needed'),
  prose('9 while idle the reader releases canvases that left the band.', 'r19-while-idle'),
  prose('10 for brevity the stub translator expands each block in place.', 'r19-for-brevity'),
  prose('11 if ready the compare pane copies the original canvas.', 'r19-if-ready-prose'),
  prose('3 If the model is cold', 'r20-If-cold', 'heading'),
  prose('2 While loading', 'r20-While-loading', 'heading'),
];

/** Cite-rich mix of parentheticals and numbered prose. */
export const CITE_RICH_PROSE: CodeLineCase[] = [
  ...PARENTHETICAL_PROSE.slice(0, 5),
  ...DISCUSSION_PROSE.slice(0, 4),
  prose(
    'The probe yields a content type (Appendix B) without reading the whole file.',
    'cite-appendix',
  ),
  prose(
    'Layout must not break a heading (Table 4) that happens to mention return.',
    'cite-return-word',
  ),
  prose(
    'The compare pane will continue to share scroll (Figure 8) with the original.',
    'cite-compare',
  ),
  prose(
    'The rule must not break ordinary discussion (Section 4.1) into a listing.',
    'cite-discussion',
  ),
  prose('We return to the original canvas (Figure 9) when compare is turned off.', 'cite-canvas'),
  prose(
    'The queue will continue to drain (Section 7) after a visible page is aborted.',
    'cite-drain',
  ),
  prose('The run yields a translated page (Section 8) whose status matches the boxes.', 'cite-run'),
  prose('1 for example (Table 2), the reader sees the heading first.', 'cite-numbered-table'),
  prose('2 if so: the block stays as the page drew it.', 'cite-if-so-colon'),
  prose('7 for each of the three backends we report the median (Table 1).', 'cite-for-each-table'),
  prose(
    '4 while reading, the queue sorts remaining pages by distance (Figure 3).',
    'cite-while-figure',
  ),
];

/** The 16 listing shapes plus numbered comma/bracket/then/do/tuple lines. */
export const LISTING_LINES: CodeLineCase[] = [
  code('if (x) {', 'shape-if'),
  code('const y = 1;', 'shape-const'),
  code('for each (m : evalModules) {', 'shape-for-each'),
  code('1 for each (m) {', 'shape-numbered-for-each'),
  code('emit(translate(block))', 'shape-emit'),
  code('return result;', 'shape-return'),
  code('break;', 'shape-break'),
  code('continue;', 'shape-continue'),
  code('if (x) { return y; }', 'shape-if-return'),
  code('for (item of items) continue;', 'shape-for-continue'),
  code('{ return a; }', 'shape-brace-return'),
  code('switch (kind) {', 'shape-switch'),
  code('catch (error) {', 'shape-catch'),
  code('1  for block in page:', 'shape-py-for'),
  code('2 if ready:', 'shape-py-if'),
  code('3 while waiting:', 'shape-py-while'),
  code('4 def layout(page):', 'shape-py-def'),
  code('5 repeat:', 'shape-py-repeat'),
  code('6 until done:', 'shape-py-until'),
  code('1 For block in page:', 'shape-For-block'),
  code('1 While queue:', 'shape-While-queue'),
  code('evalModules = modules for the evaluation;', 'shape-assign'),
  code('devEval = the readability of m by a', 'shape-camel'),
  code('output evaluation = calibModel.predict(m);', 'shape-predict'),
  code('for each (m : evalModules) {', 'shape-for-each-dup'),
];

export const NUMBERED_CODE: CodeLineCase[] = [
  code('1  for i in range(0, n):', 'r20-range'),
  code('1  while q, p:', 'r20-while-tuple-colon'),
  code('1  while q, p do', 'r20-while-tuple-do'),
  code('3  x = f(a, b);', 'r20-call-assign'),
  code('1  swap(a, low, high);', 'r20-swap'),
  code('1  if low < high then', 'r20-if-then'),
  code('3      c[i, j] = a[i, j]', 'r20-matrix'),
  code('1  a, b = b, a', 'r20-tuple-assign'),
  code('1  merge(left, right):', 'r20-merge'),
  code('2  if left[i] <= right[j]:', 'r20-merge-if'),
  code('1  for block in page:', 'r18-py-for'),
  code('1 For block in page:', 'r19-For-block'),
  code('1 While queue:', 'r19-While-queue'),
  code('2 if ready:', 'r18-if-ready'),
  code('5 repeat:', 'r18-repeat'),
  code('1 for each (m) {', 'r17-numbered-for-each'),
];

export const CODE_LINE_CORPUS: CodeLineCase[] = [
  ...PARENTHETICAL_PROSE,
  ...DISCUSSION_PROSE,
  ...BIG_PROSE,
  ...NUMBERED_PROSE,
  ...CITE_RICH_PROSE,
  ...LISTING_LINES,
  ...NUMBERED_CODE,
];
