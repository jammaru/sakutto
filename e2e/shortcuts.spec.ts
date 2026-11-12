import { expect, test, type Page } from '@playwright/test';
import { loadExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  MARKER,
  injectContentScript,
  invokeOnCommandPath,
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

async function pressAltLetter(page: Page, code: string, key: string) {
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

async function waitForShortcutRefresh(page: Page, expected: string): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(async () => page.locator('html').getAttribute('data-sakutto-page-shortcut'))
    .toBe(expected);
}

interface PageKeyLog {
  key: string;
  code: string;
  alt: boolean;
  prevented: boolean;
  target: string;
}

async function installKeyLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: PageKeyLog[] = [];
    (window as unknown as { __sakuttoKeys: PageKeyLog[] }).__sakuttoKeys = log;
    window.addEventListener(
      'keydown',
      (event) => {
        log.push({
          key: event.key,
          code: event.code,
          alt: event.altKey,
          prevented: event.defaultPrevented,
          target: event.target instanceof Element ? event.target.id : '',
        });
      },
      true,
    );
  });
}

async function readKeyLog(page: Page): Promise<PageKeyLog[]> {
  return page.evaluate(
    () => (window as unknown as { __sakuttoKeys: PageKeyLog[] }).__sakuttoKeys ?? [],
  );
}

test.describe('translate-page command', () => {
  test('starts translation through the onCommand handler path', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await invokeOnCommandPath(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('keeps the page translated when Chrome command and in-page Alt+A arrive together', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            code: 'KeyA',
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await invokeOnCommandPath(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.sakuttoState))
        .toBe('translated');
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('options names the key Chrome actually assigned for translate-page', async () => {
    const extension = await loadExtension('en-US');
    try {
      const bindings = await readCommandBindings(extension.worker);
      const pageCommand = bindings.find((entry) => entry.name === 'translate-page');
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      const kbd = options.locator('kbd').first();
      await expect(kbd).toBeVisible();
      if (pageCommand?.shortcut) {
        await expect(kbd).toHaveText(pageCommand.shortcut);
      } else {
        await expect(options.locator('[data-sakutto="shortcut-fallback"]').first()).toBeVisible();
      }
      await options.close();
    } finally {
      await extension.close();
    }
  });

  test('unassigned commands use the in-page default', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await simulateNeverAssignedShortcuts(extension.worker);
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(options.locator('kbd').first()).toHaveText('Alt+A (on pages)');
      await expect(options.locator('[data-sakutto="shortcut-fallback"]').first()).toBeVisible();
      await options.close();

      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await waitForShortcutRefresh(page, 'Alt+A');
      await pressAltLetter(page, 'KeyA', 'a');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('a customized shortcut turns the in-page default off', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await stubCommandBindings(extension.worker, CUSTOM_PAGE_BINDINGS);
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(options.locator('kbd').first()).toHaveText('Alt+Q');
      await expect(options.locator('[data-sakutto="shortcut-fallback"]')).toHaveCount(0);
      await options.close();

      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await waitForShortcutRefresh(page, 'Alt+Q');
      await pressAltLetter(page, 'KeyA', 'a');
      await page.waitForTimeout(300);
      await expect(page.locator('#lead')).not.toContainText(MARKER);
      await pressAltLetter(page, 'KeyQ', 'q');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('an assigned default does not double-toggle from onCommand plus in-page Alt+A', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await stubCommandBindings(extension.worker, ASSIGNED_DEFAULT_BINDINGS);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await waitForShortcutRefresh(page, 'Alt+A');
      await pressAltLetter(page, 'KeyA', 'a');
      await invokeOnCommandPath(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.sakuttoState))
        .toBe('translated');
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('unassigned Alt+A is delivered to a focused textarea and left unprevented', async () => {
    const extension = await loadExtension('en-US');
    try {
      await resetExtensionStorage(extension.worker);
      await simulateNeverAssignedShortcuts(extension.worker);
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/article.html`);
      await injectContentScript(extension.worker, page);
      await waitForContentSession(extension.worker, page);
      await waitForShortcutRefresh(page, 'Alt+A');
      await page.evaluate(() => {
        const field = document.createElement('textarea');
        field.id = 'draft';
        field.value = 'hello';
        document.body.prepend(field);
      });
      await installKeyLog(page);
      await page.locator('#draft').click();
      await page.keyboard.press('Alt+a');
      const hits = (await readKeyLog(page)).filter((entry) => entry.code === 'KeyA' && entry.alt);
      expect(hits.length, JSON.stringify(hits)).toBeGreaterThan(0);
      expect(hits.every((entry) => entry.prevented === false)).toBe(true);
      expect(hits.some((entry) => entry.target === 'draft')).toBe(true);
      await page.waitForTimeout(300);
      await expect(page.locator('#lead')).not.toContainText(MARKER);
      await expect(page.locator('#draft')).toHaveValue('hello');
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
      await invokeOnCommandPath(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await expect(page.locator('#draft')).toHaveValue('hello');
      await page.close();
    } finally {
      await extension.close();
    }
  });
});
