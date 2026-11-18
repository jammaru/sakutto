import { describe, expect, it } from 'vitest';
import type { IndexHtmlTransformContext } from 'vite';
import {
  entryStylesheetOrder,
  reproducibleEntryStylesheets,
  type StylesheetBundle,
  type StylesheetBundleChunk,
} from '../scripts/reproducible-entry-stylesheets.ts';

/**
 * The shape of the intermittent CI failure this guards against: options.html imports the mount,
 * FolderPermissionRestore and folder-input chunks, and folder-input also imports the restore
 * chunk. When Vite's shared per-chunk CSS cache was filled by another entry first
 * (onboarding.html), options.html listed folder-input.css before restore.css; when options ran
 * first, it listed restore.css first. Both orders referenced the same bytes otherwise.
 */
const bundle: StylesheetBundle = {
  'chunks/options.js': {
    type: 'chunk',
    fileName: 'chunks/options.js',
    imports: ['chunks/mount.js', 'chunks/restore.js', 'chunks/folder-input.js'],
    viteMetadata: { importedCss: ['assets/options.css'] },
  },
  'chunks/mount.js': {
    type: 'chunk',
    fileName: 'chunks/mount.js',
    viteMetadata: { importedCss: ['assets/mount.css'] },
  },
  'chunks/restore.js': {
    type: 'chunk',
    fileName: 'chunks/restore.js',
    viteMetadata: { importedCss: ['assets/restore.css'] },
  },
  'chunks/folder-input.js': {
    type: 'chunk',
    fileName: 'chunks/folder-input.js',
    imports: ['chunks/restore.js'],
    viteMetadata: { importedCss: ['assets/folder-input.css'] },
  },
};

const entry = bundle['chunks/options.js'];
if (!entry) throw new Error('fixture entry chunk missing');

function entryHtml(hrefOrder: readonly string[]): string {
  const head = [
    '  <head>',
    '    <title>Sakutto</title>',
    '    <link rel="modulepreload" crossorigin href="/chunks/mount.js">',
  ];
  for (const href of hrefOrder) {
    head.push(`    <link rel="stylesheet" crossorigin href="${href}">`);
  }
  return ['<!DOCTYPE html>', '<html lang="en">', ...head, '  </head>', '</html>', ''].join('\n');
}

function indexHtmlHandler(): (html: string, ctx: IndexHtmlTransformContext) => string | undefined {
  const plugin = reproducibleEntryStylesheets();
  const hook = plugin.transformIndexHtml;
  if (hook === undefined || typeof hook === 'function') {
    throw new Error('transformIndexHtml must be an object-form hook');
  }
  const handler = hook.handler as unknown as (
    html: string,
    ctx: IndexHtmlTransformContext,
  ) => string | undefined;
  return (html, ctx) => handler(html, ctx);
}

/** The transform context `vite:build-html` hands to its post hooks. */
function transformContext(chunk: unknown, bundle: unknown): IndexHtmlTransformContext {
  const context: IndexHtmlTransformContext = {
    path: '/options.html',
    filename: 'src/entrypoints/options/index.html',
  };
  if (chunk !== undefined) {
    context.chunk = chunk as NonNullable<IndexHtmlTransformContext['chunk']>;
  }
  if (bundle !== undefined) {
    context.bundle = bundle as NonNullable<IndexHtmlTransformContext['bundle']>;
  }
  return context;
}

describe('entry stylesheet order', () => {
  it('walks the entry imports depth-first and appends the entry CSS last', () => {
    expect(entryStylesheetOrder(entry, bundle)).toEqual([
      'assets/mount.css',
      'assets/restore.css',
      'assets/folder-input.css',
      'assets/options.css',
    ]);
  });

  it('lists a stylesheet shared through two import paths once', () => {
    // restore.css is reachable both directly and through folder-input; the direct import
    // decides its position, and the second visit contributes nothing.
    const order = entryStylesheetOrder(entry, bundle);
    expect(order.filter((file) => file === 'assets/restore.css')).toHaveLength(1);
  });
});

describe('reproducible entry stylesheets plugin', () => {
  const handler = indexHtmlHandler();

  it('rewrites stylesheet tags that another entry traversal reordered', () => {
    // onboarding.html ran first and left folder-input.css before restore.css in options.html.
    const poisoned = entryHtml([
      '/assets/mount.css',
      '/assets/folder-input.css',
      '/assets/restore.css',
      '/assets/options.css',
    ]);
    const expected = entryHtml([
      '/assets/mount.css',
      '/assets/restore.css',
      '/assets/folder-input.css',
      '/assets/options.css',
    ]);
    expect(handler(poisoned, transformContext(entry, bundle))).toBe(expected);
  });

  it('leaves an entry whose tags already match the bundle byte-identical', () => {
    const ordered = entryHtml([
      '/assets/mount.css',
      '/assets/restore.css',
      '/assets/folder-input.css',
      '/assets/options.css',
    ]);
    expect(handler(ordered, transformContext(entry, bundle))).toBe(ordered);
  });

  it('touches only stylesheet tags, never modulepreload links', () => {
    const poisoned = entryHtml([
      '/assets/mount.css',
      '/assets/folder-input.css',
      '/assets/restore.css',
      '/assets/options.css',
    ]);
    const rewritten = handler(poisoned, transformContext(entry, bundle));
    expect(rewritten).toContain('<link rel="modulepreload" crossorigin href="/chunks/mount.js">');
    expect(rewritten?.indexOf('modulepreload')).toBeLessThan(
      rewritten?.indexOf('stylesheet') ?? -1,
    );
  });

  it('leaves an entry untouched when a stylesheet link is not in the chunk graph', () => {
    const handwritten = entryHtml(['/assets/mount.css']).replace(
      '  </head>',
      '    <link rel="stylesheet" crossorigin href="/theme.css">\n  </head>',
    );
    expect(handler(handwritten, transformContext(entry, bundle))).toBeUndefined();
  });

  it('leaves an entry without stylesheet chunks alone', () => {
    const plain = entryHtml([]);
    const bare: StylesheetBundleChunk = { type: 'chunk', fileName: 'chunks/plain.js' };
    expect(handler(plain, transformContext(bare, {}))).toBeUndefined();
  });
});
