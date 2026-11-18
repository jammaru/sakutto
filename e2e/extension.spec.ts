import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

test.describe('built extension', () => {
  test('starts the extension service worker', async () => {
    const extension = await loadExtension('en-US');
    try {
      expect(extension.extensionId).toMatch(EXTENSION_ID_PATTERN);
    } finally {
      await extension.close();
    }
  });

  test('renders the popup, options, typed and onboarding pages in English', async () => {
    const extension = await loadExtension('en-US');
    try {
      const pages = ['popup.html', 'options.html', 'onboarding.html', 'typed.html'];

      for (const path of pages) {
        const page = await extension.context.newPage();
        await page.goto(`chrome-extension://${extension.extensionId}/${path}`);
        await expect(page.locator('h1')).toHaveText('Sakutto - Local AI translation');
        if (path === 'onboarding.html') {
          await expect(page.getByRole('checkbox')).toHaveCount(0);
          const radios = page.getByRole('radio');
          await expect(radios).toHaveCount(2);
          await expect(radios.nth(0)).toHaveAccessibleName('Save in this browser');
          await expect(radios.nth(0)).toBeChecked();
          await expect(radios.nth(1)).toHaveAccessibleName(
            'Use a shared model folder (Chromium browsers)',
          );
          await expect(radios.nth(1)).not.toBeChecked();
          await expect(page.locator('[data-store-recommended]')).toContainText(
            'Use a shared model folder (Chromium browsers)',
          );
          await expect(page.locator('[data-store-recommended] .recommended-badge')).toHaveText(
            'Recommended',
          );
          await expect(page.locator('fieldset.store ~ .action-row')).toBeVisible();
          await expect(
            page.getByText(
              'For people who use Chrome, Edge, or another Chromium browser: one model copy is shared between them.',
            ),
          ).toHaveCount(0);
          await expect(
            page.getByText(
              'After you press start, a folder dialog opens in Documents. Create or choose Documents/Sakutto, or choose the existing folder if another browser already has the models. Any folder you can write to also works.',
            ),
          ).toHaveCount(0);
          await expect(
            page.getByText('When the browser asks, choose “Allow on every visit” in Chrome'),
          ).toHaveCount(0);
          await radios.nth(1).check();
          await expect(
            page.getByText(
              'For people who use Chrome, Edge, or another Chromium browser: one model copy is shared between them.',
            ),
          ).toBeVisible();
          await expect(
            page.getByText(
              'After you press start, a folder dialog opens in Documents. Create or choose Documents/Sakutto, or choose the existing folder if another browser already has the models. Any folder you can write to also works.',
            ),
          ).toBeVisible();
          await expect(
            page.getByText('When the browser asks, choose “Allow on every visit” in Chrome'),
          ).toBeVisible();
          await expect(page.getByText('Restarts then need no extra clicks')).toBeVisible();
          await expect(page.getByText('“Ask every time I access” in Edge')).toBeVisible();
          await expect(
            page.getByText('equivalent to Chrome’s “Allow on every visit”'),
          ).toBeVisible();
          await expect(page.getByText('despite the name, no later prompts')).toBeVisible();
          await expect(page.getByText('サイトアクセス時は常に許可')).toBeVisible();
          await expect(
            page.getByText('Japanese Edge: 「アクセスするたびに確認する」'),
          ).toBeVisible();
          await radios.nth(0).check();
          await expect(
            page.getByText(
              'After you press start, a folder dialog opens in Documents. Create or choose Documents/Sakutto, or choose the existing folder if another browser already has the models. Any folder you can write to also works.',
            ),
          ).toHaveCount(0);
          await expect(page.getByText('A shared folder means:')).toBeVisible();
          await expect(
            page.getByText(
              'Other profiles and other Chromium browsers can use it right away, with no extra download.',
            ),
          ).toBeVisible();
          await expect(
            page.getByText('One copy on disk, so you save space (573 MB / 1.81 GB).'),
          ).toBeVisible();
          await expect(
            page.getByText(
              "The file stays if you clear this browser's data. Pick the same folder again and you skip the download.",
            ),
          ).toBeVisible();
          await expect(page.getByRole('heading', { name: 'Import a model file' })).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'Agree to the license and start' }),
          ).toBeEnabled();
          await expect(page.locator('#start-notice')).toHaveText(
            'Pressing "Agree to the license and start" means you agree to the PLaMo Community License.',
          );
          // The clearer structure: three short parts, then the age line, then the links.
          await expect(page.getByRole('heading', { name: 'PLaMo terms of use' })).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'Personal and academic use' }),
          ).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'Work and commercial use' }),
          ).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'When the conditions are not met' }),
          ).toBeVisible();
          await expect(page.getByText('Other license information')).toBeAttached();
          const details = page.locator('details');
          await details.locator('summary').click();
          await expect(details.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
            'href',
            'https://jammaru.com/sakutto/privacy/',
          );
          await expect(details.getByRole('link', { name: 'Source code' })).toHaveAttribute(
            'href',
            'https://github.com/jammaru/sakutto',
          );
        }
        if (path === 'options.html') {
          await expect(page.getByRole('group', { name: 'Where to save the model' })).toBeVisible();
          await expect(page.getByRole('heading', { name: 'Import a model file' })).toHaveCount(0);
          await expect(page.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
            'href',
            'https://jammaru.com/sakutto/privacy/',
          );
          await expect(page.getByRole('link', { name: 'Source code' })).toHaveAttribute(
            'href',
            'https://github.com/jammaru/sakutto',
          );
          // Chrome owns the bindings, so the panel shows them and links to Chrome's editor.
          // A fresh install must name the defaults, not "Not set".
          await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
          await expect(page.locator('kbd')).toHaveText(['Alt+A', 'Alt+B', 'Alt+S', 'Alt+T']);
        }
        if (path === 'typed.html') {
          await expect(page.locator('textarea')).toBeVisible();
        }
        await page.close();
      }
    } finally {
      await extension.close();
    }
  });

  test('translates the bundled sample page', async () => {
    const extension = await loadExtension('ja');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/sample.html?to=ja`);
      // HTML ships both language articles. `article h1` matches both until boot JS
      // removes one, and Playwright throws immediately on a two-element locator.
      await expect(page.locator('article[data-sample="ja"]')).toHaveCount(0);
      await expect(page.locator('article[data-sample="en"] h1')).toContainText(
        '§ja§Morning at the station',
      );
      await page.close();
    } finally {
      await extension.close();
    }
  });

  test('renders the pages in Japanese for a Japanese browser', async () => {
    const extension = await loadExtension('ja');
    try {
      const pages = ['popup.html', 'options.html', 'onboarding.html', 'typed.html'];

      for (const path of pages) {
        const page = await extension.context.newPage();
        await page.goto(`chrome-extension://${extension.extensionId}/${path}`);
        await expect(page.locator('h1')).toHaveText('Sakutto - ローカルAI翻訳');
        if (path === 'onboarding.html') {
          await expect(page.getByRole('checkbox')).toHaveCount(0);
          const radios = page.getByRole('radio');
          await expect(radios).toHaveCount(2);
          await expect(radios.nth(0)).toHaveAccessibleName('このブラウザ内に保存する');
          await expect(radios.nth(0)).toBeChecked();
          await expect(radios.nth(1)).toHaveAccessibleName(
            '共有モデルフォルダを使う（Chromiumブラウザ）',
          );
          await expect(radios.nth(1)).not.toBeChecked();
          await expect(page.locator('[data-store-recommended]')).toContainText(
            '共有モデルフォルダを使う（Chromiumブラウザ）',
          );
          await expect(page.locator('[data-store-recommended] .recommended-badge')).toHaveText(
            'おすすめ',
          );
          await expect(page.locator('fieldset.store ~ .action-row')).toBeVisible();
          await expect(
            page.getByText(
              'Chrome や Edge など複数の Chromium ブラウザで使う人向けです。モデルは1つで済みます。',
            ),
          ).toHaveCount(0);
          await expect(
            page.getByText(
              '「ライセンスに同意して開始」を押すと、フォルダ選択がドキュメントで開きます。「ドキュメント/Sakutto」を作成するか選んでください。別のブラウザにモデルが既にある場合は、その既存フォルダを選びます。書き込みできる別のフォルダでもかまいません。',
            ),
          ).toHaveCount(0);
          await expect(
            page.getByText('ブラウザから求められたら、Chromeでは「サイトアクセス時は常に許可」'),
          ).toHaveCount(0);
          await radios.nth(1).check();
          await expect(
            page.getByText(
              'Chrome や Edge など複数の Chromium ブラウザで使う人向けです。モデルは1つで済みます。',
            ),
          ).toBeVisible();
          await expect(
            page.getByText(
              '「ライセンスに同意して開始」を押すと、フォルダ選択がドキュメントで開きます。「ドキュメント/Sakutto」を作成するか選んでください。別のブラウザにモデルが既にある場合は、その既存フォルダを選びます。書き込みできる別のフォルダでもかまいません。',
            ),
          ).toBeVisible();
          await expect(
            page.getByText('ブラウザから求められたら、Chromeでは「サイトアクセス時は常に許可」'),
          ).toBeVisible();
          await expect(page.getByText('再起動後も追加のクリックは不要になります')).toBeVisible();
          await expect(page.getByText('サイトアクセス時は常に許可')).toBeVisible();
          await expect(page.getByText('Edgeでは「アクセスするたびに確認する」')).toBeVisible();
          await expect(
            page.getByText(
              '（Chromeの「サイトアクセス時は常に許可」にあたる項目で、名前と違って次から確認されません）',
            ),
          ).toBeVisible();
          await radios.nth(0).check();
          await expect(
            page.getByText(
              '「ライセンスに同意して開始」を押すと、フォルダ選択がドキュメントで開きます。「ドキュメント/Sakutto」を作成するか選んでください。別のブラウザにモデルが既にある場合は、その既存フォルダを選びます。書き込みできる別のフォルダでもかまいません。',
            ),
          ).toHaveCount(0);
          await expect(page.getByText('共有フォルダを使うと：')).toBeVisible();
          await expect(
            page.getByText(
              '他のプロフィールや別の Chromium ブラウザでもダウンロードなしですぐ使える',
            ),
          ).toBeVisible();
          await expect(
            page.getByText('モデルは1つだけなので容量を節約（573 MB / 1.81 GB）'),
          ).toBeVisible();
          await expect(
            page.getByText(
              'ブラウザのデータを消してもファイルは残る。同じフォルダを選べば再ダウンロード不要',
            ),
          ).toBeVisible();
          await expect(
            page.getByRole('button', { name: 'ライセンスに同意して開始' }),
          ).toBeEnabled();
          await expect(page.locator('#start-notice')).toHaveText(
            '「ライセンスに同意して開始」を押すと、PLaMo Community Licenseに同意したことになります。',
          );
          await expect(page.getByRole('heading', { name: 'PLaMoの利用条件' })).toBeVisible();
          await expect(page.getByRole('heading', { name: '個人・学術目的での利用' })).toBeVisible();
          await expect(page.getByRole('heading', { name: '仕事・商業目的での利用' })).toBeVisible();
          await expect(page.getByRole('heading', { name: '条件を満たさない場合' })).toBeVisible();
          await expect(page.getByText('その他のライセンス情報')).toBeAttached();
          const details = page.locator('details');
          await details.locator('summary').click();
          await expect(details.getByRole('link', { name: 'プライバシーポリシー' })).toHaveAttribute(
            'href',
            'https://jammaru.com/sakutto/privacy/',
          );
          await expect(details.getByRole('link', { name: 'ソースコード' })).toHaveAttribute(
            'href',
            'https://github.com/jammaru/sakutto',
          );
          // The age line states the requirement and does not disclaim verification.
          await expect(
            page.getByText(
              '18歳未満など、単独で契約できる年齢に達していない場合は、親権者等の同意が必要です。',
            ),
          ).toBeVisible();
        }
        if (path === 'options.html') {
          await expect(page.getByRole('group', { name: 'モデルの保存先' })).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'モデルファイルをインポート' }),
          ).toHaveCount(0);
          await expect(page.getByRole('link', { name: 'プライバシーポリシー' })).toHaveAttribute(
            'href',
            'https://jammaru.com/sakutto/privacy/',
          );
          await expect(page.getByRole('link', { name: 'ソースコード' })).toHaveAttribute(
            'href',
            'https://github.com/jammaru/sakutto',
          );
          await expect(
            page.getByRole('heading', { name: 'キーボードショートカット' }),
          ).toBeVisible();
        }
        if (path === 'typed.html') {
          await expect(page.locator('textarea')).toBeVisible();
        }
        await page.close();
      }
    } finally {
      await extension.close();
    }
  });
});
