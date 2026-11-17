import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  MARKER,
  dispatchCommand,
  injectContentScript,
  readCommandBindings,
  resetExtensionStorage,
  simulateNeverAssignedShortcuts,
  stubCommandBindings,
  waitForContentSession,
  waitTranslated,
} from './page';

const CUSTOM_PAGE_BINDINGS = [
  { name: 'translate-page', shortcut: 'Alt+Q' },
  { name: 'toggle-bilingual', shortcut: 'Alt+B' },
  { name: 'translate-selection', shortcut: 'Alt+S' },
  { name: 'translate-compose', shortcut: 'Alt+T' },
];

const ASSIGNED_DEFAULT_BINDINGS = [
  { name: 'translate-page', shortcut: 'Alt+A' },
  { name: 'toggle-bilingual', shortcut: 'Alt+B' },
  { name: 'translate-selection', shortcut: 'Alt+S' },
  { name: 'translate-compose', shortcut: 'Alt+T' },
];

async function pressAltLetter(page: Page, code: string, key: string): Promise<void> {
  await page.evaluate(
    ({ code, key }) => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { code, key },
  );
}

async function refreshShortcutUi(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function openOptions(extension: Awaited<ReturnType<typeof loadExtension>>): Promise<Page> {
  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
  return options;
}

test.describe('native browser commands', () => {
  test('starts translation through the real commands.onCommand listener', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await dispatchCommand(extension.worker, page);
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('ignores assigned Alt+A keydown and translates only through onCommand', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await stubCommandBindings(extension.worker, ASSIGNED_DEFAULT_BINDINGS);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await pressAltLetter(page, 'KeyA', 'a');
      await page.waitForTimeout(300);
      await expect(page.locator('#lead')).not.toContainText(MARKER);

      await dispatchCommand(extension.worker, page);
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('does not handle a customized Alt+Q binding in the page', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await stubCommandBindings(extension.worker, CUSTOM_PAGE_BINDINGS);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await pressAltLetter(page, 'KeyQ', 'q');
      await page.waitForTimeout(300);
      await expect(page.locator('#lead')).not.toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('does not translate an unset command from page keydown', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await simulateNeverAssignedShortcuts(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await pressAltLetter(page, 'KeyA', 'a');
      await page.waitForTimeout(300);
      await expect(page.locator('#lead')).not.toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('an assigned command still translates through onCommand while a textarea is focused', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await page.evaluate(() => {
        const field = document.createElement('textarea');
        field.id = 'draft';
        field.value = 'hello';
        document.body.prepend(field);
      });
      await page.locator('#draft').click();
      await dispatchCommand(extension.worker, page);
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await expect(page.locator('#draft')).toHaveValue('hello');
      await page.close();
    } finally {
      await extension.close();
    }
  });
});

test.describe('unset shortcut notice', () => {
  test('options hides the notice and names the assigned key', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await stubCommandBindings(extension.worker, ASSIGNED_DEFAULT_BINDINGS);
      const options = await openOptions(extension);
      await expect(options.locator('kbd').first()).toHaveText('Alt+A');
      await expect(options.locator('[data-sakutto="shortcut-unset-notice"]')).toHaveCount(0);
      await expect(options.getByRole('button', { name: 'Change shortcuts' })).toBeVisible();
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('options shows, refreshes, and opens the shortcut editor from the notice', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await simulateNeverAssignedShortcuts(extension.worker);
      const options = await openOptions(extension);
      const notice = options.locator('[data-sakutto="shortcut-unset-notice"]');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Shortcuts are not set');
      await expect(options.locator('kbd').first()).toHaveText('Not set');
      const changeShortcuts = options.getByRole('button', { name: 'Change shortcuts' });
      await expect(changeShortcuts).toHaveCount(0);

      await stubCommandBindings(extension.worker, ASSIGNED_DEFAULT_BINDINGS);
      await refreshShortcutUi(options);
      await expect(notice).toHaveCount(0);
      await expect(options.locator('kbd').first()).toHaveText('Alt+A');
      await expect(changeShortcuts).toBeVisible();

      await simulateNeverAssignedShortcuts(extension.worker);
      await refreshShortcutUi(options);
      await expect(notice).toBeVisible();
      await expect(changeShortcuts).toHaveCount(0);
      const editorPromise = extension.context.waitForEvent('page');
      await options.locator('[data-sakutto="open-shortcut-settings"]').click();
      const editor = await editorPromise;
      expect(editor.url()).toBe('chrome://extensions/shortcuts');
      await editor.close();
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('popup shows the notice when unset and hides it after assignment', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await simulateNeverAssignedShortcuts(extension.worker);
      const popup = await extension.context.newPage();
      await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
      const notice = popup.locator('[data-sakutto="shortcut-unset-notice"]');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Shortcuts are not set');
      const changeShortcuts = popup.getByRole('button', { name: 'Change shortcuts' });
      await expect(changeShortcuts).toHaveCount(0);

      await stubCommandBindings(extension.worker, ASSIGNED_DEFAULT_BINDINGS);
      await refreshShortcutUi(popup);
      await expect(notice).toHaveCount(0);
      await expect(changeShortcuts).toBeVisible();
      await popup.close();
    } finally {
      await extension.close();
    }
  });

  test('the real browser bindings determine whether options shows the notice', async () => {
    const extension = await loadExtension('en-US');
    try {
      const bindings = await readCommandBindings(extension.worker);
      const pageCommand = bindings.find((entry) => entry.name === 'translate-page');
      const options = await openOptions(extension);
      await expect(options.locator('kbd').first()).toBeVisible();
      const changeShortcuts = options.getByRole('button', { name: 'Change shortcuts' });
      if (pageCommand?.shortcut) {
        await expect(options.locator('kbd').first()).toHaveText(pageCommand.shortcut);
        await expect(options.locator('[data-sakutto="shortcut-unset-notice"]')).toHaveCount(0);
        await expect(changeShortcuts).toBeVisible();
      } else {
        await expect(options.locator('kbd').first()).toHaveText('Not set');
        await expect(options.locator('[data-sakutto="shortcut-unset-notice"]')).toBeVisible();
        await expect(changeShortcuts).toHaveCount(0);
      }
      await options.close();
    } finally {
      await extension.close();
    }
  });
});
