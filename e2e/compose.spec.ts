import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { FIXTURE_ORIGIN, MARKER, commandPage, resetExtensionStorage } from './page';

let extension: LoadedExtension;

async function openComposePage(): Promise<Page> {
  await resetExtensionStorage(extension.worker);
  const page = await extension.context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/compose.html`);
  return page;
}

async function applyCompose(page: Page): Promise<void> {
  await commandPage(extension.worker, page, 'compose');
  await expect
    .poll(async () => page.locator('sakutto-compose').evaluate((el) => (el as HTMLElement).hidden))
    .toBe(false);
  await page.waitForTimeout(150);
  await page.locator('sakutto-compose').evaluate((el) => {
    el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
  });
}

test.describe('compose translation', () => {
  test.beforeAll(async () => {
    extension = await loadExtension('en-US');
  });

  test.afterAll(async () => {
    if (!extension) return;
    await extension.close();
  });

  test('replaces a textarea draft only after Replace', async () => {
    const page = await openComposePage();
    try {
      const box = page.locator('#plain');
      await box.fill('明日会いましょう。');
      await box.focus();
      await commandPage(extension.worker, page, 'compose');
      await expect(box).toHaveValue('明日会いましょう。');
      await expect
        .poll(async () =>
          page.locator('sakutto-compose').evaluate((el) => (el as HTMLElement).hidden),
        )
        .toBe(false);
      await page.screenshot({ path: 'e2e-results/compose-preview.png', fullPage: true });
      await page.waitForTimeout(150);
      await page.locator('sakutto-compose').evaluate((el) => {
        el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
      });
      await expect(box).toHaveValue(`${MARKER}明日会いましょう。`);
      await page.screenshot({ path: 'e2e-results/compose-replaced.png', fullPage: true });
    } finally {
      await page.close();
    }
  });

  test('replaces a plain contenteditable region', async () => {
    const page = await openComposePage();
    try {
      const rich = page.locator('#rich');
      await rich.fill('会議は明日です。');
      await rich.focus();
      await applyCompose(page);
      await expect(rich).toContainText(`${MARKER}会議は明日です。`);
    } finally {
      await page.close();
    }
  });

  test('replaces a Slate-style editor through beforeinput', async () => {
    const page = await openComposePage();
    try {
      await page.evaluate(() => {
        (window as unknown as { __slate: { set(text: string): void } }).__slate.set(
          'よろしくお願いします。',
        );
      });
      await page.locator('#slate').focus();
      await applyCompose(page);
      await expect
        .poll(async () =>
          page.evaluate(() => document.querySelector('#slate')?.getAttribute('data-slate-value')),
        )
        .toBe(`${MARKER}よろしくお願いします。`);
      await page.screenshot({ path: 'e2e-results/compose-slate.png', fullPage: true });
      await page.locator('sakutto-compose').evaluate((el) => {
        el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'undo' }));
      });
      await expect
        .poll(async () =>
          page.evaluate(() => document.querySelector('#slate')?.getAttribute('data-slate-value')),
        )
        .toBe('よろしくお願いします。');
    } finally {
      await page.close();
    }
  });

  test('keeps Gmail signature and quoted history when replacing the body', async () => {
    const page = await openComposePage();
    try {
      await page.locator('#mail').focus();
      await applyCompose(page);
      await expect(page.locator('#mail')).toContainText(`${MARKER}会議は明日です。`);
      await expect(page.locator('.gmail_signature_prefix')).toHaveText('-- ');
      await expect(page.locator('.gmail_signature')).toHaveText('Jane Doe');
      await expect(page.locator('.gmail_quote')).toContainText('On Monday');
    } finally {
      await page.close();
    }
  });

  test('keeps Outlook quoted siblings after the reply header', async () => {
    const page = await openComposePage();
    try {
      await page.locator('#outlook').focus();
      await applyCompose(page);
      await expect(page.locator('#outlook')).toContainText(`${MARKER}会議は明日です。`);
      await expect(page.locator('#appendonsend')).toHaveCount(1);
      await expect(page.locator('#divRplyFwdMsg')).toContainText('From: Alex');
      await expect(page.locator('#quoted')).toHaveText('Quoted original that must survive');
      await expect(page.locator('#Signature')).toHaveText('Sent from Outlook');
    } finally {
      await page.close();
    }
  });

  test('never writes into a password field', async () => {
    const page = await openComposePage();
    try {
      const secret = page.locator('#secret');
      await secret.focus();
      await commandPage(extension.worker, page, 'compose');
      await expect(secret).toHaveValue('hunter2');
      await expect
        .poll(async () =>
          page.locator('sakutto-compose').evaluate((el) => (el as HTMLElement).hidden),
        )
        .toBe(false);
    } finally {
      await page.close();
    }
  });

  test('leaves drafts alone while the page around them is translated', async () => {
    const page = await openComposePage();
    try {
      await page.locator('#plain').fill('This is my unsent draft');
      await commandPage(extension.worker, page, 'toggle');
      await expect(page.locator('h1')).toContainText(MARKER);
      await expect(page.locator('#plain')).toHaveValue('This is my unsent draft');
      await expect(page.locator('sakutto-compose')).toHaveCount(1);
      await expect(page.locator('sakutto-compose')).toBeHidden();
    } finally {
      await page.close();
    }
  });

  test('anchors a dark bar to the Discord-like input without covering the log', async () => {
    await resetExtensionStorage(extension.worker);
    const page = await extension.context.newPage();
    await page.setViewportSize({ width: 900, height: 640 });
    await page.goto(`${FIXTURE_ORIGIN}/compose-discord.html`);
    try {
      const draft = page.locator('#draft');
      await draft.focus();
      await commandPage(extension.worker, page, 'compose');
      const panel = page.locator('sakutto-compose');
      await expect.poll(async () => panel.evaluate((el) => (el as HTMLElement).hidden)).toBe(false);
      await page.waitForTimeout(200);
      await expect(panel).toHaveAttribute('data-theme', 'dark');
      await expect(panel).toHaveAttribute('data-placement', 'above');
      const boxes = await page.evaluate(() => {
        const host = document.querySelector('sakutto-compose');
        const field = document.querySelector('#draft');
        if (!(host instanceof HTMLElement) || !(field instanceof HTMLElement)) {
          throw new Error('missing compose nodes');
        }
        const panelBox = host.getBoundingClientRect();
        const fieldBox = field.getBoundingClientRect();
        return {
          panel: { x: panelBox.x, y: panelBox.y, width: panelBox.width, bottom: panelBox.bottom },
          field: { x: fieldBox.x, y: fieldBox.y, width: fieldBox.width },
        };
      });
      expect(boxes.panel.bottom).toBeLessThanOrEqual(boxes.field.y + 2);
      expect(Math.abs(boxes.panel.x - boxes.field.x)).toBeLessThan(8);
      expect(boxes.panel.width).toBeGreaterThan(boxes.field.width - 8);
      await page.screenshot({ path: 'e2e-results/compose-discord-bar.png' });
      await page.screenshot({ path: 'e2e-results/compose-discord-bar-handle.png' });
    } finally {
      await page.close();
    }
  });

  test('opens the bar with a hint when the field is empty', async () => {
    const page = await openComposePage();
    try {
      const box = page.locator('#plain');
      await box.fill('');
      await box.focus();
      await commandPage(extension.worker, page, 'compose');
      const panel = page.locator('sakutto-compose');
      await expect.poll(async () => panel.evaluate((el) => (el as HTMLElement).hidden)).toBe(false);
      await page.screenshot({ path: 'e2e-results/compose-empty-bar.png', fullPage: true });
    } finally {
      await page.close();
    }
  });

  test('places the Discord-like bar below, in the corner, and freely', async () => {
    await resetExtensionStorage(extension.worker);
    const page = await extension.context.newPage();
    await page.setViewportSize({ width: 900, height: 640 });
    await page.goto(`${FIXTURE_ORIGIN}/compose-discord.html`);
    try {
      const draft = page.locator('#draft');
      await draft.focus();
      await commandPage(extension.worker, page, 'compose');
      const panel = page.locator('sakutto-compose');
      await expect.poll(async () => panel.evaluate((el) => (el as HTMLElement).hidden)).toBe(false);
      await page.waitForTimeout(200);

      // The Discord-like grid pins the box to the bottom. Leave room under it so
      // "below" can actually sit there instead of auto-flipping back above.
      await page.evaluate(() => {
        const compose = document.querySelector('.compose');
        if (compose instanceof HTMLElement) compose.style.paddingBottom = '200px';
      });
      await panel.evaluate((el) => {
        el.dispatchEvent(
          new CustomEvent('sakutto-compose-action', {
            detail: { action: 'placement', value: 'below' },
          }),
        );
      });
      await expect(panel).toHaveAttribute('data-placement', 'below');
      const belowBoxes = await page.evaluate(() => {
        const host = document.querySelector('sakutto-compose');
        const field = document.querySelector('#draft');
        if (!(host instanceof HTMLElement) || !(field instanceof HTMLElement)) {
          throw new Error('missing compose nodes');
        }
        return {
          panel: host.getBoundingClientRect(),
          field: field.getBoundingClientRect(),
        };
      });
      expect(belowBoxes.panel.y).toBeGreaterThanOrEqual(belowBoxes.field.bottom - 2);
      await page.screenshot({ path: 'e2e-results/compose-discord-bar-below.png' });

      await panel.evaluate((el) => {
        el.dispatchEvent(
          new CustomEvent('sakutto-compose-action', {
            detail: { action: 'placement', value: 'corner' },
          }),
        );
      });
      await expect(panel).toHaveAttribute('data-placement', 'corner');
      const cornerBox = await panel.evaluate((el) => (el as HTMLElement).getBoundingClientRect());
      expect(cornerBox.right).toBeGreaterThan(900 - 40);
      expect(cornerBox.bottom).toBeGreaterThan(640 - 40);
      await page.screenshot({ path: 'e2e-results/compose-discord-bar-corner.png' });

      await panel.evaluate((el) => {
        el.dispatchEvent(
          new CustomEvent('sakutto-compose-action', {
            detail: { action: 'placement', value: 'free' },
          }),
        );
        el.dispatchEvent(
          new CustomEvent('sakutto-compose-action', {
            // The Discord bar is nearly as wide as the window, so 24px is the
            // leftmost clamped drop. Sit it on the message log, not on the box.
            detail: { action: 'free-point', x: 24, y: 120 },
          }),
        );
      });
      await expect(panel).toHaveAttribute('data-placement', 'free');
      await expect
        .poll(async () =>
          panel.evaluate((el) => {
            const box = (el as HTMLElement).getBoundingClientRect();
            return { x: Math.round(box.x), y: Math.round(box.y) };
          }),
        )
        .toEqual({ x: 24, y: 120 });
      await page.screenshot({ path: 'e2e-results/compose-discord-bar-free.png' });
      await page.screenshot({ path: 'e2e-results/compose-discord-bar-dragged.png' });
    } finally {
      await page.close();
    }
  });

  test('updates the preview after Replace when the reader keeps typing', async () => {
    const page = await openComposePage();
    try {
      const box = page.locator('#plain');
      await box.fill('明日会いましょう。');
      await box.focus();
      await applyCompose(page);
      await expect(box).toHaveValue(`${MARKER}明日会いましょう。`);
      await box.focus();
      await box.pressSequentially(' 追記');
      await page.waitForTimeout(900);
      await page.locator('sakutto-compose').evaluate((el) => {
        el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
      });
      await expect(box).toHaveValue(`${MARKER}${MARKER}明日会いましょう。 追記`);
    } finally {
      await page.close();
    }
  });

  test('translates a new draft after Replace, clear, and type', async () => {
    const page = await openComposePage();
    try {
      const box = page.locator('#plain');
      await box.fill('明日会いましょう。');
      await box.focus();
      await applyCompose(page);
      await expect(box).toHaveValue(`${MARKER}明日会いましょう。`);
      await box.press('Control+A');
      await box.press('Backspace');
      await box.pressSequentially('こんにちは');
      await page.waitForTimeout(900);
      await page.locator('sakutto-compose').evaluate((el) => {
        el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
      });
      await expect(box).toHaveValue(`${MARKER}こんにちは`);
    } finally {
      await page.close();
    }
  });

  test('replaces several drafts in a row from the same field', async () => {
    const page = await openComposePage();
    try {
      const box = page.locator('#plain');
      await box.fill('あ');
      await box.focus();
      await applyCompose(page);
      await expect(box).toHaveValue(`${MARKER}あ`);
      for (const draft of ['い', 'う']) {
        await box.fill(draft);
        await page.waitForTimeout(900);
        await page.locator('sakutto-compose').evaluate((el) => {
          el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
        });
        await expect(box).toHaveValue(`${MARKER}${draft}`);
      }
    } finally {
      await page.close();
    }
  });

  test('updates a Slate-style preview after Replace when typing continues', async () => {
    const page = await openComposePage();
    try {
      await page.evaluate(() => {
        (window as unknown as { __slate: { set(text: string): void } }).__slate.set(
          'よろしくお願いします。',
        );
      });
      await page.locator('#slate').focus();
      await applyCompose(page);
      await expect
        .poll(async () =>
          page.evaluate(() => document.querySelector('#slate')?.getAttribute('data-slate-value')),
        )
        .toBe(`${MARKER}よろしくお願いします。`);
      // Discord/Slate rewrites the DOM without an `input` event. Append through the
      // fixture's render path so the MutationObserver, not keydown, has to resume preview.
      await page.evaluate(() => {
        const editor = document.querySelector('#slate');
        const current = editor?.getAttribute('data-slate-value') ?? '';
        (window as unknown as { __slate: { set(text: string): void } }).__slate.set(
          `${current} 追記`,
        );
      });
      await page.waitForTimeout(900);
      await page.locator('sakutto-compose').evaluate((el) => {
        el.dispatchEvent(new CustomEvent('sakutto-compose-action', { detail: 'replace' }));
      });
      await expect
        .poll(async () =>
          page.evaluate(() => document.querySelector('#slate')?.getAttribute('data-slate-value')),
        )
        .toBe(`${MARKER}${MARKER}よろしくお願いします。 追記`);
    } finally {
      await page.close();
    }
  });

  test('uses a light bar on a Gmail-like compose window', async () => {
    await resetExtensionStorage(extension.worker);
    const page = await extension.context.newPage();
    await page.setViewportSize({ width: 900, height: 640 });
    await page.goto(`${FIXTURE_ORIGIN}/compose-gmail.html`);
    try {
      const draft = page.locator('#draft');
      await draft.focus();
      await commandPage(extension.worker, page, 'compose');
      const panel = page.locator('sakutto-compose');
      await expect.poll(async () => panel.evaluate((el) => (el as HTMLElement).hidden)).toBe(false);
      await page.waitForTimeout(200);
      await expect(panel).toHaveAttribute('data-theme', 'light');
      await expect(panel).toHaveAttribute('data-placement', 'above');
      await page.screenshot({ path: 'e2e-results/compose-gmail-bar.png' });
    } finally {
      await page.close();
    }
  });
});
