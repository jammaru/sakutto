import { describe, expect, it } from 'vitest';
import { traitsOfName, traitsOfStyle } from '@/pdf/fonts';
import {
  isPdfContentType,
  isPdfForgetRequest,
  isPdfInspectRequest,
  isPdfInspectResult,
  isPdfOpenResult,
  looksLikePdfBytes,
  looksLikePdfUrl,
  pdfDocumentLooksLikePdf,
  pdfFileName,
  readerUrl,
  tabLooksLikePdf,
} from '@/shared/pdf';

describe('font traits', () => {
  it('reads weight, slant and family from a subset font name', () => {
    expect(traitsOfName('AAAAAA+TimesNewRomanPS-BoldMT')).toEqual({
      family: 'serif',
      bold: true,
      italic: false,
      math: false,
    });
    expect(traitsOfName('BAAAAA+TimesNewRomanPS-ItalicMT')).toEqual({
      family: 'serif',
      bold: false,
      italic: true,
      math: false,
    });
    expect(traitsOfName('CAAAAA+Helvetica-Oblique')).toEqual({
      family: 'sans-serif',
      bold: false,
      italic: true,
      math: false,
    });
    expect(traitsOfName('DAAAAA+DejaVuSansMono-Bold')).toEqual({
      family: 'monospace',
      bold: true,
      italic: false,
      math: false,
    });
  });

  it('does not read a subset tag as a trait', () => {
    // `ABCDEF+` is a subset prefix, not a descriptor; a plain body face has no traits.
    expect(traitsOfName('ABCDEF+ArialMT')).toEqual({
      family: 'sans-serif',
      bold: false,
      italic: false,
      math: false,
    });
  });

  /**
   * The one signal that says "this run is mathematics".
   *
   * A LaTeX paper sets its equations in Computer Modern's math faces and its body in Computer
   * Modern Roman, so the names have to be told apart exactly: matching `CMR` would call every
   * paragraph a formula and translate nothing.
   */
  it('recognises the math faces a TeX paper sets equations in', () => {
    for (const name of [
      'BQFOTO+CMMI12',
      'GJLKFF+CMMI10',
      'SJHXEX+CMSY10',
      'IDQFMU+CMMIB9',
      'FJMAXR+CMMI9',
      'ABCDEF+STIXTwoMath-Regular',
      'ABCDEF+CambriaMath',
      'MJXTEX-I',
      'ABCDEF+MathJax_Math-Italic',
      'ABCDEF+NTXMI10',
      'ABCDEF+Symbol',
    ]) {
      expect(traitsOfName(name).math, name).toBe(true);
    }
    for (const name of [
      // Computer Modern Roman is the *text* of a LaTeX paper, as are its bold, italic,
      // slanted and sans forms. None of them is mathematics.
      'CBRNUA+CMR10',
      'UCYNTM+CMR17',
      'MJWINQ+CMR12',
      'ABCDEF+CMBX10',
      'ABCDEF+CMTI10',
      'ABCDEF+CMSS10',
      'NDYTXC+NimbusRomNo9L-Regu',
      'ABCDEF+ArialMT',
      'ABCDEF+TimesNewRomanPS-BoldMT',
    ]) {
      expect(traitsOfName(name).math, name).toBe(false);
    }
  });

  it('trusts a monospace report only for a coding face, not a CJK body font', () => {
    expect(traitsOfStyle('monospace', 'ABCDEF+Courier')).toMatchObject({ family: 'monospace' });
    expect(traitsOfStyle('monospace', 'ABCDEF+DejaVuSansMono')).toMatchObject({
      family: 'monospace',
    });
    expect(traitsOfStyle('monospace', 'WenQuanYiMicroHei')).not.toMatchObject({
      family: 'monospace',
    });
    expect(traitsOfStyle('monospace', 'DroidSansFallback')).not.toMatchObject({
      family: 'monospace',
    });
    expect(traitsOfStyle('monospace', 'NotoSansCJKjp-Regular')).not.toMatchObject({
      family: 'monospace',
    });
    expect(traitsOfStyle('monospace', 'IPAGothic')).not.toMatchObject({ family: 'monospace' });
    expect(traitsOfStyle('monospace', 'Meiryo')).not.toMatchObject({ family: 'monospace' });
    expect(traitsOfStyle('monospace', 'MS-Mincho')).not.toMatchObject({ family: 'monospace' });
    expect(traitsOfStyle('monospace', 'SimSun')).not.toMatchObject({ family: 'monospace' });
    expect(traitsOfStyle('monospace', 'HiraginoSans-W3')).not.toMatchObject({
      family: 'monospace',
    });
    expect(traitsOfStyle('monospace', 'ABCDEF+SomeUnknown')).not.toMatchObject({
      family: 'monospace',
    });
    expect(
      traitsOfStyle('monospace', 'ABCDEF+SomeUnknown', '本文は日本語の段落でありコードではない。'),
    ).not.toMatchObject({ family: 'monospace' });
  });
});

describe('PDF URL and bytes', () => {
  it('recognises a PDF by its path', () => {
    expect(looksLikePdfUrl('https://example.org/papers/a.pdf')).toBe(true);
    expect(looksLikePdfUrl('https://example.org/a/b.PDF')).toBe(true);
    expect(looksLikePdfUrl('https://example.org/a.html')).toBe(false);
    expect(looksLikePdfUrl('chrome-extension://abc/reader.html')).toBe(false);
    expect(looksLikePdfUrl(undefined)).toBe(false);
  });

  it('recognises a paper server that serves the document without an extension', () => {
    // Some hosts serve a document at `/pdf/<id>` with no `.pdf` suffix. Without this the
    // popup offered page translation for a file the browser was already showing as a PDF.
    expect(looksLikePdfUrl('https://example.org/pdf/sample-2024')).toBe(true);
    expect(looksLikePdfUrl('https://example.org/pdf/sample-2024v2')).toBe(true);
    expect(looksLikePdfUrl('https://example.org/pdf/sample-2024/')).toBe(true);
    expect(looksLikePdfUrl('https://papers.example.org/pdf/demo-2024v3')).toBe(true);
    // A site's own help page under the same segment is not a document.
    expect(looksLikePdfUrl('https://example.org/pdf/help')).toBe(false);
    expect(looksLikePdfUrl('https://example.org/pdf/')).toBe(false);
    expect(looksLikePdfUrl('https://example.org/article/_pdf/-char/ja')).toBe(true);
    expect(looksLikePdfUrl('https://example.org/download?type=pdf')).toBe(true);
    expect(looksLikePdfUrl('https://example.org/download?format=pdf')).toBe(true);
  });

  it('recognises a PDF from the live document or the response type when the path is silent', () => {
    expect(isPdfContentType('application/pdf')).toBe(true);
    expect(isPdfContentType('application/pdf; charset=binary')).toBe(true);
    expect(isPdfContentType('text/html')).toBe(false);
    expect(
      pdfDocumentLooksLikePdf({
        contentType: 'application/pdf',
        embedType: '',
        embedSrc: '',
      }),
    ).toBe(true);
    expect(
      tabLooksLikePdf({
        url: 'https://example.org/article/_pdf/-char/ja',
      }),
    ).toBe(true);
    expect(
      tabLooksLikePdf({
        url: 'https://example.org/download',
        document: null,
        contentType: 'application/pdf',
      }),
    ).toBe(true);
    expect(
      tabLooksLikePdf({
        url: 'https://example.org/download',
        document: { contentType: '', embedType: 'application/pdf', embedSrc: '' },
      }),
    ).toBe(true);
    expect(
      tabLooksLikePdf({
        url: 'https://example.org/download',
        document: { contentType: '', embedType: '', embedSrc: '' },
        contentType: 'application/pdf',
      }),
    ).toBe(false);
  });

  it('recognises the header wherever the document puts it', () => {
    const header = new TextEncoder().encode('%PDF-1.7\n');
    expect(looksLikePdfBytes(header)).toBe(true);

    const withJunk = new Uint8Array([0x00, 0x01, 0x02, ...header]);
    expect(looksLikePdfBytes(withJunk)).toBe(true);

    expect(looksLikePdfBytes(new TextEncoder().encode('<html></html>'))).toBe(false);
    expect(looksLikePdfBytes(new Uint8Array())).toBe(false);
  });

  it('names a document from its URL and encodes the reader link', () => {
    expect(pdfFileName('https://example.org/a/paper.pdf')).toBe('paper.pdf');
    expect(pdfFileName('https://example.org/download')).toBe('download.pdf');
    expect(readerUrl('abc-123')).toBe('/reader.html?id=abc-123');
    expect(readerUrl('')).toBe('/reader.html');
  });

  it('accepts an inspect request for the active tab', () => {
    expect(isPdfInspectRequest({ type: 'pdf:inspect', tabId: 3 })).toBe(true);
    expect(isPdfInspectRequest({ type: 'pdf:inspect' })).toBe(false);
    expect(isPdfInspectResult({ pdf: true })).toBe(true);
    expect(isPdfInspectResult({ pdf: false })).toBe(true);
    expect(isPdfInspectResult({ opened: true })).toBe(false);
  });

  it('accepts a forget request only with a stored id', () => {
    expect(isPdfForgetRequest({ type: 'pdf:forget', id: 'abc' })).toBe(true);
    expect(isPdfForgetRequest({ type: 'pdf:forget' })).toBe(false);
    expect(isPdfForgetRequest({ type: 'pdf:open', tabId: 1 })).toBe(false);
  });

  it('accepts only the shapes the background sends back', () => {
    expect(isPdfOpenResult({ opened: true })).toBe(true);
    expect(isPdfOpenResult({ opened: false, reason: 'not-pdf' })).toBe(true);
    expect(isPdfOpenResult({ opened: false, reason: 'file-denied' })).toBe(true);
    expect(isPdfOpenResult({ opened: false, reason: 'nonsense' })).toBe(false);
    expect(isPdfOpenResult({ opened: false })).toBe(false);
    expect(isPdfOpenResult(null)).toBe(false);
  });
});
