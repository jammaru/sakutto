import { expect, test, type Page, type Worker } from '@playwright/test';
import { loadExtension } from './extension';
import { FIXTURE_ORIGIN, invokeOnCommandPath, resetExtensionStorage } from './page';

/**
 * Grants the optional all-sites origins the way the product does, without Chrome's native
 * prompt (Playwright cannot click it). The options page runs its own toggle: the stub only
 * answers `permissions.request` / `contains`, while `scripting.registerContentScripts` is the
 * browser's real machinery, so a newly opened page gets the bundle from the registration
 * itself — never from a test-side `executeScript` and never from the popup.
 */
async function enableAllSitesViaOptions(
  context: { newPage: () => Promise<Page> },
  extensionId: string,
): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForSelector('[data-sakutto="all-sites"]');
  await options.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome: ChromeWithStubs }).chrome;
    const originalContains = chrome.permissions.contains.bind(chrome.permissions);
    const state = { granted: false };
    (globalThis as unknown as { __allSitesStubState: typeof state }).__allSitesStubState = state;
    const contains = async ({ origins }: { origins: string[] }) => {
      if (state.granted && (origins.includes('https://*/*') || origins.includes('http://*/*'))) {
        return true;
      }
      return originalContains({ origins });
    };
    const request = async () => {
      state.granted = true;
      return true;
    };
    const remove = async () => {
      state.granted = false;
      return true;
    };
    try {
      chrome.permissions.contains = contains;
      chrome.permissions.request = request;
      chrome.permissions.remove = remove;
    } catch {
      for (const [name, value] of [
        ['contains', contains],
        ['request', request],
        ['remove', remove],
      ] as const) {
        Object.defineProperty(chrome.permissions, name, { configurable: true, value });
      }
    }
  });
  await options.locator('[data-sakutto="all-sites"]').check();
  await expect(options.locator('[data-sakutto="all-sites"]')).toBeChecked();
  return options;
}

async function turnOffAllSitesViaOptions(options: Page): Promise<void> {
  await options.locator('[data-sakutto="all-sites"]').uncheck();
  await expect(options.locator('[data-sakutto="all-sites"]')).not.toBeChecked();
}

/** Read the live registration from the worker. Callers poll it: registration is async. */
async function registeredAllSites(worker: Worker): Promise<boolean> {
  return worker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: {
          scripting: {
            getRegisteredContentScripts(): Promise<Array<{ id?: string }>>;
          };
        };
      }
    ).chrome;
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return scripts.some((script) => script.id === 'sakutto-all-sites');
  });
}

async function selectLead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lead = document.getElementById('lead');
    if (!lead) throw new Error('missing #lead');
    const range = document.createRange();
    range.selectNodeContents(lead);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

interface ChromeWithStubs {
  permissions: {
    contains(options: { origins: string[] }): Promise<boolean>;
    request(options: { origins: string[] }): Promise<boolean>;
    remove(options: { origins: string[] }): Promise<boolean>;
  };
}

test('without the all-sites grant, a fresh page has no selection button until an explicit action', async () => {
  const extension = await loadExtension('en-US');
  try {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    await expect.poll(() => registeredAllSites(extension.worker)).toBe(false);

    const page = await extension.context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    await selectLead(page);
    // The registration is the only passive path; without the grant nothing offers the
    // selection from page load.
    await page.waitForTimeout(800);
    await expect(page.locator('sakutto-select')).toBeHidden();
    await page.close();
  } finally {
    await extension.close();
  }
});

test('with the all-sites grant, a fresh page offers the selection from page load', async () => {
  const extension = await loadExtension('en-US');
  try {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const options = await enableAllSitesViaOptions(extension.context, extension.extensionId);
    await expect.poll(() => registeredAllSites(extension.worker)).toBe(true);

    // Select before the idle bundle has to be there; the one-time init offer still shows
    // the button for a highlight that predates the script.
    const page = await extension.context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    await selectLead(page);
    await expect(page.locator('sakutto-select')).toBeVisible({ timeout: 15_000 });
    await page.close();

    // A page opened after the registration also gets the bundle from the registration,
    // with no open of the popup and no test-side injection.
    const fresh = await extension.context.newPage();
    await fresh.goto(`${FIXTURE_ORIGIN}/wiki.html`);
    await selectLead(fresh);
    await expect(fresh.locator('sakutto-select')).toBeVisible({ timeout: 15_000 });
    await fresh.close();

    // Turning the control off unregisters, so the next load is quiet again.
    await turnOffAllSitesViaOptions(options);
    await expect.poll(() => registeredAllSites(extension.worker)).toBe(false);
    const afterRevoke = await extension.context.newPage();
    await afterRevoke.goto(`${FIXTURE_ORIGIN}/wiki.html`);
    await selectLead(afterRevoke);
    await afterRevoke.waitForTimeout(800);
    await expect(afterRevoke.locator('sakutto-select')).toBeHidden();
    await afterRevoke.close();
    await options.close();
  } finally {
    await extension.close();
  }
});

test('a never site stays quiet from the grant, but an explicit command still works', async () => {
  const extension = await loadExtension('en-US');
  try {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    await extension.worker.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: ChromeWithRules }).chrome;
      await chrome.storage.local.set({
        siteRules: { '127.0.0.1': { host: '127.0.0.1', auto: 'never' } },
      });
    });
    const options = await enableAllSitesViaOptions(extension.context, extension.extensionId);
    await expect.poll(() => registeredAllSites(extension.worker)).toBe(true);

    const page = await extension.context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    await selectLead(page);
    await page.waitForTimeout(800);
    await expect(page.locator('sakutto-select')).toBeHidden();

    // The explicit command path keeps today's behavior on a never site.
    await invokeOnCommandPath(extension.worker, page, 'selection');
    await expect(page.locator('sakutto-pop')).toBeVisible({ timeout: 15_000 });
    await page.close();
    await options.close();
  } finally {
    await extension.close();
  }
});

interface ChromeWithRules {
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}
