/** The parts of the reader's progress that decide whether work is still going on. */
export interface PdfStatusInput {
  total: number;
  pending: number;
  parsed: number;
  pages: number;
}

export type PdfStatusKind = 'preparing' | 'reading' | 'no-text' | 'working' | 'done';

/**
 * Whether the toolbar should say the document is still being worked on.
 *
 * Only work that can still change the page counts: blocks waiting in the queue, or pages not
 * yet read. A block that did not fit (`overflowed`) or failed is finished work — it is reported
 * by its own note under the page — and keeping the toolbar on "Translating N / N" for it left a
 * completed document looking stuck.
 */
export function pdfStatusKind(progress: PdfStatusInput | null): PdfStatusKind {
  if (!progress) return 'preparing';
  const readingMore = progress.parsed < progress.pages;
  if (progress.total === 0) {
    if (!readingMore && progress.pages > 0) return 'no-text';
    return 'reading';
  }
  if (progress.pending > 0 || readingMore) return 'working';
  return 'done';
}
