// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nextSelectionScrollOffset,
  PageOverlay,
  selectionBodyCapPx,
  selectionTextExtends,
  SELECTION_BODY_MAX_HEIGHT,
  setPlainTextContent,
  uiShadow,
} from '@/dom/overlay';
import { copyTextToClipboard, copyTextViaDocument } from '@/shared/clipboard-copy';
import { PageSession, type PageEngine, type SessionPreferences } from '@/dom/session';
import type { OverlayLabels } from '@/dom/overlay';

const labels: OverlayLabels = {
  original: '原文',
  chromeNote: 'Chrome の内蔵翻訳',
  machine: 'PLaMo による機械翻訳です。',
  selectionPending: '翻訳しています…',
  selectionFailed: 'この選択範囲を翻訳できませんでした。',
  selectionTitle: '選択したテキスト',
  selectionIcon: '選択したテキストを翻訳します',
  selectionResize: '翻訳ポップアップの幅を変更します',
  selectionCopy: '訳文をコピー',
  selectionCopied: 'コピーしました',
  selectionCopyFailed: 'コピーできませんでした。訳文を選んでコピーしてください。',
  close: '閉じる',
  bilingualOn: 'このサイトの表示を対訳にしました。',
  replaceOn: 'このサイトの表示を置換にしました。',
  barLabel: '翻訳の進み具合',
  barProgress: (done: number, total: number) => '翻訳中 ' + String(done) + ' / ' + String(total),
  barRate: (tokens: string, segments: string) => tokens + ' tok/s · ' + segments + ' 区間/s',
  barDone: '翻訳しました。',
  barPartial: (blocks: number) => '翻訳できない箇所が ' + String(blocks) + ' 件残っています。',
  barOriginal: '原文に戻す',
  barAlways: 'このサイトを常に翻訳します',
  barAlwaysOn: 'このサイトは常に翻訳します。',
};

type MutableDocument = { execCommand?: (command: string) => boolean };
type MutableNavigator = { clipboard?: unknown };

function stubClipboard(mode: 'ok' | 'reject'): { saved: string[] } {
  const saved: string[] = [];
  const target = {
    writeText: async (text: string): Promise<void> => {
      saved.push(text);
      if (mode === 'reject') throw new Error('clipboard write refused');
    },
  };
  Object.defineProperty(navigator, 'clipboard', { value: target, configurable: true });
  return { saved };
}

function stubExecCommand(): { captured: string[] } {
  const captured: string[] = [];
  (document as unknown as MutableDocument).execCommand = (command: string) => {
    const active = document.activeElement;
    captured.push(active instanceof HTMLTextAreaElement ? active.value : String(active));
    return command === 'copy';
  };
  return { captured };
}

function mountOverlay(overrides: Partial<OverlayLabels> = {}): PageOverlay {
  return new PageOverlay(document, { ...labels, ...overrides });
}

function popShadow(): ShadowRoot {
  const host = document.querySelector('sakutto-pop');
  const shadow = uiShadow(host);
  if (!shadow) throw new Error('missing sakutto-pop shadow root');
  return shadow;
}

function copyButton(shadow: ShadowRoot): HTMLButtonElement {
  const button = shadow.querySelector('button.copy');
  if (!(button instanceof HTMLButtonElement)) throw new Error('missing copy button');
  return button;
}

function copyNote(shadow: ShadowRoot): HTMLElement {
  const note = shadow.querySelector('.copy-note');
  if (!(note instanceof HTMLElement)) throw new Error('missing copy feedback note');
  return note;
}

function popBody(shadow: ShadowRoot): HTMLElement {
  const body = shadow.querySelector('.body');
  if (!(body instanceof HTMLElement)) throw new Error('missing pop body');
  return body;
}

async function flush(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

const RECT = new DOMRect(16, 16, 0, 0);

afterEach(() => {
  delete (navigator as unknown as MutableNavigator).clipboard;
  delete (document as unknown as MutableDocument).execCommand;
});

describe('copyTextToClipboard', () => {
  it('copies through the async clipboard API first', async () => {
    const { saved } = stubClipboard('ok');

    const ok = await copyTextToClipboard('一行目\n二行目', navigator.clipboard, document);

    expect(ok).toBe(true);
    expect(saved).toEqual(['一行目\n二行目']);
  });

  it('falls back to a textarea when the clipboard API refuses', async () => {
    const { saved } = stubClipboard('reject');
    const { captured } = stubExecCommand();

    const ok = await copyTextToClipboard('一行目\n二行目', navigator.clipboard, document);

    expect(ok).toBe(true);
    expect(saved).toEqual(['一行目\n二行目']);
    expect(captured).toEqual(['一行目\n二行目']);
    // The textarea is the fallback's own scaffolding, not something the reader keeps.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when no clipboard API is exposed at all', async () => {
    delete (navigator as unknown as MutableNavigator).clipboard;
    const { captured } = stubExecCommand();

    const ok = await copyTextToClipboard('plain result', null, document);

    expect(ok).toBe(true);
    expect(captured).toEqual(['plain result']);
  });

  it('refuses empty text without touching either path', async () => {
    const { saved } = stubClipboard('ok');
    const { captured } = stubExecCommand();

    const ok = await copyTextToClipboard('   ', navigator.clipboard, document);

    expect(ok).toBe(false);
    expect(saved).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('reports failure instead of throwing when both paths refuse', async () => {
    stubClipboard('reject');
    (document as unknown as MutableDocument).execCommand = () => false;

    await expect(copyTextToClipboard('一行目', navigator.clipboard, document)).resolves.toBe(false);
  });
});

describe('copyTextViaDocument', () => {
  it('restores the focused element and keeps the copy gesture local', () => {
    const { captured } = stubExecCommand();
    const anchor = document.createElement('button');
    document.body.append(anchor);
    anchor.focus();

    const ok = copyTextViaDocument(document, '訳文の一行目\n訳文の二行目');

    expect(ok).toBe(true);
    expect(captured).toEqual(['訳文の一行目\n訳文の二行目']);
    expect(document.activeElement).toBe(anchor);
    expect(document.querySelector('textarea')).toBeNull();
    anchor.remove();
  });

  it('does not start a copy when there is nothing to copy', () => {
    let called = false;
    (document as unknown as MutableDocument).execCommand = () => {
      called = true;
      return true;
    };

    expect(copyTextViaDocument(document, '')).toBe(false);
    expect(called).toBe(false);
  });
});

const sessionPreferences: SessionPreferences = {
  targetLanguage: 'ja',
  targetExplicit: true,
  form: 'polite',
  display: 'replace',
  auto: 'ask',
  host: 'example.com',
  context: false,
  tier: 'c8',
  pace: 'quality',
};

describe('selection failure copy control', () => {
  /**
   * An engine that throws a plain error, not an abort. The batch catch block leaves the
   * signal live, so the finally loop settles the selection through showSelectionFailure —
   * the failure paint the revealSelection path was already given the failed flag for.
   */
  const failingEngine: PageEngine = {
    async *translate() {
      throw new Error('engine exploded');
      // Unreachable, but the engine contract is an async generator.
      yield { id: 'unused', final: '' };
    },
  };

  it('keeps the copy control off when the engine failure notice replaces the popup text', async () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p>Hello world</p>';
    const session = new PageSession(document, {
      engine: failingEngine,
      labels,
      preferences: sessionPreferences,
      scheduleFrame: (callback) => callback(),
    });
    try {
      session.translateSelection('Hello world', new DOMRect(12, 12, 80, 18));
      await session.whenIdle();

      const shadow = popShadow();
      // The failure notice took the body, the way a real engine outage paints it.
      expect(popBody(shadow).textContent).toBe(labels.selectionFailed);
      const button = copyButton(shadow);
      expect(button.disabled).toBe(true);

      // A click on the disabled control must not put the failure notice on the clipboard.
      const { saved } = stubClipboard('ok');
      button.click();
      await flush();
      expect(saved).toEqual([]);
      expect(copyNote(shadow).hidden).toBe(true);
    } finally {
      await session.dispose();
      document.body.innerHTML = '';
    }
  });
});

describe('selection popup copy control', () => {
  it('stays disabled while the translation is pending', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '', null, true, 'ja');
      const shadow = popShadow();
      expect(copyButton(shadow).disabled).toBe(true);
      expect(popBody(shadow).textContent).toBe(labels.selectionPending);
    } finally {
      overlay.destroy();
    }
  });

  it('copies exactly the popup text once it exists, line breaks included', async () => {
    const overlay = mountOverlay();
    try {
      const text = '一行目の訳文です。\n二行目の訳文です。';
      overlay.showSelection(RECT, text, 'plamo', false, 'ja');
      const shadow = popShadow();
      const button = copyButton(shadow);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-label')).toBe(labels.selectionCopy);
      expect(popBody(shadow).textContent).toBe(text);
      setPlainTextContent(popBody(shadow), text);

      const { saved } = stubClipboard('ok');
      button.click();
      await flush();

      expect(saved).toEqual([text]);
      expect(copyNote(shadow).hidden).toBe(false);
      expect(copyNote(shadow).textContent).toBe(labels.selectionCopied);
      expect(button.getAttribute('aria-label')).toBe(labels.selectionCopied);
      expect(button.dataset.state).toBe('copied');
    } finally {
      overlay.destroy();
    }
  });

  it('clears the brief feedback after a moment', async () => {
    vi.useFakeTimers();
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '訳文', 'plamo', false, 'ja');
      const shadow = popShadow();
      const button = copyButton(shadow);
      stubClipboard('ok');

      button.click();
      await flush();
      expect(copyNote(shadow).hidden).toBe(false);

      vi.advanceTimersByTime(2600);
      expect(copyNote(shadow).hidden).toBe(true);
      expect(copyNote(shadow).textContent).toBe('');
      expect(button.getAttribute('aria-label')).toBe(labels.selectionCopy);
      expect(button.dataset.state).toBeUndefined();
    } finally {
      overlay.destroy();
      vi.useRealTimers();
    }
  });

  it('shows the failure message when both copy paths refuse', async () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '訳文', 'plamo', false, 'ja');
      const shadow = popShadow();
      const button = copyButton(shadow);
      stubClipboard('reject');

      button.click();
      await flush();

      expect(copyNote(shadow).hidden).toBe(false);
      expect(copyNote(shadow).textContent).toBe(labels.selectionCopyFailed);
      expect(button.getAttribute('aria-label')).toBe(labels.selectionCopyFailed);
      expect(button.dataset.state).toBeUndefined();
    } finally {
      overlay.destroy();
    }
  });

  it('lets the reader copy the finished part while the translation streams', async () => {
    const overlay = mountOverlay();
    try {
      const shadow = popShadow();
      overlay.showSelection(RECT, '', null, true, 'ja');
      expect(copyButton(shadow).disabled).toBe(true);

      const partial = '書きかけの訳文';
      overlay.showSelection(RECT, partial, 'plamo', false, 'ja');
      const button = copyButton(shadow);
      expect(button.disabled).toBe(false);

      const { saved } = stubClipboard('ok');
      button.click();
      await flush();
      expect(saved).toEqual([partial]);
    } finally {
      overlay.destroy();
    }
  });

  it('keeps the control off for the failure notice', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, labels.selectionFailed, null, false, 'ja', true);
      const shadow = popShadow();
      expect(popBody(shadow).textContent).toBe(labels.selectionFailed);
      expect(copyButton(shadow).disabled).toBe(true);
    } finally {
      overlay.destroy();
    }
  });

  it('disables the control again once the popup is hidden', async () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '訳文', 'plamo', false, 'ja');
      const shadow = popShadow();
      const button = copyButton(shadow);
      stubClipboard('ok');
      button.click();
      await flush();
      expect(copyNote(shadow).hidden).toBe(false);

      overlay.hideSelection();
      expect(button.disabled).toBe(true);
      expect(copyNote(shadow).hidden).toBe(true);
    } finally {
      overlay.destroy();
    }
  });

  it('refreshes the accessible label when the labels change', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '訳文', 'plamo', false, 'ja');
      const shadow = popShadow();
      expect(copyButton(shadow).getAttribute('aria-label')).toBe(labels.selectionCopy);

      overlay.setLabels({
        ...labels,
        selectionCopy: 'Copy the translation',
        selectionCopied: 'Copied',
        selectionCopyFailed: 'Could not copy the translation.',
      });
      expect(copyButton(shadow).getAttribute('aria-label')).toBe('Copy the translation');
      expect(copyButton(shadow).title).toBe('Copy the translation');
    } finally {
      overlay.destroy();
    }
  });
});

describe('selection popup control pair', () => {
  /*
   * happy-dom lays nothing out — every rect is 0×0, which is why the page-flow helper
   * lays pages out by hand — and its em-based computed values come back as NaN. So this
   * file pins the style contract that makes the pair match, and the e2e spec measures
   * the real getBoundingClientRect heights in Chromium.
   */

  function controlPair(): { row: HTMLElement; copy: HTMLButtonElement; close: HTMLButtonElement } {
    const shadow = popShadow();
    const row = shadow.querySelector('.controls');
    const copy = shadow.querySelector('button.copy');
    const close = shadow.querySelector('.controls button:not(.copy)');
    if (!(row instanceof HTMLElement)) throw new Error('missing control row');
    if (!(copy instanceof HTMLButtonElement)) throw new Error('missing copy control');
    if (!(close instanceof HTMLButtonElement)) throw new Error('missing close control');
    return { row, copy, close };
  }

  function bubbleStyle(): string {
    return popShadow().querySelector('style')?.textContent ?? '';
  }

  /** The box model inputs happy-dom reads the same way on every access. */
  function boxModel(element: Element): Record<string, string> {
    const view = document.defaultView;
    if (!view) throw new Error('missing window');
    const style = view.getComputedStyle(element);
    return {
      boxSizing: style.boxSizing,
      lineHeight: style.lineHeight,
      fontSize: style.fontSize,
    };
  }

  it('stretches the icon-only copy control to the close control height', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '訳文', 'plamo', false, 'ja');
      const view = document.defaultView;
      if (!view) throw new Error('missing window');
      const { row, copy, close } = controlPair();

      // Both controls sit in one row, in order, and the row stretches them to the taller
      // box, so the pair keeps one height whatever the locale spells on the close button.
      expect([...row.children]).toEqual([copy, close]);
      const rowStyle = view.getComputedStyle(row);
      expect(rowStyle.display).toBe('flex');
      expect(rowStyle.alignItems).toBe('stretch');

      // Everything that builds a button's height lives in the shared rule, and the copy
      // control restates none of it — only its tighter horizontal padding and its gap.
      const style = bubbleStyle();
      const shared = /button \{[^}]*\}/.exec(style)?.[0] ?? '';
      expect(shared).toContain('box-sizing: border-box');
      expect(shared).toContain('padding: 0.333em 0.667em');
      expect(shared).toContain('border: 0');
      expect(shared).toContain('border-radius: 0.5em');
      expect(shared).toContain('margin-top: 0.667em');
      const own = /\.copy \{[^}]*\}/.exec(style)?.[0] ?? '';
      for (const restated of [
        'padding:',
        'padding-top',
        'padding-bottom',
        'padding-block',
        'border',
        'box-sizing',
        'line-height',
        'margin-top',
      ]) {
        expect(own).not.toContain(restated);
      }

      // The pair still shares what happy-dom can read reliably, and the copy control
      // centers its glyph instead of stacking it under a text strut.
      expect(boxModel(copy)).toEqual(boxModel(close));
      const copyStyle = view.getComputedStyle(copy);
      expect(copyStyle.display).toBe('inline-flex');
      expect(copyStyle.alignItems).toBe('center');
    } finally {
      overlay.destroy();
    }
  });

  it('keeps the copy box unchanged when the copied state swaps the icon', async () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '訳文', 'plamo', false, 'ja');
      const { copy, close } = controlPair();
      const style = bubbleStyle();

      // One rule sizes both glyphs, so the tick inherits the sheets' box exactly, and the
      // copied state only picks which glyph is on top. A rule that resized the box would
      // shift the row; the real rect is measured by the e2e spec.
      expect(style).toMatch(/\.copy svg \{[^}]*width: 1\.25em;[^}]*height: 1\.25em;/);
      for (const rule of style.match(/\[data-state='copied'\][^{]*\{[^}]*\}/g) ?? []) {
        expect(rule).toMatch(/\{ display: (?:none|block); \}/);
      }
      const before = boxModel(copy);
      stubClipboard('ok');

      copy.click();
      await flush();

      expect(copy.dataset.state).toBe('copied');
      expect(boxModel(copy)).toEqual(before);
      expect(boxModel(copy)).toEqual(boxModel(close));
    } finally {
      overlay.destroy();
    }
  });
});

/** The selection popup's card, which carries the marker class that scopes the cap. */
function popCard(shadow: ShadowRoot): HTMLElement {
  const card = shadow.querySelector('.card');
  if (!(card instanceof HTMLElement)) throw new Error('missing pop card');
  return card;
}

function bubbleCss(shadow: ShadowRoot): string {
  return shadow.querySelector('style')?.textContent ?? '';
}

/** The full brace block of one selector, so the new rule can be pinned exactly. */
function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start) + 1);
}

/** Long enough that the translation would stretch the popup well past the cap. */
function longTranslation(): string {
  return 'The translation keeps going and going. '.repeat(60);
}

/**
 * happy-dom lays nothing out, so the capped scroller is simulated: the port is `base`
 * pixels tall and the content grows a pixel per character, the way the real one does
 * while a translation streams in.
 */
function liveBodyScroll(body: HTMLElement, base: number): { top: () => number } {
  let scrollTop = 0;
  Object.defineProperty(body, 'scrollHeight', {
    configurable: true,
    get: () => base + (body.textContent?.length ?? 0),
  });
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => base });
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return { top: () => scrollTop };
}

/** Fixed metrics, for the cases that only need the scroller's edges. */
function fixedBodyScroll(
  body: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
): { top: () => number } {
  let scrollTop = 0;
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return { top: () => scrollTop };
}

/** A wheel gesture somewhere inside the popup, kept as a value so it can be inspected. */
function wheelOver(target: Element, deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    composed: true,
    deltaY,
  });
  target.dispatchEvent(event);
  return event;
}

describe('selection scroll arithmetic', () => {
  const box = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
    scrollTop,
    scrollHeight,
    clientHeight,
  });

  it('recognizes a streaming append but not a repeat or a rewrite', () => {
    expect(selectionTextExtends('こんにちは', 'こんにちは世界')).toBe(true);
    expect(selectionTextExtends('こんにちは', 'こんにちは')).toBe(false);
    expect(selectionTextExtends('さようなら', 'こんにちは世界')).toBe(false);
    expect(selectionTextExtends('', 'こんにちは')).toBe(false);
  });

  it('starts a newly opened popup and the first real text at the top', () => {
    const reading = {
      opening: true,
      wasPending: false,
      extendsPrevious: true,
      before: box(600, 900, 300),
      after: box(600, 1200, 300),
    };
    expect(nextSelectionScrollOffset(reading)).toBe(0);
    expect(nextSelectionScrollOffset({ ...reading, opening: false, wasPending: true })).toBe(0);
  });

  it('pins a streaming append to the bottom when the reader already sat at the end', () => {
    expect(
      nextSelectionScrollOffset({
        opening: false,
        wasPending: false,
        extendsPrevious: true,
        before: box(600, 900, 300),
        after: box(600, 1200, 300),
      }),
    ).toBe(900);
  });

  it('pins the first append that crosses the cap when the text still fit', () => {
    expect(
      nextSelectionScrollOffset({
        opening: false,
        wasPending: false,
        extendsPrevious: true,
        before: box(0, 280, 300),
        after: box(0, 400, 300),
      }),
    ).toBe(100);
  });

  it('keeps a scrolled-up reader at their offset, clamped to the new end', () => {
    expect(
      nextSelectionScrollOffset({
        opening: false,
        wasPending: false,
        extendsPrevious: true,
        before: box(120, 900, 300),
        after: box(120, 1000, 300),
      }),
    ).toBe(120);
    // A rewrite, not an append, keeps the offset under the same clamp instead of pinning.
    expect(
      nextSelectionScrollOffset({
        opening: false,
        wasPending: false,
        extendsPrevious: false,
        before: box(120, 900, 300),
        after: box(120, 400, 300),
      }),
    ).toBe(100);
  });
});

describe('selection popup body cap', () => {
  it('keeps the cap at 40vh between a floor and a ceiling', () => {
    // The measured case: a 1280×800 viewport had the popup covering 98% of the screen.
    expect(selectionBodyCapPx(800)).toBe(320);
    // A 390×844 phone viewport gets a proportionate reading area, not a fixed box.
    expect(selectionBodyCapPx(844)).toBeCloseTo(337.6, 5);
    // A very short viewport keeps a usable floor; a very tall one stops growing.
    expect(selectionBodyCapPx(300)).toBe(140);
    expect(selectionBodyCapPx(2000)).toBe(420);
    expect(selectionBodyCapPx(0)).toBe(140);
    expect(SELECTION_BODY_MAX_HEIGHT).toBe('clamp(140px, 40vh, 420px)');
  });

  it('caps and scrolls the translated text, not the whole card', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, longTranslation(), 'plamo', false, 'ja');
      const shadow = popShadow();
      const card = popCard(shadow);
      // The selection popup's card carries the marker class that scopes the new rule.
      expect(card.className).toBe('card selection');
      const css = bubbleCss(shadow);
      const rule = cssBlock(css, '.card.selection .body {');
      expect(rule).toBe(
        '.card.selection .body {\n' +
          '  max-height: ' +
          SELECTION_BODY_MAX_HEIGHT +
          ';\n' +
          '  overflow-y: auto;\n' +
          '  overscroll-behavior: contain;\n' +
          '}',
      );
      // The shared card rule keeps bounding the whole card, which the capped popup
      // never reaches: the translation scrolls inside it instead of stretching it.
      expect(cssBlock(css, '.card {')).toContain('max-height: calc(100vh - 16px)');
      // 320px of reading area plus the fixed chrome stays far short of the 784px card
      // the bug measured on a 1280×800 viewport.
      expect(selectionBodyCapPx(800) + 240).toBeLessThan(784);
    } finally {
      overlay.destroy();
    }
  });

  it('contains touch pans on the card chrome without touching the tooltip', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, longTranslation(), 'plamo', false, 'ja');
      const shadow = popShadow();
      const css = bubbleCss(shadow);
      // A touch that starts on the kicker, the note, the controls, or the padding is
      // not a wheel event, so only the card's own containment can end it there. The
      // card is a scroll container even when its content fits.
      const cardRule = cssBlock(css, '.card.selection {');
      expect(cardRule).toContain('overscroll-behavior: contain');
      // The translated text keeps its own containment as well.
      expect(cssBlock(css, '.card.selection .body {')).toContain('overscroll-behavior: contain');
      // The shared card rule stays exactly as it was, so the hover tooltip keeps the
      // default overscroll behavior on its whole-card scroller.
      const shared = cssBlock(css, '.card {');
      expect(shared).toContain('max-height: calc(100vh - 16px)');
      expect(shared).not.toContain('overscroll-behavior');
      // The tooltip's card carries no marker class either, so the scoped rules never
      // match it.
      overlay.showOriginal(document.body, 'Original words', 'plamo');
      const tipCard = uiShadow(document.querySelector('sakutto-tip'))?.querySelector('.card');
      expect(tipCard?.className).toBe('card');
    } finally {
      overlay.destroy();
    }
  });

  it('keeps the hover tooltip on its whole-card max-height', () => {
    const overlay = mountOverlay();
    try {
      overlay.showOriginal(document.body, 'Original words', 'plamo');
      const shadow = uiShadow(document.querySelector('sakutto-tip'));
      // No marker class on the tooltip's card, so the selection cap rule never matches it.
      expect(shadow?.querySelector('.card')?.className).toBe('card');
      expect(shadow?.querySelector('.body')?.textContent).toBe('Original words');
      const css = shadow?.querySelector('style')?.textContent ?? '';
      expect(cssBlock(css, '.card {')).toContain('max-height: calc(100vh - 16px)');
    } finally {
      overlay.destroy();
    }
  });

  it('keeps a one-line translation exactly as small as before', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '一行の訳文です。', 'plamo', false, 'ja');
      const shadow = popShadow();
      const body = popBody(shadow);
      expect(body.textContent).toBe('一行の訳文です。');
      const rule = cssBlock(bubbleCss(shadow), '.card.selection .body {');
      // The rule is a max-height alone: no min-height, no fixed height, no padding or
      // width, so a short translation shrinks to its content with no empty scrollport.
      expect(rule).toBe(
        '.card.selection .body {\n' +
          '  max-height: ' +
          SELECTION_BODY_MAX_HEIGHT +
          ';\n' +
          '  overflow-y: auto;\n' +
          '  overscroll-behavior: contain;\n' +
          '}',
      );
      // The card is still only as tall as its content: kicker, body, note, and controls.
      const card = popCard(shadow);
      expect([...card.children].map((child) => child.className)).toEqual([
        'kicker',
        'body',
        'note',
        'note copy-note',
        'controls',
        'resize-handle left',
        'resize-handle right',
      ]);
    } finally {
      overlay.destroy();
    }
  });

  it('keeps the header, engine note, and controls outside the scrolling text', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, longTranslation(), 'plamo', false, 'ja');
      const shadow = popShadow();
      const card = popCard(shadow);
      const body = popBody(shadow);
      const kicker = shadow.querySelector('.kicker');
      const note = shadow.querySelector('.note');
      const controls = shadow.querySelector('.controls');
      // The scroller holds the translation alone; the chrome stays beside it in the
      // card, so scrolling the text can never carry the header or the controls away.
      for (const chrome of [kicker, note, controls]) {
        expect(chrome instanceof HTMLElement).toBe(true);
        expect(body.contains(chrome)).toBe(false);
        expect(card.contains(chrome)).toBe(true);
      }
      expect(note?.textContent).toBe(labels.machine);
      body.scrollTop = 120;
      expect(card.contains(shadow.querySelector('.controls'))).toBe(true);
      expect(body.textContent).toBe(longTranslation());
    } finally {
      overlay.destroy();
    }
  });
});

describe('selection popup wheel gestures', () => {
  it('scrolls the capped text and never lets the gesture reach the page', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, longTranslation(), 'plamo', false, 'ja');
      const shadow = popShadow();
      const body = popBody(shadow);
      const scroll = fixedBodyScroll(body, 500, 300);
      expect(body.textContent?.length).toBeGreaterThan(300);

      // Over the translation itself the gesture moves the text, not the page.
      const overText = wheelOver(body, 60);
      expect(overText.defaultPrevented).toBe(true);
      expect(scroll.top()).toBe(60);

      // Over the header and over the controls the gesture is still local, and it moves
      // the text, which is the only thing in the popup that can scroll.
      const header = shadow.querySelector('.kicker');
      const controls = shadow.querySelector('.controls');
      expect(header instanceof HTMLElement).toBe(true);
      expect(controls instanceof HTMLElement).toBe(true);
      if (header) {
        const overHeader = wheelOver(header, 40);
        expect(overHeader.defaultPrevented).toBe(true);
      }
      if (controls) {
        const overControls = wheelOver(controls, 40);
        expect(overControls.defaultPrevented).toBe(true);
      }
      expect(scroll.top()).toBe(140);

      // Already at the bottom edge, and then past the top edge: still contained.
      const down = wheelOver(body, 500);
      expect(down.defaultPrevented).toBe(true);
      expect(scroll.top()).toBe(200);
      const up = wheelOver(body, -500);
      expect(up.defaultPrevented).toBe(true);
      expect(scroll.top()).toBe(0);
    } finally {
      overlay.destroy();
    }
  });

  it('keeps the gesture local even when the translation does not overflow', () => {
    const overlay = mountOverlay();
    try {
      overlay.showSelection(RECT, '一行の訳文です。', 'plamo', false, 'ja');
      const shadow = popShadow();
      const body = popBody(shadow);
      const scroll = fixedBodyScroll(body, 120, 120);
      const event = wheelOver(body, 60);
      expect(event.defaultPrevented).toBe(true);
      expect(scroll.top()).toBe(0);
    } finally {
      overlay.destroy();
    }
  });
});

describe('selection popup streaming scroll', () => {
  it('opens at the top, pins the bottom while streaming, and keeps a scrolled-up reader', () => {
    const overlay = mountOverlay();
    try {
      const shadow = popShadow();
      const body = popBody(shadow);
      const scroll = liveBodyScroll(body, 300);

      // The pending placeholder opens the popup at the top of the translation.
      overlay.showSelection(RECT, '', null, true, 'ja');
      expect(body.textContent).toBe(labels.selectionPending);
      expect(scroll.top()).toBe(0);

      // The first real text replaces the placeholder and still starts at the top.
      const first = 'あ'.repeat(100);
      overlay.showSelection(RECT, first, 'plamo', false, 'ja');
      expect(body.textContent).toBe(first);
      expect(scroll.top()).toBe(0);

      // The reader scrolls to the bottom of what has arrived.
      body.scrollTop = 100;
      // A streaming append keeps the newest text in view.
      const second = first + 'あ'.repeat(100);
      overlay.showSelection(RECT, second, 'plamo', false, 'ja');
      expect(scroll.top()).toBe(200);

      // Scrolled up, the reader's place survives the next append.
      body.scrollTop = 60;
      overlay.showSelection(RECT, second + 'あ'.repeat(100), 'plamo', false, 'ja');
      expect(scroll.top()).toBe(60);

      // A text that rewrites the translation instead of extending it keeps the offset,
      // clamped so it cannot sit past the new end.
      overlay.showSelection(RECT, 'あ'.repeat(40), 'plamo', false, 'ja');
      expect(scroll.top()).toBe(40);

      // A reopened popup starts at the top again, whatever the last position was.
      overlay.hideSelection();
      body.scrollTop = 180;
      overlay.showSelection(RECT, second, 'plamo', false, 'ja');
      expect(scroll.top()).toBe(0);
    } finally {
      overlay.destroy();
    }
  });
});

describe('selection popup placement', () => {
  it('flips above the selection measuring the capped card, not the uncapped text', () => {
    const overlay = mountOverlay();
    try {
      const shadow = popShadow();
      const card = popCard(shadow);
      const view = document.defaultView;
      if (!view) throw new Error('missing window');
      const height = view.innerHeight;
      const host = document.querySelector('sakutto-pop');
      if (!(host instanceof HTMLElement)) throw new Error('missing pop host');
      // The laid-out card: the capped reading area plus the fixed chrome. Overriding
      // the property proves place reads the card the layout shows, never the uncapped
      // text height the old whole-card scroller would have produced.
      let laidOut = 440;
      Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => laidOut });
      const anchor = new DOMRect(200, height - 120, 240, 18);

      overlay.showSelection(anchor, longTranslation(), 'plamo', false, 'ja');
      // The card does not fit below the selection, so it flips above it...
      expect(Number.parseFloat(host.style.top)).toBe(anchor.top - 440 - 16);
      // ...and the top margin never engages: an uncapped text height would have pushed
      // the popup there instead of leaving it beside the selection.
      expect(host.style.top).not.toBe('8px');

      // A streaming paint that grows the visible card repositions from the new height.
      laidOut = 520;
      overlay.showSelection(
        anchor,
        longTranslation() + ' More sentences arrive.',
        'plamo',
        false,
        'ja',
      );
      expect(Number.parseFloat(host.style.top)).toBe(anchor.top - 520 - 16);
    } finally {
      overlay.destroy();
    }
  });

  it('pulls a flipped card fully on screen when the selection sits below the fold', () => {
    const overlay = mountOverlay();
    try {
      const shadow = popShadow();
      const card = popCard(shadow);
      const view = document.defaultView;
      if (!view) throw new Error('missing window');
      const height = view.innerHeight;
      const host = document.querySelector('sakutto-pop');
      if (!(host instanceof HTMLElement)) throw new Error('missing pop host');
      // The selection's last line is below the fold; the capped card still fits.
      const anchor = new DOMRect(24, height + 80, 220, 18);
      Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => 400 });

      overlay.showSelection(anchor, longTranslation(), 'plamo', false, 'ja');
      // The flip alone would leave the engine note and the Close control past the
      // viewport, so the card is pulled up until its bottom lands on the viewport's
      // bottom margin.
      expect(Number.parseFloat(host.style.top)).toBe(height - 400 - 8);

      // A card taller than the viewport pins to the top margin instead of going negative.
      Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => height });
      overlay.showSelection(anchor, longTranslation(), 'plamo', false, 'ja');
      expect(host.style.top).toBe('8px');
    } finally {
      overlay.destroy();
    }
  });
});
