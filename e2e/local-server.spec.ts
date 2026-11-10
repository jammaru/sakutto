import { createServer, type IncomingMessage, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { loadExtension } from './extension';

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startFakeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      await readBody(request);
      if ((request.url ?? '').includes('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'pfnet/plamo-3-translate-0.8b-MLX-4bit' }] }));
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
});
