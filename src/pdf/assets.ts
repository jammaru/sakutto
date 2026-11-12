/**
 * Where the packaged pdf.js build lives, and how to load it.
 *
 * pdf.js is loaded from a packaged file rather than imported through the bundler because it
 * resolves its worker, its CMaps and its standard fonts relative to its own URL. An import
 * through the bundler would move the module into `chunks/` and every one of those lookups
 * would then point at a directory that does not exist.
 */
export const PDFJS_ASSET_DIRECTORY = 'vendor/pdfjs';

export interface PdfjsAssetUrls {
  /** The library module, imported dynamically. */
  library: string;
  /** The worker module, handed to pdf.js through `GlobalWorkerOptions`. */
  worker: string;
  /** Base URL for the CMaps, with a trailing slash. */
  cmaps: string;
  /** Base URL for the standard font substitutes, with a trailing slash. */
  standardFonts: string;
}

export function resolvePdfjsAssetUrls(extensionUrl: (path: string) => string): PdfjsAssetUrls {
  const base = extensionUrl(PDFJS_ASSET_DIRECTORY);
  return {
    library: `${base}/build/pdf.min.mjs`,
    worker: `${base}/build/pdf.worker.min.mjs`,
    cmaps: `${base}/cmaps/`,
    standardFonts: `${base}/standard_fonts/`,
  };
}

/** The subset of the pdf.js module this extension uses. */
export interface PdfjsModule {
  getDocument: (source: { data: Uint8Array } & Record<string, unknown>) => {
    promise: Promise<import('pdfjs-dist').PDFDocumentProxy>;
  };
  GlobalWorkerOptions: { workerSrc: string };
  /** The operator codes, used to find a page's drawing areas. */
  OPS: Record<string, number>;
}

let loading: Promise<PdfjsModule> | null = null;

/**
 * Loads pdf.js once per document.
 *
 * `import()` of a URL is the only way to keep the module's own location: a static import is
 * rewritten by the bundler and the file then lives somewhere the relative asset paths do not
 * describe. The URL is built from `chrome.runtime.getURL`, so it can only ever point inside
 * the extension package.
 */
export function loadPdfjs(assets: PdfjsAssetUrls): Promise<PdfjsModule> {
  if (!loading) {
    loading = (import(/* @vite-ignore */ assets.library) as Promise<PdfjsModule>).then((module) => {
      module.GlobalWorkerOptions.workerSrc = assets.worker;
      return module;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
