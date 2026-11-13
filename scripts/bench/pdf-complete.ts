/**
 * Whether a PDF bench coverage row has finished: translated, skipped, or failed.
 *
 * Same-language and math-heavy blocks are marked `done` with empty text. Waiting only for
 * a translation or a failure hangs `pnpm bench:pdf` on those.
 */
export function isPdfBenchBlockFinished(entry: { state: string; translation?: string }): boolean {
  return entry.state === 'done' || entry.state === 'failed';
}
