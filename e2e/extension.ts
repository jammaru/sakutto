import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';

const extensionPath = resolve('.output/chrome-mv3');

const ALLOWED_REQUEST = [
  /^chrome-extension:/,
  /^chrome:/,
  /^devtools:/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?\//,
  /^http:\/\/localhost(?::\d+)?\//,
  /^https:\/\/huggingface\.co\//,
  /^https:\/\/cdn-lfs\.huggingface\.co\//,
  /^data:/,
  /^blob:/,
  /^about:/,
];

export interface LoadedExtension {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  denied: string[];
  close: () => Promise<void>;
}

export function isAllowedRequest(url: string): boolean {
  return ALLOWED_REQUEST.some((pattern) => pattern.test(url));
}

export async function loadExtension(lang: 'en-US' | 'ja'): Promise<LoadedExtension> {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'sakutto-profile-'));
  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--lang=${lang === 'ja' ? 'ja' : 'en-US'}`,
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--disable-default-apps',
  ];
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    ...(lang === 'en-US' ? { locale: 'en-US' } : {}),
    args,
  });

  const denied: string[] = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isAllowedRequest(url)) return route.continue();
    if (!denied.includes(url)) denied.push(url);
    return route.abort();
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context
      .waitForEvent('serviceworker', { timeout: 30_000 })
      .catch(async (error: unknown) => {
        await context.close();
        await rm(profileDirectory, { recursive: true, force: true });
        throw error;
      }));

  return {
    context,
    extensionId: new URL(worker.url()).host,
    worker,
    denied,
    close: async () => {
      await context.close();
      await rm(profileDirectory, { recursive: true, force: true });
    },
  };
}
