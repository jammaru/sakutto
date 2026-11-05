import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4173);

function longPage() {
  const paragraphs = Array.from({ length: 40 }, (_, index) => {
    return `<p id="p${index}">段落${index}の本文です。</p>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8" /><title>Long page</title></head>
  <body><article>${paragraphs}</article></body>
</html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/long.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(longPage());
    return;
  }

  const relative = normalize(url.pathname).replace(/^[/\\]+/, '');
  const file = join(root, relative);
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }

  try {
    const body = await readFile(file);
    const type =
      extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    response.writeHead(200, { 'content-type': type });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1');
