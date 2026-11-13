import { mkdir, writeFile } from 'node:fs/promises';
import type { Page, Worker } from '@playwright/test';

export const FIXTURE_ORIGIN = 'http://127.0.0.1:4173';
export const MARKER = '§en§';

interface ExtensionChrome {
  tabs: {
    query(query: Record<string, unknown>): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  scripting: {
    executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  commands: {
    getAll(): Promise<Array<{ name?: string; shortcut?: string }>>;
  };
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
      get(key: string): Promise<Record<string, unknown>>;
      remove(key: string): Promise<void>;
    };
  };
}

export async function resetExtensionStorage(
  worker: Worker,
  options: {
    targetLanguage?: string;
    translateVideoCaptions?: boolean;
    videoCaptionDisplay?: 'replace' | 'bilingual';
    captionCustomHosts?: string[];
    translationPopupSize?: number;
  } = {},
): Promise<void> {
  const targetLanguage = options.targetLanguage ?? 'en';
  const translateVideoCaptions = options.translateVideoCaptions === true;
  const videoCaptionDisplay = options.videoCaptionDisplay ?? 'bilingual';
  const captionCustomHosts = options.captionCustomHosts ?? [];
  const translationPopupSize = options.translationPopupSize ?? 100;
  const settings = {
    schemaVersion: 1,
    targetLanguage,
    form: 'polite',
    display: 'replace',
    consent: null,
    highQualityDismissed: false,
    glossary: [],
    idleMinutes: 5,
    tier: 'auto',
    pace: 'quality',
    composeIcon: true,
    shortcutsEnabled: {
      'translate-page': true,
      'toggle-bilingual': true,
      'translate-selection': true,
      'translate-compose': true,
    },
    composeTargetLanguage: null,
    composeInstantReplace: false,
    composePlacement: 'above',
    selectedModelId: 'plamo-3-translate-0.8b-q4_k_m',
    engineSource: 'in-browser',
    localServerUrl: 'http://127.0.0.1:8080/v1',
    localServerModel: '',
    localServerApiKey: '',
    localServerTimeoutMs: 120_000,
    localServerAllowRemote: false,
    localServerParallel: 8,
    localServerExperimentalAck: false,
    translateVideoCaptions,
    videoCaptionDisplay,
    captionCustomHosts,
    translationPopupSize,
  };

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await worker.evaluate(
      async ({ settings }) => {
        const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
        await chrome.storage.local.set({ siteRules: {}, settings });
        await chrome.storage.local.remove('captionEnableIntent');
        await chrome.storage.local.remove('shortcutAssigned');
      },
      { settings },
    );
    const stored = await worker.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
      const value = await chrome.storage.local.get('settings');
      return value.settings as
        { translateVideoCaptions?: boolean; targetLanguage?: string } | undefined;
    });
    if (
      stored?.translateVideoCaptions === translateVideoCaptions &&
      stored.targetLanguage === targetLanguage
    ) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const again = await worker.evaluate(async () => {
        const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
        const value = await chrome.storage.local.get('settings');
        return value.settings as { translateVideoCaptions?: boolean } | undefined;
      });
      if (again?.translateVideoCaptions === translateVideoCaptions) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('extension settings did not stick');
}

export async function injectContentScript(worker: Worker, page: Page): Promise<void> {
  const url = page.url();
  await worker.evaluate(async (url) => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    const matched = await chrome.tabs.query({ url });
    const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const current = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = matched[0]?.id ?? lastFocused[0]?.id ?? current[0]?.id;
    if (tabId === undefined) throw new Error('fixture tab was not found');
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/content.js'],
    });
  }, url);
}

/** Waits until the content script's page session can answer, the way onCommand does. */
export async function waitForContentSession(worker: Worker, page: Page): Promise<void> {
  const url = page.url();
  await worker.evaluate(async (url) => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    const matched = await chrome.tabs.query({ url });
    const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const current = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = matched[0]?.id ?? lastFocused[0]?.id ?? current[0]?.id;
    if (tabId === undefined) throw new Error('fixture tab was not found');
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/content.js'],
    });
    const state = await chrome.tabs.sendMessage(tabId, { type: 'page:state' });
    if (!state || typeof state !== 'object') throw new Error('content session did not answer');
  }, url);
}

/** The same inject + `page:command` path `commands.onCommand` uses after it has a tab. */
export async function invokeOnCommandPath(
  worker: Worker,
  page: Page,
  command: 'toggle' | 'restore' | 'bilingual' | 'selection' | 'compose' = 'toggle',
): Promise<void> {
  const url = page.url();
  await worker.evaluate(
    async ({ url, command }) => {
      const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
      const matched = await chrome.tabs.query({ url });
      const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const current = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = matched[0]?.id ?? lastFocused[0]?.id ?? current[0]?.id;
      if (tabId === undefined) throw new Error('fixture tab was not found');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['/content-scripts/content.js'],
      });
      await chrome.tabs.sendMessage(tabId, { type: 'page:command', command });
    },
    { url, command },
  );
}

export async function readCommandBindings(
  worker: Worker,
): Promise<Array<{ name?: string; shortcut?: string }>> {
  return worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    return chrome.commands.getAll();
  });
}

/** Overrides `commands.getAll()` in the service worker so tests can force empty or rebound keys. */
export async function stubCommandBindings(
  worker: Worker,
  bindings: Array<{ name: string; shortcut: string }>,
): Promise<void> {
  await worker.evaluate((bindings) => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    const stub = async (): Promise<Array<{ name: string; shortcut: string }>> => bindings;
    try {
      chrome.commands.getAll = stub;
    } catch {
      Object.defineProperty(chrome.commands, 'getAll', {
        configurable: true,
        value: stub,
      });
    }
  }, bindings);
}

const NEVER_ASSIGNED = {
  'translate-page': false,
  'toggle-bilingual': false,
  'translate-selection': false,
  'translate-compose': false,
} as const;

/**
 * Simulates an old install that never received Chrome's suggested keys: empty `getAll()`
 * and `shortcutAssigned` all false. A later `onInstalled` write of `true` is overwritten
 * until the false map sticks.
 */
export async function simulateNeverAssignedShortcuts(worker: Worker): Promise<void> {
  const empty = [
    { name: 'translate-page', shortcut: '' },
    { name: 'toggle-bilingual', shortcut: '' },
    { name: 'translate-selection', shortcut: '' },
    { name: 'translate-compose', shortcut: '' },
  ];
  await stubCommandBindings(worker, empty);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await worker.evaluate(async (assigned) => {
      const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
      await chrome.storage.local.set({ shortcutAssigned: assigned });
    }, NEVER_ASSIGNED);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stored = await worker.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
      const value = await chrome.storage.local.get('shortcutAssigned');
      return value.shortcutAssigned as Record<string, boolean> | undefined;
    });
    if (stored?.['translate-page'] === false) return;
  }
  throw new Error('never-assigned shortcut map did not stick');
}

export async function commandPage(
  worker: Worker,
  page: Page,
  command: 'toggle' | 'restore' | 'bilingual' | 'compose',
): Promise<void> {
  const url = page.url();
  await worker.evaluate(
    async ({ url, command }) => {
      const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
      const matched = await chrome.tabs.query({ url });
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = matched[0]?.id ?? active[0]?.id;
      if (tabId === undefined) throw new Error('fixture tab was not found');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['/content-scripts/content.js'],
      });
      await chrome.tabs.sendMessage(tabId, { type: 'page:command', command });
    },
    { url, command },
  );
}

export async function waitTranslated(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.sakuttoState === 'translated');
}

export async function readSiteDisplay(worker: Worker): Promise<string | undefined> {
  return worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    const stored = await chrome.storage.local.get('siteRules');
    const rules = stored.siteRules as Record<string, { display?: string }> | undefined;
    return rules?.['127.0.0.1']?.display;
  });
}

export async function savePerf(name: string, page: Page): Promise<void> {
  const raw = await page.evaluate(
    () => document.querySelector('sakutto-perf')?.textContent ?? null,
  );
  if (!raw) return;

  const parsed = JSON.parse(raw) as {
    startedAt: number;
    firstTextAt: number | null;
    segments: Array<{ id: string; ms: number }>;
  };
  await mkdir('e2e-results', { recursive: true });
  await writeFile(
    `e2e-results/${name}.json`,
    `${JSON.stringify(
      {
        page: name,
        timeToFirstTextMs:
          parsed.firstTextAt === null ? null : Math.round(parsed.firstTextAt - parsed.startedAt),
        segments: parsed.segments,
      },
      null,
      2,
    )}\n`,
  );
}
