// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComposeController,
  composeIconPosition,
  composeLangTag,
  composePanelPosition,
  composePanelWidth,
  composeShadow,
  composeSurfaceIsDark,
  type ComposeLabels,
} from '@/dom/compose';
import type { PageEngine } from '@/dom/session';
import type { ComposePreferences } from '@/dom/compose';

const labels: ComposeLabels = {
  title: 'Draft translation',
  icon: 'Translate what you are writing',
  replace: 'Replace',
  undo: 'Restore original',
  close: 'Close',
  pending: 'Translating…',
  failed: 'Could not translate this draft.',
  empty: 'Type something to translate.',
  tooLong: 'This draft is too long to translate.',
  swap: 'Switch the translation direction',
  replaced: 'Replaced. You can restore the original.',
  stale: 'The draft changed. Replace is paused until the preview catches up.',
  setup: 'PLaMo is not ready yet.',
  loading: 'The PLaMo model is loading.',
  ineligible: 'This field cannot be translated.',
  openSetup: 'Open setup',
  target: 'Target',
  autoSource: 'Auto',
  replaceHint: (compose, enter) => `${compose} / ${enter} to replace`,
  langPair: (source, target) => `${source} → ${target}`,
  into: (language) => `Into ${language}`,
  chromeOnly: (language) => `PLaMo does not translate into ${language}.`,
};

function immediate(render: (text: string, tgt: string) => string): PageEngine {
  return {
    async *translate(segments, options) {
      for (const segment of segments) {
        yield { id: segment.id, final: render(segment.text, options.tgt), engine: 'plamo' };
      }
    },
  };
}

function panelText(): string {
  return composeShadow(document.querySelector('sakutto-compose'))?.textContent ?? '';
}

function panelButton(label: string): HTMLButtonElement {
  const shadow = composeShadow(document.querySelector('sakutto-compose'));
  const button = [...(shadow?.querySelectorAll('button') ?? [])].find((node) => {
    const text = node.textContent ?? '';
    return (
      text === label || text.startsWith(`${label} `) || node.getAttribute('aria-label') === label
    );
  });
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return button;
}

function panelCard(): HTMLElement {
  const card = composeShadow(document.querySelector('sakutto-compose'))?.querySelector('.card');
  if (!(card instanceof HTMLElement)) throw new Error('missing card');
  return card;
}

function clickPanel(label: string): void {
  panelButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const defaultPrefs: ComposePreferences = {
  targetLanguage: 'ja',
  form: 'polite',
  enabled: true,
  uiLanguage: 'en',
  showIcon: true,
  readiness: 'ready',
  explicitTarget: false,
  instantReplace: false,
  replaceShortcut: 'Alt+T',
};

describe('compose controller', () => {
  const controllers: ComposeController[] = [];

  afterEach(() => {
    for (const controller of controllers) controller.destroy();
    controllers.length = 0;
    document.body.innerHTML = '';
  });

  function start(
    engine: PageEngine = immediate((text, tgt) => `§${tgt}§${text}`),
    prefs: Partial<ComposePreferences> = {},
  ): ComposeController {
    const controller = new ComposeController(document, {
      engine,
      labels,
      preferences: { ...defaultPrefs, ...prefs },
      previewMs: 20,
    });
    controllers.push(controller);
    return controller;
  }

  it('shows a preview without rewriting the field until Replace is chosen', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    expect(field.value).toBe('See you tomorrow.');

    clickPanel('Replace');
    await vi.waitFor(() => {
      expect(field.value).toBe('§ja§See you tomorrow.');
    });
    expect(panelText()).toContain('Replaced');

    clickPanel('Restore original');
    await vi.waitFor(() => {
      expect(field.value).toBe('See you tomorrow.');
    });
  });

  it('replaces on a second shortcut once the preview is ready, and keeps undo', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    expect(panelText()).toContain('Alt+T');
    expect(panelButton('Replace').textContent).toBe('Replace');
    await new Promise((resolve) => setTimeout(resolve, 220));
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(field.value).toBe('§ja§See you tomorrow.');
    });
    controller.handleShortcut();
    expect(panelButton('Restore original').disabled).toBe(false);
    expect(field.value).toBe('§ja§See you tomorrow.');
  });

  it('replaces with Ctrl+Enter in the field while the preview is open', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    start();
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 't', altKey: true, code: 'KeyT', bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => {
      expect(field.value).toBe('§ja§See you tomorrow.');
    });
  });

  it('does not replace on plain Enter', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(field.value).toBe('See you tomorrow.');
  });

  it('applies as soon as a pending translation finishes if the shortcut was pressed again', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        await gate;
        for (const segment of segments) {
          yield { id: segment.id, final: `§${options.tgt}§${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const controller = start(engine);
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('Translating');
    });
    await new Promise((resolve) => setTimeout(resolve, 220));
    controller.handleShortcut();
    expect(field.value).toBe('See you tomorrow.');
    release?.();
    await vi.waitFor(() => {
      expect(field.value).toBe('§ja§See you tomorrow.');
    });
  });

  it('replaces immediately when instant replace is on', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start(undefined, { instantReplace: true });
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(field.value).toBe('§ja§See you tomorrow.');
    });
    expect(panelButton('Restore original').disabled).toBe(false);
  });

  it('re-translates when the preview target language changes', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const picked: string[] = [];
    const controller = new ComposeController(document, {
      engine: immediate((text, tgt) => `§${tgt}§${text}`),
      labels,
      preferences: defaultPrefs,
      previewMs: 20,
      onTarget: (language) => {
        picked.push(language);
      },
    });
    controllers.push(controller);
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    const select = composeShadow(document.querySelector('sakutto-compose'))?.querySelector(
      'select.target',
    );
    if (!(select instanceof HTMLSelectElement)) throw new Error('missing target select');
    select.value = 'ko';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ko§See you tomorrow.');
    });
    expect(picked).toEqual(['ko']);
  });

  it('does not start a reverse translation from the input event Replace itself fires', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    let calls = 0;
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls += 1;
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: `§${options.tgt}§${segment.text}`,
            engine: 'plamo',
          };
        }
      },
    };
    const controller = start(engine);
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    expect(calls).toBe(1);
    clickPanel('Replace');
    await vi.waitFor(() => {
      expect(field.value).toBe('§ja§See you tomorrow.');
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
    expect(panelText()).not.toContain('The draft changed');
  });

  it('marks the preview stale when the draft changes after it', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    start();
    const controller = controllers[0]!;
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    field.value = 'See you tomorrow. Extra.';
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(panelButton('Replace').disabled).toBe(true);
    expect(panelText()).toContain('The draft changed');
  });

  it('ignores input events while an IME composition is in progress', async () => {
    document.body.innerHTML = '<textarea id="box">あ</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    let calls = 0;
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `§${options.tgt}§${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const controller = start(engine);
    controller.handleShortcut();
    await vi.waitFor(() => expect(calls).toBe(1));
    field.value = 'あい';
    field.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
    field.dispatchEvent(new Event('compositionend', { bubbles: true }));
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it('does not steal Escape while only the icon is visible', () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    start();
    field.focus();
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const icon = document.querySelector('sakutto-write');
    expect(icon instanceof HTMLElement && icon.hidden === false).toBe(true);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const prevented = !field.dispatchEvent(event);
    expect(prevented).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('dismisses the panel on Escape and ignores Escape during composition', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(false);
    });
    const composing = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    field.dispatchEvent(composing);
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(false);
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(true);
  });

  it('hides the icon on a search box and when the setting is off', () => {
    document.body.innerHTML = `
      <input id="search" type="search" value="query">
      <textarea id="box">hello</textarea>
    `;
    const search = document.querySelector('#search');
    if (!(search instanceof HTMLInputElement)) throw new Error('missing search');
    start();
    search.focus();
    search.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect((document.querySelector('sakutto-write') as HTMLElement).hidden).toBe(true);
    const box = document.querySelector('#box');
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    box.focus();
    box.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect((document.querySelector('sakutto-write') as HTMLElement).hidden).toBe(false);
    controllers[0]?.setPreferences({ ...defaultPrefs, showIcon: false });
    expect((document.querySelector('sakutto-write') as HTMLElement).hidden).toBe(true);
  });

  it('hides the icon on blur so a later scroll does not bring it back', async () => {
    document.body.innerHTML = '<textarea id="box">hello</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    start();
    field.focus();
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect((document.querySelector('sakutto-write') as HTMLElement).hidden).toBe(false);
    field.blur();
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    window.dispatchEvent(new Event('scroll'));
    expect((document.querySelector('sakutto-write') as HTMLElement).hidden).toBe(true);
  });

  it('shows a setup message instead of translating when the model is not ready', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    let calls = 0;
    const engine: PageEngine = {
      async *translate() {
        calls += 1;
        yield { id: 'compose', final: 'nope', engine: 'plamo' };
      },
    };
    const controller = start(engine, { readiness: 'no-consent' });
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('PLaMo is not ready yet.');
    });
    expect(calls).toBe(0);
    expect(panelButton('Replace').disabled).toBe(true);
  });

  it('replaces a Slate-style editor so Enter would send the translation', async () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    let value = '会議は明日です';
    let beforeCount = 0;
    const render = (): void => {
      editor.textContent = value;
    };
    editor.addEventListener('beforeinput', (event) => {
      const input = event as InputEvent;
      if (input.inputType !== 'insertText' && input.inputType !== 'insertFromPaste') return;
      const data = input.data ?? input.dataTransfer?.getData('text/plain') ?? '';
      if (data.length === 0) return;
      event.preventDefault();
      beforeCount += 1;
      const next = data;
      const apply = (): void => {
        value = next;
        render();
      };
      const view = editor.ownerDocument.defaultView;
      if (view && typeof view.requestAnimationFrame === 'function') {
        view.requestAnimationFrame(() => setTimeout(apply, 0));
      } else {
        setTimeout(apply, 32);
      }
    });
    render();
    document.body.append(editor);
    editor.focus();

    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§en§');
    });
    expect(value).toBe('会議は明日です');
    clickPanel('Replace');
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(value).toBe('§en§会議は明日です');
    });
    expect(beforeCount).toBe(1);
    clickPanel('Restore original');
    await vi.waitFor(() => {
      expect(value).toBe('会議は明日です');
    });
    expect(panelButton('Restore original').disabled).toBe(true);
    clickPanel('Restore original');
    expect(value).toBe('会議は明日です');
    expect(beforeCount).toBe(2);
  });

  it('does not write into a password field and shows that it cannot be translated', () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2">';
    const field = document.querySelector('#pw');
    if (!(field instanceof HTMLInputElement)) throw new Error('missing password');
    field.focus();
    start().handleShortcut();
    expect(field.value).toBe('hunter2');
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(false);
    expect(panelText()).toContain('This field cannot be translated.');
    expect(panelButton('Replace').disabled).toBe(true);
  });

  it('ignores a page-dispatched replace event in the production build', async () => {
    expect(__SAKUTTO_FAKE_ENGINE__).toBe(false);
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    const host = document.querySelector('sakutto-compose');
    host?.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(field.value).toBe('See you tomorrow.');
  });

  it('restores the whole draft after replacing a selection', async () => {
    document.body.innerHTML = '<textarea id="box">Hello world extra</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    field.setSelectionRange(0, 5);
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§Hello');
    });
    clickPanel('Replace');
    await vi.waitFor(() => {
      expect(field.value).toBe('§ja§Hello world extra');
    });
    clickPanel('Restore original');
    await vi.waitFor(() => {
      expect(field.value).toBe('Hello world extra');
    });
  });

  it('shows a loading message instead of setup while the model is busy', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    let calls = 0;
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls += 1;
        for (const segment of segments) {
          yield { id: segment.id, final: `§${options.tgt}§${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const controller = start(engine, { readiness: 'model-busy' });
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('The PLaMo model is loading.');
    });
    expect(panelText()).not.toContain('PLaMo is not ready yet.');
    expect(calls).toBe(0);
    expect(panelButton('Open setup').classList.contains('visible')).toBe(false);
    controller.setPreferences({ ...defaultPrefs, readiness: 'ready' });
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    expect(calls).toBe(1);
  });

  it('places the icon outside a short single-line field', () => {
    const pos = composeIconPosition(new DOMRect(20, 40, 240, 32), { width: 800, height: 600 });
    expect(pos.left).toBeGreaterThanOrEqual(260);
    expect(pos.left + 26).toBeLessThanOrEqual(20 + 240 + 6 + 26 + 1);
  });

  it('anchors the preview bar to the field and flips below when there is no room', () => {
    const above = composePanelPosition(
      new DOMRect(40, 500, 400, 44),
      { width: 400, height: 72 },
      { width: 800, height: 600 },
    );
    expect(above.placement).toBe('above');
    expect(above.left).toBe(40);
    expect(above.top).toBe(500 - 72 - 6);
    const below = composePanelPosition(
      new DOMRect(40, 8, 400, 44),
      { width: 400, height: 72 },
      { width: 800, height: 600 },
    );
    expect(below.placement).toBe('below');
    expect(below.top).toBe(8 + 44 + 6);
    expect(composePanelWidth(new DOMRect(40, 500, 400, 44), 800)).toBe(400);
    expect(composePanelWidth(new DOMRect(40, 500, 120, 44), 800)).toBe(240);
  });

  it('tags languages compactly for the chip', () => {
    expect(composeLangTag('ja')).toBe('JA');
    expect(composeLangTag('en-US')).toBe('EN');
    expect(composeLangTag('zh-Hans')).toBe('ZH');
    expect(composeLangTag('zh-Hant')).toBe('ZH-T');
    expect(composeLangTag(null)).toBe('');
  });

  it('picks a dark surface from a dark field even when the OS is light', () => {
    document.body.innerHTML =
      '<div id="chat" style="background:#313338"><textarea id="box" style="background:#383a40">hello</textarea></div>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    expect(composeSurfaceIsDark(field)).toBe(true);
    document.body.innerHTML =
      '<div id="mail" style="background:#ffffff"><textarea id="box" style="background:#ffffff">hello</textarea></div>';
    const light = document.querySelector('#box');
    if (!(light instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    expect(composeSurfaceIsDark(light)).toBe(false);
  });

  it('hides the panel when the field is cleared after send', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    field.value = '';
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(true);
    expect(panelText()).not.toContain('Type something to translate.');
  });

  it('does not steal Escape from the page while the panel is open', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(false);
    });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const prevented = !document.body.dispatchEvent(event);
    expect(prevented).toBe(false);
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(false);
  });

  it('uses a language chip and an undo toast after replace', async () => {
    document.body.innerHTML = '<textarea id="box">会議は明日です。</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§en§');
    });
    expect(panelText()).toContain('JA → EN');
    expect(panelText()).toContain('Alt+T / Ctrl+Enter to replace');
    expect(panelCard().classList.contains('undo')).toBe(false);
    clickPanel('Replace');
    await vi.waitFor(() => {
      expect(field.value).toBe('§en§会議は明日です。');
    });
    expect(panelCard().classList.contains('undo')).toBe(true);
    expect(panelButton('Restore original').disabled).toBe(false);
    expect(panelText()).toContain('Replaced');
  });

  it('follows a dark field with a dark compose bar', async () => {
    document.body.innerHTML =
      '<div style="background:#313338;color:#f2f3f5"><textarea id="box" style="background:#383a40;color:#f2f3f5">会議は明日です。</textarea></div>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§en§');
    });
    expect(panelCard().classList.contains('dark')).toBe(true);
    expect((document.querySelector('sakutto-compose') as HTMLElement).dataset.theme).toBe('dark');
  });

  it('stays idle when the site is set to never translate', () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    start(undefined, { enabled: false }).handleShortcut();
    expect(field.value).toBe('See you tomorrow.');
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(true);
  });
});
