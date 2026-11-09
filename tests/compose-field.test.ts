// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isTranslationExcluded, listTranslatableBlocks } from '@/dom/blocks';
import {
  collapseComposeCaret,
  composeEditableRoot,
  composeFieldRect,
  focusedComposeField,
  isComposeCandidate,
  isComposeMenuTarget,
  isSensitiveField,
  readComposeText,
  readDraftRegionText,
  replaceComposeText,
  shouldHandleComposeCommand,
  showsComposeIcon,
  snapshotComposeField,
  textsMatch,
  undoComposeReplace,
} from '@/dom/compose-field';

function mountSlate(
  initial: string,
  options: { asyncSelection?: boolean; asyncApply?: boolean } = {},
): HTMLElement & { slateValue: string; beforeCount: number } {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('data-slate-editor', 'true');
  let value = initial;
  let selStart = value.length;
  let selEnd = value.length;
  const render = (): void => {
    editor.replaceChildren();
    const block = document.createElement('div');
    block.setAttribute('data-slate-node', 'element');
    const text = document.createElement('span');
    text.setAttribute('data-slate-node', 'text');
    text.textContent = value;
    block.append(text);
    editor.append(block);
  };
  const offsetsFromDom = (): { start: number; end: number } => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return { start: selStart, end: selEnd };
    const range = selection.getRangeAt(0);
    if (
      !editor.contains(range.commonAncestorContainer) &&
      range.commonAncestorContainer !== editor
    ) {
      return { start: selStart, end: selEnd };
    }
    const pre = range.cloneRange();
    pre.selectNodeContents(editor);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    return { start, end: start + range.toString().length };
  };
  document.addEventListener('selectionchange', () => {
    const next = offsetsFromDom();
    selStart = next.start;
    selEnd = next.end;
  });
  let beforeCount = 0;
  editor.addEventListener('beforeinput', (event) => {
    const input = event as InputEvent;
    if (input.inputType !== 'insertText' && input.inputType !== 'insertFromPaste') return;
    const data = input.data ?? input.dataTransfer?.getData('text/plain') ?? '';
    if (data.length === 0) return;
    event.preventDefault();
    beforeCount += 1;
    const start = options.asyncSelection ? selStart : offsetsFromDom().start;
    const end = options.asyncSelection ? selEnd : offsetsFromDom().end;
    const apply = (): void => {
      value = value.slice(0, start) + data + value.slice(end);
      selStart = selEnd = start + data.length;
      render();
    };
    if (options.asyncApply) {
      const view = editor.ownerDocument.defaultView;
      if (view && typeof view.requestAnimationFrame === 'function') {
        view.requestAnimationFrame(() => {
          setTimeout(apply, 0);
        });
      } else {
        setTimeout(apply, 32);
      }
    } else {
      apply();
    }
  });
  render();
  Object.defineProperty(editor, 'slateValue', {
    get: () => value,
  });
  Object.defineProperty(editor, 'beforeCount', {
    get: () => beforeCount,
  });
  return editor as unknown as HTMLElement & { slateValue: string; beforeCount: number };
}

describe('compose field eligibility', () => {
  it('accepts a textarea, a text input and a contenteditable region', () => {
    document.body.innerHTML = `
      <textarea id="box">hello</textarea>
      <input id="title" type="text" value="query">
      <div id="editor" contenteditable>draft</div>
    `;
    expect(isComposeCandidate(document.querySelector('#box')!)).toBe(true);
    expect(isComposeCandidate(document.querySelector('#title')!)).toBe(true);
    expect(isComposeCandidate(document.querySelector('#editor')!)).toBe(true);
  });

  it('refuses passwords, hidden values, non-text inputs and secrets by autocomplete', () => {
    document.body.innerHTML = `
      <input id="pw" type="password" value="hunter2">
      <input id="hidden" type="hidden" value="token">
      <input id="number" type="number" value="3">
      <input id="otp" autocomplete="one-time-code" value="123456">
      <input id="card" autocomplete="cc-number" value="4111111111111111">
      <input id="named" name="password" value="secret">
      <input id="api" name="api_key" value="sk">
      <input id="pin" name="pin" value="1234">
      <input id="emailish" type="text" inputmode="email" value="a@b.c">
      <textarea id="ok">hello</textarea>
    `;
    expect(isSensitiveField(document.querySelector('#pw')!)).toBe(true);
    expect(isComposeCandidate(document.querySelector('#pw')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#hidden')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#number')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#otp')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#card')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#named')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#api')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#pin')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#emailish')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#ok')!)).toBe(true);
    expect(isComposeMenuTarget(document.querySelector('#pw')!)).toBe(false);
    expect(isComposeMenuTarget(document.querySelector('#ok')!)).toBe(true);
  });

  it('refuses a read-only or disabled field', () => {
    document.body.innerHTML = `
      <textarea id="ro" readonly>locked</textarea>
      <input id="off" disabled value="no">
    `;
    expect(isComposeCandidate(document.querySelector('#ro')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#off')!)).toBe(false);
  });

  it('hides the inline icon on search boxes and comboboxes', () => {
    document.body.innerHTML = `
      <input id="search" type="search" value="query">
      <div id="combo" contenteditable role="combobox">pick</div>
      <textarea id="box">hello</textarea>
    `;
    expect(isComposeCandidate(document.querySelector('#search')!)).toBe(true);
    expect(showsComposeIcon(document.querySelector('#search')!)).toBe(false);
    expect(showsComposeIcon(document.querySelector('#combo')!)).toBe(false);
    expect(showsComposeIcon(document.querySelector('#box')!)).toBe(true);
  });
});

describe('reading and replacing compose text', () => {
  it('replaces a textarea through the value setter and an input event', async () => {
    document.body.innerHTML = '<textarea id="box">こんにちは</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    const seen: string[] = [];
    field.addEventListener('input', () => {
      seen.push(field.value);
    });
    const result = await replaceComposeText(field, 'Hello there');
    expect(result.ok).toBe(true);
    expect(field.value).toBe('Hello there');
    expect(seen).toContain('Hello there');
  });

  it('replaces only the selected span in a textarea', async () => {
    document.body.innerHTML = '<textarea id="box">Hello world</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.setSelectionRange(0, 5);
    expect(readComposeText(field)).toBe('Hello');
    expect((await replaceComposeText(field, 'Bonjour')).ok).toBe(true);
    expect(field.value).toBe('Bonjour world');
  });

  it('replaces a text input the same way', async () => {
    document.body.innerHTML = '<input id="title" type="text" value="下書き">';
    const field = document.querySelector('#title');
    if (!(field instanceof HTMLInputElement)) throw new Error('missing input');
    expect((await replaceComposeText(field, 'Draft')).ok).toBe(true);
    expect(field.value).toBe('Draft');
    expect(readComposeText(field)).toBe('Draft');
  });

  it('replaces a plain contenteditable region', async () => {
    document.body.innerHTML = '<div id="editor" contenteditable>会議は明日です</div>';
    const field = document.querySelector('#editor');
    if (!(field instanceof HTMLElement)) throw new Error('missing editor');
    expect((await replaceComposeText(field, 'The meeting is tomorrow.')).ok).toBe(true);
    expect(readComposeText(field).replace(/\n$/u, '')).toBe('The meeting is tomorrow.');
  });

  /**
   * Assumed Gmail compose DOM: one `<div>` per draft line, then `.gmail_signature_prefix`
   * (`-- `), `.gmail_signature`, and `.gmail_quote`. Newlines must stay as sibling divs,
   * not collapse into one text node.
   */
  it('leaves Gmail signature, prefix and quoted history in place as line divs', async () => {
    document.body.innerHTML = `
      <div id="editor" contenteditable>
        <div id="body">明日会いましょう。</div>
        <div>場所は駅です。</div>
        <div class="gmail_signature_prefix">-- </div>
        <div class="gmail_signature">Jane Doe</div>
        <div class="gmail_quote">On Monday, Alex wrote: Hello</div>
      </div>
    `;
    const field = document.querySelector('#editor');
    if (!(field instanceof HTMLElement)) throw new Error('missing editor');
    expect(readComposeText(field)).toContain('明日会いましょう。');
    expect(readComposeText(field)).not.toContain('Jane Doe');
    expect(readComposeText(field)).not.toContain('On Monday');
    expect(readComposeText(field)).not.toContain('--');
    expect((await replaceComposeText(field, 'See you tomorrow.\nAt the station.')).ok).toBe(true);
    const draftDivs = [...field.children].filter(
      (node) =>
        !node.classList.contains('gmail_signature') &&
        !node.classList.contains('gmail_signature_prefix') &&
        !node.classList.contains('gmail_quote'),
    );
    expect(draftDivs.map((node) => node.textContent)).toEqual([
      'See you tomorrow.',
      'At the station.',
    ]);
    expect(field.querySelector('.gmail_signature_prefix')?.textContent).toBe('-- ');
    expect(field.querySelector('.gmail_signature')?.textContent).toContain('Jane Doe');
    expect(field.querySelector('.gmail_quote')?.textContent).toContain('On Monday');
  });

  it('reads a Gmail draft inside a dir=ltr wrapper that also holds the signature', async () => {
    document.body.innerHTML = `
      <div id="editor" contenteditable>
        <div dir="ltr">
          <div>明日会いましょう。</div>
          <div class="gmail_signature_prefix">-- </div>
          <div class="gmail_signature">Jane Doe</div>
        </div>
      </div>
    `;
    const field = document.querySelector('#editor');
    if (!(field instanceof HTMLElement)) throw new Error('missing editor');
    expect(readComposeText(field)).toContain('明日会いましょう。');
    expect(readComposeText(field)).not.toContain('Jane Doe');
    expect(readComposeText(field).trim().length).toBeGreaterThan(0);
    expect((await replaceComposeText(field, 'See you tomorrow.')).ok).toBe(true);
    expect(textsMatch(readComposeText(field), 'See you tomorrow.')).toBe(true);
    expect(field.querySelector('[dir="ltr"]')).not.toBeNull();
    expect(field.querySelector('.gmail_signature_prefix')?.textContent).toBe('-- ');
    expect(field.querySelector('.gmail_signature')?.textContent).toContain('Jane Doe');
  });

  /**
   * Assumed Outlook web compose DOM: draft, `#appendonsend`, a preceding `<hr>`,
   * `#divRplyFwdMsg`, quoted-body siblings after that header (not nested inside it),
   * then `#Signature`.
   */
  it('preserves Outlook quoted siblings from the first excluded marker onward', async () => {
    document.body.innerHTML = `
      <div id="editor" contenteditable>
        <div>会議は明日です。</div>
        <div id="appendonsend"></div>
        <hr>
        <div id="divRplyFwdMsg">From: Alex</div>
        <div id="quoted">Quoted original that must survive</div>
        <div id="Signature">Sent from Outlook</div>
      </div>
    `;
    const field = document.querySelector('#editor');
    if (!(field instanceof HTMLElement)) throw new Error('missing editor');
    expect(readComposeText(field)).toContain('会議は明日です。');
    expect(readComposeText(field)).not.toContain('From: Alex');
    expect(readComposeText(field)).not.toContain('Quoted original');
    expect((await replaceComposeText(field, 'The meeting is tomorrow.')).ok).toBe(true);
    expect(field.querySelector('#appendonsend')).not.toBeNull();
    expect(field.querySelector('hr')).not.toBeNull();
    expect(field.querySelector('#divRplyFwdMsg')?.textContent).toContain('From: Alex');
    expect(field.querySelector('#quoted')?.textContent).toContain(
      'Quoted original that must survive',
    );
    expect(field.querySelector('#Signature')?.textContent).toContain('Sent from Outlook');
  });

  /**
   * Slate (and Lexical, ProseMirror, Draft) keep the document in JS. Writing `textContent`
   * leaves that document on the original draft, so Enter would send the untranslated text.
   * The replacement has to go through `beforeinput` / `insertText` so the editor updates.
   */
  it('replaces a Slate-style editor through beforeinput so its document matches', async () => {
    const editor = mountSlate('日本語の下書き');
    document.body.append(editor);
    editor.focus();
    const result = await replaceComposeText(editor, 'English draft');
    expect(result.ok).toBe(true);
    expect(result.method).toBe('beforeinput');
    expect(editor.slateValue).toBe('English draft');
    expect(readComposeText(editor).replace(/\n$/u, '')).toBe('English draft');
  });

  it('undoes a Slate-style replace through beforeinput so the internal model matches', async () => {
    const editor = mountSlate('日本語の下書き', { asyncSelection: true });
    document.body.append(editor);
    editor.focus();
    const snapshot = snapshotComposeField(editor);
    const replaced = await replaceComposeText(editor, 'English draft');
    expect(replaced.ok).toBe(true);
    expect(replaced.method).toBe('beforeinput');
    expect(editor.slateValue).toBe('English draft');
    const undone = await undoComposeReplace(editor, snapshot, replaced.method);
    expect(undone.ok).toBe(true);
    expect(editor.slateValue).toBe('日本語の下書き');
    expect(readComposeText(editor).replace(/\n$/u, '')).toBe('日本語の下書き');
  });

  it('treats a canceled beforeinput as success only after the document matches', async () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = 'original';
    let beforeCount = 0;
    editor.addEventListener('beforeinput', (event) => {
      beforeCount += 1;
      event.preventDefault();
      editor.textContent = 'translated';
    });
    document.body.append(editor);
    editor.focus();
    const result = await replaceComposeText(editor, 'translated');
    expect(beforeCount).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('beforeinput');
  });

  it('does not treat a canceled beforeinput as success when the document stays put', async () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = 'original';
    editor.addEventListener('beforeinput', (event) => {
      event.preventDefault();
    });
    document.body.append(editor);
    editor.focus();
    const result = await replaceComposeText(editor, 'translated');
    expect(result.ok).toBe(true);
    expect(readComposeText(editor).replace(/\n$/u, '')).toBe('translated');
  });

  it('stops after a beforeinput handler mutates the field without canceling', async () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = 'original';
    let inserts = 0;
    editor.addEventListener('beforeinput', () => {
      inserts += 1;
      editor.textContent = `${editor.textContent ?? ''}X`;
    });
    const exec = document.execCommand;
    document.execCommand = ((command: string) => {
      if (command === 'insertText') inserts += 1;
      return typeof exec === 'function' ? exec.call(document, command) : false;
    }) as typeof document.execCommand;
    document.body.append(editor);
    editor.focus();
    const result = await replaceComposeText(editor, 'translated');
    document.execCommand = exec;
    expect(inserts).toBe(1);
    expect(result.ok).toBe(true);
    expect(editor.textContent).toBe('originalX');
  });

  it('waits for a Slate-style selectionchange before inserting', async () => {
    const editor = mountSlate('日本語の下書き', { asyncSelection: true });
    document.body.append(editor);
    editor.focus();
    const result = await replaceComposeText(editor, 'English draft');
    expect(result.ok).toBe(true);
    expect(editor.slateValue).toBe('English draft');
  });

  it('waits for an async Slate render and writes only once', async () => {
    const editor = mountSlate(
      'こんにちはー！！これはSakuttoの入力リアルタイム翻訳機能を使ってコメントしています。',
      {
        asyncApply: true,
      },
    );
    document.body.append(editor);
    editor.focus();
    const snapshot = snapshotComposeField(editor);
    const result = await replaceComposeText(
      editor,
      "Hi there!! I'm commenting using Sakutto's real-time input translation feature.",
    );
    expect(result.ok).toBe(true);
    expect(editor.beforeCount).toBe(1);
    expect(editor.slateValue).toBe(
      "Hi there!! I'm commenting using Sakutto's real-time input translation feature.",
    );
    expect(editor.slateValue.includes('Hi there!!')).toBe(true);
    expect(
      editor.slateValue.split(
        "Hi there!! I'm commenting using Sakutto's real-time input translation feature.",
      ).length - 1,
    ).toBe(1);

    const undone = await undoComposeReplace(editor, snapshot, result.method);
    expect(undone.ok).toBe(true);
    expect(editor.slateValue).toBe(
      'こんにちはー！！これはSakuttoの入力リアルタイム翻訳機能を使ってコメントしています。',
    );

    const again = await undoComposeReplace(editor, snapshot, result.method);
    expect(again.ok).toBe(true);
    expect(editor.beforeCount).toBe(2);
    expect(editor.slateValue).toBe(
      'こんにちはー！！これはSakuttoの入力リアルタイム翻訳機能を使ってコメントしています。',
    );
  });

  it('serializes a second replace so a double trigger cannot insert twice', async () => {
    const editor = mountSlate('日本語の下書き', { asyncApply: true });
    document.body.append(editor);
    editor.focus();
    const first = replaceComposeText(editor, 'English draft');
    const second = replaceComposeText(editor, 'English draft');
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(editor.beforeCount).toBe(1);
    expect(editor.slateValue).toBe('English draft');
  });

  it('ignores zero-width characters when verifying a write', () => {
    expect(textsMatch('Hi\u200B there', 'Hi there')).toBe(true);
    expect(textsMatch('Hi\u00A0there', 'Hi there')).toBe(true);
  });

  it('prefers native undo so formatting can come back after insertText', async () => {
    document.body.innerHTML = '<div id="editor" contenteditable><b>hello</b></div>';
    const field = document.querySelector('#editor');
    if (!(field instanceof HTMLElement)) throw new Error('missing editor');
    const snapshot = snapshotComposeField(field);
    field.textContent = 'translated';
    const exec = document.execCommand;
    let undone = false;
    document.execCommand = ((command: string) => {
      if (command === 'undo') {
        undone = true;
        field.innerHTML = '<b>hello</b>';
        return true;
      }
      return typeof exec === 'function' ? exec.call(document, command) : false;
    }) as typeof document.execCommand;
    const result = await undoComposeReplace(field, snapshot, 'insertText');
    document.execCommand = exec;
    expect(undone).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('undo');
    expect(field.querySelector('b')?.textContent).toBe('hello');
  });

  it('does not use execCommand undo after a native value write', async () => {
    document.body.innerHTML = '<textarea id="box">typed more</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    const snapshot = snapshotComposeField(field);
    field.value = 'translated';
    const exec = document.execCommand;
    let undone = false;
    document.execCommand = ((command: string) => {
      if (command === 'undo') {
        undone = true;
        field.value = 'typed';
        return true;
      }
      return typeof exec === 'function' ? exec.call(document, command) : false;
    }) as typeof document.execCommand;
    const result = await undoComposeReplace(field, snapshot, 'native');
    document.execCommand = exec;
    expect(undone).toBe(false);
    expect(result.ok).toBe(true);
    expect(field.value).toBe('typed more');
  });

  it('falls back to the snapshot when execCommand undo reverts too far', async () => {
    document.body.innerHTML = '<textarea id="box">typed more</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    const snapshot = snapshotComposeField(field);
    field.value = 'translated';
    const exec = document.execCommand;
    document.execCommand = ((command: string) => {
      if (command === 'undo') {
        field.value = 'typed';
        return true;
      }
      return typeof exec === 'function' ? exec.call(document, command) : false;
    }) as typeof document.execCommand;
    const result = await undoComposeReplace(field, snapshot, 'insertText');
    document.execCommand = exec;
    expect(result.ok).toBe(true);
    expect(field.value).toBe('typed more');
  });

  it('restores the whole textarea after replacing a selected span', async () => {
    document.body.innerHTML = '<textarea id="box">Hello world extra</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    const snapshot = snapshotComposeField(field);
    field.setSelectionRange(0, 5);
    expect((await replaceComposeText(field, 'Bonjour')).ok).toBe(true);
    expect(field.value).toBe('Bonjour world extra');
    expect((await undoComposeReplace(field, snapshot, 'native')).ok).toBe(true);
    expect(field.value).toBe('Hello world extra');
  });

  it('replaces the selected occurrence when the same text appears twice', async () => {
    document.body.innerHTML = '<textarea id="box">foo foo bar</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.setSelectionRange(4, 7);
    expect(readComposeText(field)).toBe('foo');
    expect((await replaceComposeText(field, 'baz')).ok).toBe(true);
    expect(field.value).toBe('foo baz bar');
  });

  it('treats extra Gmail-style newlines as the same draft when verifying', () => {
    expect(
      textsMatch('See you tomorrow.\n\nAt the station.', 'See you tomorrow.\nAt the station.'),
    ).toBe(true);
  });

  it('offsets a same-origin iframe field by the frame rect', () => {
    const frame = document.createElement('div');
    document.body.append(frame);
    Object.defineProperty(frame, 'getBoundingClientRect', {
      value: () => new DOMRect(20, 30, 400, 300),
    });
    Object.defineProperty(frame, 'clientLeft', { configurable: true, value: 2 });
    Object.defineProperty(frame, 'clientTop', { configurable: true, value: 3 });
    const inner = document.implementation.createHTMLDocument('frame');
    Object.defineProperty(inner, 'defaultView', {
      configurable: true,
      value: { frameElement: frame },
    });
    const field = inner.createElement('textarea');
    inner.body.append(field);
    Object.defineProperty(field, 'getBoundingClientRect', {
      value: () => new DOMRect(4, 5, 100, 40),
    });
    const rect = composeFieldRect(field, document);
    expect(rect?.left).toBe(26);
    expect(rect?.top).toBe(38);
    expect(rect?.width).toBe(100);
    Object.defineProperty(inner, 'defaultView', {
      configurable: true,
      value: { frameElement: null },
    });
    expect(composeFieldRect(field, document)).toBeNull();
  });

  it('does not write into a password field', async () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2">';
    const field = document.querySelector('#pw');
    if (!(field instanceof HTMLInputElement)) throw new Error('missing password');
    expect((await replaceComposeText(field, 'Hello')).ok).toBe(false);
    expect(field.value).toBe('hunter2');
  });

  it('finds the focused compose field and ignores a password that has focus', () => {
    document.body.innerHTML = `
      <textarea id="box">hello</textarea>
      <input id="pw" type="password" value="secret">
    `;
    const box = document.querySelector('#box');
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    box.focus();
    expect(focusedComposeField(document)).toBe(box);

    const password = document.querySelector('#pw');
    if (!(password instanceof HTMLInputElement)) throw new Error('missing password');
    password.focus();
    expect(focusedComposeField(document)).toBeNull();
  });

  it('climbs from a focused Slate span to the contenteditable textbox', () => {
    const editor = mountSlate('hello');
    const span = editor.querySelector('[data-slate-node="text"]');
    if (!(span instanceof HTMLElement)) throw new Error('missing slate span');
    expect(composeEditableRoot(span)).toBe(editor);
    expect(isComposeCandidate(editor)).toBe(true);
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => span,
    });
    try {
      expect(focusedComposeField(document)).toBe(editor);
      expect(shouldHandleComposeCommand(document)).toBe(true);
    } finally {
      Reflect.deleteProperty(document, 'activeElement');
    }
  });

  it('collapses a leftover insertText selection so later typing is not the old translation', () => {
    document.body.innerHTML = '<textarea id="box">Hello world</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    field.setSelectionRange(0, field.value.length);
    expect(readComposeText(field)).toBe('Hello world');
    collapseComposeCaret(field);
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
    expect(readComposeText(field)).toBe('Hello world');
    expect(readDraftRegionText(field)).toBe('Hello world');
  });

  it('collapses a contenteditable selection to the end of the draft', () => {
    document.body.innerHTML = '<div id="box" contenteditable="true">Hello world</div>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLElement)) throw new Error('missing editor');
    const selected = document.createRange();
    selected.selectNodeContents(field);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selected);
    expect(readComposeText(field)).toBe('Hello world');
    collapseComposeCaret(field);
    const collapsed = document.getSelection();
    expect(collapsed?.isCollapsed).toBe(true);
    expect(readDraftRegionText(field)).toBe('Hello world');
  });

  it('climbs from a child of role=textbox when that root is not contenteditable', () => {
    document.body.innerHTML = '<div role="textbox" id="box"><span id="caret">x</span></div>';
    const box = document.querySelector('#box');
    const caret = document.querySelector('#caret');
    if (!(box instanceof HTMLElement) || !(caret instanceof HTMLElement)) {
      throw new Error('missing textbox');
    }
    expect(composeEditableRoot(caret)).toBe(box);
    expect(isComposeCandidate(box)).toBe(true);
    caret.focus();
    expect(focusedComposeField(document)).toBe(box);
  });
});

describe('page translation leaves drafts and compose UI alone', () => {
  it('does not collect the text inside a textarea or contenteditable', () => {
    document.body.innerHTML = `
      <p>Page copy to translate</p>
      <textarea>This is my unsent draft</textarea>
      <div contenteditable>Another unsent draft</div>
    `;
    const blocks = listTranslatableBlocks(document).map((block) =>
      (block.textContent ?? '').trim(),
    );
    expect(blocks).toEqual(['Page copy to translate']);
  });

  it('skips the compose panel the way it skips the other overlay hosts', () => {
    document.body.innerHTML = '';
    const host = document.createElement('sakutto-compose');
    host.textContent = 'Draft translation Hello there';
    document.body.append(host);
    expect(isTranslationExcluded(host)).toBe(true);
    expect(listTranslatableBlocks(document)).toEqual([]);
  });
});
