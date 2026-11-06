import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';

import { DEFAULT_MODEL_ID, getModel } from '../../src/engine/model/catalog.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PINNED_MODEL = getModel(DEFAULT_MODEL_ID);
export const MODEL_URL = PINNED_MODEL.url;
export const MODEL_SHA = PINNED_MODEL.sha256;
export const MODEL_ID = 'plamo-3-translate-0.8b-q4_k_m';
export const MODEL_FILE = 'plamo-3-translate-0.8b-Q4_K_M.gguf';

/**
 * Japanese output runs about this many tokens per character for this model family. Both
 * benches use it so their token rates can be read side by side; it is an estimate, not a
 * tokenizer call.
 */
export const JA_TOKENS_PER_CHAR = 447 / 1000;

export interface ChromeApi {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  scripting: {
    executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
}

export interface ModelStatus {
  state: string;
  progress: number;
  error?: string;
  received: number;
  total: number;
}

export interface EngineStatus {
  model: ModelStatus;
  backend: string | null;
  tier: string | null;
  threads: number | null;
  plamoReady: boolean;
  chromeSupported: boolean;
}

export function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

export function has(flag: string): boolean {
  return process.argv.includes(flag);
}

export function log(scope: string, message: string): void {
  console.log(`[${scope}] ${new Date().toISOString()} ${message}`);
}

/** Settings the e2e and bench packages store before translating, with the license accepted. */
export function settings(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    targetLanguage: 'ja',
    form: 'polite',
    display: 'replace',
    consent: {
      license: 'plamo-community',
      version: '2026-11-05',
      acceptedAt: '2026-11-05T00:00:00.000Z',
      guardian: true,
    },
    highQualityDismissed: true,
    glossary: [],
    idleMinutes: 15,
    tier: 'auto',
    pace: 'quality',
  };
}

export async function extensionCall(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate(async (payload) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    return chrome.runtime.sendMessage(payload);
  }, message);
}

export async function readStatus(page: Page): Promise<EngineStatus | null> {
  const value = await extensionCall(page, { type: 'engine:status' });
  if (!value || typeof value !== 'object') return null;
  return value as EngineStatus;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash());
  });
  return hash.digest('hex');
}

export async function ensureModel(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    log('bench', `downloading the model to ${path}`);
    await mkdir(dirname(path), { recursive: true });
    const response = await fetch(MODEL_URL);
    if (!response.ok || !response.body) {
      throw new Error(`The model download failed with HTTP ${String(response.status)}.`);
    }
    const { createWriteStream } = await import('node:fs');
    const sink = createWriteStream(path);
    const reader = response.body.getReader();
    await new Promise<void>((resolveWrite, reject) => {
      sink.on('error', reject);
      sink.on('finish', () => resolveWrite());
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              sink.end();
              return;
            }
            if (value) sink.write(Buffer.from(value));
            pump();
          })
          .catch(reject);
      };
      pump();
    });
  }

  const digest = await sha256File(path);
  if (digest !== MODEL_SHA) {
    throw new Error(`Model SHA-256 is ${digest}, expected ${MODEL_SHA}.`);
  }
}

/** Serves the cached model to the extension so the download never reaches the network. */
export async function routeModel(context: BrowserContext, modelPath: string): Promise<void> {
  await context.route('**/*plamo-3-translate-0.8b-Q4_K_M.gguf*', async (route) => {
    await route.fulfill({
      path: modelPath,
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  });
}

export async function prepareModel(
  page: Page,
): Promise<{ downloadMs: number; warmMs: number; status: EngineStatus }> {
  await page.evaluate(async (stored) => {
    const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;
    await chrome.storage.local.set({ settings: stored, siteRules: {} });
  }, settings());

  const downloadStarted = Date.now();
  const accepted = await extensionCall(page, { type: 'model:download', modelId: MODEL_ID });
  if (accepted !== true) {
    throw new Error(`The model download was refused: ${JSON.stringify(accepted)}`);
  }

  let status = await readStatus(page);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    status = await readStatus(page);
    const state = status?.model.state ?? 'unknown';
    if (state === 'error') {
      throw new Error(status?.model.error ?? 'The model download failed.');
    }
    if (state === 'ready' || state === 'loaded') break;
    log('bench', `model ${state} ${String(Math.round((status?.model.progress ?? 0) * 100))}%`);
    await page.waitForTimeout(2000);
  }
  if (!status || (status.model.state !== 'ready' && status.model.state !== 'loaded')) {
    throw new Error(`The model was not ready: ${status?.model.state ?? 'missing'}.`);
  }
  const downloadMs = Date.now() - downloadStarted;

  const warmStarted = Date.now();
  log('bench', 'loading the model');
  const warmed = await extensionCall(page, { type: 'engine:warm' });
  if (warmed !== true) throw new Error('The model warm-up failed.');
  status = await readStatus(page);
  if (!status?.plamoReady) throw new Error('PLaMo did not become ready after warm-up.');
  return { downloadMs, warmMs: Date.now() - warmStarted, status };
}

export async function clearCache(page: Page): Promise<void> {
  await extensionCall(page, { type: 'cache:clear' });
}
