import { describe, expect, it } from 'vitest';
import { pdfStatusKind } from '@/pdf/status';

describe('pdfStatusKind', () => {
  it('is done once nothing is pending, even when some blocks overflowed or failed', () => {
    expect(pdfStatusKind({ total: 139, pending: 0, parsed: 8, pages: 8 })).toBe('done');
  });

  it('keeps working while blocks are queued or pages are unread', () => {
    expect(pdfStatusKind({ total: 139, pending: 3, parsed: 8, pages: 8 })).toBe('working');
    expect(pdfStatusKind({ total: 20, pending: 0, parsed: 3, pages: 8 })).toBe('working');
  });

  it('reports reading, no-text and preparing', () => {
    expect(pdfStatusKind({ total: 0, pending: 0, parsed: 2, pages: 8 })).toBe('reading');
    expect(pdfStatusKind({ total: 0, pending: 0, parsed: 8, pages: 8 })).toBe('no-text');
    expect(pdfStatusKind(null)).toBe('preparing');
  });
});
