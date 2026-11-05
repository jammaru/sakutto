import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';

interface WorkerMessage {
  verb?: string;
  args?: unknown[];
}

test('starts the packaged wllama worker', async () => {
  test.skip(
    !existsSync('.output/chrome-mv3/vendor/wllama/wllama.wasm'),
    'The packaged wllama build is not in this extension.',
  );

  const extension = await loadExtension('en-US');
  try {
    const page = await extension.context.newPage();
    await page.goto(`chrome-extension://${extension.extensionId}/offscreen.html`);

    const base = `chrome-extension://${extension.extensionId}/vendor/wllama/`;
    const debug = await page.evaluate(async (assetBase) => {
      const options = {
        pathConfig: { 'wllama.wasm': `${assetBase}wllama.wasm` },
        nbThread: 0,
        compat: false,
        noWebGPU: true,
        moduleUrl: `${assetBase}wllama-module.js`,
      };
      const workerUrl = `${assetBase}wllama-worker.js?options=${encodeURIComponent(JSON.stringify(options))}`;
      const worker = new Worker(workerUrl);

      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error('the wllama worker did not report its module boot'));
        }, 20_000);

        worker.onerror = (event) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(event.message || 'the wllama worker failed to load'));
        };
        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const data = event.data;
          if (data?.verb !== 'console.debug') return;
          const line = data.args?.[0];
          if (typeof line !== 'string' || !line.includes('Multithread enabled')) return;

          clearTimeout(timer);
          worker.terminate();
          resolve(line);
        };

        worker.postMessage({
          verb: 'module.init',
          args: [`${assetBase}wllama-pthread.js`, false],
          callbackId: 1,
        });
      });
    }, base);

    expect(debug).toContain('Multithread enabled');
    await page.close();
  } finally {
    await extension.close();
  }
});
