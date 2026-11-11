import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Worker } from '@playwright/test';
import { launchExtension, type LoadedExtension } from './extension';
import {
  DEFAULT_MODEL_ID,
  HIGH_QUALITY_MODEL_ID,
  getModel,
  type ModelId,
} from '../src/engine/model/catalog';

/**
 * Model bytes are not the real GGUF weights. The engine treats a file as installed when
 * `model.gguf` is the catalog size and `model.json` names the catalog hash, which is all
 * the selection and fallback paths read. A one-byte write at the last offset stands in
 * for the download.
 */
test.describe('selected model survives a browser restart', () => {
  test.describe.configure({ timeout: 180_000 });

  test('keeps High accuracy selected when Standard is also installed', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'sakutto-model-'));
    let extension: LoadedExtension | null = null;
    try {
      extension = await launchExtension('ja', profile);
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantModels(planter, [DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID]);
      await planter.close();

      const options = await openOptions(extension);
      await options.getByRole('button', { name: '高精度（2B） このモデルを使う' }).click();
      await expect(modelRow(options, '高精度（2B）').getByText('使用中')).toBeVisible({
        timeout: 60_000,
      });
      await expect(modelRow(options, '標準（0.8B）').getByText('使用中')).toHaveCount(0);
      await expect.poll(() => readSelectedModel(extension!.worker)).toBe(HIGH_QUALITY_MODEL_ID);
      await options.close();
      await extension.close();
      extension = null;

      extension = await launchExtension('ja', profile);
      const reopened = await openOptions(extension);
      await expect(modelRow(reopened, '高精度（2B）').getByText('使用中')).toBeVisible({
        timeout: 60_000,
      });
      await expect(modelRow(reopened, '標準（0.8B）').getByText('使用中')).toHaveCount(0);
      await expect(
        modelRow(reopened, '標準（0.8B）').getByRole('button', { name: 'このモデルを使う' }),
      ).toBeVisible();
      await expect(reopened.getByText('選んでいたモデルがこの端末にないため')).toHaveCount(0);
      expect(await readEngineModel(reopened)).toEqual({
        id: HIGH_QUALITY_MODEL_ID,
        fallback: false,
      });
      expect(await readSelectedModel(extension.worker)).toBe(HIGH_QUALITY_MODEL_ID);
      await reopened.close();
    } finally {
      await extension?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

  test('falls back to the only installed model and keeps that choice', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'sakutto-model-'));
    let extension: LoadedExtension | null = null;
    try {
      extension = await launchExtension('ja', profile);
      await expect.poll(() => readSelectedModel(extension!.worker)).toBe(DEFAULT_MODEL_ID);
      // Open the engine once while no model file exists, so this document does not
      // fall back and save 2B before we close. The next launch is the first time
      // the host sees the planted file.
      const primer = await extension.context.newPage();
      await primer.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      expect(await readEngineModel(primer)).toMatchObject({
        id: DEFAULT_MODEL_ID,
        fallback: false,
      });
      await plantModels(primer, [HIGH_QUALITY_MODEL_ID]);
      await primer.close();
      await writeSelectedModel(extension.worker, DEFAULT_MODEL_ID);
      await extension.close();
      extension = null;

      extension = await launchExtension('ja', profile);
      const options = await openOptions(extension);
      await expect(modelRow(options, '高精度（2B）').getByText('使用中')).toBeVisible({
        timeout: 60_000,
      });
      await expect(options.getByText('選んでいたモデルがこの端末にないため')).toBeVisible();
      await expect.poll(() => readSelectedModel(extension!.worker)).toBe(HIGH_QUALITY_MODEL_ID);
      expect(await readEngineModel(options)).toEqual({
        id: HIGH_QUALITY_MODEL_ID,
        fallback: true,
      });
      await options.close();
      await extension.close();
      extension = null;

      extension = await launchExtension('ja', profile);
      const reopened = await openOptions(extension);
      await expect(modelRow(reopened, '高精度（2B）').getByText('使用中')).toBeVisible({
        timeout: 60_000,
      });
      await expect(reopened.getByText('選んでいたモデルがこの端末にないため')).toHaveCount(0);
      expect(await readEngineModel(reopened)).toEqual({
        id: HIGH_QUALITY_MODEL_ID,
        fallback: false,
      });
      expect(await readSelectedModel(extension.worker)).toBe(HIGH_QUALITY_MODEL_ID);
      await reopened.close();
    } finally {
      await extension?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
});

function modelRow(page: Page, name: string) {
  return page.locator('li').filter({ hasText: name });
}

async function openOptions(extension: LoadedExtension): Promise<Page> {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
  await expect(page.getByRole('heading', { name: 'モデル' })).toBeVisible();
  return page;
}

async function plantModels(page: Page, modelIds: readonly ModelId[]): Promise<void> {
  const models = modelIds.map((modelId) => {
    const entry = getModel(modelId);
    return { id: entry.id, size: entry.size, sha256: entry.sha256, commit: entry.commit };
  });
  const planted = await page.evaluate(async (entries) => {
    const root = await navigator.storage.getDirectory();
    const sakutto = await root.getDirectoryHandle('sakutto', { create: true });
    const directory = await sakutto.getDirectoryHandle('models', { create: true });
    const sizes: Record<string, number> = {};
    for (const entry of entries) {
      const modelDir = await directory.getDirectoryHandle(entry.id, { create: true });
      const file = await modelDir.getFileHandle('model.gguf', { create: true });
      const writable = await file.createWritable();
      if (entry.size > 0) {
        await writable.seek(entry.size - 1);
        await writable.write(new Uint8Array([0]));
      }
      await writable.close();
      const manifest = await modelDir.getFileHandle('model.json', { create: true });
      const manifestWriter = await manifest.createWritable();
      await manifestWriter.write(
        JSON.stringify({
          id: entry.id,
          sha256: entry.sha256,
          size: entry.size,
          commit: entry.commit,
          verifiedAt: Date.now(),
        }),
      );
      await manifestWriter.close();
      sizes[entry.id] = (await file.getFile()).size;
    }
    return sizes;
  }, models);

  for (const entry of models) {
    expect(planted[entry.id]).toBe(entry.size);
  }
}

async function readSelectedModel(worker: Worker): Promise<string | undefined> {
  return worker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome;
    const stored = await chrome.storage.local.get('settings');
    const settings = stored.settings as { selectedModelId?: string } | undefined;
    return settings?.selectedModelId;
  });
}

async function writeSelectedModel(worker: Worker, modelId: string): Promise<void> {
  await worker.evaluate(async (modelId) => {
    const chrome = (
      globalThis as unknown as {
        chrome: {
          storage: {
            local: {
              get(key: string): Promise<Record<string, unknown>>;
              set(items: Record<string, unknown>): Promise<void>;
            };
          };
        };
      }
    ).chrome;
    const stored = await chrome.storage.local.get('settings');
    const settings = (stored.settings ?? {}) as Record<string, unknown>;
    settings.schemaVersion = 1;
    settings.selectedModelId = modelId;
    await chrome.storage.local.set({ settings });
  }, modelId);
}

async function readEngineModel(page: Page): Promise<{ id: string | undefined; fallback: boolean }> {
  return page.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }
    ).chrome;
    const response = (await chrome.runtime.sendMessage({ type: 'engine:status' })) as {
      model?: { id?: string };
      modelFallback?: boolean;
    } | null;
    return { id: response?.model?.id, fallback: response?.modelFallback === true };
  });
}
