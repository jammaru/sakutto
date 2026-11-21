import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';
import { chooseEmptySharedFolder, plantLicenseConsent } from './folder-model-helpers';
import { seedStandardOcrModels } from './ocr-model-helpers';

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
      await page.evaluate(async () => {
        const chrome = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
          }
        ).chrome;
        await chrome.runtime.sendMessage({ type: 'model-folder:reload' });
      });
      const status = await page.evaluate(async () => {
        const chrome = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
          }
        ).chrome;
        return chrome.runtime.sendMessage({ type: 'ocr:inspect', tier: 'standard' });
      });
      expect(status).toMatchObject({ state: 'ready', id: 'standard' });
      expect(extension.denied.filter((url) => url.includes('huggingface'))).toEqual([]);
    } finally {
      await page.close();
    }
  } finally {
    await extension.close();
  }
});
