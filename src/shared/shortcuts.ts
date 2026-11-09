import type { PageCommandName, ShortcutAssigned, ShortcutSnapshot } from './messages';
import { isRecord } from './object';

export type { ShortcutAssigned, ShortcutSnapshot };

/** The commands the manifest declares, in the order the settings page lists them. */
export const SHORTCUT_COMMANDS = [
  'translate-page',
  'toggle-bilingual',
  'translate-selection',
  'translate-compose',
] as const;

export type ShortcutCommand = (typeof SHORTCUT_COMMANDS)[number];

/** The page action each command runs. */
export const SHORTCUT_PAGE_COMMANDS: Readonly<Record<ShortcutCommand, PageCommandName>> = {
  'translate-page': 'toggle',
  'toggle-bilingual': 'bilingual',
  'translate-selection': 'selection',
  'translate-compose': 'compose',
};

/**
 * The key the manifest suggests for each command. A page or a settings screen uses these
 * until the browser answers with the keys the user actually bound. Chrome reports the same
 * bindings with its own spelling on a Mac.
 */
export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutCommand, string>> = {
  'translate-page': 'Alt+A',
  'toggle-bilingual': 'Alt+B',
  'translate-selection': 'Alt+S',
  'translate-compose': 'Alt+T',
};

/** The key the selection command has until Chrome answers. */
export const DEFAULT_SELECTION_SHORTCUT = DEFAULT_SHORTCUTS['translate-selection'];

/** The key the compose command has until Chrome answers. */
export const DEFAULT_COMPOSE_SHORTCUT = DEFAULT_SHORTCUTS['translate-compose'];

export type ShortcutEnabled = Record<ShortcutCommand, boolean>;

/** Every command is on until the user turns it off in Sakutto's own settings. */
export function defaultShortcutEnabled(): ShortcutEnabled {
  return {
    'translate-page': true,
    'toggle-bilingual': true,
    'translate-selection': true,
    'translate-compose': true,
  };
}

export function normalizeShortcutEnabled(value: unknown): ShortcutEnabled {
  const next = defaultShortcutEnabled();
  if (!isRecord(value)) return next;
  for (const command of SHORTCUT_COMMANDS) {
    if (value[command] === false) next[command] = false;
  }
  return next;
}

/**
 * Whether the browser has assigned a key to each command at least once. Missing keys have
 * not been observed yet. `true` never goes back to `false`: a later empty binding is a
 * user clear, not a reason to revive the in-page default.
 */
export type ShortcutAssignment = Partial<ShortcutAssigned>;

export function emptyShortcutAssigned(): ShortcutAssigned {
  return {
    'translate-page': false,
    'toggle-bilingual': false,
    'translate-selection': false,
    'translate-compose': false,
  };
}

export function shortcutAssignedRecord(recorded: ShortcutAssignment): ShortcutAssigned {
  const next = emptyShortcutAssigned();
  for (const command of SHORTCUT_COMMANDS) {
    next[command] = recorded[command] === true;
  }
  return next;
}

export function normalizeShortcutAssignment(value: unknown): ShortcutAssignment {
  if (!isRecord(value)) return {};
  const next: ShortcutAssignment = {};
  for (const command of SHORTCUT_COMMANDS) {
    if (value[command] === true) next[command] = true;
    else if (value[command] === false) next[command] = false;
  }
  return next;
}

export function sameShortcutAssignment(
  left: ShortcutAssignment,
  right: ShortcutAssignment,
): boolean {
  for (const command of SHORTCUT_COMMANDS) {
    if (left[command] !== right[command]) return false;
  }
  return true;
}

function hasShortcutKey(binding: string | null | undefined): binding is string {
  return typeof binding === 'string' && binding.length > 0;
}

/**
 * Merges a live `commands.getAll()` snapshot into the persisted assignment map.
 *
 * A command the map has never seen is recorded as assigned only when the browser reported a
 * key. An unassigned command becomes assigned if a key appears later. Assigned never goes
 * back to false, so clearing the key in the browser's shortcut editor is not mistaken for
 * the install-time conflict that still needs the in-page default.
 */
export function rememberShortcutAssignments(
  recorded: ShortcutAssignment,
  snapshot: ShortcutSnapshot,
): ShortcutAssigned {
  const next = emptyShortcutAssigned();
  for (const command of SHORTCUT_COMMANDS) {
    next[command] = recorded[command] === true || hasShortcutKey(snapshot[command]);
  }
  return next;
}

export function markCommandAssigned(
  recorded: ShortcutAssignment,
  command: ShortcutCommand,
): ShortcutAssignment {
  if (recorded[command] === true) return recorded;
  return { ...recorded, [command]: true };
}

export interface BoundShortcutOptions {
  readonly fallback?: string;
  readonly enabled?: boolean;
  /**
   * Whether the browser has assigned a key to this command at least once. `true` means a
   * later empty snapshot is a user clear — no in-page fallback. `false` means the first
   * observation was empty (a conflict at install), so the manifest default stays on the
   * page. Omitted until that observation is recorded, which also keeps the default so
   * first-run still works before `onInstalled` finishes.
   */
  readonly assigned?: boolean | undefined;
}

/**
 * The key a page should listen for. A key the user set in the browser wins. An empty
 * binding is a user clear when that command was assigned at least once, and the in-page
 * default only when the browser never assigned the suggested key (another extension already
 * holds it, a command added in an update, a second copy of this extension). Sakutto's own
 * setting is a separate off switch. `null` on the snapshot (the command was not listed)
 * follows the same empty-binding rule. No snapshot at all keeps the default so a page can
 * answer before the background replies.
 */
export function boundShortcut(
  snapshot: ShortcutSnapshot | null,
  command: ShortcutCommand,
  options: BoundShortcutOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_SHORTCUTS[command];
  if (options.enabled === false) return '';
  if (!snapshot) return fallback;
  const binding = snapshot[command];
  if (hasShortcutKey(binding)) return binding;
  if (options.assigned === true) return '';
  return fallback;
}

/**
 * True when the in-page default is filling in because the browser never assigned a key.
 * A user-cleared command is empty in the snapshot too, but `assigned` is then true and
 * this is false, so the settings screen can say "Not set" instead of advertising a fallback.
 */
export function usesInPageFallback(
  snapshot: ShortcutSnapshot | null,
  command: ShortcutCommand,
  assigned?: boolean | undefined,
): boolean {
  if (!snapshot) return false;
  if (hasShortcutKey(snapshot[command])) return false;
  return assigned !== true;
}

/** The shape `browser.commands.getAll()` returns, without depending on its declared type. */
export interface CommandBinding {
  readonly name?: string | undefined;
  readonly shortcut?: string | undefined;
}

export function isShortcutCommand(value: string): value is ShortcutCommand {
  return (SHORTCUT_COMMANDS as readonly string[]).includes(value);
}

/** Reads the commands a user can rebind into the keys a page cares about. */
export function readShortcutSnapshot(commands: readonly CommandBinding[]): ShortcutSnapshot {
  const shortcutOf = (name: ShortcutCommand): string | null => {
    const command = commands.find((entry) => entry.name === name);
    if (command === undefined) return null;
    return command.shortcut ?? '';
  };
  return {
    'translate-page': shortcutOf('translate-page'),
    'toggle-bilingual': shortcutOf('toggle-bilingual'),
    'translate-selection': shortcutOf('translate-selection'),
    'translate-compose': shortcutOf('translate-compose'),
  };
}

type Modifier = 'primary' | 'macctrl' | 'command' | 'alt' | 'shift';

interface ParsedKey {
  /** `KeyboardEvent.code`, which does not move with the keyboard layout. */
  code: string;
  /** Lowercase `KeyboardEvent.key` values that are the same key. */
  keys: readonly string[];
}

interface ParsedShortcut {
  modifiers: readonly Modifier[];
  key: ParsedKey;
}

const MODIFIER_TOKENS: ReadonlyMap<string, Modifier> = new Map<string, Modifier>([
  ['ctrl', 'primary'],
  ['control', 'macctrl'],
  ['macctrl', 'macctrl'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['opt', 'alt'],
  ['shift', 'shift'],
  ['command', 'command'],
  ['cmd', 'command'],
]);

/** The notation Chrome reports on a Mac, e.g. `⌥⇧P`. */
const MODIFIER_GLYPHS: ReadonlyMap<string, Modifier> = new Map<string, Modifier>([
  ['⌥', 'alt'],
  ['⇧', 'shift'],
  ['⌘', 'command'],
  ['⌃', 'macctrl'],
]);

const NAMED_KEYS: ReadonlyMap<string, ParsedKey> = new Map<string, ParsedKey>([
  ['comma', { code: 'Comma', keys: [','] }],
  ['period', { code: 'Period', keys: ['.'] }],
  ['home', { code: 'Home', keys: ['home'] }],
  ['end', { code: 'End', keys: ['end'] }],
  ['pageup', { code: 'PageUp', keys: ['pageup'] }],
  ['pagedown', { code: 'PageDown', keys: ['pagedown'] }],
  ['space', { code: 'Space', keys: [' '] }],
  ['insert', { code: 'Insert', keys: ['insert'] }],
  ['delete', { code: 'Delete', keys: ['delete'] }],
  ['up', { code: 'ArrowUp', keys: ['arrowup'] }],
  ['down', { code: 'ArrowDown', keys: ['arrowdown'] }],
  ['left', { code: 'ArrowLeft', keys: ['arrowleft'] }],
  ['right', { code: 'ArrowRight', keys: ['arrowright'] }],
]);

function parseKey(token: string): ParsedKey | null {
  const named = NAMED_KEYS.get(token.toLowerCase());
  if (named !== undefined) return named;
  if (/^[a-z]$/i.test(token)) {
    return { code: `Key${token.toUpperCase()}`, keys: [token.toLowerCase()] };
  }
  if (/^[0-9]$/.test(token)) return { code: `Digit${token}`, keys: [token] };
  return null;
}

/**
 * Reads a binding in either notation: the `Ctrl+Shift+Y` spelling from a manifest or a
 * Windows/Linux Chrome, or the glyph spelling a Mac reports. Unknown tokens and a binding
 * with no key return `null`, which makes the binding match nothing.
 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const modifiers: Modifier[] = [];
  let key: ParsedKey | null = null;

  for (const raw of shortcut.split('+')) {
    const token = raw.trim();
    if (token.length === 0) return null;

    const modifier = MODIFIER_TOKENS.get(token.toLowerCase());
    if (modifier !== undefined) {
      modifiers.push(modifier);
      continue;
    }

    let remainder = '';
    for (const char of token) {
      const glyph = MODIFIER_GLYPHS.get(char);
      if (glyph !== undefined) {
        modifiers.push(glyph);
        continue;
      }
      remainder += char;
    }
    if (remainder.length === 0) continue;
    if (key !== null) return null;

    const parsed = parseKey(remainder);
    if (parsed === null) return null;
    key = parsed;
  }

  if (key === null) return null;
  // Chrome rejects a binding without Ctrl, Alt, Command or MacCtrl, so one is not a shortcut
  // this page should answer either.
  const held = modifiers.some((modifier) => modifier !== 'shift');
  if (!held) return null;
  return { modifiers, key };
}

/** True when this machine's Chrome treats `Ctrl` as Command, as it does on a Mac. */
export function isMacPlatform(): boolean {
  const nav = globalThis.navigator as
    (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  if (!nav) return false;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';
  return /mac/i.test(platform);
}

/**
 * True when the key event is the key the user bound to this command. `Ctrl` means Command on
 * a Mac, as it does in a manifest, and `MacCtrl` is the Control key there.
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: string,
  platform: { readonly mac?: boolean } = {},
): boolean {
  const parsed = parseShortcut(shortcut);
  if (parsed === null) return false;

  const mac = platform.mac ?? isMacPlatform();
  const primary = parsed.modifiers.includes('primary');
  const command = parsed.modifiers.includes('command');
  const macctrl = parsed.modifiers.includes('macctrl');

  const ctrl = macctrl || (!mac && primary);
  const meta = command || (mac && primary);

  if (event.ctrlKey !== ctrl) return false;
  if (event.metaKey !== meta) return false;
  if (event.altKey !== parsed.modifiers.includes('alt')) return false;
  if (event.shiftKey !== parsed.modifiers.includes('shift')) return false;

  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  return event.code === parsed.key.code || parsed.key.keys.includes(key);
}

/** Alt+S with no other modifier, including a keyboard that reports the letter as `s`. */
export function isPlainAltS(event: KeyboardEvent): boolean {
  return matchesShortcut(event, DEFAULT_SELECTION_SHORTCUT);
}

/**
 * The binding in the `aria-keyshortcuts` spelling, which names modifiers `Control`, `Meta`,
 * `Alt` and `Shift` whatever key the platform draws. `null` when the binding cannot be read.
 */
export function ariaShortcut(
  shortcut: string,
  platform: { readonly mac?: boolean } = {},
): string | null {
  const parsed = parseShortcut(shortcut);
  if (parsed === null) return null;

  const mac = platform.mac ?? isMacPlatform();
  const parts: string[] = [];
  if (parsed.modifiers.includes('primary')) parts.push(mac ? 'Meta' : 'Control');
  if (parsed.modifiers.includes('command')) parts.push('Meta');
  if (parsed.modifiers.includes('macctrl')) parts.push('Control');
  if (parsed.modifiers.includes('alt')) parts.push('Alt');
  if (parsed.modifiers.includes('shift')) parts.push('Shift');
  parts.push(parsed.key.code.replace(/^Key/, '').replace(/^Digit/, ''));
  return parts.join('+');
}

const DISPLAY_GLYPHS: ReadonlyMap<string, string> = new Map<string, string>([
  ['⌘', 'Cmd'],
  ['⌥', 'Option'],
  ['⇧', 'Shift'],
  ['⌃', 'Ctrl'],
  ['⌫', 'Backspace'],
  ['↵', 'Enter'],
]);

/**
 * The binding as a reader should see it. Chrome reports `⌥⇧P` on a Mac; `Option+Shift+P`
 * names the same keys in words, next to the `Alt+Shift+P` a Windows Chrome reports.
 */
export function displayShortcut(shortcut: string): string {
  const parts: string[] = [];
  let word = '';
  const flush = (): void => {
    const text = word.trim();
    if (text.length > 0) parts.push(text);
    word = '';
  };

  for (const char of shortcut.trim()) {
    const glyph = DISPLAY_GLYPHS.get(char);
    if (glyph !== undefined) {
      flush();
      parts.push(glyph);
      continue;
    }
    if (char === '+') {
      flush();
      continue;
    }
    word += char;
  }
  flush();

  return parts.join('+');
}
