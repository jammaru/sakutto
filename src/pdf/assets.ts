/**
 * Where the packaged pdf.js build lives, and how to load it.
 *
 * pdf.js is loaded from a packaged file rather than imported through the bundler because it
 * resolves its worker, its CMaps and its standard fonts relative to its own URL. An import
 * through the bundler would move the module into `chunks/` and every one of those lookups
 * would then point at a directory that does not exist. The packaged files are the *legacy*
 * build, which keeps the reader on the manifest's Chrome 116 floor. pdf.js 6 also uses a few
 * APIs newer than that floor, so `sync-pdfjs.mjs` puts small shims in front of the library
 * and worker entry points; the upstream files stay byte-for-byte as npm shipped them.
 */
export const PDFJS_ASSET_DIRECTORY = 'vendor/pdfjs';

export interface PdfjsAssetUrls {
  /** The compatibility entry point for the library, imported dynamically. */
  library: string;
  /** Worker compatibility entry point, handed to pdf.js through `GlobalWorkerOptions`. */
  worker: string;
  /** Base URL for the CMaps, with a trailing slash. */
  cmaps: string;
  /** Base URL for the standard font substitutes, with a trailing slash. */
  standardFonts: string;
  /** Base URL for the JPEG 2000 / JBIG2 / ICC wasm decoders, with a trailing slash. */
  wasm: string;
  /** Base URL for the CMYK ICC profile, with a trailing slash. */
  iccs: string;
}

export function resolvePdfjsAssetUrls(extensionUrl: (path: string) => string): PdfjsAssetUrls {
  const base = extensionUrl(PDFJS_ASSET_DIRECTORY);
  return {
    library: `${base}/build/pdf.entry.mjs`,
    worker: `${base}/build/pdf.worker.entry.mjs`,
    cmaps: `${base}/cmaps/`,
    standardFonts: `${base}/standard_fonts/`,
    wasm: `${base}/wasm/`,
    iccs: `${base}/iccs/`,
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
