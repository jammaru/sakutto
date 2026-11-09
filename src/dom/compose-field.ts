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
 * Reply chrome that must not be sent through the model or overwritten. Assumed DOM:
 *
 * Gmail: draft lines, then `.gmail_signature_prefix` (`-- `), `.gmail_signature`,
 * `.gmail_quote` / `blockquote.gmail_quote`.
 *
 * Outlook web: draft, then `#appendonsend`, a preceding `<hr>`, `#divRplyFwdMsg`,
 * quoted-body siblings after that header, then `#Signature`. Quoted history is not
 * nested inside `#divRplyFwdMsg`; everything from the first of these markers onward
 * is kept, including that preceding `<hr>`.
 */
export const COMPOSE_EXCLUDED_SELECTOR = [
  '.gmail_signature',
  '.gmail_signature_prefix',
  '[data-smartmail="gmail_signature"]',
  '.gmail_quote',
  'blockquote.gmail_quote',
  '#divRplyFwdMsg',
  '[id$="divRplyFwdMsg"]',
  '#Signature',
  '#appendonsend',
  '[id="appendonsend"]',
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
 * Password and other secrets return false so the command can no-op with feedback; the
 * menu item itself stays visible on every editable because Chrome decides its contents
 * when the menu opens.
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

function normalizeForCompare(value: string): string {
  return lineBreaks(value)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/gu, '\n')
    .trim();
}

export function textsMatch(actual: string, wanted: string): boolean {
  return normalizeForCompare(actual) === normalizeForCompare(wanted);
}

function isHr(node: Node): boolean {
  return node instanceof HTMLHRElement || (node instanceof Element && node.localName === 'hr');
}

function isBlankText(node: Node): boolean {
  return node instanceof Text && (node.textContent ?? '').trim().length === 0;
}

function childHoldsExcluded(child: Node): boolean {
  if (!(child instanceof Element)) return false;
  return (
    child.matches(COMPOSE_EXCLUDED_SELECTOR) ||
    child.querySelector(COMPOSE_EXCLUDED_SELECTOR) !== null
  );
}

/**
 * First child of the compose root that must be kept: the earliest excluded marker, or a
 * preceding `<hr>` / whitespace. Everything from that node onward is quoted history,
 * signature, or Outlook's send-append marker — not the draft.
 */
export function firstPreservedChild(field: Element): ChildNode | null {
  const children = [...field.childNodes];
  const index = children.findIndex((child) => childHoldsExcluded(child));
  if (index < 0) return null;
  let start = index;
  while (start > 0) {
    const prev = children[start - 1]!;
    if (isBlankText(prev) || isHr(prev)) {
      start -= 1;
      continue;
    }
    break;
  }
  return children[start] ?? null;
}

export function preservedTail(field: Element): ChildNode[] {
  const start = firstPreservedChild(field);
  if (!start) return [];
  const nodes: ChildNode[] = [];
  for (let node: ChildNode | null = start; node; node = node.nextSibling) nodes.push(node);
  return nodes;
}

function nodeIsAtOrAfter(node: Node, cutoff: Node): boolean {
  if (node === cutoff) return true;
  if (cutoff.contains(node)) return true;
  const position = cutoff.compareDocumentPosition(node);
  return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
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

function visibleText(field: Element): string {
  if (field instanceof HTMLElement && typeof field.innerText === 'string') {
    return lineBreaks(field.innerText);
  }
  return lineBreaks(field.textContent ?? '');
}

export function readDraftRegionText(field: Element): string {
  if (isNativeTextField(field)) return lineBreaks(field.value);
  const clone = field.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return visibleText(field);
  const cutoff = firstPreservedChild(clone);
  if (cutoff) {
    while (cutoff.nextSibling) cutoff.nextSibling.remove();
    cutoff.remove();
  }
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

/** Whole-field snapshot taken before a replace, so undo can restore more than a selection. */
export interface ComposeSnapshot {
  text: string;
  html: string | null;
  draft: string;
}

export function snapshotComposeField(field: Element): ComposeSnapshot {
  if (isNativeTextField(field)) {
    return { text: field.value, html: null, draft: field.value };
  }
  return {
    text: visibleText(field),
    html: field.innerHTML,
    draft: readDraftRegionText(field),
  };
}

export function snapshotMatchesField(field: Element, snapshot: ComposeSnapshot): boolean {
  if (isNativeTextField(field)) return textsMatch(field.value, snapshot.text);
  if (snapshot.html !== null && field.innerHTML === snapshot.html) return true;
  return textsMatch(visibleText(field), snapshot.text);
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
    const keep = new Set(preservedTail(field));
    const draft = [...field.childNodes].filter((node) => {
      if (keep.has(node)) return false;
      if (isBlankText(node)) return false;
      return true;
    });
    if (draft.length > 0) {
      range.setStartBefore(draft[0]!);
      range.setEndAfter(draft[draft.length - 1]!);
    } else if (keep.size > 0) {
      range.setStart(field, 0);
      range.setEndBefore([...keep][0]!);
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

function draftUsesDivLines(field: Element, tail: readonly ChildNode[]): boolean {
  const draft = [...field.childNodes].filter((node) => !tail.includes(node) && !isBlankText(node));
  const elements = draft.filter((node): node is Element => node instanceof Element);
  if (tail.length > 0 && elements.length === 0) return true;
  return elements.length > 0 && elements.every((element) => element.localName === 'div');
}

function nodesForDraftLines(doc: Document, text: string, asDivs: boolean): Node[] {
  const lines = text.split('\n');
  if (asDivs) {
    return lines.map((line) => {
      const div = doc.createElement('div');
      if (line.length === 0) div.append(doc.createElement('br'));
      else div.append(doc.createTextNode(line));
      return div;
    });
  }
  const nodes: Node[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) nodes.push(doc.createElement('br'));
    if (line.length > 0) nodes.push(doc.createTextNode(line));
  }
  if (nodes.length === 0) nodes.push(doc.createTextNode(''));
  return nodes;
}

function applyNativeContents(field: Element, text: string): boolean {
  const doc = field.ownerDocument;
  const tail = preservedTail(field);
  if (tail.length > 0) {
    const lead = nodesForDraftLines(doc, text, draftUsesDivLines(field, tail));
    field.replaceChildren(...lead, ...tail);
    dispatchNativeInput(field, text, 'insertText');
    return true;
  }
  const selection = doc.getSelection();
  if (selection && selection.rangeCount > 0) {
    try {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const asDivs = draftUsesDivLines(field, []);
      const nodes = nodesForDraftLines(doc, text, asDivs);
      for (const node of nodes) {
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
      }
      selection.removeAllRanges();
      selection.addRange(range);
      dispatchNativeInput(field, text, 'insertText');
      return true;
    } catch {
      // Fall through to rewriting the subtree.
    }
  }
  if (draftUsesDivLines(field, [])) {
    field.replaceChildren(...nodesForDraftLines(doc, text, true));
  } else {
    field.replaceChildren(...nodesForDraftLines(doc, text, false));
  }
  dispatchNativeInput(field, text, 'insertText');
  return true;
}

function richSelectionSpan(
  field: Element,
): { start: number; end: number; selected: string } | null {
  const selection = field.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!nodeInside(field, range.commonAncestorContainer)) return null;
  const cutoff = firstPreservedChild(field);
  if (cutoff && nodeIsAtOrAfter(range.startContainer, cutoff)) return null;
  try {
    const prefix = field.ownerDocument.createRange();
    prefix.setStart(field, 0);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const selected = range.toString();
    return { start, end: start + selected.length, selected };
  } catch {
    return null;
  }
}

function expectedDraft(field: Element, translation: string): string {
  if (isNativeTextField(field)) {
    const span = nativeSpan(field);
    if (!span) return translation;
    return field.value.slice(0, span.start) + translation + field.value.slice(span.end);
  }
  const current = readDraftRegionText(field);
  const span = richSelectionSpan(field);
  if (!span) return translation;
  const { start, end, selected } = span;
  if (start >= 0 && end <= current.length && current.slice(start, end) === selected) {
    return current.slice(0, start) + translation + current.slice(end);
  }
  const first = current.indexOf(selected);
  if (first < 0) return translation;
  const second = current.indexOf(selected, first + selected.length);
  if (second < 0) {
    return current.slice(0, first) + translation + current.slice(first + selected.length);
  }
  const raw = lineBreaks(field.textContent ?? '');
  if (start >= 0 && end <= raw.length) {
    return raw.slice(0, start) + translation + raw.slice(end);
  }
  return current.slice(0, start) + translation + current.slice(end);
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
  preserved: readonly ChildNode[],
): Promise<StrategyOutcome> {
  await nextComposeFrame(field.ownerDocument);
  const kept = preserved.every((node) => node.isConnected && field.contains(node));
  if (textsMatch(readDraftRegionText(field), expected) && kept) return 'ok';
  if (surfaceOf(field) !== before || !kept) return 'changed';
  return 'noop';
}

function accepted(
  outcome: StrategyOutcome,
  method: ComposeReplaceMethod,
): ComposeReplaceResult | null {
  if (outcome === 'ok' || outcome === 'changed') return { ok: true, method };
  return null;
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
  const preserved = preservedTail(field);

  if (isNativeTextField(field)) {
    const span = nativeSpan(field);
    if (!span) selectNative(field);
    const run = async (
      method: ComposeReplaceMethod,
      act: () => void,
    ): Promise<ComposeReplaceResult | null> => {
      const before = surfaceOf(field);
      act();
      return accepted(await afterStrategy(field, expected, before, preserved), method);
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
    return { ok: outcome !== 'noop', method: outcome === 'noop' ? null : 'native' };
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
    return accepted(await afterStrategy(field, expected, before, preserved), method);
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
  return { ok: outcome !== 'noop', method: outcome === 'noop' ? null : 'native' };
}

async function writeSnapshot(
  field: Element,
  snapshot: ComposeSnapshot,
): Promise<ComposeReplaceResult> {
  if (isNativeTextField(field)) {
    setNativeValue(field, snapshot.text);
    dispatchNativeInput(field, snapshot.text, 'insertReplacementText');
    await nextComposeFrame(field.ownerDocument);
    return { ok: snapshotMatchesField(field, snapshot), method: 'native' };
  }
  if (snapshot.html !== null) {
    field.innerHTML = snapshot.html;
    dispatchNativeInput(field, snapshot.draft, 'insertReplacementText');
    await nextComposeFrame(field.ownerDocument);
    if (snapshotMatchesField(field, snapshot)) return { ok: true, method: 'native' };
  }
  return replaceComposeText(field, snapshot.draft);
}

/**
 * Restores the pre-replace snapshot. `execCommand('undo')` is used only when the
 * replacement itself went through `insertText`, and only if the field then matches
 * the snapshot; otherwise the snapshot is written back. Calling undo blindly would
 * revert the user's earlier typing when the write used a value setter or a DOM
 * rewrite that never entered the browser undo stack.
 */
export async function undoComposeReplace(
  field: Element,
  snapshot: ComposeSnapshot,
  method: ComposeReplaceMethod | null = null,
): Promise<ComposeReplaceResult> {
  if (!isComposeCandidate(field)) return { ok: false, method: null };
  focusField(field);
  if (method === 'insertText' && tryExecUndo(field.ownerDocument)) {
    await nextComposeFrame(field.ownerDocument);
    if (snapshotMatchesField(field, snapshot)) return { ok: true, method: 'undo' };
  }
  return writeSnapshot(field, snapshot);
}

function mapFieldRectToOverlay(field: Element, overlayDoc: Document): DOMRect | null {
  const local = field.getBoundingClientRect();
  let left = local.left;
  let top = local.top;
  let doc = field.ownerDocument;
  while (doc !== overlayDoc) {
    const frame = doc.defaultView?.frameElement;
    if (!(frame instanceof Element)) return null;
    const frameRect = frame.getBoundingClientRect();
    left += frameRect.left;
    top += frameRect.top;
    doc = frame.ownerDocument;
  }
  return new DOMRect(left, top, local.width, local.height);
}

/**
 * The box used to park the compose icon, in the overlay document's viewport. Same-origin
 * iframe fields are offset by the frame rect; when the frame cannot be mapped, returns
 * `null` so the icon is not shown at the wrong place.
 */
export function composeFieldRect(
  field: Element,
  overlayDoc: Document = field.ownerDocument,
): DOMRect | null {
  const mapped = mapFieldRectToOverlay(field, overlayDoc);
  if (!mapped) return null;
  const view = overlayDoc.defaultView;
  const width = view?.innerWidth ?? 800;
  const height = view?.innerHeight ?? 600;
  const left = Math.min(Math.max(mapped.left, 8), Math.max(8, width - 8));
  const top = Math.min(Math.max(mapped.top, 8), Math.max(8, height - 8));
  const right = Math.min(Math.max(mapped.right, left), width - 8);
  const bottom = Math.min(Math.max(mapped.bottom, top), height - 8);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
