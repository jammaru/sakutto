import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchExtension, loadExtension, type LoadedExtension } from './extension';
import { DEFAULT_MODEL_ID, getModel } from '../src/engine/model/catalog';

const PICKER_HINT =
  'The folder picker opens in Documents. Create a folder named “Sakutto” there, or open it if it already exists, then select Documents\\Sakutto.';
const FOLDER_RADIO = 'Use a shared model folder (Chrome and Edge)';
const BROWSER_RADIO = 'Save in this browser (recommended)';
const OFFER_OPEN_SETTINGS = 'Choose the folder in Settings';
const ALLOW_FOLDER_ACCESS = 'Allow folder access';

test.describe('shared model folder', () => {
  test('shows the Chromium folder controls and rejects a wrong-sized file', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(page.getByRole('heading', { name: 'Shared model folder' })).toBeVisible();
      await expect(page.getByText(PICKER_HINT)).toBeVisible();
      await expect(
        page.getByText('The default is still storage inside this browser.'),
      ).toBeVisible();
      await expect(page.getByText('A shared folder means:')).toBeVisible();
      await expect(
        page.getByText('One copy on disk, so you save space (573 MB / 1.81 GB).'),
      ).toBeVisible();
      await plantLicenseConsent(page);
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
            showDirectoryPicker: (options?: unknown) => Promise<FileSystemDirectoryHandle>;
            __sakuttoPicker?: unknown;
          }
        ).showDirectoryPicker = async (options) => {
          (globalThis as unknown as { __sakuttoPicker?: unknown }).__sakuttoPicker = options;
          return chosen;
        };
      }, official);

      await choose.click();
      expect(
        await page.evaluate(() => (globalThis as { __sakuttoPicker?: unknown }).__sakuttoPicker),
      ).toEqual({
        id: 'sakutto-models',
        mode: 'readwrite',
        startIn: 'documents',
      });
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

  test('options turns Documents into a Sakutto folder', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(page);
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const documents = await root.getDirectoryHandle('Documents', { create: true });
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker = async () => documents;
      });
      await page.getByRole('button', { name: 'Choose model folder' }).click();
      await expect(page.getByRole('status')).toHaveText('Using the folder Sakutto.', {
        timeout: 15_000,
      });
      await expect
        .poll(async () => directoryExists(page, ['Documents', 'Sakutto', 'sakutto-models']), {
          timeout: 15_000,
        })
        .toBe(true);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding uses a verified shared file and does not download', async () => {
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await plantVerifiedSharedModel(page);
      await page.getByRole('radio', { name: FOLDER_RADIO }).check();
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.getByRole('heading', { name: "You're ready." })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole('button', { name: 'Try a sample page' })).toBeVisible();
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding stays on the license screen when a folder already has a verified file', async () => {
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantVerifiedSharedModel(planter);
      await persistPlantedSharedFolder(planter);
      await reloadFolder(planter);
      await planter.close();

      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await expect(
        page.getByRole('button', { name: 'Agree to the license and start' }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: "You're ready." })).toHaveCount(0);
      await expect(page.getByRole('radio', { name: FOLDER_RADIO })).toBeChecked();
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding downloads into the browser when the recommended option is left selected', async () => {
    const extension = await loadExtension('en-US');
    await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await mockEmptySharedFolder(page);
      await expect(page.getByRole('radio', { name: BROWSER_RADIO })).toBeChecked();
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.getByText('Downloading 0% (0 MB / 573 MB)')).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 15_000 })
        .toMatchObject({ configured: false });
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding downloads into an empty shared folder, not OPFS', async () => {
    const extension = await loadExtension('en-US');
    await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await mockEmptySharedFolder(page);
      await expect(page.getByRole('radio', { name: BROWSER_RADIO })).toBeChecked();
      await page.getByRole('radio', { name: FOLDER_RADIO }).check();
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.getByText('Downloading 0% (0 MB / 573 MB)')).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'granted' });
      await expect
        .poll(async () => directoryExists(page, ['e2e-shared', 'sakutto-models']), {
          timeout: 15_000,
        })
        .toBe(true);
      expect(await listDirectory(page, ['sakutto', 'models'])).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding stays put and shows one integrity alert for a wrong file', async () => {
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    const official = getModel(DEFAULT_MODEL_ID).file;
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await page.getByRole('radio', { name: FOLDER_RADIO }).check();
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
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      const alert = page.getByRole('alert').filter({ hasText: 'is not the official PLaMo model' });
      await expect(alert).toHaveCount(1, { timeout: 30_000 });
      await expect(alert).toHaveText(
        `The file ${official} is not the official PLaMo model, so Sakutto will not use it.`,
      );
      await expect(page.getByRole('heading', { name: "You're ready." })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding stays put when the folder picker is cancelled', async () => {
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await page.evaluate(() => {
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker = async () => {
          throw new DOMException('The user aborted a request.', 'AbortError');
        };
      });
      await expect(page.getByRole('radio', { name: BROWSER_RADIO })).toBeChecked();
      await page.getByRole('radio', { name: FOLDER_RADIO }).check();
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(
        page.getByRole('button', { name: 'Agree to the license and start' }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: "You're ready." })).toHaveCount(0);
      await expect(page.getByRole('radio', { name: FOLDER_RADIO })).toBeChecked();
      await expect(page.locator('[data-folder-picker-hint]')).toHaveText(PICKER_HINT);
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding can switch to browser storage after a cancelled picker', async () => {
    const extension = await loadExtension('en-US');
    await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await page.evaluate(() => {
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker = async () => {
          throw new DOMException('The user aborted a request.', 'AbortError');
        };
      });
      await page.getByRole('radio', { name: FOLDER_RADIO }).check();
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.locator('[data-folder-picker-hint]')).toHaveText(PICKER_HINT);
      await page.getByRole('radio', { name: BROWSER_RADIO }).check();
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.getByText('Downloading 0% (0 MB / 573 MB)')).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 15_000 })
        .toMatchObject({ configured: false });
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('options stays put and repeats the picker steps when cancelled', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(page);
      await page.evaluate(() => {
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker = async () => {
          throw new DOMException('The user aborted a request.', 'AbortError');
        };
      });
      await page.getByRole('button', { name: 'Choose model folder' }).click();
      await expect(page.locator('[data-folder-picker-hint]')).toHaveText(PICKER_HINT);
      await expect(page.getByText('Models are stored inside this browser.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop using shared folder' })).toBeDisabled();
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding creates Sakutto under Documents and shows that name', async () => {
    const extension = await loadExtension('en-US');
    await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await page.getByRole('radio', { name: FOLDER_RADIO }).check();
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const documents = await root.getDirectoryHandle('Documents', { create: true });
        (
          globalThis as unknown as {
            showDirectoryPicker: (options?: unknown) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker = async (options) => {
          (globalThis as unknown as { __sakuttoPicker?: unknown }).__sakuttoPicker = options;
          return documents;
        };
      });
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.getByRole('status')).toHaveText('Using the folder Sakutto.');
      await expect
        .poll(async () => directoryExists(page, ['Documents', 'Sakutto', 'sakutto-models']), {
          timeout: 15_000,
        })
        .toBe(true);
      expect(await listDirectory(page, ['sakutto', 'models'])).toEqual([]);
      expect(
        await page.evaluate(() => (globalThis as { __sakuttoPicker?: unknown }).__sakuttoPicker),
      ).toEqual({
        id: 'sakutto-models',
        mode: 'readwrite',
        startIn: 'documents',
      });
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding skips the download when Sakutto already has a verified file', async () => {
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await plantVerifiedSharedModel(page, 'Sakutto');
      await page.getByRole('radio', { name: FOLDER_RADIO }).check();
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.getByRole('heading', { name: "You're ready." })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole('status')).toHaveText('Using the folder Sakutto.');
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('offers a one-time move after onboarding saves the model in this browser', async () => {
    test.setTimeout(180_000);
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const onboarding = await extension.context.newPage();
      await onboarding.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await onboarding.getByRole('radio', { name: BROWSER_RADIO }).check();
      await onboarding.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(onboarding.getByRole('heading', { name: "You're ready." })).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(async () => readOfferDismissed(onboarding)).toBe(false);
      expect(hits).toEqual([]);
      await onboarding.close();

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      const offer = popup.getByText('Moving to a shared folder means:');
      await expect(offer).toBeVisible({ timeout: 30_000 });
      const options = await pickFolderFromPopupOffer(extension, popup);
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 180_000 })
        .toMatchObject({ configured: true, permission: 'granted' });
      await expect
        .poll(async () => directoryExists(options, ['e2e-shared', 'sakutto-models']), {
          timeout: 15_000,
        })
        .toBe(true);
      expect(hits).toEqual([]);
      await options.close();
      await popup.close();

      const again = await extension.context.newPage();
      await again.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(again.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expect(again.getByText('Moving to a shared folder means:')).toHaveCount(0);
      await expect(
        again.getByRole('button', { name: 'Choose the folder in Settings' }),
      ).toHaveCount(0);
      await again.close();
    } finally {
      await extension.close();
    }
  });

  // Picker is mocked with an OPFS directory handle, so this cannot prove Chromium
  // FSA grants survive popup close or restart. One-copy-on-disk after a verified
  // move is covered in unit tests (real bytes + SHA-256). See
  // docs/design/fsa-permission-lifetime.md.
  test('translates after a popup-card move, after the popup closes, and after a restart', async () => {
    test.setTimeout(180_000);
    const profileDirectory = await mkdtemp(join(tmpdir(), 'sakutto-folder-move-'));
    try {
      const extension = await launchExtension('en-US', profileDirectory, false);
      const hits = await interceptGguf(extension, 'hang');
      try {
        const planter = await extension.context.newPage();
        await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
        await plantOpfsOfficial(planter);
        await planter.close();

        const onboarding = await extension.context.newPage();
        await onboarding.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
        await onboarding.getByRole('radio', { name: BROWSER_RADIO }).check();
        await onboarding.getByRole('button', { name: 'Agree to the license and start' }).click();
        await expect(onboarding.getByRole('heading', { name: "You're ready." })).toBeVisible({
          timeout: 30_000,
        });
        await onboarding.close();

        const popup = await extension.context.newPage();
        await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
        await expect(popup.getByText('Moving to a shared folder means:')).toBeVisible({
          timeout: 30_000,
        });
        const options = await pickFolderFromPopupOffer(extension, popup);
        await expect
          .poll(async () => readSharedFolder(options), { timeout: 180_000 })
          .toMatchObject({
            configured: true,
          });
        await expect
          .poll(async () => readModelState(options), { timeout: 60_000 })
          .toMatch(/^(ready|loaded|loading)$/);
        expect(hits).toEqual([]);
        await options.close();
        await popup.close();

        await expectSampleTranslates(extension);
        expect(hits).toEqual([]);
      } finally {
        await extension.close();
      }

      const extensionId = extension.extensionId;
      const restarted = await launchExtension('en-US', profileDirectory, false);
      expect(restarted.extensionId).toBe(extensionId);
      const restartHits = await interceptGguf(restarted, 'hang');
      try {
        await expectSampleTranslates(restarted);
        expect(restartHits).toEqual([]);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  });

  test('hides the onboarding browser-storage offer after the popup is closed', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const onboarding = await extension.context.newPage();
      await onboarding.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await onboarding.getByRole('radio', { name: BROWSER_RADIO }).check();
      await onboarding.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(onboarding.getByRole('heading', { name: "You're ready." })).toBeVisible({
        timeout: 30_000,
      });
      await onboarding.close();

      const first = await extension.context.newPage();
      await first.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(first.getByText('Moving to a shared folder means:')).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(async () => readOfferDismissed(first), { timeout: 10_000 }).toBe(true);
      await first.close();

      const again = await extension.context.newPage();
      await again.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(again.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expect(again.getByText('Moving to a shared folder means:')).toHaveCount(0);
      await expect(
        again.getByRole('button', { name: 'Choose the folder in Settings' }),
      ).toHaveCount(0);
      await again.close();
    } finally {
      await extension.close();
    }
  });

  test('offers a one-click move when an official model is already in OPFS', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      const offer = popup.getByText('Moving to a shared folder means:');
      await expect(offer).toBeVisible({ timeout: 30_000 });
      await expect(popup.getByText(PICKER_HINT)).toBeVisible();
      await expect(popup.getByText('サイトアクセス時は常に許可')).toBeVisible();
      await expect(popup.getByText('アクセスするたびに確認する')).toBeVisible();
      await expect(popup.getByText('One copy on disk, so you save space (573 MB).')).toBeVisible();
      await expect(
        popup.getByRole('button', { name: 'Choose the folder in Settings' }),
      ).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Later' })).toBeVisible();
      await expect(popup.getByRole('button', { name: "Don't show again" })).toHaveCount(0);
      await expect(popup.locator('dialog')).toHaveCount(0);

      await expect.poll(async () => readOfferDismissed(popup), { timeout: 10_000 }).toBe(true);
      await popup.getByRole('button', { name: 'Later' }).click();
      await expect(offer).toHaveCount(0);
      await popup.reload();
      await expect(offer).toHaveCount(0);
      await expect(popup.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await popup.close();

      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(
        options.getByRole('button', { name: 'Choose the folder in Settings' }),
      ).toHaveCount(0);
      await expect(options.getByRole('button', { name: 'Choose model folder' })).toBeVisible();
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('repeats the picker steps when the move offer picker is cancelled', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(popup.getByText('Moving to a shared folder means:')).toBeVisible({
        timeout: 30_000,
      });
      const [options] = await Promise.all([
        extension.context.waitForEvent('page'),
        popup.getByRole('button', { name: OFFER_OPEN_SETTINGS }).click(),
      ]);
      await expect(options.getByRole('heading', { name: 'Shared model folder' })).toBeVisible({
        timeout: 15_000,
      });
      await plantLicenseConsent(options);
      await options.evaluate(() => {
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker = async () => {
          throw new DOMException('The user aborted a request.', 'AbortError');
        };
      });
      await options.getByRole('button', { name: 'Choose model folder' }).click();
      await expect(options.locator('[data-folder-picker-hint]')).toHaveText(PICKER_HINT);
      await expect(popup.getByRole('button', { name: OFFER_OPEN_SETTINGS })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Later' })).toBeVisible();
      await options.close();
      await popup.close();
    } finally {
      await extension.close();
    }
  });

  test('does not show the move offer again after the popup is closed', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const first = await extension.context.newPage();
      await first.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(first.getByText('Moving to a shared folder means:')).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(async () => readOfferDismissed(first), { timeout: 10_000 }).toBe(true);
      await first.close();

      const again = await extension.context.newPage();
      await again.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(again.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expect(again.getByText('Moving to a shared folder means:')).toHaveCount(0);
      await expect(
        again.getByRole('button', { name: 'Choose the folder in Settings' }),
      ).toHaveCount(0);
      await again.close();

      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(options.getByRole('button', { name: 'Choose model folder' })).toBeVisible();
      await expect(
        options.getByRole('button', { name: 'Choose the folder in Settings' }),
      ).toHaveCount(0);
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('hides the move offer when the folder picker is missing', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const page = await extension.context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'showDirectoryPicker', {
          configurable: true,
          value: undefined,
        });
      });
      await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(page.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose the folder in Settings' })).toHaveCount(
        0,
      );
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('does not show the move offer without an installed official model', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(page.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose the folder in Settings' })).toHaveCount(
        0,
      );
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('keeps the folder option in settings without a move prompt', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(page.getByRole('heading', { name: 'Shared model folder' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose model folder' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose the folder in Settings' })).toHaveCount(
        0,
      );
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('moves from OPFS in one click after the folder picker', async () => {
    test.setTimeout(180_000);
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(page.getByRole('button', { name: OFFER_OPEN_SETTINGS })).toBeVisible({
        timeout: 30_000,
      });
      const options = await pickFolderFromPopupOffer(extension, page);
      expect(
        await options.evaluate(() => (globalThis as { __sakuttoPicker?: unknown }).__sakuttoPicker),
      ).toEqual({
        id: 'sakutto-models',
        mode: 'readwrite',
        startIn: 'documents',
      });
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 180_000 })
        .toMatchObject({ configured: true, permission: 'granted' });
      await options.close();
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('hides the onboarding folder choice when the picker is missing', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'showDirectoryPicker', {
          configurable: true,
          value: undefined,
        });
      });
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await expect(
        page.getByRole('button', { name: 'Agree to the license and start' }),
      ).toBeVisible();
      await expect(page.getByRole('radio')).toHaveCount(0);
      await expect(page.getByText(FOLDER_RADIO)).toHaveCount(0);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('restores a mocked prompt grant with one click and does not download', async () => {
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(options);
      await mockEmptySharedFolder(options);
      await options.getByRole('button', { name: 'Choose model folder' }).click();
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 30_000 })
        .toMatchObject({ configured: true, permission: 'granted' });

      await setPermissionOverride(options, 'prompt');
      await reloadFolder(options);
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'prompt' });
      await options.reload();
      await expect(options.getByRole('heading', { name: 'Shared model folder' })).toBeVisible();
      await expect(options.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toBeVisible();
      await options.getByRole('button', { name: ALLOW_FOLDER_ACCESS }).click();
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'granted' });
      expect(hits).toEqual([]);
      await options.close();

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await setPermissionOverride(popup, 'prompt');
      await reloadFolder(popup);
      await expect
        .poll(async () => readSharedFolder(popup), { timeout: 15_000 })
        .toMatchObject({ permission: 'prompt' });
      await popup.reload();
      await expect(popup.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toBeVisible();
      await expect(
        popup.getByText(
          'Page translation waits until the PLaMo model finishes downloading and loads.',
        ),
      ).toHaveCount(0);
      await expect(popup.getByRole('button', { name: 'Open onboarding' })).toHaveCount(0);
      await expect(popup.getByText('The model could not be loaded')).toHaveCount(0);
      await popup.getByRole('button', { name: ALLOW_FOLDER_ACCESS }).click();
      await expect
        .poll(async () => readSharedFolder(popup), { timeout: 15_000 })
        .toMatchObject({ permission: 'granted' });
      expect(hits).toEqual([]);
      await expect(popup.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toHaveCount(0);
      await popup.close();
    } finally {
      await extension.close();
    }
  });

  test('keeps the restore button when a mocked grant stays denied', async () => {
    const extension = await loadExtension('en-US');
    try {
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(options);
      await mockEmptySharedFolder(options);
      await options.getByRole('button', { name: 'Choose model folder' }).click();
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 30_000 })
        .toMatchObject({ configured: true });

      await setPermissionOverride(options, 'denied');
      await reloadFolder(options);
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 15_000 })
        .toMatchObject({ permission: 'denied' });
      await options.reload();
      await expect(options.getByRole('heading', { name: 'Shared model folder' })).toBeVisible();
      await expect(options.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toBeVisible();
      await options.getByRole('button', { name: ALLOW_FOLDER_ACCESS }).click();
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 10_000 })
        .toMatchObject({ permission: 'denied' });
      await expect(options.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toBeVisible();
      await options.close();
    } finally {
      await extension.close();
    }
  });
});

async function interceptGguf(
  extension: LoadedExtension,
  mode: 'hang' | 'partial',
): Promise<string[]> {
  const hits: string[] = [];
  const size = getModel(DEFAULT_MODEL_ID).size;
  const modelDownload = /gguf|huggingface\.co|cdn-lfs|hf\.co/i;
  extension.context.on('request', (request) => {
    if (modelDownload.test(request.url())) hits.push(request.url());
  });
  await extension.context.route(modelDownload, async (route) => {
    hits.push(route.request().url());
    if (mode === 'hang') {
      await new Promise(() => undefined);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      },
      body: Buffer.alloc(64 * 1024),
    });
  });
  return hits;
}

async function mockEmptySharedFolder(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const chosen = await root.getDirectoryHandle('e2e-shared', { create: true });
    (
      globalThis as unknown as {
        showDirectoryPicker: (options?: unknown) => Promise<FileSystemDirectoryHandle>;
        __sakuttoPicker?: unknown;
      }
    ).showDirectoryPicker = async (options) => {
      (globalThis as unknown as { __sakuttoPicker?: unknown }).__sakuttoPicker = options;
      return chosen;
    };
  });
}

async function pickFolderFromPopupOffer(extension: LoadedExtension, popup: Page): Promise<Page> {
  const [options] = await Promise.all([
    extension.context.waitForEvent('page'),
    popup.getByRole('button', { name: OFFER_OPEN_SETTINGS }).click(),
  ]);
  await expect(options.getByRole('heading', { name: 'Shared model folder' })).toBeVisible({
    timeout: 15_000,
  });
  await plantLicenseConsent(options);
  await mockEmptySharedFolder(options);
  await options.getByRole('button', { name: 'Choose model folder' }).click();
  return options;
}

async function plantLicenseConsent(page: Page): Promise<void> {
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

async function persistPlantedSharedFolder(page: Page, folderName = 'e2e-shared'): Promise<void> {
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const chosen = await root.getDirectoryHandle(name);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('sakutto-model-folder', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(
          { handle: chosen, name: chosen.name, savedAt: Date.now() },
          'directory',
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('persist failed'));
      };
      request.onerror = () => reject(request.error ?? new Error('open failed'));
    });
  }, folderName);
}

async function setPermissionOverride(
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

async function reloadFolder(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }
    ).chrome;
    await chrome.runtime.sendMessage({ type: 'model-folder:reload' });
  });
}

async function plantOpfsOfficial(page: Page): Promise<void> {
  const entry = getModel(DEFAULT_MODEL_ID);
  const planted = await page.evaluate(async (payload) => {
    const root = await navigator.storage.getDirectory();
    const sakutto = await root.getDirectoryHandle('sakutto', { create: true });
    const models = await sakutto.getDirectoryHandle('models', { create: true });
    const modelDir = await models.getDirectoryHandle(payload.id, { create: true });
    const file = await modelDir.getFileHandle('model.gguf', { create: true });
    const writable = await file.createWritable();
    if (payload.size > 0) {
      await writable.seek(payload.size - 1);
      await writable.write(new Uint8Array([0]));
    }
    await writable.close();
    const manifest = await modelDir.getFileHandle('model.json', { create: true });
    const manifestWriter = await manifest.createWritable();
    await manifestWriter.write(
      JSON.stringify({
        id: payload.id,
        sha256: payload.sha256,
        size: payload.size,
        commit: payload.commit,
        verifiedAt: Date.now(),
      }),
    );
    await manifestWriter.close();
    return (await file.getFile()).size;
  }, entry);
  expect(planted).toBe(entry.size);
}

async function plantVerifiedSharedModel(page: Page, folderName = 'e2e-shared'): Promise<void> {
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

async function directoryExists(page: Page, parts: readonly string[]): Promise<boolean> {
  return page.evaluate(async (segments) => {
    let directory = await navigator.storage.getDirectory();
    for (const part of segments) {
      try {
        directory = await directory.getDirectoryHandle(part);
      } catch {
        return false;
      }
    }
    return true;
  }, parts);
}

async function readOfferDismissed(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: {
          storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
        };
      }
    ).chrome;
    const stored = await chrome.storage.local.get('settings');
    const settings = stored.settings;
    return (
      typeof settings === 'object' &&
      settings !== null &&
      (settings as { sharedFolderOfferDismissed?: unknown }).sharedFolderOfferDismissed === true
    );
  });
}

async function expectSampleTranslates(extension: LoadedExtension): Promise<void> {
  const sample = await extension.context.newPage();
  try {
    await sample.goto(`chrome-extension://${extension.extensionId}/sample.html?to=ja`);
    await expect(sample.locator('article[data-sample="en"] h1')).toContainText(
      '§ja§Morning at the station',
      { timeout: 30_000 },
    );
    await expect
      .poll(async () => readModelState(sample), { timeout: 60_000 })
      .toMatch(/^(ready|loaded|loading)$/);
    await expect
      .poll(async () => readSharedFolder(sample), { timeout: 15_000 })
      .toMatchObject({ configured: true });
  } finally {
    await sample.close();
  }
}

async function readModelState(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }
    ).chrome;
    const response = (await chrome.runtime.sendMessage({ type: 'engine:status' })) as {
      model?: { state?: string };
    } | null;
    return response?.model?.state;
  });
}

async function readSharedFolder(
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

async function listDirectory(page: Page, parts: readonly string[]): Promise<string[]> {
  return page.evaluate(async (segments) => {
    let directory = await navigator.storage.getDirectory();
    for (const part of segments) {
      try {
        directory = await directory.getDirectoryHandle(part);
      } catch {
        return [];
      }
    }
    const names: string[] = [];
    const listing = directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    };
    for await (const [name] of listing.entries()) names.push(name);
    return names.sort();
  }, parts);
}
