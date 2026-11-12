import { browser } from 'wxt/browser';
import type { ShortcutAssigned, ShortcutQueryResult, ShortcutSnapshot } from './messages';
import {
  defaultShortcutFor,
  markCommandAssigned,
  normalizeShortcutAssignment,
  readShortcutSnapshot,
  rememberShortcutAssignments,
  sameShortcutAssignment,
  shortcutAssignedRecord,
  SHORTCUT_COMMANDS,
  type CommandBinding,
  type ShortcutAssignment,
  type ShortcutCommand,
} from './shortcuts';

const SHORTCUT_ASSIGNED_KEY = 'shortcutAssigned';

let writeQueue: Promise<unknown> = Promise.resolve();

async function loadShortcutAssignmentUnlocked(): Promise<ShortcutAssignment> {
  const stored = await browser.storage.local.get(SHORTCUT_ASSIGNED_KEY);
  return normalizeShortcutAssignment(stored[SHORTCUT_ASSIGNED_KEY]);
}

async function saveShortcutAssignmentUnlocked(recorded: ShortcutAssignment): Promise<void> {
  await browser.storage.local.set({ [SHORTCUT_ASSIGNED_KEY]: recorded });
}

function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const operation = writeQueue.then(work);
  writeQueue = operation.catch(() => undefined);
  return operation;
}

type CommandsUpdate = (details: { name: string; shortcut: string }) => Promise<void>;

function commandsUpdate(): CommandsUpdate | undefined {
  const update = (browser.commands as { update?: unknown }).update;
  return typeof update === 'function' ? (update as CommandsUpdate) : undefined;
}

/**
 * Firefox can write shortcuts (`browser.commands.update`). Chrome cannot — its commands
 * API is getAll / onCommand / onChanged; `commands.update` is Firefox-only (MDN). Empty
 * commands are restored to the build's per-OS default; a key the user set is left alone.
 * A conflict still leaves the command empty, and the in-page fallback covers that.
 */
export async function restoreEmptyCommandShortcuts(
  commands: readonly CommandBinding[],
): Promise<readonly CommandBinding[]> {
  const update = commandsUpdate();
  if (!update) return commands;

  let restored = false;
  for (const command of SHORTCUT_COMMANDS) {
    const current = commands.find((entry) => entry.name === command)?.shortcut ?? '';
    if (typeof current === 'string' && current.length > 0) continue;
    try {
      await update({ name: command, shortcut: defaultShortcutFor(command) });
      restored = true;
    } catch {
      // Another add-on already owns this key, or the browser refused the binding.
    }
  }
  if (!restored) return commands;
  try {
    return await browser.commands.getAll();
  } catch {
    return commands;
  }
}

/**
 * Reads the live command list, records which commands the browser has assigned at least
 * once, and returns both. Writes are queued so an `onInstalled` snapshot and a later
 * `onCommand` cannot drop each other. An empty live binding still uses the in-page default.
 */
export function resolveShortcutQuery(
  commands: readonly CommandBinding[],
): Promise<ShortcutQueryResult> {
  return enqueueWrite(async () => {
    const snapshot = readShortcutSnapshot(commands);
    const recorded = await loadShortcutAssignmentUnlocked();
    const next = rememberShortcutAssignments(recorded, snapshot);
    if (!sameShortcutAssignment(recorded, next)) {
      await saveShortcutAssignmentUnlocked(next);
    }
    return { snapshot, assigned: next };
  });
}

/**
 * Records that the browser delivered this command. Kept so a late first snapshot still
 * knows the key existed; empty bindings now fall back regardless.
 */
export function noteShortcutCommandAssigned(command: ShortcutCommand): Promise<ShortcutAssigned> {
  return enqueueWrite(async () => {
    const recorded = await loadShortcutAssignmentUnlocked();
    const next = markCommandAssigned(recorded, command);
    if (!sameShortcutAssignment(recorded, next)) {
      await saveShortcutAssignmentUnlocked(next);
    }
    return shortcutAssignedRecord(next);
  });
}

/** Exposed for tests that need to inspect the persisted map directly. */
export async function loadShortcutAssignment(): Promise<ShortcutAssignment> {
  return loadShortcutAssignmentUnlocked();
}

export function observeShortcutSnapshot(snapshot: ShortcutSnapshot): Promise<ShortcutAssigned> {
  return enqueueWrite(async () => {
    const recorded = await loadShortcutAssignmentUnlocked();
    const next = rememberShortcutAssignments(recorded, snapshot);
    if (!sameShortcutAssignment(recorded, next)) {
      await saveShortcutAssignmentUnlocked(next);
    }
    return shortcutAssignedRecord(next);
  });
}
