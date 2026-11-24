// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfReader, type ReaderLabels } from '@/pdf/reader';
import type { PdfDocument, PdfPage } from '@/pdf/extract';
import type { PdfEngine } from '@/pdf/session';

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const labels: ReaderLabels = {
  translate: 'Translate',
  restore: 'Restore',
  translating: 'Translating',
  translated: 'Translated',
  progress: (done, total) => `${String(done)}/${String(total)}`,
  emptyPage: 'Empty',
  renderFailed: 'Could not draw',
  noText: 'No text',
  scanning: (page, of) => `${String(page)}/${String(of)}`,
  failed: 'Failed',
  selectionTranslating: '…',
  selectionFailed: 'failed',
  overflowOpen: 'Open',
  compareOriginal: 'Original',
  compareTranslated: 'Translated',
  pdfBilingual: 'Bilingual',
  ocrReading: (page, of) => `OCR ${String(page)}/${String(of)}`,
  ocrFailed: 'OCR failed',
};

const silentEngine: PdfEngine = {
  async *translate() {
    /* no chunks */
  },
};

function fakePage(): PdfPage {
  return {
    getViewport: ({ scale }) => ({
      width: 200 * scale,
      height: 280 * scale,
      transform: [scale, 0, 0, -scale, 0, 280 * scale],
    }),
    getTextContent: async () => ({ items: [], styles: {} }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    commonObjs: { get: () => null },
    render: () => ({ promise: Promise.resolve() }),
  };
}

function geometries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    width: 200,
    height: 280,
  }));
}

describe('PDF reader page prefetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it('does not prefetch a page that the single-flight parse is already working on', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const idleCallbacks: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });

    let releaseSecondPage = (): void => undefined;
    const secondPage = new Promise<PdfPage>((resolve) => {
      releaseSecondPage = () => resolve(fakePage());
    });
    const requested: number[] = [];
    const document_: PdfDocument = {
      numPages: 3,
      getPage: async (number) => {
        requested.push(number);
        return number === 2 ? await secondPage : fakePage();
      },
      getMetadata: async () => null,
      destroy: async () => undefined,
    };
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(3), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });

    reader.start();
    // The first getPage(2) is the initial canvas draw; the second is page 1's parse, which is
    // blocked on the pending promise. Page 0 has finished and queued its idle prefetch by then.
    await vi.waitFor(() => expect(requested.filter((number) => number === 2).length).toBe(2));
    expect(idleCallbacks.length).toBeGreaterThan(0);
    for (const callback of idleCallbacks.splice(0)) callback();
    expect(requested.filter((number) => number === 2)).toHaveLength(2);

    releaseSecondPage();
    await vi.waitFor(() => expect(reader.parsedPages()).toEqual([0, 1, 2]));
    reader.destroy();
  });

  it('drops a prefetch when its page finishes parsing', () => {
    const reader = Object.create(PdfReader.prototype) as PdfReader;
    const internals = reader as unknown as {
      parsed: Set<number>;
      prefetch: { index: number; task: Promise<unknown> } | null;
      markParsed: (index: number) => void;
    };
    internals.parsed = new Set<number>();
    internals.prefetch = { index: 1, task: Promise.resolve({ page: {}, extracted: {} }) };
    internals.markParsed(1);
    expect(internals.parsed.has(1)).toBe(true);
    expect(internals.prefetch).toBeNull();
  });
});
