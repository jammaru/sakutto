// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusedPdfPage, PdfReader, type ReaderLabels } from '@/pdf/reader';
import type { PdfDocument, PdfPage } from '@/pdf/extract';
import type { PdfEngine } from '@/pdf/session';

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
});
