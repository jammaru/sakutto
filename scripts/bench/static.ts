import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ROOT } from './host.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface StaticServer {
  origin: string;
  close: () => Promise<void>;
}

/**
 * A plain index makes `pnpm bench:serve` usable by hand: every fixture is one click away
 * instead of a URL the reader has to construct. The bench run never requests it.
 */
function indexHtml(root: string): string {
  let files: string[];
  try {
    files = readdirSync(root)
      .filter((name) => name.endsWith('.html'))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    files = [];
  }
  const items = files.map((name) => `        <li><a href="/${name}">${name}</a></li>`).join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sakutto page bench fixtures</title>
    <style>
      body {
        margin: 0;
        padding: 48px 32px;
        background: #fbfaf7;
        color: #1b1b1f;
        font: 16px/1.6 -apple-system, 'Segoe UI', Roboto, sans-serif;
      }
      main {
        max-width: 44rem;
        margin: 0 auto;
      }
      h1 {
        font-size: 1.5rem;
        margin: 0 0 6px;
      }
      p {
        color: #57534c;
        margin: 0 0 22px;
      }
      li {
        margin: 0 0 6px;
      }
      code {
        background: #efece5;
        border-radius: 4px;
        padding: 1px 5px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Page bench fixtures</h1>
      <p>
        Translate one of these with Sakutto, then run <code>pnpm bench:live</code> to keep the
        numbers.
      </p>
      <ul>
${items}
      </ul>
    </main>
  </body>
</html>
`;
}

/**
 * Cross-origin isolation for the fixture documents. The live bench runs the same
 * headers as `server.ts` so the page side of a translation is measured under the
 * conditions the extension expects.
 */
const ISOLATED: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/**
 * Serves one directory of static files. The bench pages are self-contained HTML with no
 * external requests, so this is all they need, and the same server backs `pnpm bench:serve`
 * for opening the pages by hand.
 */
export function startStaticServer(options: {
  directory: string;
  port?: number;
}): Promise<StaticServer> {
  const root = resolve(options.directory);

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');

    if (relative === '' || relative === 'index.html') {
      const body = indexHtml(root);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body)),
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }

    const file = join(root, relative);
    if (!file.startsWith(root)) {
      response.writeHead(403, { 'Content-Type': 'text/plain' });
      response.end('forbidden');
      return;
    }

    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }

    response.writeHead(200, {
      ...ISOLATED,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': String(size),
    });
    createReadStream(file).pipe(response);
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('The static server did not bind a port.'));
        return;
      }
      resolveServer({
        origin: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const dirArg = args.indexOf('--dir');
  const port = portArg === -1 ? 4180 : Number(args[portArg + 1] ?? '4180');
  const directory = dirArg === -1 ? join(ROOT, 'bench', 'pages') : resolve(args[dirArg + 1] ?? '.');

  void startStaticServer({ directory, port }).then((server) => {
    console.log(`Serving ${directory} at ${server.origin}/`);
    console.log('Open one of the pages listed in bench/README.md in Chrome.');
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main();
}

export const PAGES_DIR = fileURLToPath(new URL('../../bench/pages/', import.meta.url));
