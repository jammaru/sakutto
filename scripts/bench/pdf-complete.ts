/**
 * Whether a PDF bench coverage row has finished: translated, skipped, or failed.
 *
 * Same-language and math-heavy blocks are marked `done` with empty text. Waiting only for
 * a translation or a failure hangs `pnpm bench:pdf` on those.
 *
 * Call this in Node after `page.evaluate` returns states. Playwright serialises the evaluate
 * callback into the page, so a Node import is not in that scope.
 */
export function isPdfBenchBlockFinished(entry: { state: string; translation?: string }): boolean {
  return entry.state === 'done' || entry.state === 'failed';
}

/** How many coverage rows a wait loop should treat as finished. */
export function pdfBenchFinishedCount(
  entries: readonly { state: string; translation?: string }[],
): number {
  return entries.filter(isPdfBenchBlockFinished).length;
}
