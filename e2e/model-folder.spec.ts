import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchExtension, loadExtension, type LoadedExtension } from './extension';
import { DEFAULT_MODEL_ID, getModel } from '../src/engine/model/catalog';
import { FIXTURE_ORIGIN } from './page';

const PICKER_HINT =
  'After you press start, a folder dialog opens in Documents. Create or choose Documents/Sakutto, or choose the existing folder if another browser already has the models. Any folder you can write to also works.';
const FOLDER_RADIO = 'Use a shared model folder (Chromium browsers)';
const BROWSER_RADIO = 'Save in this browser';
const SETTINGS_FOLDER_RADIO = 'Shared folder';
const SETTINGS_BROWSER_RADIO = 'In this browser';
const STORAGE_LEGEND = 'Where to save the model';
const MOVE_DONE = 'The models are now stored in the shared folder.';
const COPY_DONE = 'The models are now stored in this browser.';
const NO_MODELS = 'No official PLaMo model was found in that folder.';
const MOVE_LEAD = 'Moving to a shared folder means:';
const ALLOW_FOLDER_ACCESS = 'Allow folder access';

test.describe('shared model folder', () => {
  test('shows Chromium storage choices and rejects a wrong-sized folder file', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(page.getByRole('group', { name: STORAGE_LEGEND })).toBeVisible();
      await expect(
        page.getByText('Choose where the model is stored. Existing models move with the choice.'),
      ).toBeVisible();
      await expect(page.getByText('A shared folder means:')).toBeVisible();
      await expect(
        page.getByText('One copy on disk, so you save space (573 MB / 1.81 GB).'),
      ).toBeVisible();
      const folderRadio = page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO });
      const browserRadio = page.getByRole('radio', { name: SETTINGS_BROWSER_RADIO });
      await expect(browserRadio).toBeChecked();
      await plantLicenseConsent(page);

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

      await folderRadio.check();
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
      await expect(folderRadio).toBeChecked();
      await expect(
        page.getByText(
          'The model could not be moved to the shared folder. The browser copy was kept.',
        ),
      ).toBeVisible();
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
      await page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO }).check();
      await expect(page.getByText(MOVE_DONE)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO })).toBeChecked();
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

  test('settings moves OPFS into the chosen folder and removes the browser copy', async () => {
    test.setTimeout(180_000);
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await plantVerifiedSharedModel(planter);
      await planter.close();

      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(page);
      await mockEmptySharedFolder(page);
      await expect(page.getByRole('radio', { name: SETTINGS_BROWSER_RADIO })).toBeChecked();
      await page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO }).check();
      await expect(page.getByText(MOVE_DONE)).toBeVisible({ timeout: 180_000 });
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 30_000 })
        .toMatchObject({ configured: true, permission: 'granted' });
      await expect
        .poll(
          () => fileExists(page, ['e2e-shared', 'sakutto-models', getModel(DEFAULT_MODEL_ID).file]),
          {
            timeout: 30_000,
          },
        )
        .toBe(true);
      await expect
        .poll(() => directoryExists(page, ['sakutto', 'models', DEFAULT_MODEL_ID]), {
          timeout: 30_000,
        })
        .toBe(false);
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('settings switches from folder to browser without deleting folder files', async () => {
    test.setTimeout(180_000);
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await plantVerifiedSharedModel(planter);
      await persistPlantedSharedFolder(planter);
      await reloadFolder(planter);
      await planter.close();

      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(page);
      const folderRadio = page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO });
      await expect(folderRadio).toBeChecked({ timeout: 30_000 });
      await page.getByRole('radio', { name: SETTINGS_BROWSER_RADIO }).check();
      await expect(page.getByText(COPY_DONE)).toBeVisible({ timeout: 180_000 });
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 30_000 })
        .toMatchObject({ configured: false });
      await expect
        .poll(() => directoryExists(page, ['sakutto', 'models', DEFAULT_MODEL_ID]), {
          timeout: 30_000,
        })
        .toBe(true);
      expect(
        await fileExists(page, ['e2e-shared', 'sakutto-models', getModel(DEFAULT_MODEL_ID).file]),
      ).toBe(true);
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('settings reports no models when switching an empty folder to browser storage', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await mockEmptySharedFolder(planter);
      await persistPlantedSharedFolder(planter);
      await reloadFolder(planter);
      await planter.close();

      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(page);
      const browserRadio = page.getByRole('radio', { name: SETTINGS_BROWSER_RADIO });
      await expect(page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO })).toBeChecked({
        timeout: 30_000,
      });
      await browserRadio.check();
      await expect(page.getByText(NO_MODELS)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(COPY_DONE)).toHaveCount(0);
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 15_000 })
        .toMatchObject({ configured: false });
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

  test('onboarding keeps browser storage selected when a folder already has a verified file', async () => {
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
      await expect(page.getByRole('radio', { name: BROWSER_RADIO })).toBeChecked();
      await expect(page.getByRole('radio', { name: FOLDER_RADIO })).not.toBeChecked();
      expect(hits).toEqual([]);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('onboarding downloads into browser storage by default without opening the picker', async () => {
    const extension = await loadExtension('en-US');
    await interceptGguf(extension, 'hang');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/onboarding.html`);
      await mockEmptySharedFolder(page);
      await expect(page.getByRole('radio', { name: BROWSER_RADIO })).toBeChecked();
      await expect(page.getByRole('radio', { name: FOLDER_RADIO })).not.toBeChecked();
      await expect(page.getByText(PICKER_HINT)).toHaveCount(0);
      await page.getByRole('button', { name: 'Agree to the license and start' }).click();
      await expect(page.getByText('Downloading 0% (0 MB / 573 MB)')).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 15_000 })
        .toMatchObject({ configured: false });
      expect(
        await page.evaluate(() => (globalThis as { __sakuttoPicker?: unknown }).__sakuttoPicker),
      ).toBeUndefined();
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
      await expect(page.getByText(PICKER_HINT)).toBeVisible();
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
      // The static hint is already on screen; a cancel must not insert a duplicate below it.
      await expect(page.getByText(PICKER_HINT)).toBeVisible();
      await expect(page.locator('[data-folder-picker-hint]')).toHaveCount(0);
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
      await expect(page.getByText(PICKER_HINT)).toBeVisible();
      await expect(page.locator('[data-folder-picker-hint]')).toHaveCount(0);
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
      await page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO }).click();
      await expect(page.getByRole('radio', { name: SETTINGS_BROWSER_RADIO })).toBeChecked();
      await expect(page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO })).not.toBeChecked();
      await expect(
        page.getByText(
          'The model could not be moved to the shared folder. The browser copy was kept.',
        ),
      ).toHaveCount(0);
      await expect(
        page.getByText('The model could not be copied. The previous storage choice was kept.'),
      ).toHaveCount(0);
      await expect
        .poll(async () => readSharedFolder(page), { timeout: 15_000 })
        .toMatchObject({ configured: false });
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

  test('does not prompt to move after onboarding saves the model in this browser', async () => {
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
      expect(hits).toEqual([]);
      await onboarding.close();

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(popup.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expectNoPopupMovePrompt(popup);
      await popup.close();

      const again = await extension.context.newPage();
      await again.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(again.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expectNoPopupMovePrompt(again);
      await again.close();
    } finally {
      await extension.close();
    }
  });

  // Picker is mocked with an OPFS directory handle, so this cannot prove Chromium
  // FSA grants survive popup close or restart. One-copy-on-disk after a verified
  // move is covered in unit tests (real bytes + SHA-256). See
  // docs/design/fsa-permission-lifetime.md.
  test('translates after a Settings folder pick, after the popup closes, and after a restart', async () => {
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
        await expectNoPopupMovePrompt(popup);
        await popup.close();

        const options = await extension.context.newPage();
        await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
        await expect(options.getByRole('group', { name: STORAGE_LEGEND })).toBeVisible();
        await pickFolderInSettings(options);
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

  test('does not prompt to move when an official model is already in OPFS', async () => {
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(popup.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expectNoPopupMovePrompt(popup);
      await popup.reload();
      await expectNoPopupMovePrompt(popup);
      await popup.close();

      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(options.getByRole('group', { name: STORAGE_LEGEND })).toBeVisible();
      await expect(options.getByRole('radio', { name: SETTINGS_FOLDER_RADIO })).toBeVisible();
      await expectNoPopupMovePrompt(options);
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('does not show a move prompt without an installed official model', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await expect(page.getByRole('button', { name: 'Translate this page' })).toBeVisible();
      await expectNoPopupMovePrompt(page);
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
      await expect(page.getByRole('group', { name: STORAGE_LEGEND })).toBeVisible();
      await expect(page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO })).toBeVisible();
      await expectNoPopupMovePrompt(page);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('moves from OPFS in one click after choosing the folder in Settings', async () => {
    test.setTimeout(180_000);
    const extension = await loadExtension('en-US');
    try {
      const planter = await extension.context.newPage();
      await planter.goto(`chrome-extension://${extension.extensionId}/sample.html`);
      await plantOpfsOfficial(planter);
      await planter.close();

      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await pickFolderInSettings(options);
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

  test('keeps a mocked prompt grant dormant without a popup re-grant', async () => {
    const extension = await loadExtension('en-US');
    const hits = await interceptGguf(extension, 'hang');
    try {
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(options);
      await plantVerifiedSharedModel(options);
      await options.getByRole('radio', { name: SETTINGS_FOLDER_RADIO }).check();
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 30_000 })
        .toMatchObject({ configured: true, permission: 'granted' });

      await setPermissionOverride(options, 'prompt');
      await reloadFolder(options);
      await options.reload();
      await expect(options.getByRole('group', { name: STORAGE_LEGEND })).toBeVisible();
      // A tab reload only queries. It must not turn the mocked prompt into a silent grant.
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'prompt' });
      await expect(options.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toBeVisible();
      await options.close();

      const hostPage = await extension.context.newPage();
      await hostPage.goto(`${FIXTURE_ORIGIN}/article.html`);

      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await setPermissionOverride(popup, 'prompt');
      await reloadFolder(popup);
      await popup.reload();
      await popup.waitForTimeout(1_000);
      await expect
        .poll(async () => readSharedFolder(popup), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'prompt' });
      await expect(popup.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toHaveCount(0);

      // Translation continues from OPFS/browser storage; a popup click never requests the
      // folder grant and never opens a re-grant flow.
      await hostPage.bringToFront();
      await popup.reload();
      const translate = popup.getByRole('button', { name: 'Translate this page' });
      await expect(translate).toBeEnabled();
      await translate.click();
      await expect
        .poll(async () => readSharedFolder(popup), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'prompt' });
      await expect(popup.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toHaveCount(0);
      expect(hits).toEqual([]);
      await popup.close();
      await hostPage.close();
    } finally {
      await extension.close();
    }
  });

  test('opens a folder-enable tab for a denied restore and keeps the popup card-free', async () => {
    const extension = await loadExtension('en-US');
    try {
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await plantLicenseConsent(options);
      await mockEmptySharedFolder(options);
      await options.getByRole('radio', { name: SETTINGS_FOLDER_RADIO }).check();
      await expect
        .poll(async () => readSharedFolder(options), { timeout: 30_000 })
        .toMatchObject({ configured: true });

      await setPermissionOverride(options, 'denied');
      await reloadFolder(options);
      await options.reload();
      await expect(options.getByRole('group', { name: STORAGE_LEGEND })).toBeVisible();
      const allow = options.getByRole('button', { name: ALLOW_FOLDER_ACCESS });
      await expect(allow).toBeVisible();

      const grantTabPromise = extension.context.waitForEvent('page');
      await allow.click();
      const grantTab = await grantTabPromise;
      const grantUrl = `chrome-extension://${extension.extensionId}/folder-enable.html`;
      await grantTab.waitForTimeout(250);
      if (!grantTab.url().startsWith(grantUrl)) await grantTab.goto(grantUrl);
      await grantTab.waitForURL(/folder-enable\.html/);
      await expect(grantTab.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toBeVisible();
      await grantTab.close();
      await options.close();

      const hostPage = await extension.context.newPage();
      await hostPage.goto(`${FIXTURE_ORIGIN}/article.html`);
      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      await setPermissionOverride(popup, 'denied');
      await reloadFolder(popup);
      await hostPage.bringToFront();
      await popup.reload();
      await expect
        .poll(async () => readSharedFolder(popup), { timeout: 15_000 })
        .toMatchObject({ configured: true, permission: 'denied' });
      await expect(popup.getByRole('button', { name: ALLOW_FOLDER_ACCESS })).toHaveCount(0);
      await popup.close();
      await hostPage.close();
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

async function expectNoPopupMovePrompt(page: Page): Promise<void> {
  await expect(page.getByText(MOVE_LEAD)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose the folder in Settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Later' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move to a shared folder' })).toHaveCount(0);
}

async function pickFolderInSettings(page: Page): Promise<void> {
  await plantLicenseConsent(page);
  await mockEmptySharedFolder(page);
  await page.getByRole('radio', { name: SETTINGS_FOLDER_RADIO }).check();
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

async function fileExists(page: Page, parts: readonly string[]): Promise<boolean> {
  return page.evaluate(async (segments) => {
    let directory = await navigator.storage.getDirectory();
    const name = segments.at(-1);
    if (!name) return false;
    for (const part of segments.slice(0, -1)) {
      try {
        directory = await directory.getDirectoryHandle(part);
      } catch {
        return false;
      }
    }
    try {
      const file = await directory.getFileHandle(name);
      return (await file.getFile()).size > 0;
    } catch {
      return false;
    }
  }, parts);
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
