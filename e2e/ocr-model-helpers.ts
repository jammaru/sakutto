import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { OCR_TIER_CATALOG } from '../src/engine/ocr/catalog';
import type { LoadedExtension } from './extension';

/**
 * OCR models are never committed. Read a local cache when one exists (the maintainer's
 * machine), otherwise download the pinned bundles once into a temporary directory. The bytes
 * are then written straight into the extension's OPFS store, so the 30-second page assertion
 * measures OCR, not a 23 MB network transfer.
 */
export async function ocrModelBytes(): Promise<Record<string, Uint8Array>> {
  const cache = process.env.SAKUTTO_OCR_MODEL_DIR;
  const output: Record<string, Uint8Array> = {};
  for (const file of OCR_TIER_CATALOG.standard.files) {
    const path = cache ? join(cache, file.path) : join(tmpdir(), 'sakutto-e2e-models', file.path);
    try {
      await access(path);
    } catch {
      if (!cache) {
        await mkdir(join(tmpdir(), 'sakutto-e2e-models'), { recursive: true });
        const response = await fetch(file.url);
        if (!response.ok) throw new Error(`OCR model download failed: ${file.url}`);
        await writeFile(path, Buffer.from(await response.arrayBuffer()));
      }
    }
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength !== file.size) {
      throw new Error(
        `OCR model ${file.path} has ${bytes.byteLength} bytes, expected ${file.size}`,
      );
    }
    output[file.path] = bytes;
  }
  return output;
}

export async function seedStandardOcrModels(extension: LoadedExtension): Promise<void> {
  const bytes = await ocrModelBytes();
  const page: Page = await extension.context.newPage();
  try {
    await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    const encoded: Record<string, string> = {};
    for (const [path, value] of Object.entries(bytes)) {
      let binary = '';
      const chunk = 0x8000;
      for (let offset = 0; offset < value.byteLength; offset += chunk) {
        binary += String.fromCharCode(...value.subarray(offset, offset + chunk));
      }
      encoded[path] = btoa(binary);
    }
    const files = OCR_TIER_CATALOG.standard.files.map((file) => ({
      path: file.path,
      commit: file.commit,
      size: file.size,
      sha256: file.sha256,
      url: file.url,
    }));
    await page.evaluate(
      async ({ encoded, files }) => {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('sakutto', { create: true });
        const models = await directory.getDirectoryHandle('models', { create: true });
        const tier = await models.getDirectoryHandle('ocr-standard', { create: true });
        const manifestFiles: Array<Record<string, unknown>> = [];
        for (const [path, base64] of Object.entries(encoded)) {
          const binary = atob(base64);
          const data = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1)
            data[index] = binary.charCodeAt(index);
          const handle = await tier.getFileHandle(path, { create: true });
          const writable = await handle.createWritable();
          await writable.write(data);
          await writable.close();
          const stat = await (await handle.getFile()).lastModified;
          const pin = files.find((item) => item.path === path);
          manifestFiles.push({ ...pin, lastModified: stat });
        }
        const manifest = { id: 'standard', verifiedAt: Date.now(), files: manifestFiles };
        const handle = await tier.getFileHandle('asset.json', { create: true });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(manifest));
        await writable.close();
      },
      { encoded, files },
    );
  } finally {
    await page.close();
  }
}

export async function setFileUrls(extension: LoadedExtension, enabled: boolean): Promise<void> {
  const before = extension.worker;
  const settings = await extension.context.newPage();
  try {
    await settings.goto(`chrome://extensions/?id=${extension.extensionId}`);
    await settings.waitForTimeout(900);
    const changed = await settings.evaluate((wanted) => {
      const manager = document.querySelector('extensions-manager');
      const details = manager?.shadowRoot?.querySelector('extensions-detail-view');
      const rows = [...(details?.shadowRoot?.querySelectorAll('extensions-toggle-row') ?? [])];
      const toggle = rows
        .find((row) => row.id === 'allow-on-file-urls')
        ?.shadowRoot?.querySelector('cr-toggle');
      if (!toggle) throw new Error('file URL toggle is missing');
      if ((toggle.getAttribute('aria-checked') === 'true') === wanted) return false;
      (toggle as HTMLElement).click();
      return true;
    }, enabled);
    if (changed) {
      await settings.waitForTimeout(500);
      extension.worker =
        extension.context.serviceWorkers().find((worker) => worker !== before) ??
        (await extension.context.waitForEvent('serviceworker', { timeout: 15_000 }));
    }
  } finally {
    await settings.close();
  }
}

/** Send the same popup message the real UI sends, from a real extension page. */
export interface PdfOpenOutcome {
  page: Page;
  reason: string | null;
}

export async function openPdfTab(
  extension: LoadedExtension,
  page: Page,
  url: string,
): Promise<PdfOpenOutcome> {
  await page.bringToFront();
  const tabId = await extension.worker.evaluate(async () => {
    const browser = (
      globalThis as unknown as {
        chrome: {
          tabs: { query(query: Record<string, unknown>): Promise<Array<{ id?: number }>> };
        };
      }
    ).chrome;
    return (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  });
  const helper: Page = await extension.context.newPage();
  const created = extension.context.waitForEvent('page', { timeout: 15_000 });
  try {
    await helper.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    const result = await helper.evaluate(
      async ({ tabId, url }) => {
        const browser = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
          }
        ).chrome;
        return (await browser.runtime.sendMessage({ type: 'pdf:open', tabId, url })) as {
          opened: boolean;
          reason?: string;
        };
      },
      { tabId, url },
    );
    const reader = await created;
    await reader.waitForURL(/reader\.html/u, { timeout: 15_000 });
    return {
      page: reader,
      reason: result?.opened === true ? null : String(result?.reason ?? 'unknown'),
    };
  } finally {
    await helper.close();
  }
}
