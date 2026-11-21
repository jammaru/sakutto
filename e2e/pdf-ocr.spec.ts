import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadExtension } from './extension';
import { resetExtensionStorage } from './page';
import { plantLicenseConsent } from './folder-model-helpers';
import { openPdfTab, seedStandardOcrModels, setFileUrls } from './ocr-model-helpers';

const IMAGE_SOURCE = resolve('bench/ocr/fixtures/en-scan.png');

interface FixtureServer {
  url(name: string): string;
  close(): Promise<void>;
}

async function serveFixtures(directory: string): Promise<FixtureServer> {
  const server = createServer(async (request, response) => {
    const name = (request.url ?? '').replace(/^\//u, '');
    if (!/^[a-z0-9._-]+$/iu.test(name)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(directory, name));
      response.writeHead(200, {
        'content-type': name.endsWith('.pdf') ? 'application/pdf' : 'image/png',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fixture server has no port');
  return {
    url: (name) => `http://127.0.0.1:${address.port}/${name}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function prepare(extension: Awaited<ReturnType<typeof loadExtension>>, withModels: boolean) {
  await extension.context.unroute('**/*');
  await resetExtensionStorage(extension.worker, { targetLanguage: 'en' });
  const helper: Page = await extension.context.newPage();
  try {
    await helper.goto(`chrome-extension://${extension.extensionId}/popup.html`);
    await plantLicenseConsent(helper);
  } finally {
    await helper.close();
  }
  if (withModels) await seedStandardOcrModels(extension);
}

function translatedText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function waitForOcrText(page: Page, timeoutMs: number): Promise<number> {
  const started = Date.now();
  await page.waitForFunction(
    () => {
      const source = [...document.querySelectorAll('.sakutto-page__text')]
        .map((node) => node.textContent ?? '')
        .join(' ');
      const progress = (
        globalThis as {
          __sakuttoPdf?: {
            session: { progress(): { done: number; total: number; failed: number } };
          };
        }
      ).__sakuttoPdf?.session.progress();
      return (
        source.includes('LOCAL TRANSLATION NOTES') &&
        progress !== undefined &&
        progress.total > 0 &&
        progress.done === progress.total &&
        progress.failed === 0
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
  return Date.now() - started;
}

interface Fixtures {
  directory: string;
  server: FixtureServer;
  pdfPath: string;
  pdfUrl: string;
}

/** Every test owns its fixture server and directory: CI shards run specs in parallel workers. */
async function createFixtures(): Promise<Fixtures> {
  const directory = await mkdtemp(join(tmpdir(), 'sakutto-ocr-fixtures-'));
  // A one-page, image-only scan generated at test time. No text layer, no committed binary.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const image = (await readFile(IMAGE_SOURCE)).toString('base64');
    await page.setContent(
      `<style>@page { margin: 0 } body { margin: 0 } img { display: block }</style><img src="data:image/png;base64,${image}">`,
    );
    await writeFile(
      join(directory, 'scan.pdf'),
      await page.pdf({ width: '900px', height: '650px', printBackground: true }),
    );
  } finally {
    await browser.close();
  }
  await writeFile(join(directory, 'en-scan.png'), await readFile(IMAGE_SOURCE));
  return {
    directory,
    server: await serveFixtures(directory),
    pdfPath: join(directory, 'scan.pdf'),
    pdfUrl: pathToFileURL(join(directory, 'scan.pdf')).href,
  };
}

test.describe('scanned PDF and image OCR in real Chromium', () => {
  test('http scanned PDF finishes OCR within 30 seconds', async () => {
    test.setTimeout(90_000);
    const fixtures = await createFixtures();
    const extension = await loadExtension('en-US');
    try {
      await prepare(extension, true);
      const pdf = await extension.context.newPage();
      const pdfUrl = fixtures.server.url('scan.pdf');
      await pdf.goto(pdfUrl);
      const started = Date.now();
      const opened = await openPdfTab(extension, pdf, pdfUrl);
      expect(opened.reason).toBeNull();
      await waitForOcrText(opened.page, 30_000);
      const elapsed = Date.now() - started;
      console.log(`1-page scanned PDF OCR on CI: ${elapsed} ms`);
      expect(await translatedText(opened.page)).not.toContain('認識できませんでした');
    } finally {
      await extension.close();
      await fixtures.server.close();
      await rm(fixtures.directory, { recursive: true, force: true });
    }
  });

  test('file:// scanned PDF offers the picker and finishes OCR', async () => {
    test.setTimeout(90_000);
    const fixtures = await createFixtures();
    const extension = await loadExtension('en-US');
    try {
      await prepare(extension, true);
      await setFileUrls(extension, true);
      const pdf = await extension.context.newPage();
      const fileUrl = fixtures.pdfUrl;
      await pdf.goto(fileUrl);
      const started = Date.now();
      const opened = await openPdfTab(extension, pdf, fileUrl);
      // Chrome's service worker cannot fetch file:// bytes even with file access enabled; the
      // reader must say so instead of hanging, and the picker must still work.
      expect(opened.reason).toBe('file-denied');
      await expect(opened.page.locator('[data-sakutto="file-access-message"]')).toBeVisible();
      await opened.page.locator('#pdf-file').setInputFiles(fixtures.pdfPath);
      await waitForOcrText(opened.page, 30_000);
      const elapsed = Date.now() - started;
      console.log(`1-page file:// scanned PDF OCR via picker on CI: ${elapsed} ms`);
    } finally {
      await extension.close();
      await fixtures.server.close();
      await rm(fixtures.directory, { recursive: true, force: true });
    }
  });

  test('missing OCR model shows an actionable message instead of hanging', async () => {
    test.setTimeout(60_000);
    const fixtures = await createFixtures();
    const extension = await loadExtension('ja');
    try {
      await prepare(extension, false);
      const pdf = await extension.context.newPage();
      const pdfUrl = fixtures.server.url('scan.pdf');
      await pdf.goto(pdfUrl);
      const opened = await openPdfTab(extension, pdf, pdfUrl);
      expect(opened.reason).toBeNull();
      await expect(opened.page.getByText('設定でOCRモデルをダウンロードしてください')).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await extension.close();
      await fixtures.server.close();
      await rm(fixtures.directory, { recursive: true, force: true });
    }
  });

  test('image context menu OCR still works over http', async () => {
    test.setTimeout(60_000);
    const fixtures = await createFixtures();
    const extension = await loadExtension('en-US');
    try {
      await prepare(extension, true);
      const image = await extension.context.newPage();
      const imageUrl = fixtures.server.url('en-scan.png');
      await image.goto(imageUrl);
      await image.bringToFront();
      const tabId = await extension.worker.evaluate(async () => {
        const browser = (
          globalThis as unknown as {
            chrome: {
              tabs: { query(query: Record<string, unknown>): Promise<Array<{ id?: number }>> };
            };
          }
        ).chrome;
        return (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      });
      if (tabId === undefined) throw new Error('active tab has no id');
      await extension.worker.evaluate(
        async ({ tabId, srcUrl }) => {
          const browser = (
            globalThis as unknown as {
              chrome: {
                contextMenus: { onClicked: unknown };
                tabs: { get(id: number): Promise<unknown> };
              };
            }
          ).chrome;
          await (
            browser.contextMenus.onClicked as unknown as {
              dispatch(info: { menuItemId: string; srcUrl: string }, tab: unknown): Promise<void>;
            }
          ).dispatch({ menuItemId: 'translate-image', srcUrl }, await browser.tabs.get(tabId));
        },
        { tabId, srcUrl: imageUrl },
      );
      await expect
        .poll(
          async () =>
            image.evaluate(() => {
              const host =
                document.querySelector('[data-sakutto-image-translation]') ?? document.body;
              return (host.shadowRoot?.textContent ?? host.textContent ?? '').includes('§en§');
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
    } finally {
      await extension.close();
      await fixtures.server.close();
      await rm(fixtures.directory, { recursive: true, force: true });
    }
  });
});
