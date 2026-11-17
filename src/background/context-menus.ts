import { browser } from 'wxt/browser';
import { readRuntimeLastError } from '@/shared/runtime-last-error';
import { PDF_COMMAND } from '@/shared/shortcuts';
import { PDF_MENU_URL_PATTERNS } from '@/shared/pdf';

let installChain: Promise<void> = Promise.resolve();
let menusReady = false;

type ContextMenuCreate = {
  id: string;
  title: string;
  contexts: Array<'page' | 'selection' | 'editable' | 'link'>;
  documentUrlPatterns?: string[];
};

export function resetContextMenusForTests(): void {
  menusReady = false;
  installChain = Promise.resolve();
}

/** Queue a serial install so SW wake/onInstalled races cannot double-create menus. */
export function scheduleContextMenusInstall(): void {
  installChain = installChain.then(
    () => installContextMenusOnce(),
    () => installContextMenusOnce(),
  );
}

/** Await the queued install work (tests and callers that need ordering). */
export function flushContextMenuInstall(): Promise<void> {
  scheduleContextMenusInstall();
  return installChain;
}

async function installContextMenusOnce(): Promise<void> {
  if (menusReady) return;

  await removeAllMenus();
  await createMenu({
    id: 'translate-page',
    title: browser.i18n.getMessage('contextTranslatePage'),
    contexts: ['page'],
  });
  await createMenu({
    id: 'translate-selection',
    title: browser.i18n.getMessage('contextTranslateSelection'),
    contexts: ['selection'],
  });
  await createMenu({
    id: 'translate-compose',
    title: browser.i18n.getMessage('contextTranslateCompose'),
    contexts: ['editable'],
  });
  await createMenu({
    id: PDF_COMMAND,
    title: browser.i18n.getMessage('contextTranslatePdf'),
    contexts: ['page', 'link'],
    documentUrlPatterns: [...PDF_MENU_URL_PATTERNS],
  });

  menusReady = true;
}

function removeAllMenus(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      readRuntimeLastError();
      resolve();
    };
    try {
      const result = (
        browser.contextMenus.removeAll as ((callback: () => void) => unknown) | undefined
      )?.(done);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as PromiseLike<unknown>).then(done, done);
        return;
      }
      if (result === undefined) {
        done();
      }
    } catch {
      done();
    }
  });
}

function createMenu(properties: ContextMenuCreate): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      readRuntimeLastError();
      resolve();
    };
    try {
      const result = (
        browser.contextMenus.create as (
          createProperties: ContextMenuCreate,
          callback: () => void,
        ) => unknown
      )(properties, done);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as PromiseLike<unknown>).then(done, done);
        return;
      }
      if (result === undefined) {
        done();
      }
    } catch {
      done();
    }
  });
}
