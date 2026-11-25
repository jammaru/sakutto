// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  focusedPdfPage,
  PdfOcrModelMissingError,
  PdfReader,
  type ReaderLabels,
} from '@/pdf/reader';
import type { PdfDocument, PdfPage } from '@/pdf/extract';
import type { PdfEngine } from '@/pdf/session';
import { ocrPageTimeoutMs } from '@/engine/offscreen/protocol';
import type { OcrResult } from '@/engine/ocr/types';

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
  ocrDownload: 'Download OCR (23 MB)',
  ocrDownloadFailed: 'Download failed',
  ocrDownloadProgress: (status) => `${String(Math.round(status.progress * 100))}%`,
};

type ObserverRecord = {
  root: unknown;
  rootMargin: string | undefined;
  callback: IntersectionObserverCallback;
};

const observerRecords: ObserverRecord[] = [];
let resizeCallback: ResizeObserverCallback | null = null;

class FakeIntersectionObserver {
  readonly records: Element[] = [];
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    observerRecords.push({
      root: options?.root ?? null,
      rootMargin: options?.rootMargin,
      callback,
    });
  }
  observe(target: Element): void {
    this.records.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function fakePage(renders: { count: number }): PdfPage {
  return {
    getViewport: ({ scale }) => ({
      width: 200 * scale,
      height: 280 * scale,
      transform: [scale, 0, 0, -scale, 0, 280 * scale],
    }),
    getTextContent: async () => ({ items: [], styles: {} }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    commonObjs: { get: () => null },
    render: () => {
      renders.count += 1;
      return { promise: Promise.resolve() };
    },
  };
}

/** Native prose plus a label inside a large partial raster: a mixed page that still needs OCR. */
function mixedScanPage(renders: { count: number }, scanned: boolean): PdfPage {
  return {
    getViewport: ({ scale }) => ({
      width: 200 * scale,
      height: 280 * scale,
      transform: [scale, 0, 0, -scale, 0, 280 * scale],
    }),
    getTextContent: async () => ({
      items: [
        {
          // PDF y grows upward, then the image flip puts this at y 250..260 inside the raster.
          str: 'Native label inside the raster figure',
          transform: [10, 0, 0, 10, 20, 20],
          width: 120,
          height: 10,
          fontName: 'F1',
        },
        {
          // y 20..30, above the image: real prose that must still be translated.
          str: 'Native prose outside the raster figure.',
          transform: [10, 0, 0, 10, 20, 250],
          width: 120,
          height: 10,
          fontName: 'F1',
        },
      ],
      styles: {},
    }),
    getOperatorList: async () =>
      scanned
        ? { fnArray: [1, 2], argsArray: [[140, 0, 0, 200, 30, 20], []] }
        : { fnArray: [], argsArray: [] },
    commonObjs: { get: () => null },
    render: () => {
      renders.count += 1;
      return { promise: Promise.resolve() };
    },
  };
}

/** A native header painted over a page-sized raster: the raster is the scan, not a figure. */
function fullPageScanPage(renders: { count: number }): PdfPage {
  return {
    getViewport: ({ scale }) => ({
      width: 200 * scale,
      height: 280 * scale,
      transform: [scale, 0, 0, -scale, 0, 280 * scale],
    }),
    getTextContent: async () => ({
      items: [
        {
          str: 'Native header on the full-page scan',
          transform: [10, 0, 0, 10, 20, 250],
          width: 160,
          height: 10,
          fontName: 'F1',
        },
      ],
      styles: {},
    }),
    getOperatorList: async () => ({
      fnArray: [1, 2],
      argsArray: [[200, 0, 0, 280, 0, 0], []],
    }),
    commonObjs: { get: () => null },
    render: () => {
      renders.count += 1;
      return { promise: Promise.resolve() };
    },
  };
}

function fakeDocument(
  renders: { count: number },
  pages = 3,
  requested: number[] = [],
): PdfDocument {
  return {
    numPages: pages,
    getPage: async (number) => {
      requested.push(number);
      return fakePage(renders);
    },
    getMetadata: async () => null,
    destroy: async () => undefined,
  };
}

const silentEngine: PdfEngine = {
  async *translate() {
    /* no chunks */
  },
};

function geometries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    width: 200,
    height: 280,
  }));
}

function viewportRect(top: number): DOMRect {
  return {
    top,
    bottom: top + 280,
    left: 0,
    right: 200,
    width: 200,
    height: 280,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const scannedResult: OcrResult = (() => {
  const region = {
    text: 'Recovered scanned body text',
    confidence: 0.95,
    recognitionConfidence: 0.95,
    vertical: false,
    quad: [
      { x: 20, y: 20 },
      { x: 180, y: 20 },
      { x: 180, y: 50 },
      { x: 20, y: 50 },
    ],
    symbolScores: [0.95],
  } as const;
  return {
    regions: [region],
    lines: [{ orientation: 'horizontal', items: [region], indices: [0] }],
    text: region.text,
  };
})();

/** Scanned text below the native figure label, in the 2x OCR raster's coordinates. */
const mixedScannedResult: OcrResult = (() => {
  const region = {
    text: 'Scanned body beside the raster figure',
    confidence: 0.95,
    recognitionConfidence: 0.95,
    vertical: false,
    quad: [
      { x: 20, y: 120 },
      { x: 180, y: 120 },
      { x: 180, y: 140 },
      { x: 20, y: 140 },
    ],
    symbolScores: [0.95],
  } as const;
  return {
    regions: [region],
    lines: [{ orientation: 'horizontal', items: [region], indices: [0] }],
    text: region.text,
  };
})();

function ocrCanvas(): void {
  const getContext = function (this: HTMLCanvasElement): CanvasRenderingContext2D {
    return {
      setTransform: () => undefined,
      fillRect: () => undefined,
      getImageData: () => ({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4),
      }),
    } as unknown as CanvasRenderingContext2D;
  };
  HTMLCanvasElement.prototype.getContext =
    getContext as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

function cancelledError(): Error {
  const error = new Error('Rendering cancelled');
  error.name = 'RenderingCancelledException';
  return error;
}

function placeHost(host: HTMLElement, top: number): void {
  host.getBoundingClientRect = () => viewportRect(top);
}

function intersect(host: HTMLElement, top = 20): void {
  placeHost(host, top);
  const record = observerRecords[0];
  record?.callback(
    [
      {
        target: host,
        isIntersecting: true,
        boundingClientRect: viewportRect(top),
      } as unknown as IntersectionObserverEntry,
    ],
    record as unknown as IntersectionObserver,
  );
}

function stubCanvas(): void {
  HTMLCanvasElement.prototype.getContext = (() => ({
    setTransform: () => undefined,
    fillRect: () => undefined,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

function pageHost(root: HTMLElement, index: number): HTMLElement {
  const host = root.querySelector(`[data-page="${String(index)}"]`);
  if (!(host instanceof HTMLElement)) throw new Error(`expected page ${String(index)}`);
  return host;
}

describe('focusedPdfPage', () => {
  it('picks the page covering the viewport, not a far page in the parse band', () => {
    expect(
      focusedPdfPage(
        [
          { index: 0, top: 20, bottom: 400 },
          { index: 1, top: 420, bottom: 800 },
          { index: 4, top: 1800, bottom: 2200 },
        ],
        600,
      ),
    ).toBe(0);
    expect(
      focusedPdfPage(
        [
          { index: 0, top: -200, bottom: 80 },
          { index: 1, top: 100, bottom: 480 },
          { index: 2, top: 900, bottom: 1280 },
        ],
        600,
      ),
    ).toBe(1);
    expect(
      focusedPdfPage(
        [
          { index: 3, top: 1400, bottom: 1780 },
          { index: 4, top: 1800, bottom: 2180 },
        ],
        600,
      ),
    ).toBeNull();
  });
});

describe('PdfReader viewport observer', () => {
  afterEach(() => {
    observerRecords.length = 0;
    resizeCallback = null;
    vi.unstubAllGlobals();
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it('observes the window, not #pages, and redraws visible pages on resize', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const renders = { count: 0 };
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 240 });
    document.body.append(root);

    HTMLCanvasElement.prototype.getContext = (() => ({
      setTransform: () => undefined,
      fillRect: () => undefined,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const reader = new PdfReader(root, geometries(3), {
      document: fakeDocument(renders, 3),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });

    expect(observerRecords.length).toBeGreaterThan(0);
    expect(observerRecords[0]?.root).toBeNull();

    const firstHost = root.querySelector('.sakutto-page');
    if (!(firstHost instanceof HTMLElement)) throw new Error('expected a page host');
    firstHost.getBoundingClientRect = () =>
      ({
        top: 20,
        bottom: 300,
        left: 0,
        right: 200,
        width: 200,
        height: 280,
        x: 0,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    observerRecords[0]?.callback(
      [
        {
          target: firstHost,
          isIntersecting: true,
          boundingClientRect: firstHost.getBoundingClientRect(),
        } as unknown as IntersectionObserverEntry,
      ],
      observerRecords[0] as unknown as IntersectionObserver,
    );
    const started = Date.now();
    while (renders.count === 0 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const afterDraw = renders.count;
    expect(afterDraw).toBeGreaterThan(0);

    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    resizeCallback?.([], {} as ResizeObserver);
    const resized = Date.now();
    while (renders.count === afterDraw && Date.now() - resized < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(renders.count).toBeGreaterThan(afterDraw);

    reader.destroy();
  });

  it('does not parse a far page first when only that page entered the observer band', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('innerHeight', 600);

    const renders = { count: 0 };
    const requested: number[] = [];
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 240 });
    document.body.append(root);
    stubCanvas();

    const reader = new PdfReader(root, geometries(5), {
      document: fakeDocument(renders, 5, requested),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });

    const hosts = [...root.querySelectorAll('.sakutto-page')];
    expect(hosts).toHaveLength(5);
    hosts.forEach((host, index) => {
      if (!(host instanceof HTMLElement)) return;
      const top = index === 0 ? 20 : 400 + index * 400;
      host.getBoundingClientRect = () => viewportRect(top);
    });
    const far = hosts[4];
    if (!(far instanceof HTMLElement)) throw new Error('expected a far page');

    observerRecords[0]?.callback(
      [
        {
          target: far,
          isIntersecting: true,
          boundingClientRect: far.getBoundingClientRect(),
        } as unknown as IntersectionObserverEntry,
      ],
      observerRecords[0] as unknown as IntersectionObserver,
    );
    reader.start();
    const started = Date.now();
    while (requested.length < 2 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(requested[0]).toBe(1);
    expect(requested.slice(0, 2)).not.toContain(5);
    reader.destroy();
  });

  it('keeps the scanned-page notice after a resize redraws the canvas', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const renders = { count: 0 };
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 240 });
    document.body.append(root);
    HTMLCanvasElement.prototype.getContext = (() => ({
      setTransform: () => undefined,
      fillRect: () => undefined,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument(renders, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });
    const host = root.querySelector('.sakutto-page');
    if (!(host instanceof HTMLElement)) throw new Error('expected a page host');
    host.getBoundingClientRect = () =>
      ({
        top: 20,
        bottom: 300,
        left: 0,
        right: 200,
        width: 200,
        height: 280,
        x: 0,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    reader.start();
    const parsed = Date.now();
    while (host.dataset.pageEmpty !== 'true' && Date.now() - parsed < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(host.dataset.pageEmpty).toBe('true');
    expect(host.querySelector('.sakutto-page__missing')?.textContent).toBe('Empty');

    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    resizeCallback?.([], {} as ResizeObserver);
    const resized = Date.now();
    while (Date.now() - resized < 50) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(host.dataset.pageEmpty).toBe('true');
    expect(host.dataset.renderFailed).toBeUndefined();
    expect(host.hasAttribute('data-empty')).toBe(false);

    reader.destroy();
  });

  it('does not show the scanned-page notice when a page with text fails to render', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 240 });
    document.body.append(root);
    stubCanvas();

    let draws = 0;
    const page: PdfPage = {
      getViewport: ({ scale }) => ({
        width: 200 * scale,
        height: 280 * scale,
        transform: [scale, 0, 0, -scale, 0, 280 * scale],
      }),
      getTextContent: async () => ({
        items: [
          {
            str: 'A paragraph of selectable source text on this page.',
            transform: [10, 0, 0, 10, 40, 200],
            width: 160,
            height: 10,
            fontName: 'F1',
          },
        ],
        styles: {},
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: () => null },
      render: () => {
        draws += 1;
        return { promise: Promise.reject(new Error('draw failed')) };
      },
    };
    const document_: PdfDocument = {
      numPages: 1,
      getPage: async () => page,
      getMetadata: async () => null,
      destroy: async () => undefined,
    };

    const reader = new PdfReader(root, geometries(1), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });
    const host = root.querySelector('.sakutto-page');
    if (!(host instanceof HTMLElement)) throw new Error('expected a page host');
    host.getBoundingClientRect = () =>
      ({
        top: 20,
        bottom: 300,
        left: 0,
        right: 200,
        width: 200,
        height: 280,
        x: 0,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    reader.start();
    const started = Date.now();
    while (host.dataset.renderFailed !== 'true' && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(draws).toBeGreaterThanOrEqual(2);
    expect(host.dataset.renderFailed).toBe('true');
    expect(host.dataset.pageEmpty).toBeUndefined();
    expect(host.hasAttribute('data-empty')).toBe(false);
    expect(host.querySelector('.sakutto-page__render-failed')?.textContent).toBe('Could not draw');

    reader.destroy();
  });

  it('cancels an in-flight page render when a newer draw starts', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const renders = { started: 0, cancelled: 0 };
    let release: (() => void) | null = null;
    const page: PdfPage = {
      getViewport: ({ scale }) => ({
        width: 200 * scale,
        height: 280 * scale,
        transform: [scale, 0, 0, -scale, 0, 280 * scale],
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: () => null },
      render: () => {
        renders.started += 1;
        let cancelled = false;
        const promise = new Promise<void>((resolve, reject) => {
          release = () => {
            if (cancelled) reject(cancelledError());
            else resolve();
          };
        });
        return {
          promise,
          cancel: () => {
            renders.cancelled += 1;
            cancelled = true;
            release?.();
          },
        };
      },
    };
    const document_: PdfDocument = {
      numPages: 1,
      getPage: async () => page,
      getMetadata: async () => null,
      destroy: async () => undefined,
    };

    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 240 });
    document.body.append(root);
    HTMLCanvasElement.prototype.getContext = (() => ({
      setTransform: () => undefined,
      fillRect: () => undefined,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const reader = new PdfReader(root, geometries(1), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });
    const host = root.querySelector('.sakutto-page');
    if (!(host instanceof HTMLElement)) throw new Error('expected a page host');
    host.getBoundingClientRect = () =>
      ({
        top: 20,
        bottom: 300,
        left: 0,
        right: 200,
        width: 200,
        height: 280,
        x: 0,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    const waiting = Date.now();
    while (renders.started === 0 && Date.now() - waiting < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(renders.started).toBeGreaterThan(0);

    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    resizeCallback?.([], {} as ResizeObserver);
    const resized = Date.now();
    while (renders.cancelled === 0 && Date.now() - resized < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(renders.cancelled).toBeGreaterThan(0);
    const second = Date.now();
    while (renders.started <= 1 && Date.now() - second < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(renders.started).toBeGreaterThan(1);
    const settled = Date.now();
    while (Date.now() - settled < 50) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(host.dataset.renderFailed).toBeUndefined();

    reader.destroy();
  });

  it('does not evict a nearby in-flight draw when a far page enters the parse band', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('innerHeight', 600);
    stubCanvas();

    const pages = 10;
    const started = Array.from({ length: pages }, () => 0);
    const cancelled = Array.from({ length: pages }, () => 0);

    const hungPage = (index: number): PdfPage => ({
      getViewport: ({ scale }) => ({
        width: 200 * scale,
        height: 280 * scale,
        transform: [scale, 0, 0, -scale, 0, 280 * scale],
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: () => null },
      render: () => {
        started[index] = (started[index] ?? 0) + 1;
        return {
          promise: new Promise<void>(() => undefined),
          cancel: () => {
            cancelled[index] = (cancelled[index] ?? 0) + 1;
          },
        };
      },
    });

    const document_: PdfDocument = {
      numPages: pages,
      getPage: async (number) => hungPage(number - 1),
      getMetadata: async () => null,
      destroy: async () => undefined,
    };

    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 240 });
    document.body.append(root);

    const reader = new PdfReader(root, geometries(pages), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });

    for (let index = 0; index < pages; index += 1) {
      placeHost(pageHost(root, index), index <= 1 ? 20 + index * 280 : 1800 + index * 400);
    }
    intersect(pageHost(root, 0), 20);
    const waiting = Date.now();
    while (started[0] === 0 && Date.now() - waiting < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(started[0]).toBeGreaterThan(0);

    observerRecords[0]?.callback(
      [
        {
          target: pageHost(root, 9),
          isIntersecting: true,
          boundingClientRect: viewportRect(2200),
        } as unknown as IntersectionObserverEntry,
      ],
      observerRecords[0] as unknown as IntersectionObserver,
    );
    const delayed = Date.now();
    while (Date.now() - delayed < 50) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(cancelled[0]).toBe(0);

    reader.destroy();
  });

  it('redraws a page whose in-flight draw was evicted, without a render-failed notice', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubCanvas();

    const pages = 10;
    const started = Array.from({ length: pages }, () => 0);
    const cancelled = Array.from({ length: pages }, () => 0);
    const succeed = new Set<number>();
    const releases: Array<(() => void) | undefined> = Array.from({ length: pages });

    const hungPage = (index: number): PdfPage => ({
      getViewport: ({ scale }) => ({
        width: 200 * scale,
        height: 280 * scale,
        transform: [scale, 0, 0, -scale, 0, 280 * scale],
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: () => null },
      render: () => {
        started[index] = (started[index] ?? 0) + 1;
        if (succeed.has(index)) return { promise: Promise.resolve() };
        const promise = new Promise<void>((_, reject) => {
          releases[index] = () => {
            reject(cancelledError());
          };
        });
        return {
          promise,
          cancel: () => {
            cancelled[index] = (cancelled[index] ?? 0) + 1;
            releases[index]?.();
          },
        };
      },
    });

    const document_: PdfDocument = {
      numPages: pages,
      getPage: async (number) => hungPage(number - 1),
      getMetadata: async () => null,
      destroy: async () => undefined,
    };

    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 240 });
    document.body.append(root);

    const reader = new PdfReader(root, geometries(pages), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });

    vi.stubGlobal('innerHeight', 600);
    const waiting = Date.now();
    while (started[2] === 0 && Date.now() - waiting < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(started[2]).toBeGreaterThan(0);

    for (let index = 0; index < pages; index += 1) {
      placeHost(pageHost(root, index), index === 9 ? 10 : 2400 + index * 400);
    }
    intersect(pageHost(root, 9), 10);
    const dropped = Date.now();
    while (cancelled[2] === 0 && Date.now() - dropped < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(cancelled[2]).toBeGreaterThan(0);
    const afterCancel = Date.now();
    while (Date.now() - afterCancel < 50) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(pageHost(root, 2).dataset.renderFailed).toBeUndefined();

    const beforeRedraw = started[2] ?? 0;
    succeed.add(2);
    for (let index = 0; index < pages; index += 1) {
      placeHost(pageHost(root, index), index === 2 ? 20 : 2400 + index * 400);
    }
    intersect(pageHost(root, 2), 20);
    const redrawn = Date.now();
    while ((started[2] ?? 0) === beforeRedraw && Date.now() - redrawn < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(started[2] ?? 0).toBeGreaterThan(beforeRedraw);
    const painted = Date.now();
    while (Date.now() - painted < 50) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(pageHost(root, 2).dataset.renderFailed).toBeUndefined();
    expect(pageHost(root, 2).querySelector('canvas')).toBeInstanceOf(HTMLCanvasElement);

    reader.destroy();
  });

  it('does not mark OCR aborted by a quick hide and re-show as failed', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    let started = 0;
    const recognize = vi.fn((_image: unknown, signal: AbortSignal) => {
      started += 1;
      if (started > 1) return Promise.resolve(scannedResult);
      return new Promise<OcrResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument({ count: 0 }, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    reader.setVisible(false);
    reader.setVisible(true);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(reader.coverage(0)).toHaveLength(1));

    expect(pageHost(root, 0).querySelector('.sakutto-page__missing')?.textContent).not.toBe(
      labels.ocrFailed,
    );
    expect(reader.coverage(0)[0]?.sourceText).toBe(scannedResult.text);
    reader.destroy();
  });

  it('shows the empty-page label after OCR returns no text', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    const emptyResult: OcrResult = { regions: [], lines: [], text: '' };
    const recognize = vi.fn().mockResolvedValue(emptyResult);
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument({ count: 0 }, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reader.coverage(0)).toHaveLength(0));
    await vi.waitFor(() =>
      expect(pageHost(root, 0).querySelector('.sakutto-page__missing')?.textContent).toBe(
        labels.emptyPage,
      ),
    );
    expect(pageHost(root, 0).dataset.pageEmpty).toBe('true');
    reader.destroy();
  });

  it('reports a transient OCR failure and replaces its fallback on retry', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    const recognize = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary model initialization failure'))
      .mockResolvedValueOnce(scannedResult);
    const reports: { parsed: number; pages: number }[] = [];
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument({ count: 0 }, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: (state) => reports.push(state),
      ocr: { recognize },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reports.at(-1)).toMatchObject({ parsed: 1, pages: 1 }));
    expect(reader.coverage(0)).toHaveLength(0);
    expect(pageHost(root, 0).querySelector('.sakutto-page__missing')?.textContent).toBe(
      labels.ocrFailed,
    );

    reader.retryOcr();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(reader.coverage(0)).toHaveLength(1));
    expect(reader.coverage(0)[0]?.sourceText).toBe(scannedResult.text);
    expect(reports.at(-1)).toMatchObject({ parsed: 1, pages: 1 });
    reader.destroy();
  });

  it('backs off a retryable page when getPage throws before OCR is attempted', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    let recognizeCalls = 0;
    const recognize = vi.fn(() => {
      recognizeCalls += 1;
      if (recognizeCalls === 1) return Promise.reject(new Error('first OCR failure'));
      return Promise.resolve(scannedResult);
    });
    const requested: number[] = [];
    let failFirstPage = false;
    const renders = { count: 0 };
    const textPage: PdfPage = {
      ...fakePage(renders),
      getTextContent: async () => ({
        items: [
          {
            str: 'A paragraph of selectable source text on this page.',
            transform: [10, 0, 0, 10, 40, 200],
            width: 160,
            height: 10,
            fontName: 'F1',
          },
        ],
        styles: {},
      }),
    };
    const document_: PdfDocument = {
      numPages: 2,
      getPage: async (number) => {
        requested.push(number);
        if (failFirstPage && number === 1) throw new Error('page load failed before OCR');
        return number === 1 ? fullPageScanPage(renders) : textPage;
      },
      getMetadata: async () => null,
      destroy: async () => undefined,
    };
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(2), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
      ops: { transform: 1, paintImageXObject: 2 },
    });

    reader.start();
    await vi.waitFor(() => expect(recognizeCalls).toBe(1));
    await vi.waitFor(() => expect(pageHost(root, 0).dataset.ocrFailed).toBe('true'));
    // The first failure makes page zero retryable; a fresh getPage failure on that
    // retry used to re-enter parseNext immediately in the same turn, forever.
    failFirstPage = true;
    const before = requested.filter((number) => number === 1).length;
    reader.retryOcr();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(requested.filter((number) => number === 1).length - before).toBeLessThanOrEqual(2);
    // The backed-off page must not starve the page behind it.
    expect(requested).toContain(2);
    reader.destroy();
  });

  it('re-queues a model-missing page after its retry budget runs out and OCR becomes ready', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    let modelsReady = false;
    const recognize = vi.fn(() => {
      if (!modelsReady) throw new PdfOcrModelMissingError('OCR models are not downloaded.');
      return Promise.resolve(scannedResult);
    });
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument({ count: 0 }, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    // Six failures exhaust the ordinary backoff budget while the download is still running.
    for (let call = 2; call <= 6; call += 1) {
      reader.retryOcr();
      await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(call));
    }
    expect(pageHost(root, 0).dataset.ocrFailed).toBe('true');
    expect(reader.coverage(0)).toHaveLength(0);

    // An `ocr:progress` message with state `ready` makes the reader call retryOcr().
    modelsReady = true;
    reader.retryOcr();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(7));
    await vi.waitFor(() => expect(reader.coverage(0)).toHaveLength(1));
    expect(reader.coverage(0)[0]?.sourceText).toBe(scannedResult.text);
    expect(pageHost(root, 0).dataset.ocrFailed).toBeUndefined();
    reader.destroy();
  });

  it('offers an inline OCR download on a missing page without downloading on its own', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    const recognize = vi.fn(() => {
      throw new PdfOcrModelMissingError('Need OCR models');
    });
    const download = vi.fn(async () => true);
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument({ count: 0 }, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize, tier: 'standard' },
      onOcrDownload: download,
    });

    reader.start();
    await vi.waitFor(() => expect(pageHost(root, 0).dataset.ocrModelMissing).toBe('true'));
    const overlay = pageHost(root, 0).querySelector<HTMLElement>('.sakutto-page__missing');
    expect(overlay?.textContent).toContain('Need OCR models');
    const button = overlay?.querySelector<HTMLButtonElement>('button.sakutto-ocr-download');
    expect(button?.textContent).toBe(labels.ocrDownload);
    expect(button?.getAttribute('data-sakutto')).toBe('ocr-download');
    expect(download).not.toHaveBeenCalled();

    button?.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith('standard'));

    reader.updateOcrDownload({
      id: 'standard',
      state: 'downloading',
      received: 5,
      total: 10,
      progress: 0.5,
    });
    expect(overlay?.querySelector('.sakutto-ocr-progress')?.textContent).toBe('50%');
    expect(button?.disabled).toBe(true);

    reader.updateOcrDownload({
      id: 'high',
      state: 'downloading',
      received: 9,
      total: 10,
      progress: 0.9,
    });
    expect(overlay?.querySelector('.sakutto-ocr-progress')?.textContent).toBe('50%');
    reader.updateOcrDownload({
      id: 'standard',
      state: 'error',
      received: 0,
      total: 0,
      progress: 0,
      error: 'offline',
    });
    expect(overlay?.textContent).toContain(labels.ocrDownloadFailed);

    reader.retryOcr();
    await vi.waitFor(() => expect(pageHost(root, 0).dataset.ocrModelMissing).toBeUndefined());
    reader.destroy();
  });
  it('surfaces a failed OCR pass on a mixed page but not on a page that never ran OCR', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    const recognize = vi.fn().mockRejectedValue(new Error('OCR is unavailable'));
    const renders = { count: 0 };
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const document_: PdfDocument = {
      numPages: 2,
      getPage: async (number) => mixedScanPage(renders, number === 1),
      getMetadata: async () => null,
      destroy: async () => undefined,
    };
    const reader = new PdfReader(root, geometries(2), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
      ops: { transform: 1, paintImageXObject: 2 },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reader.parsedPages()).toEqual([0, 1]));
    await vi.waitFor(() => expect(pageHost(root, 0).dataset.ocrFailed).toBe('true'));

    const mixed = pageHost(root, 0);
    // Native fallback blocks keep the page readable, but the OCR error must still be shown.
    expect(mixed.dataset.pageEmpty).toBe('false');
    expect(mixed.querySelector('.sakutto-page__missing')?.textContent).toBe(labels.ocrFailed);
    const textOnly = pageHost(root, 1);
    expect(textOnly.dataset.ocrFailed).toBeUndefined();
    expect(textOnly.querySelector('.sakutto-page__missing')?.textContent).not.toBe(
      labels.ocrFailed,
    );
    expect(recognize).toHaveBeenCalledTimes(1);
    reader.destroy();
  });

  it('keeps a native figure label skipped when mixed-page OCR succeeds', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    const recognize = vi.fn().mockResolvedValue(mixedScannedResult);
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const document_: PdfDocument = {
      numPages: 1,
      getPage: async () => mixedScanPage({ count: 0 }, true),
      getMetadata: async () => null,
      destroy: async () => undefined,
    };
    const reader = new PdfReader(root, geometries(1), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
      ops: { transform: 1, paintImageXObject: 2 },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reader.coverage(0)).toHaveLength(2));
    const texts = reader.coverage(0).map((entry) => entry.sourceText);
    expect(texts).toContain('Native prose outside the raster figure.');
    expect(texts).toContain(mixedScannedResult.text);
    expect(texts).not.toContain('Native label inside the raster figure');
    expect(pageHost(root, 0).dataset.ocrFailed).toBeUndefined();
    reader.destroy();
  });

  it('keeps a native figure label skipped when mixed-page OCR fails', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    const recognize = vi.fn().mockRejectedValue(new Error('OCR is unavailable'));
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const document_: PdfDocument = {
      numPages: 1,
      getPage: async () => mixedScanPage({ count: 0 }, true),
      getMetadata: async () => null,
      destroy: async () => undefined,
    };
    const reader = new PdfReader(root, geometries(1), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
      ops: { transform: 1, paintImageXObject: 2 },
    });

    reader.start();
    await vi.waitFor(() => expect(pageHost(root, 0).dataset.ocrFailed).toBe('true'));
    expect(reader.coverage(0).map((entry) => entry.sourceText)).toEqual([
      'Native prose outside the raster figure.',
    ]);
    reader.destroy();
  });

  it('keeps a native header translatable when the full-page scan OCR fails', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();
    const recognize = vi.fn().mockRejectedValue(new Error('OCR is unavailable'));
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const document_: PdfDocument = {
      numPages: 1,
      getPage: async () => fullPageScanPage({ count: 0 }),
      getMetadata: async () => null,
      destroy: async () => undefined,
    };
    const reader = new PdfReader(root, geometries(1), {
      document: document_,
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
      ops: { transform: 1, paintImageXObject: 2 },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(pageHost(root, 0).dataset.ocrFailed).toBe('true'));
    expect(reader.coverage(0).map((entry) => entry.sourceText)).toEqual([
      'Native header on the full-page scan',
    ]);
    expect(pageHost(root, 0).dataset.pageEmpty).toBe('false');
    reader.destroy();
  });

  it('uses the live OCR tier for the local timeout after a settings change', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      ocrCanvas();
      const recognize = vi.fn(() => new Promise<OcrResult>(() => undefined));
      const root = document.createElement('div');
      Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
      document.body.append(root);
      const reader = new PdfReader(root, geometries(1), {
        document: fakeDocument({ count: 0 }, 1),
        engine: silentEngine,
        labels,
        targetLanguage: 'ja',
        form: 'plain',
        onProgress: () => undefined,
        ocr: { recognize, tier: 'standard' },
      });

      // Settings change while the reader is open, before this scan page is recognized.
      reader.setOcrTier('high');
      reader.start();
      for (let index = 0; index < 20 && recognize.mock.calls.length === 0; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(recognize).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(ocrPageTimeoutMs('standard') + 1);
      expect(pageHost(root, 0).dataset.ocrFailed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(ocrPageTimeoutMs('high') - ocrPageTimeoutMs('standard'));
      expect(pageHost(root, 0).dataset.ocrFailed).toBe('true');
      reader.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('paints and translates native prose while OCR is still pending on a mixed page', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    ocrCanvas();

    const pending: { resolve: ((result: OcrResult) => void) | null } = { resolve: null };
    const recognize = vi.fn(
      (_image: unknown, signal: AbortSignal) =>
        new Promise<OcrResult>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          pending.resolve = resolve;
        }),
    );
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const renders = { count: 0 };
    const reader = new PdfReader(root, geometries(1), {
      document: {
        numPages: 1,
        getPage: async () => mixedScanPage(renders, true),
        getMetadata: async () => null,
        destroy: async () => undefined,
      },
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
      ocr: { recognize },
      ops: { transform: 1, paintImageXObject: 2 },
    });

    reader.start();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());

    // The native text layer is already selectable and handed to the session; the OCR pass is
    // deliberately still pending here. No empty-page notice may cover the readable prose.
    const host = pageHost(root, 0);
    await vi.waitFor(() =>
      expect(host.querySelector('.sakutto-page__text')?.textContent).toContain(
        'Native prose outside the raster figure.',
      ),
    );
    expect(host.dataset.pageEmpty).not.toBe('true');
    expect(host.querySelector('.sakutto-page__missing')?.textContent).not.toBe(
      labels.ocrReading(1, 1),
    );

    pending.resolve?.(scannedResult);
    await vi.waitFor(() => expect(host.dataset.pageEmpty).toBe('false'));
    reader.destroy();
  });

  it('toggles a side-by-side original and translated layout', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubCanvas();

    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);

    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument({ count: 0 }, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });

    const host = pageHost(root, 0);
    expect(root.dataset.compare).toBe('false');
    expect(reader.isCompare()).toBe(false);
    expect(host.querySelector('.sakutto-page__pane--original')).toBeInstanceOf(HTMLElement);
    expect(host.querySelector('.sakutto-page__pane--translated')).toBeInstanceOf(HTMLElement);
    expect(host.querySelector('.sakutto-page__canvas--original')).toBeInstanceOf(HTMLCanvasElement);
    expect(host.querySelectorAll('.sakutto-page__pane')).toHaveLength(2);

    reader.setCompare(true);
    expect(root.dataset.compare).toBe('true');
    expect(reader.isCompare()).toBe(true);
    const captions = [...host.querySelectorAll('.sakutto-page__caption')].map(
      (node) => node.textContent,
    );
    expect(captions).toEqual(['Original', 'Translated']);
    expect(host.style.width.endsWith('px')).toBe(true);

    reader.setCompare(false);
    expect(root.dataset.compare).toBe('false');
    expect(reader.isCompare()).toBe(false);

    reader.destroy();
  });

  it('copies the original canvas only while compare is on', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubCanvas();

    const renders = { count: 0 };
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);

    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument(renders, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });

    const host = pageHost(root, 0);
    placeHost(host, 20);
    intersect(host, 20);
    const started = Date.now();
    while (renders.count === 0 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(renders.count).toBeGreaterThan(0);
    const original = host.querySelector('.sakutto-page__canvas--original');
    if (!(original instanceof HTMLCanvasElement)) throw new Error('expected original canvas');
    expect(original.width).toBe(0);

    reader.setCompare(true);
    const copied = Date.now();
    while (original.width === 0 && Date.now() - copied < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(original.width).toBeGreaterThan(0);

    reader.setCompare(false);
    expect(original.width).toBe(0);

    reader.destroy();
  });

  it('toggles a reflowed bilingual layout without breaking compare', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubCanvas();
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);
    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument({ count: 0 }, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });
    const host = pageHost(root, 0);
    expect(host.querySelector('.sakutto-bilingual')).toBeInstanceOf(HTMLElement);
    expect(root.dataset.bilingual).toBe('false');

    reader.setBilingual(true);
    expect(reader.isBilingual()).toBe(true);
    expect(root.dataset.bilingual).toBe('true');
    expect(host.querySelectorAll('.sakutto-page__pane')).toHaveLength(2);
    expect(
      [...host.querySelectorAll('.sakutto-page__caption')].map((node) => node.textContent),
    ).toEqual(['Original', 'Translated']);

    reader.setCompare(true);
    expect(reader.isBilingual()).toBe(false);
    expect(reader.isCompare()).toBe(true);
    expect(root.dataset.bilingual).toBe('false');

    reader.setBilingual(true);
    expect(reader.isCompare()).toBe(false);
    reader.destroy();
  });

  it('keeps the original canvas and two-column sizing through bilingual redraws', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    stubCanvas();
    const renders = { count: 0 };
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 520 });
    document.body.append(root);

    const reader = new PdfReader(root, geometries(1), {
      document: fakeDocument(renders, 1),
      engine: silentEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      onProgress: () => undefined,
    });
    const host = pageHost(root, 0);
    placeHost(host, 20);
    intersect(host, 20);
    const waitForRender = async (count: number): Promise<void> => {
      const started = Date.now();
      while (renders.count < count && Date.now() - started < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(renders.count).toBeGreaterThanOrEqual(count);
    };
    await waitForRender(1);
    const original = host.querySelector('.sakutto-page__canvas--original');
    if (!(original instanceof HTMLCanvasElement)) throw new Error('expected original canvas');
    expect(original.width).toBe(0);

    reader.setBilingual(true);
    await waitForRender(2);
    // Both panes share the row: two page widths plus the gap, no fixed row height, and the
    // translated stage grows with its reflowed rows while the original keeps the page height.
    expect(Number.parseFloat(host.style.width)).toBeCloseTo(200 * 1.18 * 2 + 12, 1);
    expect(host.style.height).toBe('');
    const stages = [...host.querySelectorAll('.sakutto-page__stage')] as HTMLElement[];
    expect(Number.parseFloat(stages[0]?.style.height ?? '')).toBeCloseTo(280 * 1.18, 1);
    expect(stages[1]?.style.height).toBe('');
    expect(original.width).toBeGreaterThan(0);

    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 600 });
    resizeCallback?.([], {} as ResizeObserver);
    await waitForRender(3);
    expect(Number.parseFloat(host.style.width)).toBeCloseTo(200 * 1.38 * 2 + 12, 1);
    expect(original.width).toBeGreaterThan(0);

    reader.destroy();
  });

  it('paints an L-shaped polygon clip-path and inline spacer around a floated badge image', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    HTMLCanvasElement.prototype.getContext = (() => ({
      font: '',
      setTransform: () => undefined,
      fillRect: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const ops = { save: 1, restore: 2, transform: 3, paintImageXObject: 4 };
    const page: PdfPage = {
      getViewport: ({ scale }) => ({
        width: 300 * scale,
        height: 400 * scale,
        transform: [scale, 0, 0, -scale, 0, 400 * scale],
      }),
      getTextContent: async () => ({
        items: [
          {
            str: 'A Unit represents a cohesive self-contained element',
            transform: [10, 0, 0, 10, 95, 290],
            width: 185,
            height: 10,
            fontName: 'F1',
          },
          {
            str: 'derived from an Intent specifically designed to deliver',
            transform: [10, 0, 0, 10, 36, 276],
            width: 244,
            height: 10,
            fontName: 'F1',
          },
          {
            str: 'measurable value across independent functional blocks.',
            transform: [10, 0, 0, 10, 36, 262],
            width: 244,
            height: 10,
            fontName: 'F1',
          },
        ],
        styles: {},
      }),
      getOperatorList: async () => ({
        fnArray: [ops.save, ops.transform, ops.paintImageXObject, ops.restore],
        argsArray: [[], [55, 0, 0, 28, 36, 288], ['Im0', 55, 28], []],
      }),
      commonObjs: { get: () => null },
      render: () => ({ promise: Promise.resolve() }),
    };
    const document_: PdfDocument = {
      numPages: 1,
      getPage: async () => page,
      getMetadata: async () => null,
      destroy: async () => undefined,
    };
    const translatingEngine: PdfEngine = {
      async *translate(segments) {
        for (const segment of segments) {
          yield {
            id: segment.id,
            final:
              'ユニットとは、Intentから派生した測定可能な価値を提供するために設計された自己完結型の作業要素です。',
          };
        }
      },
    };

    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 340 });
    document.body.append(root);

    const reader = new PdfReader(root, [{ index: 0, width: 300, height: 400 }], {
      document: document_,
      engine: translatingEngine,
      labels,
      targetLanguage: 'ja',
      form: 'plain',
      ops,
      onProgress: () => undefined,
    });
    reader.start();

    const host = pageHost(root, 0);
    intersect(host, 20);
    const started = Date.now();
    while (!host.querySelector('.sakutto-cover') && Date.now() - started < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const cover = host.querySelector('.sakutto-cover');
    expect(cover).toBeInstanceOf(HTMLElement);
    if (!(cover instanceof HTMLElement)) throw new Error('expected cover');
    expect(cover.style.clipPath).toMatch(/^polygon\(/u);
    expect(cover.style.textAlign).toBe('start');
    const spacers = cover.querySelectorAll('span');
    expect(spacers.length).toBeGreaterThanOrEqual(1);
    expect((spacers[0] as HTMLElement).style.display).toBe('inline-block');
    expect(parseFloat((spacers[0] as HTMLElement).style.width)).toBeGreaterThan(40);
    expect(cover.textContent).toContain('ユニットとは');

    reader.destroy();
  });
});
