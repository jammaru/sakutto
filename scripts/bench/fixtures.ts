import { readFileSync } from 'node:fs';

const CSS = `
  body { margin: 0; font: 16px/1.5 Georgia, serif; color: #222; }
  header, footer { background: #f4f4f4; padding: 8px 16px; }
  header nav, footer nav { display: flex; gap: 12px; flex-wrap: wrap; }
  header a, footer a, aside a { color: #0645ad; }
  .layout { display: flex; align-items: flex-start; }
  article { flex: 1; max-width: 42rem; padding: 16px 24px 48px; }
  aside { width: 220px; padding: 16px; font-family: sans-serif; font-size: 14px; }
  h1 { font-size: 1.8rem; margin: 0 0 12px; }
  h2 { font-size: 1.25rem; margin: 1.4rem 0 0.4rem; }
  p { margin: 0 0 1rem; }
  pre { background: #f6f8fa; padding: 12px; overflow: auto; }
  code { font-family: ui-monospace, monospace; }
`;

const SENTENCES = [
  'The morning train leaves the quiet station while the baker opens a small shop on the corner.',
  'Children walk to school with bright bags and stop to watch the river boats.',
  'The old stone bridge carries neighbors toward the market that opens early.',
  'Bread, fruit, and flowers fill the stalls before work begins across the town.',
  'After the rain, the dusty road is clean again and the windows shine.',
  'A librarian reads the map aloud so visitors can find the hillside garden.',
  'The ferry schedule changes on windy days, and the captain posts the new times.',
  'Engineers repaired the clock tower last spring without closing the square.',
  'Local cooks simmer broth for hours and serve it with rice and pickled greens.',
  'Students copy diagrams from the museum wall and argue about the labels.',
  'The evening paper prints the weather beside a short note from the mayor.',
  'Cyclists share the narrow lane with carts that bring vegetables from the farms.',
];

function sentence(index: number, salt: number): string {
  const text = SENTENCES[(index + salt) % SENTENCES.length] ?? SENTENCES[0];
  return text ?? '';
}

export function paragraph(index: number): string {
  const parts = [0, 3, 5, 7].map((shift) => sentence(index + shift, index * 2));
  return `${parts.join(' ')} This is passage ${String(index + 1)} of the guide.`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>${CSS}</style>
  </head>
  <body>
    ${body}
  </body>
</html>
`;
}

function link(id: string, label: string): string {
  return `<a href="#${id}" data-bench="chrome" data-bench-id="${id}">${label}</a>`;
}

function prose(id: string, text: string): string {
  return `<p data-bench="prose" data-bench-id="${id}">${text}</p>`;
}

export function wikiPage(): string {
  const header = ['Sign in', 'News', 'Maps', 'Sign in', 'Weather', 'Archive', 'Sign in', 'About']
    .map((label, index) => link(`h${String(index)}`, label))
    .join('');
  const side = ['Timeline', 'Gallery', 'References', 'Sign in', 'Tools', 'Categories']
    .map((label, index) => `<li>${link(`s${String(index)}`, label)}</li>`)
    .join('');
  const blocks: string[] = [
    '<h1 data-bench="heading" data-bench-id="title">A guide to the harbor city</h1>',
  ];
  for (let index = 0; index < 16; index += 1) {
    if (index % 4 === 0) {
      blocks.push(
        `<h2 data-bench="heading" data-bench-id="h2-${String(index)}">Chapter ${String(index / 4 + 1)}</h2>`,
      );
    }
    blocks.push(prose(`p${String(index)}`, paragraph(index)));
  }
  const footer = ['Contact', 'Sign in', 'Privacy', 'Sign in']
    .map((label, index) => link(`f${String(index)}`, label))
    .join('');
  return page(
    'Harbor city guide',
    `<header><nav>${header}</nav></header>
    <div class="layout">
      <article>${blocks.join('\n')}</article>
      <aside><ul>${side}</ul></aside>
    </div>
    <footer><nav>${footer}</nav></footer>`,
  );
}

export function newsPage(): string {
  const header = ['Home', 'World', 'Business', 'Sign in', 'Science', 'Culture']
    .map((label, index) => link(`n${String(index)}`, label))
    .join('');
  const blocks = [
    '<h1 data-bench="heading" data-bench-id="title">Ferry returns to the morning route</h1>',
  ];
  for (let index = 0; index < 8; index += 1) {
    blocks.push(prose(`p${String(index)}`, paragraph(20 + index)));
  }
  return page(
    'Morning route',
    `<header><nav>${header}</nav></header><article>${blocks.join('\n')}</article>`,
  );
}

export function docsPage(): string {
  const sections: string[] = [
    '<h1 data-bench="heading" data-bench-id="title">Widget setup</h1>',
    prose('p0', paragraph(40)),
    `<pre><code data-bench="code" data-bench-id="code0">const limit = 42;\nexport function ready(value) {\n  return value &gt;= limit;\n}</code></pre>`,
    '<h2 data-bench="heading" data-bench-id="h2">Configure</h2>',
    prose('p1', paragraph(41)),
    prose('p2', paragraph(42)),
    `<pre><code data-bench="code" data-bench-id="code1">npm test -- --watch</code></pre>`,
    '<h2 data-bench="heading" data-bench-id="h3">Deploy</h2>',
    prose('p3', paragraph(43)),
    prose('p4', paragraph(44)),
    prose('p5', paragraph(45)),
  ];
  return page('Widget setup', `<article>${sections.join('\n')}</article>`);
}

export function spaPage(): string {
  const texts = Array.from({ length: 8 }, (_, index) => paragraph(50 + index));
  const payload = JSON.stringify(texts);
  return page(
    'Live notes',
    `<header><nav>${link('live', 'Sign in')}${link('notes', 'Notes')}</nav></header>
    <article>
      <h1 data-bench="heading" data-bench-id="title">Live notes</h1>
      <div id="app"></div>
    </article>
    <script>
      const texts = ${payload};
      const app = document.getElementById('app');
      for (let index = 0; index < texts.length; index += 1) {
        const node = document.createElement('p');
        node.dataset.bench = 'prose';
        node.dataset.benchId = 'p' + String(index);
        node.textContent = texts[index];
        app.append(node);
      }
      document.documentElement.dataset.benchReady = '1';
    </script>`,
  );
}

export function kyotoPage(): string {
  return readFileSync(new URL('./fixtures/kyoto.html', import.meta.url), 'utf8');
}

export const PAGES = [
  { name: 'wiki', path: '/wiki.html', html: wikiPage },
  { name: 'news', path: '/news.html', html: newsPage },
  { name: 'docs', path: '/docs.html', html: docsPage },
  { name: 'spa', path: '/spa.html', html: spaPage },
  { name: 'kyoto', path: '/kyoto.html', html: kyotoPage },
] as const;
