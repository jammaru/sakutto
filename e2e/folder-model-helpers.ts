import { expect, type Page } from '@playwright/test';
import { DEFAULT_MODEL_ID, getModel } from '../src/engine/model/catalog';

export async function plantLicenseConsent(page: Page): Promise<void> {
  await page.evaluate(async () => {
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
    const previous =
      stored.settings && typeof stored.settings === 'object'
        ? (stored.settings as Record<string, unknown>)
        : {};
    await chrome.storage.local.set({
      settings: {
        ...previous,
        schemaVersion: 1,
        consent: {
          license: 'plamo-community',
          version: '2026-11-05',
          notice: '2026-11-06',
          acceptedAt: '2026-11-05T00:00:00.000Z',
          ageNoticeShown: true,
        },
      },
    });
  });
}

export async function setPermissionOverride(
  page: Page,
  value: 'prompt' | 'denied' | 'granted' | null,
): Promise<void> {
  await page.evaluate(async (state) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('sakutto-model-folder', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('handles', 'readwrite');
        if (state) tx.objectStore('handles').put(state, 'test-permission');
        else tx.objectStore('handles').delete('test-permission');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('permission override failed'));
      };
      request.onerror = () => reject(request.error ?? new Error('permission override open failed'));
    });
  }, value);
}

export async function reloadFolder(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }
    ).chrome;
    await chrome.runtime.sendMessage({ type: 'model-folder:reload' });
  });
}

export async function plantVerifiedSharedModel(
  page: Page,
  folderName = 'e2e-shared',
): Promise<void> {
  const entry = getModel(DEFAULT_MODEL_ID);
  const planted = await page.evaluate(
    async (payload) => {
      const root = await navigator.storage.getDirectory();
      const chosen = await root.getDirectoryHandle(payload.folderName, { create: true });
      const models = await chosen.getDirectoryHandle('sakutto-models', { create: true });
      const file = await models.getFileHandle(payload.file, { create: true });
      const writable = await file.createWritable();
      if (payload.size > 0) {
        await writable.seek(payload.size - 1);
        await writable.write(new Uint8Array([0]));
      }
      await writable.close();
      const sidecar = await models.getFileHandle(`${payload.file}.verified.json`, { create: true });
      const sidecarWriter = await sidecar.createWritable();
      await sidecarWriter.write(
        JSON.stringify({
          id: payload.id,
          sha256: payload.sha256,
          size: payload.size,
          commit: payload.commit,
          verifiedAt: Date.now(),
        }),
      );
      await sidecarWriter.close();
      (
        globalThis as unknown as {
          showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker = async () => chosen;
      return (await file.getFile()).size;
    },
    {
      folderName,
      id: entry.id,
      file: entry.file,
      size: entry.size,
      sha256: entry.sha256,
      commit: entry.commit,
    },
  );
  expect(planted).toBe(entry.size);
}

export async function chooseEmptySharedFolder(page: Page, folderName = 'e2e-empty'): Promise<void> {
  await plantLicenseConsent(page);
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const chosen = await root.getDirectoryHandle(name, { create: true });
    (
      globalThis as unknown as {
        showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker = async () => chosen;
  }, folderName);
  await page.getByRole('radio', { name: 'Shared folder' }).check();
  await expect
    .poll(async () => readSharedFolder(page), { timeout: 30_000 })
    .toMatchObject({ configured: true });
}

export async function chooseSharedFolder(page: Page): Promise<void> {
  await plantLicenseConsent(page);
  await plantVerifiedSharedModel(page);
  await page.getByRole('radio', { name: 'Shared folder' }).check();
  await expect
    .poll(async () => readSharedFolder(page), { timeout: 30_000 })
    .toMatchObject({ configured: true, permission: 'granted' });
}

export async function readSharedFolder(
  page: Page,
): Promise<{ configured: boolean | undefined; permission: string | undefined }> {
  return page.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }
    ).chrome;
    const response = (await chrome.runtime.sendMessage({ type: 'engine:status' })) as {
      sharedFolder?: { configured?: boolean; permission?: string };
    } | null;
    return {
      configured: response?.sharedFolder?.configured,
      permission: response?.sharedFolder?.permission,
    };
  });
}
