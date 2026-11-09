import { browser } from 'wxt/browser';
import type { ShortcutAssigned, ShortcutQueryResult, ShortcutSnapshot } from './messages';
import {
  markCommandAssigned,
  normalizeShortcutAssignment,
  readShortcutSnapshot,
  rememberShortcutAssignments,
  sameShortcutAssignment,
  shortcutAssignedRecord,
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

/**
 * Reads the live command list, records which commands the browser has assigned at least
 * once, and returns both so a page can tell a user-cleared key from an install-time
 * conflict. Writes are queued so an `onInstalled` snapshot and a later `onCommand` cannot
 * drop each other.
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
 * Records that the browser delivered this command, so a later empty `getAll()` is a user
 * clear even if the first `onInstalled` snapshot ran before the suggested key landed.
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
