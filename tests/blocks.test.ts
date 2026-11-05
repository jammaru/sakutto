// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { countTranslatableBlocks, isTranslationExcluded } from '@/dom/blocks';

describe('translatable blocks', () => {
  it('counts leaf blocks once and skips excluded content', () => {
    document.body.innerHTML = `
      <p>Hello world</p>
      <p>12345</p>
      <p translate="no">Do not translate</p>
      <pre><code>const answer = 42;</code></pre>
      <ul>
        <li><p>Item text</p></li>
      </ul>
    `;

    expect(countTranslatableBlocks(document)).toBe(2);
    expect(isTranslationExcluded(document.querySelector('pre')!)).toBe(true);
    expect(isTranslationExcluded(document.querySelector('p')!)).toBe(false);
  });

  it('counts body text inside wrapper elements without double counting', () => {
    document.body.innerHTML = `
      <article>Release notes for <em>today</em>.</article>
      <div><div>Nested paragraph text</div></div>
      <section><h2>Heading</h2><p>Body copy</p></section>
    `;

    expect(countTranslatableBlocks(document)).toBe(4);
  });

  it('ignores blocks whose only text is excluded', () => {
    document.body.innerHTML = `
      <div><pre>const answer = 42;</pre></div>
      <div><code>npm install</code></div>
      <div>Readable text</div>
    `;

    expect(countTranslatableBlocks(document)).toBe(1);
  });

  it('skips hidden, URL-only and symbol-only blocks', () => {
    document.body.innerHTML = `
      <p aria-hidden="true">Skip this label</p>
      <p>https://example.com/path</p>
      <p>+++ ###</p>
      <div>Visible <span aria-hidden="true">secret</span> text</div>
    `;

    expect(countTranslatableBlocks(document)).toBe(1);
    expect(isTranslationExcluded(document.querySelector('[aria-hidden="true"]')!)).toBe(true);
  });

  it('treats inline-only wrappers as a single block', () => {
    document.body.innerHTML = `
      <div><span>Only <strong>inline</strong> content</span></div>
      <main><div><p>Leaf paragraph</p></div></main>
    `;

    expect(countTranslatableBlocks(document)).toBe(2);
  });
});
