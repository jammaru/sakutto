import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { PAGES } from './fixtures.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.gguf': 'application/octet-stream',
};

export interface BenchServer {
  origin: string;
  close: () => Promise<void>;
}

function isolated(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}

export function startBenchServer(options: {
  vendorDir: string;
  modelPath: string;
  engineHtml: string;
}): Promise<BenchServer> {
  const pages = new Map<string, string>(PAGES.map((page) => [page.path, page.html()]));
  pages.set('/engine.html', options.engineHtml);

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (pages.has(path)) {
      response.writeHead(200, isolated({ 'Content-Type': 'text/html; charset=utf-8' }));
      response.end(pages.get(path));
      return;
    }

    if (path === '/model.gguf') {
      const size = statSync(options.modelPath).size;
      response.writeHead(
        200,
        isolated({
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        }),
      );
      createReadStream(options.modelPath).pipe(response);
      return;
    }

    if (path.startsWith('/vendor/')) {
      const relative = normalize(path.slice('/vendor/'.length)).replace(/^(\.\.(\/|\\|$))+/, '');
      const file = join(options.vendorDir, relative);
      if (!file.startsWith(options.vendorDir)) {
        response.writeHead(403);
        response.end();
        return;
      }
      try {
        const size = statSync(file).size;
        const type = TYPES[extname(file)] ?? 'application/octet-stream';
        response.writeHead(200, isolated({ 'Content-Type': type, 'Content-Length': String(size) }));
        createReadStream(file).pipe(response);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('The bench server did not bind a port.'));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
