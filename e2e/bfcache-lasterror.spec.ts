import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { FIXTURE_ORIGIN, invokeOnCommandPath, resetExtensionStorage, waitTranslated } from './page';

async function attachOffscreenConsole(
  extension: LoadedExtension,
  messages: string[],
): Promise<{ found: boolean; detach: () => Promise<void> }> {
  const withTimeout = async <T>(promise: Promise<T>, ms = 1500): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const browser = extension.context.browser();
  if (!browser) return { found: false, detach: async () => undefined };
  const cdp = await browser.newBrowserCDPSession();
  await withTimeout(cdp.send('Target.setDiscoverTargets', { discover: true }));
  let sessionId: string | null = null;
  let messageId = 0;

  cdp.on('Target.receivedMessageFromTarget', ({ sessionId: from, message }) => {
    if (from !== sessionId) return;
    let event: { method?: string; params?: unknown };
    try {
      event = JSON.parse(message) as typeof event;
    } catch {
      return;
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      const params = event.params as
        { args?: Array<{ value?: unknown; description?: string }> } | undefined;
      const text = (params?.args ?? [])
        .map((arg) =>
          typeof arg.value === 'string'
            ? arg.value
            : typeof arg.description === 'string'
              ? arg.description
              : '',
        )
        .filter(Boolean)
        .join(' ');
      if (text) messages.push(text);
      return;
    }
    if (event.method === 'Log.entryAdded') {
      const params = event.params as { entry?: { text?: string } } | undefined;
      if (params?.entry?.text) messages.push(params.entry.text);
    }
  });

  const send = async (method: string): Promise<void> => {
    if (!sessionId) return;
    messageId += 1;
    await withTimeout(
      cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id: messageId, method }),
        })
        .catch(() => undefined),
    );
  };

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await withTimeout(cdp.send('Target.getTargets'));
    const target = targets?.targetInfos.find((info) => info.url.endsWith('/offscreen.html'));
    if (target) {
      const attached = await withTimeout(
        cdp.send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: false,
        }),
      );
      if (!attached) continue;
      sessionId = attached.sessionId;
      void send('Runtime.enable');
      void send('Log.enable');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        found: true,
        detach: async () => {
          await withTimeout(cdp.detach().catch(() => undefined));
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await withTimeout(cdp.detach().catch(() => undefined));
  return { found: false, detach: async () => undefined };
}

test('does not leave unchecked lastError across BFCache navigation', async () => {
  test.setTimeout(120_000);
  const extension = await loadExtension('en-US');
  const messages: string[] = [];
  const watch = (page: Page): void => {
    page.on('console', (message) => messages.push(message.text()));
    page.on('pageerror', (error) => messages.push(error.message));
  };
  extension.context.pages().forEach(watch);
  extension.context.on('page', watch);
  extension.worker.on('console', (message) => messages.push(message.text()));

  try {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    watch(page);
    await page.goto(`${FIXTURE_ORIGIN}/article.html`);
    await invokeOnCommandPath(extension.worker, page, 'toggle');
    await waitTranslated(page);

    const offscreen = await attachOffscreenConsole(extension, messages);
    expect(offscreen.found).toBe(true);

    await page.goto(`${FIXTURE_ORIGIN}/docs.html`);
    await page.waitForLoadState('load');
    await page.goBack();
    await page.waitForURL(`${FIXTURE_ORIGIN}/article.html`);
    await page.goForward();
    await page.waitForURL(`${FIXTURE_ORIGIN}/docs.html`);

    await page.locator('article p').first().click({ clickCount: 3 });
    await page.waitForTimeout(100);
    await invokeOnCommandPath(extension.worker, page, 'selection');
    const popover = page.locator('sakutto-pop');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');

    await page.goBack();
    await page.waitForURL(`${FIXTURE_ORIGIN}/article.html`);
    await page.goForward();
    await page.waitForURL(`${FIXTURE_ORIGIN}/docs.html`);
    await invokeOnCommandPath(extension.worker, page, 'toggle');
    await page.waitForFunction(
      () => document.documentElement.dataset.sakuttoState === 'translated',
      { timeout: 60_000 },
    );
    await page.waitForTimeout(1000);

    expect(messages.filter((message) => message.includes('Unchecked runtime.lastError'))).toEqual(
      [],
    );
    await offscreen.detach();
    await page.close();
  } finally {
    await extension.close();
  }
});
