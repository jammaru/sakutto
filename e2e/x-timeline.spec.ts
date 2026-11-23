import { expect, test } from '@playwright/test';
import { loadExtension, type LoadedExtension } from './extension';
import { FIXTURE_ORIGIN, MARKER, commandPage, resetExtensionStorage, waitTranslated } from './page';

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

  test('renders flat English output as three paragraphs with spaces after Latin sentence ends', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html?flatEn=1`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#three-paragraph-tweet')
        .evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#three-paragraph-text > sakutto-line');
      await expect(line.locator('br')).toHaveCount(4);
      const chunks = await line.evaluate((element) =>
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.nodeValue ?? ''),
      );
      expect(chunks).toHaveLength(5);
      const translated = chunks.join(' ');
      expect(translated).toContain('Welcome to Osaka!');
      expect(translated).toContain('This is the second sentence.');
      expect(translated).toContain('Come see me! Hope you visit.');
      expect(chunks[1]).toBe('');
      expect(chunks[3]).toBe('');
      // The fake model returns Osaka!This and me!Hope; neither may stay glued.
      for (const chunk of chunks) expect(chunk).not.toMatch(/[!?][A-Za-z]/u);
      await expect(page.locator('#three-paragraph-text')).toContainText('最初の段落には');
    } finally {
      await page.close();
    }
  });

  test('keeps a single within-paragraph br in flat English output', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html?flatEn=1`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#single-br-tweet')
        .evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#single-br-text > sakutto-line');
      await expect(line.locator('br')).toHaveCount(1);
      const chunks = await line.evaluate((element) =>
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.nodeValue ?? ''),
      );
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain('Welcome to Osaka!');
      expect(chunks[1]).toContain('This is the second line.');
      for (const chunk of chunks) expect(chunk).not.toMatch(/[!?][A-Za-z]/u);
    } finally {
      await page.close();
    }
  });

  test('translates lazily mounted replies on the detail page', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page.locator('#detail').evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);
      await expect(page.locator('#detail-main-text > sakutto-line')).toContainText(
        '§en§投稿の詳細画面に表示されている本文です',
      );

      await page.getByRole('button', { name: '返信を表示' }).click();
      await expect(page.locator('#reply-one > sakutto-line')).toContainText(
        '§en§返信が遅れて読み込まれた場合でも',
      );
      await page.getByRole('button', { name: 'さらに返信を表示' }).click();
      await expect(page.locator('#reply-two > sakutto-line')).toContainText(
        '§en§さらに返信を表示を押すと',
      );
      await expect(page.locator('#detail-main-text > sakutto-line')).toContainText(
        '§en§投稿の詳細画面に表示されている本文です',
      );
      await waitTranslated(page);
    } finally {
      await page.close();
    }
  });

  // Guest (logged-out) X no longer ships data-testid=tweetText. Its body is a
  // div[lang][dir=auto].whitespace-pre-wrap with raw \n between paragraphs.
  test('translates guest post bodies with raw newlines and nested quote articles', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#guest-timeline')
        .evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#guest-body > sakutto-line');
      await expect(line).toContainText('§en§');
      expect(await line.locator('br').count()).toBeGreaterThanOrEqual(2);
      await expect(page.locator('#guest-body')).toContainText('トヨタ往年のクルマたち');
      await expect(page.locator('#guest-body')).toContainText('👀✨');
      await expect(page.locator('#guest-body a[href^="/hashtag/"]')).toHaveCount(2);
      await expect(page.locator('#base-ui-guest-mention')).toBeVisible();

      // Short quote bodies are UI-length, so they use replacement mode; both still translate.
      await expect(page.locator('#guest-quote-outer')).toContainText('§en§めっちゃ悔しいなぁ');
      await expect(page.locator('#guest-quote-inner')).toContainText('§en§17時から生配信します');
    } finally {
      await page.close();
    }
  });

  test('spreads flat English over a guest body whose paragraphs are raw newlines', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html?flatEn=1`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#guest-timeline')
        .evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#guest-body > sakutto-line');
      const chunks = await line.evaluate((element) =>
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.nodeValue ?? ''),
      );
      const translated = chunks.join(' ');
      expect(translated).toContain('Welcome to Osaka!');
      expect(translated).toContain('This is the second sentence.');
      expect(translated).toContain('Come see me!');
      expect(translated).toContain('Hope you visit.');
      expect(chunks.filter((chunk) => chunk.trim().length > 0).length).toBe(3);
      expect(chunks.some((chunk) => chunk.trim().length === 0)).toBe(true);
      for (const chunk of chunks) expect(chunk).not.toMatch(/[!?][A-Za-z]/u);
      await expect(page.locator('#guest-body')).toContainText('トヨタ往年のクルマたち');
    } finally {
      await page.close();
    }
  });

  // Logged-in X keeps the tweetText testid but paints paragraph gaps with raw newlines.
  // The fake model answers each line with a flat English sentence (no newline), so this
  // exercises the same rejoin path as a real per-line engine request.
  test('keeps raw pre-wrap line gaps with flat English line answers', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html?flatEn=1`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#prewrap-stack-tweet')
        .evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const line = page.locator('#prewrap-stack-text > sakutto-line');
      await expect(line.locator('br')).toHaveCount(14);
      const chunks = await line.evaluate((element) =>
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.nodeValue ?? ''),
      );
      expect(chunks).toHaveLength(15);
      expect(chunks.filter((chunk) => chunk.trim().length === 0)).toHaveLength(7);
      const translated = chunks.filter((chunk) => chunk.trim().length > 0);
      expect(translated).toHaveLength(8);
      expect(translated.join(' ')).toContain('Welcome to Osaka!');
      expect(translated.join(' ')).toContain('The eighth line ends the flat paragraph.');
      for (const chunk of chunks) expect(chunk).not.toMatch(/\n/u);
      await expect(page.locator('#prewrap-stack-text')).toContainText('ログイン済みのタイムライン');
      await expect(page.locator('#prewrap-stack-text a[href="/hashtag/日本語"]')).toHaveCount(1);
      await expect(page.locator('#prewrap-stack-text img[alt="🌸"]')).toHaveCount(1);
    } finally {
      await page.close();
    }
  });

  test('retranslates a guest body when Show more swaps its span children', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#guest-timeline')
        .evaluate((element) => element.removeAttribute('hidden'));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const body = page.locator('#guest-show-more-text');
      const line = body.locator('> sakutto-line');
      await expect(line).toContainText('§en§');
      await expect(body).toContainText('詳細は続きをご覧ください');

      await page.locator('#guest-show-more-button').click();
      await expect(page.locator('#guest-show-more-full')).toBeVisible();
      await expect(page.locator('#guest-show-more-truncated')).toHaveCount(0);
      await expect(page.locator('#guest-show-more-button')).toHaveCount(0);
      await expect(line).toContainText('長文の本文が展開後に新しいspan一つで表示され');
      await expect(line).not.toContainText('詳細は続きをご覧ください');
      await waitTranslated(page);
    } finally {
      await page.close();
    }
  });

  // The product default is sentence reveal. The shared e2e helper still writes smooth
  // for older specs, so this one asks for sentence explicitly while the fake engine
  // answers one pre-wrap line at a time.
  test('keeps the first line of a pre-wrap post aligned while sentence reveal is running', async () => {
    await resetExtensionStorage(extension.worker, {
      targetLanguage: 'en',
      translationReveal: 'sentence',
    });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await page
        .locator('#prewrap-stack-tweet')
        .evaluate((element) => element.removeAttribute('hidden'));
      await page.evaluate(() => {
        // A slow final-only decode keeps the first answer on the page while the
        // remaining lines are still being translated.
        document.documentElement.dataset.benchPace = JSON.stringify({
          ttfbMs: 300,
          msPerChar: 12,
          deltas: 0,
        });
        const snapshots: string[][] = [];
        (globalThis as unknown as { __lineSnapshots: string[][] }).__lineSnapshots = snapshots;
        const body = document.querySelector('#prewrap-stack-text');
        if (!body) throw new Error('missing pre-wrap body');
        const record = (): void => {
          const line = body.querySelector(':scope > sakutto-line');
          if (!line) return;
          const chunks = Array.from(line.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.nodeValue ?? '');
          if (snapshots[snapshots.length - 1]?.join('\u0000') !== chunks.join('\u0000')) {
            snapshots.push(chunks);
          }
        };
        new MutationObserver(record).observe(body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      const snapshots = await page.evaluate(
        () => (globalThis as unknown as { __lineSnapshots: string[][] }).__lineSnapshots,
      );
      const firstAnswer = `${MARKER}ログイン済みのタイムラインでは本文が白折返しで描画されます。`;
      const partial = snapshots.find(
        (chunks) =>
          chunks[0] === firstAnswer && chunks.slice(1).every((chunk) => chunk.trim() === ''),
      );
      expect(partial, `snapshots were ${JSON.stringify(snapshots)}`).toBeDefined();
      const finished = snapshots.at(-1) ?? [];
      expect(finished.filter((chunk) => chunk.trim().length > 0)).toHaveLength(8);
      expect(finished[2]).toContain(`${MARKER}短い行が続く場合でも`);
    } finally {
      await page.close();
    }
  });

  test('translates a conversation injected after SPA pushState', async () => {
    await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
    const page = await extension.context.newPage();
    try {
      await page.goto(`${FIXTURE_ORIGIN}/x-timeline.html`);
      await page.locator('#main-tweet').evaluate((element) => element.setAttribute('hidden', ''));
      await commandPage(extension.worker, page, 'bilingual');
      await waitTranslated(page);

      await page.getByRole('button', { name: 'スレッドを開く' }).click();
      await expect(page).toHaveURL(/\/i\/web\/status\//u);
      await expect(page.locator('#spa-main-text > sakutto-line')).toContainText(
        '§en§シングルページ遷移で開いた詳細画面の本文です',
      );
      await expect(page.locator('#spa-reply > sakutto-line')).toContainText(
        '§en§返信が遅れて読み込まれた場合でも',
      );
      await waitTranslated(page);
    } finally {
      await page.close();
    }
  });
});
