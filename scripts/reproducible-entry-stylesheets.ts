import type { Plugin } from 'vite';

/**
 * Vite's `vite:build-html` plugin decides the order of the `<link rel="stylesheet">` tags it
 * injects by walking each HTML entry's chunk imports. In a multi-page build it shares one
 * per-chunk CSS cache (`analyzedImportedCssFiles`) across every entry, and that cache is
 * filled from whichever entry its (parallel) module transforms finish first: the cached list
 * for a chunk keeps only the stylesheets that entry had not collected yet, so an entry reached
 * later inherits stylesheet positions carved out by the first entry's import graph. Which
 * entry runs first depends on transform scheduling, not on the bundle, so two zips of one
 * commit could list the same stylesheets in a different order — options.html once flipped its
 * folder-input and FolderPermissionRestore links purely because onboarding.html happened to be
 * processed first, and the CI reproducibility check caught it.
 *
 * This plugin rewrites the injected tags to the order the bundle itself defines: entry imports
 * walked depth-first, a chunk's own CSS appended after its imports' CSS. That is exactly the
 * order `vite:build-html` computes for an entry it reaches with a cold cache, so the rewrite
 * is byte-for-byte when Vite already emits it, and every HTML entry stops depending on which
 * entry the scheduler happened to finish first.
 */

/** The slice of a rollup output chunk the stylesheet order is derived from. */
export interface StylesheetBundleChunk {
  type: 'chunk' | 'asset';
  fileName: string;
  imports?: readonly string[];
  viteMetadata?: { importedCss?: Iterable<string> };
}

export type StylesheetBundle = Record<string, StylesheetBundleChunk | undefined>;

/**
 * Returns an HTML entry's stylesheet files in bundle order — dependencies depth-first, a
 * chunk's own CSS after the CSS collected through its imports, each file once. This mirrors
 * what `vite:build-html` computes for the first entry it processes.
 */
export function entryStylesheetOrder(
  entry: StylesheetBundleChunk,
  bundle: StylesheetBundle,
): string[] {
  const files: string[] = [];
  const seenChunks = new Set<string>();
  const seenCss = new Set<string>();
  const visit = (chunk: StylesheetBundleChunk): void => {
    if (seenChunks.has(chunk.fileName)) return;
    seenChunks.add(chunk.fileName);
    for (const imported of chunk.imports ?? []) {
      const importee = bundle[imported];
      if (importee?.type === 'chunk') visit(importee);
    }
    for (const file of chunk.viteMetadata?.importedCss ?? []) {
      if (!seenCss.has(file)) {
        seenCss.add(file);
        files.push(file);
      }
    }
  };
  visit(entry);
  return files;
}

const STYLESHEET_LINK = '<link\\b[^>]*\\brel="stylesheet"[^>]*>';
const LINK_HREF = /\bhref="([^"]*)"/;

/**
 * A Vite build plugin that rewrites the stylesheet tags `vite:build-html` injected into each
 * HTML entry into the order the bundle defines. Applies to every HTML entrypoint, so one
 * entry's cached traversal can never reshape another entry's output.
 */
export function reproducibleEntryStylesheets(): Plugin {
  return {
    name: 'sakutto:reproducible-entry-stylesheets',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html: string, ctx: { chunk?: unknown; bundle?: unknown }): string | undefined => {
        const entry = ctx.chunk as StylesheetBundleChunk | undefined;
        const bundle = ctx.bundle as StylesheetBundle | undefined;
        if (!entry || entry.type !== 'chunk' || !bundle) return undefined;
        const files = entryStylesheetOrder(entry, bundle);
        if (files.length === 0) return undefined;
        const links = [...html.matchAll(new RegExp(STYLESHEET_LINK, 'g'))].map((link) => link[0]);
        if (links.length === 0) return undefined;
        const tagsByHref = new Map<string, string>();
        for (const tag of links) {
          const href = LINK_HREF.exec(tag)?.[1];
          if (href === undefined) return undefined;
          tagsByHref.set(href, tag);
        }
        const ordered: string[] = [];
        const usedHrefs = new Set<string>();
        for (const file of files) {
          const href = [...tagsByHref.keys()].find(
            (candidate) =>
              !usedHrefs.has(candidate) && (candidate === file || candidate.endsWith(`/${file}`)),
          );
          if (href === undefined) return undefined;
          const tag = tagsByHref.get(href);
          if (tag === undefined) return undefined;
          usedHrefs.add(href);
          ordered.push(tag);
        }
        // A stylesheet link the chunk graph does not explain (hand-written in the entry HTML)
        // makes the rewrite ambiguous, so the file stays as Vite emitted it.
        if (ordered.length !== links.length) return undefined;
        let index = 0;
        return html.replace(new RegExp(STYLESHEET_LINK, 'g'), () => {
          const tag = ordered[index];
          index += 1;
          return tag ?? '';
        });
      },
    },
  };
}
