// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageOverlay, setPlainTextContent, uiShadow } from '@/dom/overlay';
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
