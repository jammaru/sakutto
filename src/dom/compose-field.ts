import { collectDocuments, focusedEditableField, isOwnUi } from './blocks';

const COMPOSE_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search']);

const SENSITIVE_AUTOCOMPLETE_EXACT: ReadonlySet<string> = new Set([
  'password',
  'current-password',
  'new-password',
  'one-time-code',
]);

const SENSITIVE_INPUTMODES: ReadonlySet<string> = new Set(['numeric', 'tel', 'email']);

const SENSITIVE_ROLES: ReadonlySet<string> = new Set(['searchbox', 'combobox']);

/** Names that mean the control holds a secret, not copy a reader would translate. */
const SENSITIVE_NAME =
  /(?:^|[^a-z0-9])(?:password|passwd|pwd|secret|ssn|cvv|cvc|otp|token|pin|api[_-]?key)(?:[^a-z0-9]|$)/iu;

/**
 * Reply chrome that must not be sent through the model or overwritten: Gmail's signature and
 * quoted history, Outlook's reply header and signature block.
 */
export const COMPOSE_EXCLUDED_SELECTOR = [
  '.gmail_signature',
  '[data-smartmail="gmail_signature"]',
  '.gmail_quote',
  'blockquote.gmail_quote',
  '#divRplyFwdMsg',
  '[id$="divRplyFwdMsg"]',
  '#Signature',
].join(', ');

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

function isSensitiveAutocomplete(token: string): boolean {
  if (SENSITIVE_AUTOCOMPLETE_EXACT.has(token)) return true;
  return token.startsWith('cc-');
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
  const inputMode = field.getAttribute('inputmode')?.toLowerCase();
  if (inputMode && SENSITIVE_INPUTMODES.has(inputMode)) return true;
  for (const token of autocompleteTokens(field)) {
    if (isSensitiveAutocomplete(token)) return true;
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
 * The あA button sits on a message box, not on a search field or a combobox. Those can still
 * be translated from the shortcut or the context menu.
 */
export function showsComposeIcon(field: Element): boolean {
  if (!isComposeCandidate(field)) return false;
  if (field instanceof HTMLInputElement && field.type === 'search') return false;
  const role = field.getAttribute('role');
  if (role && SENSITIVE_ROLES.has(role)) return false;
  return true;
}

/**
 * True when the right-click target is a compose field that is allowed to be translated.
 * Password and other secrets return false so the context menu item can be hidden.
 */
export function isComposeMenuTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || isOwnUi(target)) return false;
  const field =
    focusedEditableField(target) ?? target.closest('textarea, input, [contenteditable]');
  return field !== null && isComposeCandidate(field);
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

export function textsMatch(actual: string, wanted: string): boolean {
  return actual.replace(/^\s+|\s+$/gu, '') === wanted.replace(/^\s+|\s+$/gu, '');
}

function firstExcluded(field: Element): Element | null {
  const hit = field.querySelector(COMPOSE_EXCLUDED_SELECTOR);
  return hit && field.contains(hit) ? hit : null;
}

function nodeInside(field: Element, node: Node): boolean {
  return field === node || field.contains(node);
}

/**
 * The body of the message, without Gmail/Outlook signature and quoted history. A user
 * selection inside the field, when there is one, wins so a partial rewrite does not touch
 * the rest of the thread.
 */
export function readComposeDraft(field: Element): { text: string; selection: boolean } {
  const selected = selectedComposeText(field);
  if (selected !== null) return { text: selected, selection: true };
  return { text: readDraftRegionText(field), selection: false };
}

/**
 * What the reader has typed. Native fields expose `value`; a contenteditable region is
 * read through the draft region so a signature or quoted reply is not sent to the model.
 */
export function readComposeText(field: Element): string {
  return readComposeDraft(field).text;
}

export function readDraftRegionText(field: Element): string {
  if (isNativeTextField(field)) return lineBreaks(field.value);
  if (!firstExcluded(field)) {
    if (field instanceof HTMLElement && typeof field.innerText === 'string') {
      return lineBreaks(field.innerText);
    }
    return lineBreaks(field.textContent ?? '');
  }
  const clone = field.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return lineBreaks(field.textContent ?? '');
  for (const node of [...clone.querySelectorAll(COMPOSE_EXCLUDED_SELECTOR)]) node.remove();
  return lineBreaks(clone.innerText);
}

function selectionTouchesExcluded(field: Element, selection: Selection): boolean {
  const selected = selection.toString();
  for (const node of field.querySelectorAll(COMPOSE_EXCLUDED_SELECTOR)) {
    if (typeof selection.containsNode === 'function' && selection.containsNode(node, true)) {
      return true;
    }
    const piece = (node instanceof HTMLElement ? node.innerText : node.textContent) ?? '';
    if (piece.trim().length > 0 && selected.includes(piece.trim())) return true;
  }
  return false;
}

function selectedComposeText(field: Element): string | null {
  if (isNativeTextField(field)) {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (start === null || end === null || start === end) return null;
    return lineBreaks(field.value.slice(start, end));
  }
  const selection = field.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!nodeInside(field, range.commonAncestorContainer)) return null;
  if (selectionTouchesExcluded(field, selection)) return null;
  const text = lineBreaks(selection.toString());
  return text.trim().length === 0 ? null : text;
}

function nativeSpan(field: HTMLInputElement | HTMLTextAreaElement): {
  start: number;
  end: number;
} | null {
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

function surfaceOf(field: Element): string {
  if (isNativeTextField(field)) return field.value;
  return field.innerHTML;
}

export type ComposeReplaceMethod = 'insertText' | 'beforeinput' | 'native' | 'undo';

export interface ComposeReplaceResult {
  ok: boolean;
  method: ComposeReplaceMethod | null;
}

function focusField(field: Element): void {
  if (field instanceof HTMLElement) field.focus();
}

function notifySelection(field: Element): void {
  field.ownerDocument.dispatchEvent(new Event('selectionchange'));
}

function selectNative(field: HTMLInputElement | HTMLTextAreaElement): boolean {
  focusField(field);
  try {
    field.setSelectionRange(0, field.value.length);
    notifySelection(field);
    return true;
  } catch {
    return false;
  }
}

function selectDraftRegion(field: Element): boolean {
  const doc = field.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) return false;
  try {
    const range = doc.createRange();
    const keep = new Set(siblingExcludedBlocks(field));
    const draft = [...field.childNodes].filter((node) => {
      if (keep.has(node)) return false;
      if (node instanceof Text && (node.textContent ?? '').trim().length === 0) return false;
      return true;
    });
    if (draft.length > 0) {
      range.setStartBefore(draft[0]!);
      range.setEndAfter(draft[draft.length - 1]!);
    } else if (keep.size > 0) {
      range.setStart(field, 0);
      range.setEndBefore(keep.values().next().value as Node);
    } else {
      range.selectNodeContents(field);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    notifySelection(field);
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

function tryExecUndo(doc: Document): boolean {
  const command = doc.execCommand?.bind(doc);
  if (typeof command !== 'function') return false;
  try {
    return command('undo') === true;
  } catch {
    return false;
  }
}

function clipboardFor(text: string, doc: Document): DataTransfer | null {
  const view = doc.defaultView;
  const Ctor = view?.DataTransfer ?? globalThis.DataTransfer;
  if (typeof Ctor !== 'function') return null;
  try {
    const data = new Ctor();
    data.setData('text/plain', text);
    return data;
  } catch {
    return null;
  }
}

function createBeforeInput(
  field: Element,
  inputType: string,
  text: string,
  dataTransfer: DataTransfer | null,
): Event {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  const InputEventCtor = view?.InputEvent ?? InputEvent;
  const init: InputEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType,
    data: text,
  };
  if (dataTransfer) {
    (init as InputEventInit & { dataTransfer?: DataTransfer }).dataTransfer = dataTransfer;
  }
  const event = new InputEventCtor('beforeinput', init);
  if (dataTransfer && event.dataTransfer !== dataTransfer) {
    try {
      Object.defineProperty(event, 'dataTransfer', { configurable: true, value: dataTransfer });
    } catch {
      // Some runtimes freeze dataTransfer on the event.
    }
  }
  return event;
}

function dispatchBeforeInput(
  field: Element,
  inputType: string,
  text: string,
  dataTransfer: DataTransfer | null,
): void {
  field.dispatchEvent(createBeforeInput(field, inputType, text, dataTransfer));
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

function siblingExcludedBlocks(field: Element): ChildNode[] {
  return [...field.childNodes].filter((child) => {
    if (!(child instanceof Element)) return false;
    return (
      child.matches(COMPOSE_EXCLUDED_SELECTOR) || child.querySelector(COMPOSE_EXCLUDED_SELECTOR)
    );
  });
}

function applyNativeContents(field: Element, text: string): boolean {
  const doc = field.ownerDocument;
  const keep = siblingExcludedBlocks(field);
  if (keep.length > 0) {
    const lead = doc.createTextNode(text);
    field.replaceChildren(lead, ...keep);
    dispatchNativeInput(field, text, 'insertText');
    return true;
  }
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
  return true;
}

function expectedDraft(field: Element, translation: string): string {
  const selected = selectedComposeText(field);
  if (selected === null) return translation;
  if (isNativeTextField(field)) {
    const span = nativeSpan(field);
    if (!span) return translation;
    return field.value.slice(0, span.start) + translation + field.value.slice(span.end);
  }
  const current = readDraftRegionText(field);
  const index = current.indexOf(selected);
  if (index < 0) return translation;
  return current.slice(0, index) + translation + current.slice(index + selected.length);
}

/**
 * Wait one frame so a rich editor can sync its selection (Slate listens on
 * `selectionchange`) and so a `beforeinput` handler can finish rewriting the document
 * before we decide whether the strategy worked.
 */
export function nextComposeFrame(doc: Document): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const view = doc.defaultView;
    if (view && typeof view.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => finish());
    }
    setTimeout(finish, 16);
  });
}

type StrategyOutcome = 'ok' | 'changed' | 'noop';

async function afterStrategy(
  field: Element,
  expected: string,
  before: string,
  preserved: readonly Element[],
): Promise<StrategyOutcome> {
  await nextComposeFrame(field.ownerDocument);
  const kept = preserved.every((node) => node.isConnected && field.contains(node));
  if (textsMatch(readDraftRegionText(field), expected) && kept) return 'ok';
  if (surfaceOf(field) !== before || !kept) return 'changed';
  return 'noop';
}

/**
 * Replaces the draft (or the current selection) with `text` in a way the host editor will
 * accept.
 *
 * Rich editors (Slate, Lexical, ProseMirror, Draft) ignore a write to `textContent`:
 * their document lives in JS, and a DOM rewrite leaves that document on the original
 * draft, so pressing Enter would send the untranslated text. The replacement therefore
 * keeps or restores a selection and goes through `beforeinput` / `execCommand('insertText')`,
 * then checks the field after a frame so a cancelled event is not treated as success and a
 * handler that does not cancel cannot be stacked with the next strategy.
 *
 * Signature and quoted-history blocks are left out of the selection so a Gmail or Outlook
 * compose does not lose them. Native inputs use the prototype setter so a framework that
 * hooked `value` still sees the write, then an `input` event.
 */
export async function replaceComposeText(
  field: Element,
  text: string,
): Promise<ComposeReplaceResult> {
  if (!isComposeCandidate(field)) return { ok: false, method: null };

  const expected = expectedDraft(field, text);
  const preserved = [...field.querySelectorAll(COMPOSE_EXCLUDED_SELECTOR)];

  if (isNativeTextField(field)) {
    const span = nativeSpan(field);
    if (!span) selectNative(field);
    const run = async (
      method: ComposeReplaceMethod,
      act: () => void,
    ): Promise<ComposeReplaceResult | null> => {
      const before = surfaceOf(field);
      act();
      const outcome = await afterStrategy(field, expected, before, preserved);
      if (outcome === 'ok') return { ok: true, method };
      if (outcome === 'changed') return { ok: false, method };
      return null;
    };

    const inserted = await run('insertText', () => {
      tryExecInsert(field.ownerDocument, text);
    });
    if (inserted) return inserted;

    const beforeInput = await run('beforeinput', () => {
      dispatchBeforeInput(field, 'insertText', text, null);
    });
    if (beforeInput) return beforeInput;

    const before = surfaceOf(field);
    setNativeValue(field, expected);
    dispatchNativeInput(field, text, 'insertReplacementText');
    const outcome = await afterStrategy(field, expected, before, preserved);
    return { ok: outcome === 'ok', method: 'native' };
  }

  focusField(field);
  if (selectedComposeText(field) === null) selectDraftRegion(field);
  await nextComposeFrame(field.ownerDocument);

  const run = async (
    method: ComposeReplaceMethod,
    act: () => void,
  ): Promise<ComposeReplaceResult | null> => {
    const before = surfaceOf(field);
    act();
    const outcome = await afterStrategy(field, expected, before, preserved);
    if (outcome === 'ok') return { ok: true, method };
    if (outcome === 'changed') return { ok: false, method };
    return null;
  };

  const insertText = await run('beforeinput', () => {
    dispatchBeforeInput(field, 'insertText', text, null);
  });
  if (insertText) return insertText;

  const paste = await run('beforeinput', () => {
    dispatchBeforeInput(field, 'insertFromPaste', text, clipboardFor(text, field.ownerDocument));
  });
  if (paste) return paste;

  // insertText on a range that starts at the contenteditable root can swallow sibling
  // signature and quote blocks in Gmail/Outlook. Skip it when those nodes are present.
  if (preserved.length === 0) {
    const command = await run('insertText', () => {
      tryExecInsert(field.ownerDocument, text);
    });
    if (command) return command;
  }

  const before = surfaceOf(field);
  applyNativeContents(field, text);
  const outcome = await afterStrategy(field, expected, before, preserved);
  return { ok: outcome === 'ok', method: outcome === 'ok' ? 'native' : null };
}

/**
 * Restores the last compose replacement through the editor's own undo stack when that
 * works, so formatting, signatures and quoted history come back. Falls back to rewriting
 * the stored draft text when `execCommand('undo')` does nothing.
 */
export async function undoComposeReplace(
  field: Element,
  fallback: string,
): Promise<ComposeReplaceResult> {
  if (!isComposeCandidate(field)) return { ok: false, method: null };
  focusField(field);
  if (tryExecUndo(field.ownerDocument)) {
    await nextComposeFrame(field.ownerDocument);
    return { ok: true, method: 'undo' };
  }
  return replaceComposeText(field, fallback);
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
