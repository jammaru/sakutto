import { browser } from 'wxt/browser';
import { readRuntimeLastError } from '@/shared/runtime-last-error';
import type { EngineClient } from '@/background/engine-client';
import { sharedFolderNeedsUserAction } from '@/shared/engine-status';
import {
  clearFolderGrantPending,
  readFolderGrantPending,
  saveFolderGrantPending,
} from '@/shared/folder-grant-pending';
import type { PageCommandName } from '@/shared/messages';
import { requestPageCommand } from '@/shared/messages';
import { openOrFocusExtensionTab } from '@/shared/extension-tabs';
import { ensureContentScript } from '@/shared/page-bridge';

import {
  type FolderGrantCompleteMessage,
  type FolderGrantNeededMessage,
} from '@/shared/folder-grant-messages';

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

/**
 * When the shared folder grant is dormant, defer the page command and surface a one-click
 * grant in the toolbar popup, with an in-page hint that can open it.
 */
export async function gatePageCommand(
  client: EngineClient,
  tabId: number,
  command: PageCommandName,
  frameId?: number,
): Promise<'ran' | 'deferred'> {
  const status = await client.status().catch(() => null);
  if (!status || !sharedFolderNeedsUserAction(status)) return 'ran';
  await saveFolderGrantPending({ tabId, command, frameId });
  await notifyGrantNeeded(tabId, command);
  void openFolderEnableWindow();
  return 'deferred';
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
  const status = await client.status().catch(() => null);
  if (!status || sharedFolderNeedsUserAction(status)) return false;
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
