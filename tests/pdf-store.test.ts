import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PDF_BYTES } from '@/shared/pdf';
import { classifyFetchedPdf, openPdfFromUrl, storedPdfRecord } from '@/background/pdf-store';

describe('PDF store records', () => {
  it('stores the file name and not the URL', () => {
    const record = storedPdfRecord('paper.pdf');
    expect(JSON.parse(record)).toEqual({ name: 'paper.pdf' });
    expect(record).not.toContain('http');
    expect(record).not.toContain('token');
  });

  it('classifies an oversized body as too-large', () => {
    const header = new TextEncoder().encode('%PDF-1.7\n');
    expect(classifyFetchedPdf(header, MAX_PDF_BYTES + 1)).toBe('too-large');
    expect(classifyFetchedPdf(header, header.byteLength)).toBe('ok');
    expect(classifyFetchedPdf(new TextEncoder().encode('<html>'), 10)).toBe('not-pdf');
  });
});

describe('openPdfFromUrl reasons', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns too-large from the content-length header without storing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 200,
            headers: { 'content-length': String(MAX_PDF_BYTES + 8) },
          }),
      ),
    );
    await expect(openPdfFromUrl('https://example.org/a.pdf')).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('returns fetch-failed when the request does not succeed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(openPdfFromUrl('https://example.org/a.pdf')).resolves.toEqual({
      ok: false,
      reason: 'fetch-failed',
    });
  });
});
