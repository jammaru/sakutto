import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function loadPdfjs(): Promise<{
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<{
      numPages: number;
      getPage: (n: number) => Promise<unknown>;
      loadingTask: { destroy: () => Promise<void> };
    }>;
  };
  OPS: Record<string, number>;
}> {
  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = (await import(pathToFileURL(pdfjsPath).href)) as {
    getDocument: (params: Record<string, unknown>) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<unknown>;
        loadingTask: { destroy: () => Promise<void> };
      }>;
    };
    OPS: Record<string, number>;
  };
  return pdfjs;
}

export function standardFontDataUrl(): string {
  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  return pathToFileURL(resolve(dirname(pdfjsPath), '..', '..', 'standard_fonts') + '/').href;
}

export async function openPdfBytes(bytes: Uint8Array): Promise<{
  numPages: number;
  getPage: (n: number) => Promise<unknown>;
  /** pdf.js 6 teardown lives on the loading task, not on the document proxy. */
  loadingTask: { destroy: () => Promise<void> };
}> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    fontExtraProperties: true,
    standardFontDataUrl: standardFontDataUrl(),
  }).promise;
}
