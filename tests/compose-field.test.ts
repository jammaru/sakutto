// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isTranslationExcluded, listTranslatableBlocks } from '@/dom/blocks';
import {
  focusedComposeField,
  isComposeCandidate,
  isSensitiveField,
  readComposeText,
  replaceComposeText,
} from '@/dom/compose-field';

function mountSlate(initial: string): HTMLElement & { slateValue: string } {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('data-slate-editor', 'true');
  let value = initial;
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
  editor.addEventListener('beforeinput', (event) => {
    const input = event as InputEvent;
    if (input.inputType !== 'insertText' && input.inputType !== 'insertFromPaste') return;
    if (input.data === null || input.data === undefined) return;
    event.preventDefault();
    value = input.data;
    render();
  });
  render();
  Object.defineProperty(editor, 'slateValue', {
    get: () => value,
  });
  return editor as unknown as HTMLElement & { slateValue: string };
}

describe('compose field eligibility', () => {
  it('accepts a textarea, a text input and a contenteditable region', () => {
    document.body.innerHTML = `
      <textarea id="box">hello</textarea>
      <input id="search" type="search" value="query">
      <div id="editor" contenteditable>draft</div>
    `;
    expect(isComposeCandidate(document.querySelector('#box')!)).toBe(true);
    expect(isComposeCandidate(document.querySelector('#search')!)).toBe(true);
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
      <textarea id="ok">hello</textarea>
    `;
    expect(isSensitiveField(document.querySelector('#pw')!)).toBe(true);
    expect(isComposeCandidate(document.querySelector('#pw')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#hidden')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#number')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#otp')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#card')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#named')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#ok')!)).toBe(true);
  });

  it('refuses a read-only or disabled field', () => {
    document.body.innerHTML = `
      <textarea id="ro" readonly>locked</textarea>
      <input id="off" disabled value="no">
    `;
    expect(isComposeCandidate(document.querySelector('#ro')!)).toBe(false);
    expect(isComposeCandidate(document.querySelector('#off')!)).toBe(false);
  });
});

describe('reading and replacing compose text', () => {
  it('replaces a textarea through the value setter and an input event', () => {
    document.body.innerHTML = '<textarea id="box">こんにちは</textarea>';
    const field = document.querySelector('#box');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('missing textarea');
    const seen: string[] = [];
    field.addEventListener('input', () => {
      seen.push(field.value);
    });
    const result = replaceComposeText(field, 'Hello there');
    expect(result.ok).toBe(true);
    expect(field.value).toBe('Hello there');
    expect(seen).toContain('Hello there');
  });

  it('replaces a text input the same way', () => {
    document.body.innerHTML = '<input id="title" type="text" value="下書き">';
    const field = document.querySelector('#title');
    if (!(field instanceof HTMLInputElement)) throw new Error('missing input');
    expect(replaceComposeText(field, 'Draft').ok).toBe(true);
    expect(field.value).toBe('Draft');
    expect(readComposeText(field)).toBe('Draft');
  });

  it('replaces a plain contenteditable region', () => {
    document.body.innerHTML = '<div id="editor" contenteditable>会議は明日です</div>';
    const field = document.querySelector('#editor');
    if (!(field instanceof HTMLElement)) throw new Error('missing editor');
    expect(replaceComposeText(field, 'The meeting is tomorrow.').ok).toBe(true);
    expect(readComposeText(field).replace(/\n$/u, '')).toBe('The meeting is tomorrow.');
  });

  /**
   * Slate (and Lexical, ProseMirror, Draft) keep the document in JS. Writing `textContent`
   * leaves that document on the original draft, so Enter would send the untranslated text.
   * The replacement has to go through `beforeinput` / `insertText` so the editor updates.
   */
  it('replaces a Slate-style editor through beforeinput so its document matches', () => {
    const editor = mountSlate('日本語の下書き');
    document.body.append(editor);
    editor.focus();
    const result = replaceComposeText(editor, 'English draft');
    expect(result.ok).toBe(true);
    expect(result.method).toBe('beforeinput');
    expect(editor.slateValue).toBe('English draft');
    expect(readComposeText(editor).replace(/\n$/u, '')).toBe('English draft');
  });

  it('does not write into a password field', () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2">';
    const field = document.querySelector('#pw');
    if (!(field instanceof HTMLInputElement)) throw new Error('missing password');
    expect(replaceComposeText(field, 'Hello').ok).toBe(false);
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
