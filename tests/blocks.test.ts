// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  countTranslatableBlocks,
  isTranslationExcluded,
  isTypedTextSelection,
  listTranslatableBlocks,
} from '@/dom/blocks';

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
    // A code fence keeps its `<code>` wrapper; a bare `<pre>` can hold forum prose and is
    // translatable now, so the code sample is wrapped to stay excluded here.
    document.body.innerHTML = `
      <div><pre><code>const answer = 42;</code></pre></div>
      <div><code>npm install</code></div>
      <div>Readable text</div>
    `;

    expect(countTranslatableBlocks(document)).toBe(1);
  });

  it('counts prose in a bare pre but still skips a code fence', () => {
    document.body.innerHTML = `
      <div class="text prose"><pre>짧은 연습 문장입니다.</pre></div>
      <div class="text code"><pre><code>const answer = 42;</code></pre></div>
    `;

    const prose = document.querySelector('.prose pre')!;
    const fence = document.querySelector('.code pre')!;
    expect(isTranslationExcluded(prose)).toBe(false);
    expect(isTranslationExcluded(fence)).toBe(true);
    expect(listTranslatableBlocks(document).map((block) => block.textContent?.trim())).toEqual([
      '짧은 연습 문장입니다.',
    ]);
  });

  it('skips hidden, URL-only and symbol-only blocks', () => {
    document.body.innerHTML = `
      <p aria-hidden="true">Skip this label</p>
      <p>https://example.com/path</p>
      <p>+++ ###</p>
      <div>Visible <span aria-hidden="true">secret</span> text</div>
    `;

    expect(countTranslatableBlocks(document)).toBe(1);
  });

  it('treats inline-only wrappers as a single block', () => {
    document.body.innerHTML = `
      <div><span>Only <strong>inline</strong> content</span></div>
      <main><div><p>Leaf paragraph</p></div></main>
    `;

    expect(countTranslatableBlocks(document)).toBe(2);
  });
});

describe('page coverage on app shells', () => {
  function blocks(): string[] {
    return listTranslatableBlocks(document).map((block) =>
      (block.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
  }

  it('skips a collapsed menu and keeps the same text when the panel opens', () => {
    document.body.innerHTML = `
      <div id="closed" style="display: none"><p>Hidden panel copy</p></div>
      <p>Visible copy</p>
    `;
    expect(blocks()).toEqual(['Visible copy']);
    const panel = document.querySelector<HTMLElement>('#closed');
    if (!panel) throw new Error('missing panel');
    panel.style.display = 'block';
    expect(blocks()).toEqual(['Hidden panel copy', 'Visible copy']);
  });

  it('skips screen-reader-only clones of visible copy', () => {
    document.body.innerHTML = `
      <div><span class="sr-only">Shortcut hint for screen readers</span></div>
      <p>Visible copy</p>
    `;
    expect(blocks()).toEqual(['Visible copy']);
  });

  it('keeps screen-reader text that a utility class re-enables', () => {
    document.body.innerHTML = `
      <div><span class="sr-only not-sr-only">Now visible label</span></div>
      <p>Visible copy</p>
    `;
    expect(blocks()).toContain('Now visible label');
  });

  it('keeps a container that holds both decorative and readable content', () => {
    document.body.innerHTML = `
      <div>
        <span aria-hidden="true">★</span>
        <p>Readable paragraph</p>
      </div>
    `;
    expect(blocks()).toEqual(['Readable paragraph']);
  });
});

describe('aria-hidden shells', () => {
  it('translates prose behind an aria-hidden wrapper instead of dropping the page', () => {
    // Frameworks mark an app shell aria-hidden while a dialog or portal is open. Treating
    // that as a skip list made the whole page look translated while it stayed English.
    document.body.innerHTML = `
      <div aria-hidden="true"><main><p>English body copy here</p></main></div>
    `;
    expect(countTranslatableBlocks(document)).toBe(1);
  });

  it('still skips a decorative aria-hidden glyph beside real copy', () => {
    document.body.innerHTML = `
      <div>
        <span aria-hidden="true">★</span>
        <p>Readable paragraph</p>
      </div>
    `;
    const blocks = listTranslatableBlocks(document).map((block) => block.tagName);
    expect(blocks).toEqual(['P']);
  });
});

describe('visibility edge cases', () => {
  it('keeps prose inside a content-visibility: auto section', () => {
    document.body.innerHTML = `
      <section style="content-visibility: auto"><p>Long article body</p></section>
    `;
    expect(countTranslatableBlocks(document)).toBe(1);
  });

  it('keeps a visible tab panel and skips the collapsed one', () => {
    document.body.innerHTML = `
      <div id="open"><p>Read me tab</p></div>
      <div id="closed" style="display: none"><p>Hidden tab copy</p></div>
    `;
    const blocks = listTranslatableBlocks(document).map((block) => block.textContent?.trim());
    expect(blocks).toEqual(['Read me tab']);
  });

  it('skips a closed details body but keeps its summary', () => {
    document.body.innerHTML = `
      <details><summary>More options</summary><p>Collapsed detail copy</p></details>
    `;
    const blocks = listTranslatableBlocks(document).map((block) => block.textContent?.trim());
    expect(blocks).toContain('More options');
    expect(blocks).not.toContain('Collapsed detail copy');
  });
});

describe('layout wrappers that generate no box', () => {
  /**
   * happy-dom reports `true` for a `display: contents` element, but Chromium reports
   * `false`: the element generates no box, so it has no layout to be visible in, while
   * everything inside it paints normally. The tests below run against the browser's rule
   * so the regression is caught in this environment, where the real one cannot be.
   */
  function emulateChromiumCheckVisibility(): () => void {
    const proto = Element.prototype as unknown as {
      checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
    };
    const original = proto.checkVisibility;
    proto.checkVisibility = function (this: Element): boolean {
      const style = getComputedStyle(this);
      if (style.display === 'contents') return false;
      return original ? original.call(this, { visibilityProperty: true }) : true;
    };
    return () => {
      if (original) proto.checkVisibility = original;
      else delete proto.checkVisibility;
    };
  }

  it('translates prose inside a display: contents app shell', () => {
    // Frameworks put the whole shell in a `contents` div. Reading the missing box as
    // "hidden" dropped Hugging Face's header, model card and sidebar while the bar still
    // said the page was translated.
    document.body.innerHTML = `
      <div class="hydrated contents" style="display: contents">
        <header><nav><ul><li><a href="/docs">Docs</a></li></ul></nav></header>
        <main><p>Model card body copy</p></main>
      </div>
      <p>Copy outside any wrapper</p>
    `;
    const restore = emulateChromiumCheckVisibility();
    try {
      const blocks = listTranslatableBlocks(document).map((block) => block.textContent?.trim());
      expect(blocks).toContain('Model card body copy');
      expect(blocks).toContain('Docs');
      expect(blocks).toContain('Copy outside any wrapper');
    } finally {
      restore();
    }
  });

  it('still skips a display: contents wrapper the page hides', () => {
    document.body.innerHTML = `
      <div style="display: contents; visibility: hidden"><p>Panel behind a closed menu</p></div>
      <p>Visible copy</p>
    `;
    const restore = emulateChromiumCheckVisibility();
    try {
      const blocks = listTranslatableBlocks(document).map((block) => block.textContent?.trim());
      expect(blocks).toEqual(['Visible copy']);
    } finally {
      restore();
    }
  });

  it('still skips contents inside a display: none ancestor', () => {
    document.body.innerHTML = `
      <div style="display: none"><div style="display: contents"><p>Modal copy</p></div></div>
      <p>Visible copy</p>
    `;
    const blocks = listTranslatableBlocks(document).map((block) => block.textContent?.trim());
    expect(blocks).toEqual(['Visible copy']);
  });

  /**
   * A focused field reports its value through `window.getSelection()` on Ctrl+A, while the
   * range sits on `<body>`. The block walk never sees that value, so the selection path has
   * to drop it, or the text a reader typed is queued for translation.
   */
  describe('typed text in a focused field', () => {
    it('is recognised from the field value', () => {
      document.body.innerHTML = '<textarea id="message">Draft to a friend</textarea>';
      const field = document.querySelector('#message');
      expect(isTypedTextSelection(field, 'Draft to a friend')).toBe(true);
      expect(isTypedTextSelection(field, 'Draft')).toBe(true);
    });

    it('recognises a masked password value', () => {
      document.body.innerHTML = '<input id="pw" type="password" value="hunter2">';
      const field = document.querySelector('#pw');
      expect(isTypedTextSelection(field, '•••••••')).toBe(true);
    });

    it('does not read a run of asterisks in body copy as a masked value', () => {
      // The field has its own text, so the empty-field guard does not answer for it. The
      // mask rule is what decided this before, and it dropped the prose selection.
      document.body.innerHTML = '<input id="search" value="quarterly report"><p>***</p>';
      const field = document.querySelector('#search');
      expect(isTypedTextSelection(field, '***')).toBe(false);
      expect(isTypedTextSelection(field, 'quarterly report')).toBe(true);
    });

    it('recognises a masked value whatever case the type attribute uses', () => {
      document.body.innerHTML = '<input id="pw" type="PASSWORD" value="hunter2">';
      const field = document.querySelector('#pw');
      expect(isTypedTextSelection(field, '•••••••')).toBe(true);
    });

    it('follows an open shadow root to the control holding the caret', () => {
      document.body.innerHTML = '<my-search></my-search>';
      const host = document.querySelector('my-search');
      if (!host) throw new Error('missing host');
      const input = document.createElement('input');
      input.value = 'typed in a custom element';
      host.attachShadow({ mode: 'open' }).append(input);
      input.focus();

      // `document.activeElement` stops at the host, so the host alone is not enough.
      expect(document.activeElement).toBe(host);
      expect(isTypedTextSelection(host, 'typed in a custom element')).toBe(true);
    });

    it('still finds the control when the host sits in an editable wrapper', () => {
      // Asking the host's own `closest` first answers with the wrapper, whose text is
      // empty, and the typed value went through.
      document.body.innerHTML = '<div contenteditable><my-input></my-input></div>';
      const host = document.querySelector('my-input');
      if (!host) throw new Error('missing host');
      const input = document.createElement('input');
      input.value = 'hidden from the wrapper';
      host.attachShadow({ mode: 'open' }).append(input);
      input.focus();

      expect(isTypedTextSelection(host, 'hidden from the wrapper')).toBe(true);
    });

    it('climbs back out when the host root holds no field of its own', () => {
      // The focused element inside the root is not a field, so the innermost level answers
      // nothing. The host is still inside an editable wrapper, and `closest` cannot climb
      // out of a shadow tree, so the walk has to step back out to find it.
      document.body.innerHTML = '<div id="wrap" contenteditable>Draft<my-widget></my-widget></div>';
      const host = document.querySelector('my-widget');
      if (!host) throw new Error('missing host');
      const inner = document.createElement('span');
      inner.tabIndex = 0;
      host.attachShadow({ mode: 'open' }).append(inner);
      inner.focus();

      expect(document.activeElement).toBe(host);
      expect(host.shadowRoot?.activeElement).toBe(inner);
      expect(isTypedTextSelection(host, 'Draft')).toBe(true);
    });

    it('leaves page prose alone when an empty field has focus', () => {
      document.body.innerHTML = '<input id="search"><p id="copy">Readable paragraph</p>';
      const field = document.querySelector('#search');
      expect(isTypedTextSelection(field, 'Readable paragraph')).toBe(false);
      expect(isTypedTextSelection(null, 'Readable paragraph')).toBe(false);
    });

    it('covers a contenteditable region', () => {
      document.body.innerHTML = '<div id="editor" contenteditable>Half written reply</div>';
      const field = document.querySelector('#editor');
      expect(isTypedTextSelection(field, 'Half written reply')).toBe(true);
    });
  });
});
