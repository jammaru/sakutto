import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  chooseEmptySharedFolder,
  plantLicenseConsent,
  readSharedFolder,
  reloadFolder,
  setPermissionOverride,
} from './folder-model-helpers';
import { seedStandardOcrModels } from './ocr-model-helpers';

async function listOcrFiles(page: Page, store: 'folder' | 'browser'): Promise<string[]> {
  return page.evaluate(async (which) => {
    const root = await navigator.storage.getDirectory();
    try {
      const directory =
        which === 'folder'
          ? await (
              await (
                await root.getDirectoryHandle('e2e-empty')
              ).getDirectoryHandle('sakutto-models')
            ).getDirectoryHandle('ocr-standard')
          : await (
              await (await root.getDirectoryHandle('sakutto')).getDirectoryHandle('models')
            ).getDirectoryHandle('ocr-standard');
      const names: string[] = [];
      for await (const entry of directory.values()) {
        if (entry.kind === 'file') names.push(entry.name);
      }
      return names.sort();
    } catch {
      return [];
    }
  }, store);
}

async function inspectStandardOcr(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }
    ).chrome;
    return chrome.runtime.sendMessage({ type: 'ocr:inspect', tier: 'standard' });
  });
}

/**
 * The reproduction from PR #154: a shared folder holds only the PLaMo GGUF. OCR must write
 * its ONNX weights into that same folder (in an ocr-standard/ subfolder) and must not fetch
 * them again when another profile finds the verified files there.
 */
test('OCR weights are written into the shared folder and reused from it', async () => {
  test.setTimeout(180_000);
  const extension = await loadExtension('en-US');
  try {
    // Seed browser-storage OCR first, then copy it into the chosen folder exactly as a
    // second profile would find it. No Hugging Face traffic is allowed by loadExtension.
    await seedStandardOcrModels(extension);
    const page = await extension.context.newPage();
    try {
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(page);
      await chooseEmptySharedFolder(page);
      const copied = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const source = await (
          await (await root.getDirectoryHandle('sakutto')).getDirectoryHandle('models')
        ).getDirectoryHandle('ocr-standard');
        const chosen = await root.getDirectoryHandle('e2e-empty');
        const models = await chosen.getDirectoryHandle('sakutto-models', { create: true });
        const target = await models.getDirectoryHandle('ocr-standard', { create: true });
        const names: string[] = [];
        for await (const entry of source.values()) {
          if (entry.kind !== 'file') continue;
          names.push(entry.name);
          const handle = await target.getFileHandle(entry.name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(await (await source.getFileHandle(entry.name)).getFile());
          await writable.close();
        }
        const manifest = JSON.parse(
          await (await (await target.getFileHandle('asset.json')).getFile()).text(),
        );
        for (const file of manifest.files) {
          file.lastModified = (
            await (await target.getFileHandle(file.path)).getFile()
          ).lastModified;
        }
        const sidecar = await target.getFileHandle('asset.json', { create: true });
        const writer = await sidecar.createWritable();
        await writer.write(JSON.stringify(manifest));
        await writer.close();
        return names;
      });
      expect(copied).toContain('tiny_det.onnx');
      expect(copied).toContain('small_rec.onnx');
      expect(copied).toContain('asset.json');

      // A folder change re-resolves the OCR store; the copied sidecar makes the bundle ready.
      await reloadFolder(page);
      expect(await inspectStandardOcr(page)).toMatchObject({ state: 'ready', id: 'standard' });
      expect(extension.denied.filter((url) => url.includes('huggingface'))).toEqual([]);
    } finally {
      await page.close();
    }
  } finally {
    await extension.close();
  }
});

/**
 * The re-review blocker: with a folder linked but its grant gone, a Settings download must
 * ask for permission and never write the OCR bundle into OPFS behind the user's back.
 */
test('a missing folder grant blocks OCR downloads instead of falling back to OPFS', async () => {
  test.setTimeout(120_000);
  const extension = await loadExtension('en-US');
  try {
    const page = await extension.context.newPage();
    try {
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await chooseEmptySharedFolder(page);
      // Fake-engine 'denied' stands in for a restore prompt the user dismissed: the tab cannot
      // turn it into a grant, so the action must stop with the permission warning.
      await setPermissionOverride(page, 'denied');
      await reloadFolder(page);
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'denied' });

      await page.getByRole('button', { name: 'Standard OCR Download' }).click();
      await expect(
        page
          .locator('.ocr-models')
          .getByText('Sakutto needs permission to read the shared model folder.'),
      ).toBeVisible();
      await expect.poll(async () => listOcrFiles(page, 'browser'), { timeout: 15_000 }).toEqual([]);
      expect(await listOcrFiles(page, 'folder')).toEqual([]);
    } finally {
      await page.close();
    }
  } finally {
    await extension.close();
  }
});

/**
 * The original e2e copied already-downloaded OCR files into the folder by hand. This one runs
 * the real Settings download into the empty folder and checks where the bytes land.
 */
test('a Settings download writes OCR weights into an empty chosen folder', async () => {
  test.setTimeout(180_000);
  const extension = await loadExtension('en-US');
  try {
    const page = await extension.context.newPage();
    try {
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await chooseEmptySharedFolder(page);
      await page.getByRole('button', { name: 'Standard OCR Download' }).click();
      await expect
        .poll(async () => listOcrFiles(page, 'folder'), { timeout: 120_000 })
        .toEqual(['asset.json', 'small_rec.onnx', 'tiny_det.onnx']);
      expect(await inspectStandardOcr(page)).toMatchObject({ state: 'ready', id: 'standard' });
      expect(await listOcrFiles(page, 'browser')).toEqual([]);
    } finally {
      await page.close();
    }
  } finally {
    await extension.close();
  }
});
