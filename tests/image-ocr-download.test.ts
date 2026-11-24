// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

let modelsReady = false;
const recognizeResponse = {
  text: 'Hello',
  regions: [
    {
      text: 'Hello',
      recognitionConfidence: 0.95,
      quad: [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 12 },
        { x: 0, y: 12 },
      ],
    },
  ],
  lines: [{ orientation: 'horizontal', items: [{ text: 'Hello' }] }],
};

vi.mock('wxt/browser', () => ({
  browser: {
    i18n: { getMessage: () => '', getUILanguage: () => 'en' },
    runtime: {
      sendMessage: vi.fn(async (message: { type?: string }) =>
        message?.type === 'ocr:recognize' && !modelsReady
          ? { __ocrError: 'model-missing' }
          : message?.type === 'ocr:recognize'
            ? recognizeResponse
            : null,
      ),
    },
  },
}));

const { ImageTranslationController } = await import('@/dom/image-translation');
const { uiShadow } = await import('@/dom/overlay');
const { createDefaultSettings } = await import('@/shared/settings');

const labels = {
  heading: 'Image translation',
  pending: 'Working',
  failed: 'Failed',
  empty: 'Empty',
  close: 'Close',
  original: 'Recognized text',
  permission: 'Permission',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Could not copy',
  resize: 'Resize',
  ocrMissing: 'Need OCR models',
  ocrDownloadFailed: 'Download failed',
};

function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: vi.fn(),
      getImageData: () => ({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4).fill(255),
      }),
    } as unknown as CanvasRenderingContext2D;
  });
}

function image(): void {
  const element = document.createElement('img');
  element.src = 'https://example.test/scan.png';
  Object.defineProperties(element, {
    complete: { value: true },
    naturalWidth: { value: 100 },
    naturalHeight: { value: 60 },
  });
  document.body.append(element);
}

afterEach(() => {
  modelsReady = false;
  vi.restoreAllMocks();
  document.body?.replaceChildren();
  document.documentElement
    .querySelectorAll('[data-sakutto-image-translation]')
    .forEach((node) => node.remove());
});

describe('inline OCR download in the image popup', () => {
  it('shows a click-only prompt, tracks progress, and retries the same image when ready', async () => {
    image();
    stubCanvas();
    const download = vi.fn(async () => true);
    const translate = vi.fn(async function* () {
      yield { id: 'line-0', final: 'translated', engine: 'plamo' } as const;
    });
    const controller = new ImageTranslationController({
      labels,
      translate,
      loadSettings: async () => createDefaultSettings('en'),
      requestOcrDownload: download,
    });
    await controller.start('https://example.test/scan.png');

    const host = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
    const shadow = uiShadow(host);
    const prompt = shadow?.querySelector<HTMLElement>('.ocr-prompt');
    expect(prompt?.hidden).toBe(false);
    expect(prompt?.querySelector('.ocr-message')?.textContent).toBe(labels.ocrMissing);
    const button = prompt?.querySelector<HTMLButtonElement>('button.ocr-download');
    expect(button?.textContent).toBe('Download OCR model (about 23 MB)');
    expect(shadow?.querySelector<HTMLElement>('.body')?.textContent).toBe('');
    expect(download).not.toHaveBeenCalled();

    button?.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith('standard'));
    controller.updateOcrDownload({
      id: 'standard',
      state: 'downloading',
      received: 4,
      total: 10,
      progress: 0.4,
    });
    expect(prompt?.querySelector('.ocr-progress')?.textContent).toBe('Downloading OCR model: 40%');
    expect(button?.disabled).toBe(true);

    controller.updateOcrDownload({
      id: 'high',
      state: 'downloading',
      received: 9,
      total: 10,
      progress: 0.9,
    });
    expect(prompt?.querySelector('.ocr-progress')?.textContent).toBe('Downloading OCR model: 40%');
    controller.updateOcrDownload({
      id: 'standard',
      state: 'error',
      received: 0,
      total: 0,
      progress: 0,
      error: 'offline',
    });
    expect(prompt?.querySelector('.ocr-message')?.textContent).toBe(labels.ocrDownloadFailed);

    modelsReady = true;
    controller.updateOcrDownload({
      id: 'standard',
      state: 'ready',
      received: 10,
      total: 10,
      progress: 1,
    });
    // A retry rebuilds the panel for the same image, so read the new shadow root.
    const retriedHost = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
    const retriedShadow = uiShadow(retriedHost);
    await vi.waitFor(() =>
      expect(retriedShadow?.querySelector('.body')?.textContent).toBe('translated'),
    );
    expect(retriedShadow?.querySelector<HTMLElement>('.ocr-prompt')?.hidden).toBe(true);
    expect(translate).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    controller.close();
  });

  it('reports a failed download request without starting a translation', async () => {
    image();
    stubCanvas();
    const download = vi.fn(async () => false);
    const translate = vi.fn(async function* () {
      yield { id: 'line-0', final: 'translated', engine: 'plamo' } as const;
    });
    const controller = new ImageTranslationController({
      labels,
      translate,
      loadSettings: async () => createDefaultSettings('en'),
      requestOcrDownload: download,
    });
    await controller.start('https://example.test/scan.png');
    const host = document.querySelector<HTMLElement>('[data-sakutto-image-translation]');
    const prompt = uiShadow(host)?.querySelector<HTMLElement>('.ocr-prompt');
    prompt?.querySelector<HTMLButtonElement>('button.ocr-download')?.click();
    await vi.waitFor(() =>
      expect(prompt?.querySelector('.ocr-message')?.textContent).toBe(labels.ocrDownloadFailed),
    );
    expect(translate).not.toHaveBeenCalled();
    controller.close();
  });
});
