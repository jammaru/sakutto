// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfReader, type ReaderLabels } from '@/pdf/reader';
import type { PdfDocument, PdfPage } from '@/pdf/extract';
import type { PdfEngine } from '@/pdf/session';

const labels: ReaderLabels = {
  translate: 'Translate',
  restore: 'Restore',
  translating: 'Translating',
  translated: 'Translated',
  progress: (done, total) => `${String(done)}/${String(total)}`,
  emptyPage: 'Empty',
  noText: 'No text',
  scanning: (page, of) => `${String(page)}/${String(of)}`,
  failed: 'Failed',
  selectionTranslating: '…',
  selectionFailed: 'failed',
  overflowOpen: 'Open',
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

function fakeDocument(renders: { count: number }, pages = 3): PdfDocument {
  return {
    numPages: pages,
    getPage: async () => fakePage(renders),
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
    HTMLCanvasElement.prototype.getContext = (() => ({
      setTransform: () => undefined,
      fillRect: () => undefined,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

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
      render: () => ({ promise: Promise.reject(new Error('draw failed')) }),
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
    expect(host.dataset.renderFailed).toBe('true');
    expect(host.dataset.pageEmpty).toBeUndefined();
    expect(host.hasAttribute('data-empty')).toBe(false);

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
            if (cancelled) reject(new Error('cancelled'));
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

    reader.destroy();
  });
});
