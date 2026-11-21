import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { FIXTURE_DIRECTORY, materializeFixtureSources, OCR_FIXTURES } from './ocr-fixtures.ts';

/** Renders generated SVG into the committed PNG inputs for the Node/WASM bench. */
async function main(): Promise<void> {
  await materializeFixtureSources();
  const executablePath = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome';
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    for (const fixture of OCR_FIXTURES) {
      const rendered = await page.evaluate(
        async ({ svg, width, height }) => {
          const image = new Image();
          const source = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('SVG rendering failed'));
            image.src = source;
          });
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('No 2D canvas');
          context.drawImage(image, 0, 0, width, height);
          return { png: canvas.toDataURL('image/png').split(',')[1] };
        },
        { svg: fixture.svg, width: fixture.width, height: fixture.height },
      );
      if (!rendered.png) throw new Error('PNG encoding failed for ' + fixture.id);
      await writeFile(
        join(FIXTURE_DIRECTORY, fixture.id + '.png'),
        Buffer.from(rendered.png, 'base64'),
      );
      console.log('rendered ' + fixture.id + ' ' + fixture.width + 'x' + fixture.height);
    }
  } finally {
    await browser.close();
  }
}
await main();
