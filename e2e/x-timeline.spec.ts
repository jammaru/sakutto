import { expect, test } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { FIXTURE_ORIGIN, commandPage, resetExtensionStorage, waitTranslated } from './page';

let extension: LoadedExtension;

test.describe('X timeline bilingual translation', () => {
  test.beforeAll(async () => {
    extension = await loadExtension('en-US');
  });

  test.afterAll(async () => {
    if (!extension) return;
    try {
      expect(extension.denied).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('persists after completion and same-container React re-renders with line breaks', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'ja' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#show-more').click();
      const reconciliationsBeforeTranslation = await page.evaluate(
        () => (window as unknown as { __xReconciliations: number }).__xReconciliations,
      );

      // Start directly in bilingual mode, as an always-translate X site rule does.
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#tweet > sakutto-line');
      await expect(line).toContainText(`§ja§The first paragraph`);
      await expect(line.locator('br')).toHaveCount(3);
      await expect(page.locator('#first')).toHaveText(
        'The first paragraph of this expanded post is deliberately long enough to be body copy.',
      );
      await expect(page.locator('#second')).toContainText('The second paragraph');
      await expect(page.locator('#third')).toContainText('The final paragraph');
      expect(
        await page.evaluate(
          () => (window as unknown as { __xReconciliations: number }).__xReconciliations,
        ),
      ).toBe(reconciliationsBeforeTranslation);

      // React can keep tweetText mounted and replace only its children. The cached
      // translation must be repainted onto that new source DOM, not discarded as unchanged.
      await page.locator('#force-rerender').click();
      await expect(line).toContainText(`§ja§The first paragraph`);
      await expect(line.locator('br')).toHaveCount(3);
      await expect(page.locator('#first')).toContainText('The first paragraph');
      await expect(page.locator('#second')).toContainText('The second paragraph');
      await expect(page.locator('#third')).toContainText('The final paragraph');
    } finally {
      await page.close();
    }
  });

  test('keeps blank-line gaps between all three translated paragraphs', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#three-paragraph-tweet')
        .evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#three-paragraph-text > sakutto-line');
      await expect(line.locator('br')).toHaveCount(4);
      const lines = await line.evaluate((element) =>
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.nodeValue ?? ''),
      );
      expect(lines).toHaveLength(5);
      expect(lines[0]).toContain('§en§最初の段落');
      expect(lines[1]).toBe('');
      expect(lines[2]).toContain('§en§二番目の段落');
      expect(lines[3]).toBe('');
      expect(lines[4]).toContain('§en§最後の段落');
    } finally {
      await page.close();
    }
  });

  test('translates expanded recommendation text instead of finishing the truncated request', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#recommendations')
        .evaluate((element) => element.removeAttribute('hidden'));
      await page.evaluate(() => {
        document.documentElement.dataset.benchPace = JSON.stringify({
          ttfbMs: 300,
          msPerChar: 2,
          deltas: 1,
        });
      });
      await commandPage(extension.worker, page, 'bilingual');
      await expect(page.locator('#recommendation-text')).toHaveAttribute(
        'data-sakutto-pending',
        '1',
      );
      await page.locator('#recommendation-more').click();

      const line = page.locator('#recommendation-text > sakutto-line');
      await expect(line).toContainText('§en§さらに表示を押すと現れる追加の段落です');
      await expect(line).not.toContainText('短縮版の末尾です');
      await expect(page.locator('#recommendation-text')).toContainText(
        'さらに表示を押すと現れる追加の段落です',
      );
      await waitTranslated(page);
    } finally {
      await page.close();
    }
  });

  test('drops the old translation when a running cell is recycled with new content', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#recycled-tweet')
        .evaluate((element) => element.removeAttribute('hidden'));
      await page.evaluate(() => {
        document.documentElement.dataset.benchPace = JSON.stringify({
          ttfbMs: 300,
          msPerChar: 2,
          deltas: 1,
        });
      });
      await commandPage(extension.worker, page, 'bilingual');
      await expect(page.locator('#recycled-text')).toHaveAttribute('data-sakutto-pending', '1');
      await page.locator('#recycle-cell').click();

      const line = page.locator('#recycled-text > sakutto-line');
      await expect(line).toContainText(
        '§en§再利用された同じセルにマウントされた新しい日本語の投稿です',
      );
      await expect(line).not.toContainText('古いセルに表示されていた');
      await expect(page.locator('#recycled-text')).toContainText(
        '再利用された同じセルにマウントされた新しい日本語の投稿です',
      );
      await waitTranslated(page);
    } finally {
      await page.close();
    }
  });
});
