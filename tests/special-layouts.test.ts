// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isAriaHiddenLeaf, isTranslationExcluded, listTranslatableBlocks } from '@/dom/blocks';
import { buildSegment } from '@/dom/segment';
import { languageOf } from '@/dom/detect';

/**
 * Durable fixtures for the two layouts reported after page translation: a legal / licensing
 * page and a model-hub model card. Both are checked in under `e2e/fixtures/` and rendered here
 * with happy-dom, so these assertions are about the collector's decisions on a fixed document
 * rather than about a live page that can change under the test.
 *
 * The reported counts were 68 and 147 blocks "could not be translated". Those numbers are
 * exactly the block counts the collector found, so the collector was admitting blocks it then
 * refused to build a segment for. The checks below assert the opposite for prose: every
 * element a reader sees as copy produces a segment.
 */

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'e2e/fixtures', name), 'utf8');
}

function parse(html: string): void {
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    html,
    'text/html',
  ).documentElement.innerHTML;
}

function segments(): Map<string, string> {
  const found = new Map<string, string>();
  for (const block of listTranslatableBlocks(document)) {
    const model = buildSegment(block);
    if (model) found.set(block.id, model.source);
  }
  return found;
}

function isCovered(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) throw new Error(`missing #${id}`);
  for (const block of listTranslatableBlocks(document)) {
    if (block === target || block.contains(target)) return true;
  }
  return false;
}

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('legal license page coverage', () => {
  beforeEach(() => {
    parse(fixture('legal-license.html'));
  });

  it('translates the title, lead and every article body', () => {
    const found = segments();
    expect(found.get('legal-title')).toBe('PLaMo Community License Agreement');
    expect(found.get('legal-lead')).toContain('This agreement outlines the terms');

    for (const id of [
      'def-agreement',
      'def-model',
      'def-commercial',
      'article-2-body',
      'article-3-1',
      'article-3-2',
      'article-3-3-a',
      'article-3-3-b',
      'article-7-body',
    ]) {
      expect(isCovered(id), `#${id} should be translated`).toBe(true);
    }
  });

  it('keeps the article number and its body together', () => {
    // `Article 1 (Definitions)` is a list item that owns a nested ordered list. Splitting it
    // would translate a bare heading and leave the definitions behind under it.
    const found = segments();
    expect(found.get('article-1')).toBe('Article 1 (Definitions)');
    expect(found.get('article-3')).toBe('Article 3 (This License)');
    expect(found.get('article-7')).toBe('Article 7 (Warranty Disclaimer)');
  });

  it('translates the footer links and the copyright line', () => {
    for (const id of ['legal-privacy', 'legal-terms', 'legal-contact', 'legal-copyright']) {
      expect(isCovered(id), `#${id} should be translated`).toBe(true);
    }
  });

  /**
   * The real page is served as `<html lang="ja">` with an English body. Reading that tag as
   * the source language told the model to translate English out of Japanese. A block with no
   * character from the declared language's script claims no source language instead.
   */
  it('does not report Japanese as the source of an English article body', () => {
    const body = document.getElementById('def-model');
    const title = document.getElementById('legal-title');
    if (!body || !title) throw new Error('missing elements');
    expect(languageOf(title, 'ja')).toBeNull();
    expect(languageOf(body, 'ja')).toBeNull();
  });

  it('still reports Japanese for a real Japanese paragraph on the same tag', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<p id="jp">この文書は日本語で書かれています。</p>',
    );
    const jp = document.getElementById('jp');
    if (!jp) throw new Error('missing jp');
    expect(languageOf(jp, 'ja')).toBe('ja');
  });
});

describe('model-hub card coverage', () => {
  beforeEach(() => {
    parse(fixture('model-hub.html'));
  });

  it('translates the title and the lead paragraph', () => {
    const found = segments();
    expect(found.get('model-title')).toBe('diffusion-example-27b');
    expect(found.get('readme-lead')).toContain('An experimental masked diffusion checkpoint');
  });

  /**
   * README headings wrap their text in `<a>` and `<span>`. Each heading has two child elements
   * and three or more headings repeat down the card, which is the shape the data-row rule read
   * as a record row; the headings were then dropped and the page reported leftovers.
   */
  it('translates every README heading', () => {
    for (const id of ['h2-how', 'h2-usage', 'h2-files', 'h2-limitations']) {
      expect(isCovered(id), `#${id} should be translated`).toBe(true);
    }
  });

  it('translates prose paragraphs that carry inline code', () => {
    const found = segments();
    expect(found.get('readme-how')).toContain('is converted into a masked diffusion');
    expect(found.get('readme-usage')).toContain('Load the weights with');
    expect(found.get('readme-env')).toContain('to disable the fast path');
    expect(found.get('readme-limitations')).toContain('Evaluation covered paragraph-level');
  });

  /**
   * Inline code must keep its place. Dropping it from the segment split the sentence and the
   * identifier ended up after the translated line, so the paragraph read
   * `forward + reverse scan, , with a per-channel` with `rev_gate` dangling at the end.
   */
  it('keeps inline code inside the sentence where the page put it', () => {
    const found = segments();
    const bullet = found.get('bullet-gate') ?? '';
    expect(bullet).toMatch(/reverse scan.*<i\d+>rev_gate<\/i\d+>.*initialised to zero/u);
    const usage = found.get('readme-usage') ?? '';
    expect(usage).toMatch(/Load the weights with <i\d+>load_pretrained\(path\)<\/i\d+>/u);
  });

  it('translates each README bullet', () => {
    for (const id of ['bullet-attention', 'bullet-gate', 'bullet-mask', 'bullet-loss']) {
      expect(isCovered(id), `#${id} should be translated`).toBe(true);
    }
  });

  it('translates the sidebar headings and their metadata pairs', () => {
    for (const id of [
      'sidebar-tree',
      'sidebar-spaces',
      'sidebar-collection',
      'dt-downloads',
      'dt-size',
      'dt-license',
    ]) {
      expect(isCovered(id), `#${id} should be translated`).toBe(true);
    }
  });

  it('keeps the app shell, tabs and navigation translatable', () => {
    for (const id of ['hub-name', 'tab-card', 'tab-files', 'tab-community']) {
      expect(isCovered(id), `#${id} should be translated`).toBe(true);
    }
  });

  it('leaves code and screen-reader text alone', () => {
    expect(segments().has('sr-only-hint')).toBe(false);
    const codeText = [...document.querySelectorAll('code')].map((node) => node.textContent);
    expect(codeText).toContain('load_pretrained(path)');
    for (const code of document.querySelectorAll('code')) {
      expect(isTranslationExcluded(code)).toBe(true);
    }
  });

  it('leaves an aria-hidden icon glyph out of the translation', () => {
    const icon = document.querySelector('header [aria-hidden="true"]');
    expect(icon).not.toBeNull();
    // A decorative glyph is an aria-hidden *leaf*: no block inside it, so the walk drops it.
    expect(isAriaHiddenLeaf(icon as Element)).toBe(true);
    expect([...segments().values()].some((source) => source.includes('◆'))).toBe(false);
  });
});
