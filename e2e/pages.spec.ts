import { expect, test, type Page } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import {
  FIXTURE_ORIGIN,
  MARKER,
  commandPage,
  readSiteDisplay,
  resetExtensionStorage,
  savePerf,
  waitTranslated,
} from './page';

let extension: LoadedExtension;

async function openFixture(path: string): Promise<Page> {
  await resetExtensionStorage(extension.worker);
  const page = await extension.context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}${path}`);
  await commandPage(extension.worker, page, 'toggle');
  await waitTranslated(page);
  return page;
}

test.describe('in-page translation', () => {
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

  test('translates an article, keeps links, and restores the original text', async () => {
    const page = await openFixture('/article.html');
    try {
      await expect(page.locator('#lead')).toContainText(MARKER);
      await expect(page.locator('#link a')).toHaveAttribute('href', '/docs.html');
      await expect(page.locator('#link a')).toContainText(`${MARKER}ドキュメント`);
      await savePerf('article', page);

      await commandPage(extension.worker, page, 'restore');
      await expect(page.locator('#lead')).toHaveText('今日はよく晴れています。');
      await expect(page.locator('#link a')).toHaveText('ドキュメント');
      await expect(page.locator('sakutto-note')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test('leaves code blocks untouched', async () => {
    const page = await openFixture('/docs.html');
    try {
      await expect(page.locator('h1')).toContainText(MARKER);
      await expect(page.locator('code')).toHaveText('const answer = 42;');
      await expect(page.locator('pre')).not.toContainText(MARKER);
    } finally {
      await page.close();
    }
  });

  test('translates labels and leaves form values alone', async () => {
    const page = await openFixture('/form.html');
    try {
      await expect(page.locator('label')).toContainText(MARKER);
      await expect(page.locator('td').first()).toContainText(MARKER);
      await expect(page.locator('#name')).toHaveValue('secret');
      await expect(page.locator('#price')).toHaveValue('100');
      await expect(page.locator('textarea')).toHaveValue('memo');
    } finally {
      await page.close();
    }
  });

  test('follows paragraphs added by a script', async () => {
    const page = await openFixture('/spa.html');
    try {
      await page.locator('#more').click();
      await expect(page.locator('#added')).toContainText(`${MARKER}追加された段落です。`);
    } finally {
      await page.close();
    }
  });

  test('translates a dark page without covering it', async () => {
    const page = await openFixture('/dark.html');
    try {
      await expect(page.locator('#lead')).toContainText(MARKER);
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background).toBe('rgb(17, 17, 17)');
    } finally {
      await page.close();
    }
  });

  test('translates a long page through to the last paragraph', async () => {
    const page = await openFixture('/long.html');
    try {
      await page.locator('#p39').scrollIntoViewIfNeeded();
      await expect(page.locator('#p0')).toContainText(MARKER);
      await expect(page.locator('#p39')).toContainText(MARKER);
      await savePerf('long', page);
    } finally {
      await page.close();
    }
  });

  test('translates a Chinese page', async () => {
    const page = await openFixture('/cjk.html');
    try {
      await expect(page.locator('#lead')).toContainText(`${MARKER}今天天气很好。`);
    } finally {
      await page.close();
    }
  });

  test('translates a Wikipedia-like article without leaking markup', async () => {
    const page = await openFixture('/wiki.html');
    try {
      await expect(page.locator('#lead')).toContainText('§ja§');
      await expect(page.locator('#lead .IPA')).toHaveText('oːsaka');
      await expect(page.locator('#lead sup')).toHaveText('[1]');
      await expect(page.locator('#lead a')).toHaveAttribute('href', '/wiki/Designated_city');
      await expect(page.locator('#mixed')).toContainText('§ja§');
      await expect(page.locator('#mixed')).toContainText('大坂');
      const universities = await page.locator('#universities').innerText();
      expect(universities.indexOf('Osaka University')).toBeLessThan(universities.indexOf(','));
      expect(universities.indexOf(',')).toBeLessThan(
        universities.indexOf('Osaka Metropolitan University'),
      );
      expect(await page.locator('body').innerHTML()).not.toMatch(/<i\d/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
      await expect(page.locator('html')).toHaveAttribute('data-sakutto-progress', /^\d+\/\d+$/);

      const raw = await page.evaluate(
        () => document.querySelector('sakutto-perf')?.textContent ?? '',
      );
      const perf = JSON.parse(raw) as { startedAt: number; firstTextAt: number | null };
      expect(perf.firstTextAt).not.toBeNull();
      expect((perf.firstTextAt ?? 0) - perf.startedAt).toBeLessThan(2000);

      await commandPage(extension.worker, page, 'bilingual');
      await expect(page.locator('#lead sakutto-line')).toContainText('§ja§');
      await expect(page.locator('nav sakutto-line')).toHaveCount(0);
      await expect(page.locator('aside sakutto-line')).toHaveCount(0);

      await commandPage(extension.worker, page, 'restore');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('#lead')).toContainText('designated city');
      await expect(page.locator('#lead')).not.toContainText('§ja§');
    } finally {
      await page.close();
    }
  });

  test('remembers bilingual mode for the site', async () => {
    const page = await openFixture('/article.html');
    try {
      await commandPage(extension.worker, page, 'bilingual');
      await expect(page.locator('#lead sakutto-line')).toContainText(MARKER);
      await expect(page.locator('#lead')).toContainText('今日はよく晴れています。');
      expect(await readSiteDisplay(extension.worker)).toBe('bilingual');

      await page.reload();
      await commandPage(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead sakutto-line')).toContainText(MARKER);
      await expect(page.locator('#lead')).toContainText('今日はよく晴れています。');
    } finally {
      await page.close();
    }
  });
});

test.describe('faded translation and skipped sidebar', () => {
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

  test('translates a model card sidebar and keeps the translation at full contrast', async () => {
    const page = await openFixture('/model-card.html');
    try {
      // Sidebar metadata and short labels used to be dropped, leaving a finished-looking
      // page with an English column beside it.
      await expect(page.locator('#downloads')).toContainText(MARKER);
      await expect(page.locator('#size')).toContainText(MARKER);
      await expect(page.locator('#spaces')).toContainText(MARKER);
      await expect(page.locator('#docs')).toContainText(MARKER);
      await expect(page.locator('#lead')).toContainText(MARKER);
      await expect(page.locator('#shell')).toContainText(MARKER);

      // Literal content stays literal.
      await expect(page.locator('#code')).toHaveText('model = load("weights")');
      await expect(page.locator('#sr')).toHaveText('Shortcut hint only screen readers announce');
      await expect(page.locator('html')).toHaveAttribute('data-sakutto-state', 'translated');

      // The reported bug: Japanese rendered paler than the English it replaced. The
      // translated paragraph must keep the host color at full opacity.
      const contrast = await page.evaluate(() => {
        const lead = document.querySelector('#lead');
        if (!lead) return null;
        const style = getComputedStyle(lead);
        return {
          color: style.color,
          opacity: style.opacity,
          originalColor: getComputedStyle(document.body).color,
        };
      });
      expect(contrast?.opacity).toBe('1');
      expect(contrast?.color).toBe(contrast?.originalColor);

      // A block that is still streaming must not dim. Before the fix this attribute set
      // opacity 0.58 (and shimmered to 0.32), so any paragraph the model had not finished
      // — and any block whose attribute outlived the request — read as pale gray.
      expect(
        await page.evaluate(() => {
          const lead = document.querySelector('#lead');
          if (!lead) return null;
          lead.setAttribute('data-sakutto-pending', '1');
          const opacity = getComputedStyle(lead).opacity;
          lead.removeAttribute('data-sakutto-pending');
          return opacity;
        }),
      ).toBe('1');
      expect(
        await page.evaluate(() => document.getElementById('sakutto-style')?.textContent ?? ''),
      ).not.toMatch(/color-mix\(/);

      await commandPage(extension.worker, page, 'bilingual');
      const line = page.locator('#lead sakutto-line');
      await expect(line).toContainText(MARKER);
      expect(
        await line.evaluate((element) => ({
          opacity: getComputedStyle(element).opacity,
          color: getComputedStyle(element).color,
        })),
      ).toEqual({ opacity: '1', color: contrast?.originalColor });
    } finally {
      await page.close();
    }
  });
});
