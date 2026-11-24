import { expect, test, type Page } from '@playwright/test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadExtension } from './extension';
import { resetExtensionStorage } from './page';
import { plantLicenseConsent } from './folder-model-helpers';
import { openPdfTab, seedStandardOcrModels, warmOcr } from './ocr-model-helpers';
import { openPdfBytes } from '../tests/support/open-fixture-pdf';

const PDF_SOURCE = resolve('bench/pdf/paper.pdf');
const SCAN_SOURCE = resolve('bench/pdf/scan.pdf');

async function servePdf(directory: string, name = 'paper.pdf') {
  const server = createServer((request, response) => {
    if ((request.url ?? '') !== `/${name}`) {
      response.writeHead(404).end();
      return;
    }
    void readFile(join(directory, name)).then(
      (body) => {
        response.writeHead(200, { 'content-type': 'application/pdf' }).end(body);
      },
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fixture server has no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/${name}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test.describe('translated PDF download in real Chromium', () => {
  test('the toolbar saves a real PDF with the translated text', async () => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'sakutto-pdf-export-'));
    await copyFile(PDF_SOURCE, join(directory, 'paper.pdf'));
    const server = await servePdf(directory);
    const extension = await loadExtension('ja');
    try {
      await extension.context.unroute('**/*');
      await resetExtensionStorage(extension.worker, { targetLanguage: 'ja' });
      const helper: Page = await extension.context.newPage();
      try {
        await helper.goto(`chrome-extension://${extension.extensionId}/popup.html`);
        await plantLicenseConsent(helper);
      } finally {
        await helper.close();
      }

      const source = await extension.context.newPage();
      await source.goto(server.url);
      const opened = await openPdfTab(extension, source, server.url);
      expect(opened.reason).toBeNull();

      // The primary toolbar action names the saved file in the Japanese UI.
      const button = opened.page.getByRole('button', {
        name: '翻訳後のPDFをダウンロード',
      });
      await expect(button).toBeVisible();
      await expect(opened.page.locator('[data-sakutto="download-translated-pdf"]')).toHaveAttribute(
        'aria-busy',
        'false',
      );

      const downloadPromise = opened.page.waitForEvent('download', { timeout: 90_000 });
      await button.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('paper_ja.pdf');
      const path = await download.path();
      if (!path) throw new Error('download has no saved path');
      const bytes = new Uint8Array(await readFile(path));
      expect(Buffer.from(bytes.subarray(0, 8)).toString('latin1')).toMatch(/^%PDF-/u);

      // The written file is a PDF with real text objects, not a screenshot of the page: the
      // fake engine marks every translated block with the target language.
      const document = await openPdfBytes(bytes);
      try {
        expect(document.numPages).toBeGreaterThan(0);
        const first = (await document.getPage(1)) as {
          getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
        };
        const text = (await first.getTextContent()).items.map((item) => item.str ?? '').join('');
        expect(text).toContain('§ja§');
      } finally {
        await document.destroy();
      }
      await expect(opened.page.locator('[data-sakutto="export-error"]')).toHaveCount(0);
    } finally {
      await extension.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test('a scanned page keeps its OCR translation boxes in the saved PDF', async () => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'sakutto-scan-export-'));
    await copyFile(SCAN_SOURCE, join(directory, 'scan.pdf'));
    const server = await servePdf(directory, 'scan.pdf');
    const extension = await loadExtension('ja');
    try {
      await extension.context.unroute('**/*');
      await resetExtensionStorage(extension.worker, { targetLanguage: 'ja' });
      const helper: Page = await extension.context.newPage();
      try {
        await helper.goto(`chrome-extension://${extension.extensionId}/popup.html`);
        await plantLicenseConsent(helper);
      } finally {
        await helper.close();
      }
      await seedStandardOcrModels(extension);
      await warmOcr(extension);

      const source = await extension.context.newPage();
      await source.goto(server.url);
      const opened = await openPdfTab(extension, source, server.url);
      expect(opened.reason).toBeNull();
      const button = opened.page.getByRole('button', {
        name: '翻訳後のPDFをダウンロード',
      });
      await expect(button).toBeVisible();

      const downloadPromise = opened.page.waitForEvent('download', { timeout: 90_000 });
      await button.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('scan_ja.pdf');
      const path = await download.path();
      if (!path) throw new Error('download has no saved path');
      const bytes = new Uint8Array(await readFile(path));
      expect(Buffer.from(bytes.subarray(0, 8)).toString('latin1')).toMatch(/^%PDF-/u);
      const document = await openPdfBytes(bytes);
      try {
        expect(document.numPages).toBeGreaterThan(0);
        const first = (await document.getPage(1)) as {
          getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
        };
        const text = (await first.getTextContent()).items.map((item) => item.str ?? '').join('');
        expect(text).toContain('§ja§');
        expect(text).toContain('LOCAL TRANSLATION NOTES');
      } finally {
        await document.destroy();
      }
    } finally {
      await extension.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
