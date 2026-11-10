import { createServer, type IncomingMessage, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';
import { FIXTURE_ORIGIN, commandPage, waitTranslated } from './page';

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

interface RecordedCompletion {
  prompt: string;
}

async function startFakeServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  completions: RecordedCompletion[];
}> {
  const completions: RecordedCompletion[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      const url = request.url ?? '';
      if (url.includes('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'pfnet/plamo-3-translate-0.8b-MLX-4bit' }] }));
        return;
      }
      if (url.includes('/completions')) {
        const body = raw.length > 0 ? (JSON.parse(raw) as { prompt?: unknown }) : {};
        completions.push({ prompt: typeof body.prompt === 'string' ? body.prompt : '' });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ text: 'LOCAL-SERVER-PFML3', finish_reason: 'stop' }],
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    completions,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test.describe('local server options', () => {
  test('tests a mocked OpenAI-compatible server from Settings', async () => {
    const fake = await startFakeServer();
    const extension = await loadExtension('en-US');
    try {
      const page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await expect(page.getByText('Translation engine')).toBeVisible();
      await page.getByLabel('Translation engine').selectOption('local-server');
      await page.getByLabel('Server URL').fill(fake.url);
      await page.getByLabel('Server URL').blur();
      await page.getByRole('button', { name: 'Test connection' }).click();
      await expect(page.getByRole('status')).toHaveText('Connected.');
      await page.close();
    } finally {
      await extension.close();
      await fake.close();
    }
  });

  test('translates a page through a mock /v1/completions that receives PFML3', async () => {
    const fake = await startFakeServer();
    const extension = await loadExtension('en-US');
    try {
      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      await options.getByLabel('Translation engine').selectOption('local-server');
      await options.getByLabel('Server URL').fill(fake.url);
      await options.getByLabel('Server URL').blur();
      await options
        .getByRole('combobox', { name: 'Model', exact: true })
        .fill('pfnet/plamo-3-translate-0.8b-MLX-4bit');
      await options.getByRole('combobox', { name: 'Model', exact: true }).blur();
      await options.getByRole('button', { name: 'Test connection' }).click();
      await expect(options.getByRole('status')).toHaveText('Connected.');

      const status = await options.evaluate(async () => {
        const chrome = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
          }
        ).chrome;
        return chrome.runtime.sendMessage({ type: 'engine:status' });
      });
      expect(status).toMatchObject({ backend: 'local-server', engineSource: 'local-server' });

      const probed = fake.completions.length;
      const page = await extension.context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/cjk.html`);
      await commandPage(extension.worker, page, 'toggle');
      await waitTranslated(page);
      await expect(page.locator('#lead')).toHaveText('LOCAL-SERVER-PFML3');
      expect(fake.completions.length).toBeGreaterThan(probed);
      expect(fake.completions.some((entry) => entry.prompt.includes('<|plamo:tag|>dataset'))).toBe(
        true,
      );

      const after = await options.evaluate(async () => {
        const chrome = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
          }
        ).chrome;
        return chrome.runtime.sendMessage({ type: 'engine:status' });
      });
      expect(after).toMatchObject({ backend: 'local-server', engineSource: 'local-server' });
      await page.close();
      await options.close();
    } finally {
      await extension.close();
      await fake.close();
    }
  });
});
