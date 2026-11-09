// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposeController, composeShadow, type ComposeLabels } from '@/dom/compose';
import type { PageEngine } from '@/dom/session';

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

function clickPanel(label: string): void {
  const shadow = composeShadow(document.querySelector('sakutto-compose'));
  const button = [...(shadow?.querySelectorAll('button') ?? [])].find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`missing ${label}`);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('compose controller', () => {
  const controllers: ComposeController[] = [];

  afterEach(() => {
    for (const controller of controllers) controller.destroy();
    controllers.length = 0;
    document.body.innerHTML = '';
  });

  function start(
    engine: PageEngine = immediate((text, tgt) => `§${tgt}§${text}`),
    enabled = true,
  ): ComposeController {
    const controller = new ComposeController(document, {
      engine,
      labels,
      preferences: {
        targetLanguage: 'ja',
        form: 'polite',
        enabled,
        uiLanguage: 'en',
      },
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
    expect(field.value).toBe('§ja§See you tomorrow.');
    expect(panelText()).toContain('Replaced');

    clickPanel('Restore original');
    expect(field.value).toBe('See you tomorrow.');
  });

  it('applies on a second shortcut once the preview is ready', async () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    const controller = start();
    controller.handleShortcut();
    await vi.waitFor(() => {
      expect(panelText()).toContain('§ja§See you tomorrow.');
    });
    // The first key and Chrome's command can arrive together; a second press inside
    // that window must not apply. Wait out the debounce, then apply.
    await new Promise((resolve) => setTimeout(resolve, 90));
    controller.handleShortcut();
    expect(field.value).toBe('§ja§See you tomorrow.');
  });

  it('replaces a Slate-style editor so Enter would send the translation', async () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    let value = '会議は明日です';
    const render = (): void => {
      editor.textContent = value;
    };
    editor.addEventListener('beforeinput', (event) => {
      const input = event as InputEvent;
      if (input.inputType !== 'insertText' || input.data === null) return;
      event.preventDefault();
      value = input.data;
      render();
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
    expect(value).toBe('§en§会議は明日です');
  });

  it('never opens on a password field', () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2">';
    const field = document.querySelector('#pw');
    if (!(field instanceof HTMLInputElement)) throw new Error('missing password');
    field.focus();
    start().handleShortcut();
    expect(document.querySelector('sakutto-compose') instanceof HTMLElement).toBe(true);
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(true);
    expect(field.value).toBe('hunter2');
  });

  it('stays idle when the site is set to never translate', () => {
    document.body.innerHTML = '<textarea id="box">See you tomorrow.</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.focus();
    start(undefined, false).handleShortcut();
    expect(field.value).toBe('See you tomorrow.');
    expect((document.querySelector('sakutto-compose') as HTMLElement).hidden).toBe(true);
  });
});
