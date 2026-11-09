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
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
}

export async function resetExtensionStorage(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    await chrome.storage.local.set({
      siteRules: {},
      settings: {
        schemaVersion: 1,
        targetLanguage: 'en',
        form: 'polite',
        display: 'replace',
        consent: null,
        highQualityDismissed: false,
        glossary: [],
        idleMinutes: 5,
        tier: 'auto',
      },
    });
  });
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
