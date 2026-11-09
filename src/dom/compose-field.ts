import { collectDocuments, focusedEditableField, isOwnUi } from './blocks';

const COMPOSE_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search']);

const SENSITIVE_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'password',
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]);

/** Names that mean the control holds a secret, not copy a reader would translate. */
const SENSITIVE_NAME = /(?:^|[^a-z0-9])(?:password|passwd|pwd|secret|ssn|cvv|cvc)(?:[^a-z0-9]|$)/iu;

export function isNativeTextField(field: Element): field is HTMLInputElement | HTMLTextAreaElement {
  return field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement;
}

function isContentEditable(field: Element): boolean {
  if (field instanceof HTMLElement && field.isContentEditable) return true;
  const value = field.getAttribute('contenteditable');
  return value !== null && value !== 'false';
}

function autocompleteTokens(field: Element): string[] {
  const raw = field.getAttribute('autocomplete') ?? '';
  return raw
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

/**
 * True when the control holds a secret or a value that is not prose. Password fields, card
 * numbers, one-time codes and the usual identifier inputs are refused here so a compose
 * translation cannot read them or write into them.
 */
export function isSensitiveField(field: Element): boolean {
  if (field instanceof HTMLInputElement) {
    const type = field.type;
    if (type === 'password' || type === 'hidden') return true;
    if (!COMPOSE_INPUT_TYPES.has(type)) return true;
  }
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    if (field.readOnly || field.disabled) return true;
  }
  if (field.getAttribute('aria-disabled') === 'true') return true;
  for (const token of autocompleteTokens(field)) {
    if (SENSITIVE_AUTOCOMPLETE.has(token)) return true;
  }
  const name = `${field.getAttribute('name') ?? ''} ${field.getAttribute('id') ?? ''}`;
  return SENSITIVE_NAME.test(name);
}

/**
 * True when this element is a box the reader types prose into, and that prose is allowed
 * to be translated. Own UI, secrets, and non-text inputs are out.
 */
export function isComposeCandidate(field: Element): boolean {
  if (isOwnUi(field)) return false;
  if (isSensitiveField(field)) return false;
  if (field instanceof HTMLTextAreaElement) return true;
  if (field instanceof HTMLInputElement) return COMPOSE_INPUT_TYPES.has(field.type);
  return isContentEditable(field);
}

/**
 * The focused compose field across this page and same-origin frames, or `null`.
 *
 * `document.activeElement` stops at an iframe or a shadow host; `focusedEditableField`
 * already walks open shadow roots, and `collectDocuments` walks readable frames, so a
 * Gmail compose iframe is found the same way a top-level textarea is.
 */
export function focusedComposeField(root: Document): Element | null {
  for (const doc of collectDocuments(root)) {
    const field = focusedEditableField(doc.activeElement);
    if (field && isComposeCandidate(field)) return field;
  }
  return null;
}

function lineBreaks(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

/**
 * What the reader has typed. Native fields expose `value`; a contenteditable region is
 * read through `innerText` so a visual line break stays a line break.
 */
export function readComposeText(field: Element): string {
  if (isNativeTextField(field)) return lineBreaks(field.value);
  if (field instanceof HTMLElement && typeof field.innerText === 'string') {
    return lineBreaks(field.innerText);
  }
  return lineBreaks(field.textContent ?? '');
}

export type ComposeReplaceMethod = 'insertText' | 'beforeinput' | 'native';

export interface ComposeReplaceResult {
  ok: boolean;
  method: ComposeReplaceMethod | null;
}

function focusField(field: Element): void {
  if (field instanceof HTMLElement) field.focus();
}

function selectNative(field: HTMLInputElement | HTMLTextAreaElement): boolean {
  focusField(field);
  try {
    field.setSelectionRange(0, field.value.length);
    return true;
  } catch {
    return false;
  }
}

function selectContents(field: Element): boolean {
  const doc = field.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) return false;
  try {
    const range = doc.createRange();
    range.selectNodeContents(field);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

function tryExecInsert(doc: Document, text: string): boolean {
  const command = doc.execCommand?.bind(doc);
  if (typeof command !== 'function') return false;
  try {
    return command('insertText', false, text) === true;
  } catch {
    return false;
  }
}

function dispatchEditorInput(field: Element, inputType: string, text: string): boolean {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  const InputEventCtor = view?.InputEvent ?? InputEvent;
  const before = new InputEventCtor('beforeinput', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType,
    data: text,
  });
  const allowed = field.dispatchEvent(before);
  if (!allowed || before.defaultPrevented) {
    field.dispatchEvent(
      new InputEventCtor('input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        inputType,
        data: text,
      }),
    );
    return true;
  }
  return false;
}

function setNativeValue(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(field, text);
  else field.value = text;
  if (field.value !== text) field.value = text;
}

function dispatchNativeInput(field: Element, text: string, inputType: string): void {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  const InputEventCtor = view?.InputEvent ?? InputEvent;
  field.dispatchEvent(
    new InputEventCtor('input', {
      bubbles: true,
      cancelable: false,
      composed: true,
      inputType,
      data: text,
    }),
  );
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function applyNativeContents(field: Element, text: string): boolean {
  const doc = field.ownerDocument;
  const selection = doc.getSelection();
  if (selection && selection.rangeCount > 0) {
    try {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (index > 0) range.insertNode(doc.createElement('br'));
        if (line.length > 0) {
          const node = doc.createTextNode(line);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
        }
      }
      selection.removeAllRanges();
      selection.addRange(range);
      dispatchNativeInput(field, text, 'insertText');
      return true;
    } catch {
      // Fall through to rewriting the subtree.
    }
  }
  field.textContent = text;
  dispatchNativeInput(field, text, 'insertText');
  return (
    readComposeText(field).replace(/\n$/u, '') === text.replace(/\n$/u, '') ||
    (field.textContent ?? '') === text
  );
}

function textsMatch(actual: string, wanted: string): boolean {
  return actual.replace(/\n$/u, '') === wanted.replace(/\n$/u, '');
}

/**
 * Replaces the field's contents with `text` in a way the host editor will accept.
 *
 * Rich editors (Slate, Lexical, ProseMirror, Draft) ignore a write to `textContent`:
 * their document lives in JS, and a DOM rewrite leaves that document on the original
 * draft, so pressing Enter would send the untranslated text. The replacement therefore
 * selects the current contents and goes through `execCommand('insertText')` or a
 * `beforeinput` the editor already listens to, which is also what keeps the undo stack
 * and the caret coherent.
 *
 * Native inputs use the prototype setter so a framework that hooked `value` still sees
 * the write, then an `input` event.
 */
export function replaceComposeText(field: Element, text: string): ComposeReplaceResult {
  if (!isComposeCandidate(field)) return { ok: false, method: null };

  if (isNativeTextField(field)) {
    selectNative(field);
    if (tryExecInsert(field.ownerDocument, text) && textsMatch(field.value, text)) {
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, method: 'insertText' };
    }
    if (dispatchEditorInput(field, 'insertText', text) && textsMatch(field.value, text)) {
      return { ok: true, method: 'beforeinput' };
    }
    setNativeValue(field, text);
    dispatchNativeInput(field, text, 'insertReplacementText');
    return { ok: textsMatch(field.value, text), method: 'native' };
  }

  focusField(field);
  selectContents(field);
  // Synthetic `beforeinput` first: editors that keep their document in JS (Slate, Lexical)
  // already listen for it, and an untrusted event is enough for that listener. `execCommand`
  // still follows, because a real Discord/Outlook editor may ignore untrusted input and
  // only accept the trusted `insertText` Chrome synthesises from the command.
  if (dispatchEditorInput(field, 'insertText', text)) {
    return { ok: true, method: 'beforeinput' };
  }
  if (dispatchEditorInput(field, 'insertFromPaste', text)) {
    return { ok: true, method: 'beforeinput' };
  }
  if (tryExecInsert(field.ownerDocument, text) && textsMatch(readComposeText(field), text)) {
    return { ok: true, method: 'insertText' };
  }
  const ok = applyNativeContents(field, text);
  return { ok, method: ok ? 'native' : null };
}

/** The box used to park the compose icon, clamped to the visible part of the field. */
export function composeFieldRect(field: Element): DOMRect {
  const rect = field.getBoundingClientRect();
  const view = field.ownerDocument.defaultView;
  const width = view?.innerWidth ?? 800;
  const height = view?.innerHeight ?? 600;
  const left = Math.min(Math.max(rect.left, 8), Math.max(8, width - 8));
  const top = Math.min(Math.max(rect.top, 8), Math.max(8, height - 8));
  const right = Math.min(Math.max(rect.right, left), width - 8);
  const bottom = Math.min(Math.max(rect.bottom, top), height - 8);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
