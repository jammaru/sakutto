import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  injectContentScript,
  invokeOnCommandPath,
  resetExtensionStorage,
  waitForContentSession,
  waitTranslated,
} from './page';

async function attachOffscreenConsole(
  extension: LoadedExtension,
  messages: string[],
): Promise<{ found: boolean; detach: () => Promise<void> }> {
  const browser = extension.context.browser();
  if (!browser) return { found: false, detach: async () => undefined };
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Target.setDiscoverTargets', { discover: true });
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
    await cdp
      .send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id: messageId, method }),
      })
      .catch(() => undefined);
  };

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((info) => info.url.endsWith('/offscreen.html'));
    if (target) {
      const attached = await cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: false,
      });
      sessionId = attached.sessionId;
      await send('Runtime.enable');
      await send('Log.enable');
      return {
        found: true,
        detach: async () => {
          await cdp.detach().catch(() => undefined);
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await cdp.detach().catch(() => undefined);
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
    await injectContentScript(extension.worker, page);
    await waitForContentSession(extension.worker, page);
    await page.goBack();
    await page.waitForURL(`${FIXTURE_ORIGIN}/article.html`);
    await page.goForward();
    await page.waitForURL(`${FIXTURE_ORIGIN}/docs.html`);
    await page.goBack();
    await page.waitForURL(`${FIXTURE_ORIGIN}/article.html`);

    const lead = page.locator('#lead');
    if (await lead.count()) {
      await page.evaluate(() => {
        const target = document.getElementById('lead');
        if (!target) return;
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await invokeOnCommandPath(extension.worker, page, 'selection');
    }
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
