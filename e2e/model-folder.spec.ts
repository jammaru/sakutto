import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';
import { DEFAULT_MODEL_ID, getModel } from '../src/engine/model/catalog';

test.describe('shared model folder', () => {
  test('shows the Chromium folder controls and rejects a wrong-sized file', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(page.getByRole('heading', { name: 'Shared model folder' })).toBeVisible();
      const choose = page.getByRole('button', { name: 'Choose model folder' });
      const stop = page.getByRole('button', { name: 'Stop using shared folder' });
      await expect(choose).toBeVisible();
      await expect(stop).toBeDisabled();

      const official = getModel(DEFAULT_MODEL_ID).file;
      await page.evaluate(async (fileName) => {
        const root = await navigator.storage.getDirectory();
        const chosen = await root.getDirectoryHandle('e2e-shared', { create: true });
        const models = await chosen.getDirectoryHandle('sakutto-models', { create: true });
        const file = await models.getFileHandle(fileName, { create: true });
        const writable = await file.createWritable();
        await writable.write(new Uint8Array([1, 2, 3, 4]));
        await writable.close();
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker = async () => chosen;
      }, official);

      await choose.click();
      const alert = page.getByRole('alert').filter({ hasText: 'is not the official PLaMo model' });
      await expect(alert).toHaveCount(1, { timeout: 30_000 });
      await expect(alert).toHaveText(
        `The file ${official} is not the official PLaMo model, so Sakutto will not use it.`,
      );
      await expect(stop).toBeEnabled();

      await stop.click();
      await expect(page.getByText('Models are stored inside this browser.')).toBeVisible();
      await expect(stop).toBeDisabled();
      await page.close();
    } finally {
      await extension.close();
    }
  });
});
