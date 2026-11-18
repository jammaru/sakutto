import { browser } from 'wxt/browser';
import { readRuntimeLastError } from '@/shared/runtime-last-error';
import type { EngineClient } from '@/background/engine-client';
import { sharedFolderNeedsUserAction, type EngineStatus } from '@/shared/engine-status';
import {
  queryStoredFolderPermission,
  sharedFolderSupported,
  type FolderPermission,
} from '@/engine/model/shared-folder';
import { loadSettings } from '@/shared/storage';
import type { Settings } from '@/shared/settings';
import {
  clearFolderGrantPending,
  PDF_GRANT_COMMAND,
  readFolderGrantPending,
  saveFolderGrantPending,
  type FolderGrantCommand,
  type FolderGrantPending,
} from '@/shared/folder-grant-pending';
import type { PageCommandName } from '@/shared/messages';
import { requestPageCommand } from '@/shared/messages';
import { openOrFocusExtensionTab } from '@/shared/extension-tabs';
import { ensureContentScript } from '@/shared/page-bridge';
import { openPdfForTab } from './pdf-actions';

import {
  type FolderGrantCompleteMessage,
  type FolderGrantNeededMessage,
} from '@/shared/folder-grant-messages';

const ENGINE_STATUS_RETRY_DELAYS_MS = [0, 100, 250] as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A cold offscreen document can miss the first status poll; retry briefly before falling back. */
async function readEngineStatus(client: EngineClient): Promise<EngineStatus | null> {
  for (const delay of ENGINE_STATUS_RETRY_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    const status = await client.status().catch(() => null);
    if (status) return status;
  }
  return null;
}

/**
 * The stored-permission fallback for a host that has not answered yet. A local server
 * never reads the model folder, so no grant state can unblock its page commands.
 */
export function storedFolderGrantBlocksCommand(
  settings: Pick<Settings, 'engineSource'> | null,
  permission: FolderPermission | null,
): boolean {
  if (settings?.engineSource === 'local-server') return false;
  return permission === 'prompt' || permission === 'denied';
}

/**
 * True only when the shared folder needs a grant before a translation can read it.
 *
 * Status is authoritative when the offscreen document answers. If it is still starting,
 * fall back to the stored handle: a permission that is already `granted` must run the
 * command without opening a grant tab after every restart. Firefox has no shared folder,
 * so it skips the IndexedDB query entirely.
 */
async function folderNeedsGrant(client: EngineClient): Promise<boolean> {
  const status = await readEngineStatus(client);
  if (status) return sharedFolderNeedsUserAction(status);
  if (!sharedFolderSupported()) return false;
  const settings = await loadSettings().catch(() => null);
  const permission = await queryStoredFolderPermission().catch(() => null);
  return storedFolderGrantBlocksCommand(settings, permission);
}

async function notifyGrantNeeded(tabId: number, command: PageCommandName): Promise<void> {
  const message: FolderGrantNeededMessage = { type: 'folder:grant-needed', command };
  await browser.tabs.sendMessage(tabId, message).catch(() => undefined);
  readRuntimeLastError();
}

/** Open or focus the grant tab so Chrome offers the persistent prompt without tab spam. */
export async function openFolderEnableWindow(): Promise<boolean> {
  const tabId = await openOrFocusExtensionTab('/folder-enable.html');
  return tabId !== null;
}

async function gateFolderCommand(
  client: EngineClient,
  tabId: number,
  command: FolderGrantCommand,
  frameId?: number,
): Promise<'ran' | 'deferred'> {
  if (!(await folderNeedsGrant(client))) return 'ran';
  await saveFolderGrantPending({ tabId, command, frameId });
  // Start opening the tab before the page hint round-trip so a slow content script cannot
  // delay the only surface where Chrome can offer "Allow on every visit".
  const opening = openFolderEnableWindow();
  if (command !== PDF_GRANT_COMMAND) await notifyGrantNeeded(tabId, command);
  await opening;
  return 'deferred';
}

/**
 * When the shared folder grant is dormant, defer the page command and surface a one-click
 * grant in the toolbar popup, with an in-page hint that can open it.
 */
export function gatePageCommand(
  client: EngineClient,
  tabId: number,
  command: PageCommandName,
  frameId?: number,
): Promise<'ran' | 'deferred'> {
  return gateFolderCommand(client, tabId, command, frameId);
}

export async function runGatedPageCommand(
  client: EngineClient,
  tabId: number,
  command: PageCommandName,
  frameId?: number,
): Promise<void> {
  const allFrames = command === 'compose';
  if (!(await ensureContentScript(tabId, { allFrames }))) return;
  const gate = await gatePageCommand(client, tabId, command, frameId);
  if (gate === 'deferred') return;
  await requestPageCommand(tabId, command, frameId);
}

export async function runGatedPdfCommand(
  client: EngineClient,
  tab: { id?: number | undefined; url?: string | undefined } | undefined,
): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const gate = await gateFolderCommand(client, tabId, PDF_GRANT_COMMAND);
  if (gate === 'deferred') return;
  await openPdfForTab(tab);
}

let resumeQueue: Promise<void> = Promise.resolve();

/**
 * Concurrent grants (for example two tabs finishing together) must not both run the one
 * pending command. Queue each read/check/clear cycle so the first success clears the slot
 * before the next caller can read it.
 */
export async function resumeFolderGrantPending(client: EngineClient): Promise<boolean> {
  const run = resumeQueue.then(
    () => resumeFolderGrantPendingNow(client),
    () => resumeFolderGrantPendingNow(client),
  );
  resumeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function resumeFolderGrantPendingNow(client: EngineClient): Promise<boolean> {
  const pending = await readFolderGrantPending();
  if (!pending) return false;
  // A grant can finish while the offscreen document is still reopening. Retry the status
  // briefly instead of leaving the reader's deferred action stuck on one failed poll.
  if (await folderNeedsGrant(client)) return false;
  if (pending.command === PDF_GRANT_COMMAND) return resumePdfGrantPending(pending);
  const allFrames = pending.command === 'compose';
  if (!(await ensureContentScript(pending.tabId, { allFrames }))) return false;
  // Keep the pending command until the page has actually accepted it. A missing tab or a
  // content script that cannot answer must not destroy the reader's deferred action.
  const state = await requestPageCommand(pending.tabId, pending.command, pending.frameId);
  if (!state) return false;
  // Hide the in-page hint even when the popup/folder-enable tab cannot be used as a sender
  // fallback after the pending slot is cleared.
  const complete: FolderGrantCompleteMessage = { type: 'folder:grant-complete' };
  await browser.tabs
    .sendMessage(
      pending.tabId,
      complete,
      pending.frameId === undefined ? {} : { frameId: pending.frameId },
    )
    .catch(() => undefined);
  readRuntimeLastError();
  await clearFolderGrantPending();
  return true;
}

async function resumePdfGrantPending(pending: FolderGrantPending): Promise<boolean> {
  const tab = await browser.tabs.get(pending.tabId).catch(() => null);
  if (!tab) return false;
  const opened = await openPdfForTab({ id: pending.tabId, url: tab.url });
  if (!opened) return false;
  await clearFolderGrantPending();
  return true;
}
