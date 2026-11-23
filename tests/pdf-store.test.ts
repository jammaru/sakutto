import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PDF_BYTES } from '@/shared/pdf';
import {
  classifyFetchedPdf,
  fileNameFrom,
  openPdfFromUrl,
  storedPdfRecord,
} from '@/background/pdf-store';

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

describe('fileNameFrom', () => {
  function responseWithDisposition(disposition: string): Response {
    return new Response(null, { headers: { 'content-disposition': disposition } });
  }

  it('prefers the RFC 6266 UTF-8 filename over the ASCII fallback', () => {
    const response = responseWithDisposition(
      'attachment; filename="paper.pdf"; filename*=UTF-8\'\'%E7%A0%94%E7%A9%B6%E8%AB%96%E6%96%87.pdf',
    );
    expect(fileNameFrom('https://example.org/download', response)).toBe('研究論文.pdf');
  });

  it('finds case-insensitive extended parameters with whitespace and a language tag', () => {
    const response = responseWithDisposition(
      "attachment; FILENAME* = utf-8'en'%E7%A0%94%E7%A9%B6.pdf ; filename=paper.pdf",
    );
    expect(fileNameFrom('https://example.org/download', response)).toBe('研究.pdf');
  });

  it('decodes an ISO-8859-1 extended filename', () => {
    const response = responseWithDisposition(
      'attachment; filename="fallback.pdf"; filename*=ISO-8859-1\'\'caf%E9.pdf',
    );
    expect(fileNameFrom('https://example.org/download', response)).toBe('café.pdf');
  });

  it('falls back when extended percent decoding fails or the charset is unsupported', () => {
    for (const extended of ["UTF-8''%E0%A4%A", "UTF-8''bad%ZZ.pdf", "KOI8-R''paper.pdf"]) {
      const response = responseWithDisposition(
        `attachment; filename*=${extended}; filename="fallback.pdf"`,
      );
      expect(fileNameFrom('https://example.org/download', response)).toBe('fallback.pdf');
    }
  });

  it('reads a quoted fallback containing a semicolon and preserves literal malformed escapes', () => {
    expect(
      fileNameFrom(
        'https://example.org/download',
        responseWithDisposition('attachment; filename="paper; 100% draft.pdf"'),
      ),
    ).toBe('paper; 100% draft.pdf');
  });

  it('uses only a sanitized basename from either filename parameter', () => {
    const extended = responseWithDisposition(
      "attachment; filename*=UTF-8''..%2F..%2Fprivate%2Freport%0A.pdf",
    );
    expect(fileNameFrom('https://example.org/download', extended)).toBe('report.pdf');

    const fallback = responseWithDisposition('attachment; filename="..\\\\..\\\\report.pdf"');
    expect(fileNameFrom('https://example.org/download', fallback)).toBe('report.pdf');
  });

  it('falls back to a URL basename and then to the generic name', () => {
    expect(fileNameFrom('https://example.org/files/room%20guide', new Response())).toBe(
      'room guide.pdf',
    );
    expect(fileNameFrom('not a URL', new Response())).toBe('document.pdf');
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

  it('retries a local file URL that fails the first fetch', async () => {
    const header = new TextEncoder().encode('%PDF-1.7\n');
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(header, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(openPdfFromUrl('file:///tmp/sample.pdf')).resolves.toEqual({
      ok: false,
      reason: 'store-failed',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
