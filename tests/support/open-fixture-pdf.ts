import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function loadPdfjs(): Promise<{
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<{
      numPages: number;
      getPage: (n: number) => Promise<unknown>;
      destroy: () => Promise<void>;
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
        destroy: () => Promise<void>;
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

/** Plain filesystem path with a trailing slash: the Node build reads CMaps from disk. */
export function cMapUrlFromPackage(): string {
  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  return resolve(dirname(pdfjsPath), '..', '..', 'cmaps') + '/';
}

export async function openPdfBytes(
  bytes: Uint8Array,
  cMapUrl: string = cMapUrlFromPackage(),
): Promise<{
  numPages: number;
  getPage: (n: number) => Promise<unknown>;
  destroy: () => Promise<void>;
}> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: standardFontDataUrl(),
    // The Node build reads cMaps from the filesystem, so pass a plain directory path rather
    // than a file:// URL. Fixtures with UTF-16 CMaps need them to expose their text layer; the
    // package copy is always present, unlike the gitignored public/vendor one used in prod.
    cMapUrl,
    cMapPacked: true,
  }).promise;
}
