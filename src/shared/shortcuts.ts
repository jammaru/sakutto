import { extensionBrowser, type ExtensionBrowser } from './browser.ts';
import type { PageCommandName, ShortcutAssigned, ShortcutSnapshot } from './messages';
import { isRecord } from './object.ts';

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
 * Chrome `suggested_key.default` (Windows, Linux, ChromeOS). Alt+letter is the historical
 * binding; Firefox cannot use those on Windows because they collide with the menu bar.
 */
export const CHROME_DEFAULT_SHORTCUTS: Readonly<Record<ShortcutCommand, string>> = {
  'translate-page': 'Alt+A',
  'toggle-bilingual': 'Alt+B',
  'translate-selection': 'Alt+S',
  'translate-compose': 'Alt+T',
};

/**
 * Chrome `suggested_key.mac`. `Alt` is Option on macOS. A brand-new macOS
 * Chrome profile has been observed to auto-assign Option+A/B/S/T; this file
 * does not treat Chromium accelerator tables as proof of that. An existing
 * install that already had empty bindings stays empty across updates because
 * Chrome keeps user-cleared prefs for the same extension id.
 */
export const CHROME_MAC_DEFAULT_SHORTCUTS: Readonly<Record<ShortcutCommand, string>> = {
  'translate-page': 'Alt+A',
  'toggle-bilingual': 'Alt+B',
  'translate-selection': 'Alt+S',
  'translate-compose': 'Alt+T',
};

/** Firefox defaults. Alt+Shift+letter avoids the Windows menu-bar access keys. */
export const FIREFOX_DEFAULT_SHORTCUTS: Readonly<Record<ShortcutCommand, string>> = {
  'translate-page': 'Alt+Shift+A',
  'toggle-bilingual': 'Alt+Shift+B',
  'translate-selection': 'Alt+Shift+S',
  'translate-compose': 'Alt+Shift+T',
};

/** One command's `suggested_key` object. Chrome allows at most four of these per extension. */
export type SuggestedKey = {
  readonly default: string;
  readonly mac?: string | undefined;
};

export function suggestedKeyFor(browser: ExtensionBrowser, command: ShortcutCommand): SuggestedKey {
  if (browser === 'firefox') return { default: FIREFOX_DEFAULT_SHORTCUTS[command] };
  return {
    default: CHROME_DEFAULT_SHORTCUTS[command],
    mac: CHROME_MAC_DEFAULT_SHORTCUTS[command],
  };
}

export function defaultShortcutsFor(
  browser: ExtensionBrowser,
): Readonly<Record<ShortcutCommand, string>> {
  return browser === 'firefox' ? FIREFOX_DEFAULT_SHORTCUTS : CHROME_DEFAULT_SHORTCUTS;
}

/** True when this machine's Chrome treats `Ctrl` as Command, as it does on a Mac. */
export function isMacPlatform(): boolean {
  const nav = globalThis.navigator as
    (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  if (!nav) return false;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';
  return /mac/i.test(platform);
}

export interface ShortcutPlatform {
  readonly mac?: boolean | undefined;
  readonly browser?: ExtensionBrowser | undefined;
}

/** The keys this browser and OS should start with, including Chrome's Mac Option+letter set. */
export function defaultShortcuts(
  platform: ShortcutPlatform = {},
): Readonly<Record<ShortcutCommand, string>> {
  const browser = platform.browser ?? extensionBrowser();
  if (browser === 'firefox') return FIREFOX_DEFAULT_SHORTCUTS;
  return (platform.mac ?? isMacPlatform())
    ? CHROME_MAC_DEFAULT_SHORTCUTS
    : CHROME_DEFAULT_SHORTCUTS;
}

export function defaultShortcutFor(
  command: ShortcutCommand,
  platform: ShortcutPlatform = {},
): string {
  return defaultShortcuts(platform)[command];
}

/**
 * The key a page or settings screen uses until the browser answers with the keys the user
 * actually bound, and keeps if it never answers. Chrome reports the same bindings with its
 * own spelling on a Mac.
 */
export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutCommand, string>> = defaultShortcuts();

/** The key the selection command has until the browser answers. */
export const DEFAULT_SELECTION_SHORTCUT = DEFAULT_SHORTCUTS['translate-selection'];

/** The key the compose command has until the browser answers. */
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
 * back to false, so a later empty binding is a user clear — no in-page fallback, and
 * Firefox must not `commands.update` it back. Existing installs from before this map
 * already stored it (#52): empty-from-the-start stays `false` (fallback); a key that
 * later vanished is `true` (leave off).
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
  readonly mac?: boolean | undefined;
  /**
   * Whether the browser has assigned a key to this command at least once. `true` plus an
   * empty snapshot is a user clear: no in-page fallback. `false` or omitted plus empty is
   * "never assigned" (install conflict, or an old install that stayed 未設定): use the
   * per-OS default on pages.
   */
  readonly assigned?: boolean | undefined;
}

/**
 * The key a page should listen for. A key the user set in the browser wins. An empty
 * binding uses the per-OS default only when that command was never assigned; a user
 * clear (`assigned === true`) stays off. Sakutto's own checkbox is a separate off
 * switch. No snapshot at all keeps the default so a page can answer before the
 * background replies.
 */
export function boundShortcut(
  snapshot: ShortcutSnapshot | null,
  command: ShortcutCommand,
  options: BoundShortcutOptions = {},
): string {
  const fallback = options.fallback ?? defaultShortcutFor(command, { mac: options.mac });
  if (options.enabled === false) return '';
  if (!snapshot) return fallback;
  const binding = snapshot[command];
  if (hasShortcutKey(binding)) return binding;
  if (options.assigned === true) return '';
  return fallback;
}

/**
 * True when the page is listening for the OS default because `commands.getAll()` reported
 * no key and that command was never assigned. A user-cleared command is empty too, but
 * `assigned` is then true and this is false.
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

/**
 * Chrome's `commands.getAll()` spells the Control key as `Ctrl` on every OS
 * (`ui::Command::AcceleratorToString`). On Mac a manifest `Ctrl` means Command, so a
 * snapshot `Ctrl+Shift+A` from a `MacCtrl` suggestion would otherwise be heard as
 * Command+Shift+A. Reported `Ctrl` becomes `MacCtrl`; `Command` / `⌘` stay Command, and
 * `⌃` already parses as Control.
 */
export function normalizeReportedShortcut(
  shortcut: string,
  platform: ShortcutPlatform = {},
): string {
  const mac = platform.mac ?? isMacPlatform();
  if (!mac || shortcut.length === 0) return shortcut;
  if (/(?:^|\+)MacCtrl(?:\+|$)/.test(shortcut)) return shortcut;
  if (/[⌘⌃⌥]/.test(shortcut) || /(?:^|\+)(?:Command|Cmd|Option)(?:\+|$)/i.test(shortcut)) {
    return shortcut;
  }
  return shortcut.replace(/(^|\+)Ctrl(?=\+|$)/g, '$1MacCtrl');
}

/** Reads the commands a user can rebind into the keys a page cares about. */
export function readShortcutSnapshot(
  commands: readonly CommandBinding[],
  platform: ShortcutPlatform = {},
): ShortcutSnapshot {
  const shortcutOf = (name: ShortcutCommand): string | null => {
    const command = commands.find((entry) => entry.name === name);
    if (command === undefined) return null;
    return normalizeReportedShortcut(command.shortcut ?? '', platform);
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

/**
 * True when the key event is the key the user bound to this command. `Ctrl` means Command on
 * a Mac, as it does in a manifest, and `MacCtrl` is the Control key there.
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: string,
  platform: ShortcutPlatform = {},
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
export function ariaShortcut(shortcut: string, platform: ShortcutPlatform = {}): string | null {
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
  ['⌃', 'Control'],
  ['⌫', 'Backspace'],
  ['↵', 'Enter'],
]);

const DISPLAY_TOKENS: ReadonlyMap<string, string> = new Map<string, string>([
  ['MacCtrl', 'Control'],
  ['macctrl', 'Control'],
]);

/**
 * The binding as a reader should see it. Chrome reports `⌥⇧P` on a Mac; `Option+Shift+P`
 * names the same keys in words, next to the `Alt+Shift+P` a Windows Chrome reports.
 * `MacCtrl` is Control. On a Mac, `Alt` is Option.
 */
export function displayShortcut(shortcut: string, platform: ShortcutPlatform = {}): string {
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

  const mac = platform.mac ?? isMacPlatform();
  return parts
    .map((part) => {
      const renamed = DISPLAY_TOKENS.get(part);
      if (renamed !== undefined) return renamed;
      if (mac && part === 'Alt') return 'Option';
      return part;
    })
    .join('+');
}
