/**
 * Copies the pinned pdf.js build into `public/vendor/pdfjs/`, where WXT packages it.
 *
 * The reader loads pdf.js from a packaged file rather than through a bundler, for the same
 * reason the wllama runtime is loaded that way: the library starts a worker and resolves its
 * CMaps and standard fonts relative to itself, and a bundled copy loses that base. Everything
 * it needs is copied here, so opening a PDF makes no network request — no CDN copy of the
 * worker, no CMaps for a PDF that declares a CJK font, and no substitute fetched for a
 * standard font the document leaves undeclared.
 *
 *   node scripts/sync-pdfjs.mjs
 *
 * Writes `pdfjs-build.json` beside the files with a SHA-256 for each, so the packaged library
 * can be checked against what npm gave us, the way `pnpm verify:wllama` checks the wasm.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'pdfjs-dist');
const target = join(root, 'public', 'vendor', 'pdfjs');

/**
 * Files the reader loads directly. The minified *legacy* builds are used: pdf.js 6's modern
 * build targets Chrome 125, while the packaged manifest still supports 116. The destination
 * path stays `build/` so the reader's URLs do not change. Source maps are skipped: a map is
 * not loaded at runtime and the release package refuses them.
 */
const FILES = [
  ['legacy/build/pdf.min.mjs', 'build/pdf.min.mjs'],
  ['legacy/build/pdf.worker.min.mjs', 'build/pdf.worker.min.mjs'],
];

/**
 * Shims for APIs newer than the manifest's Chrome 116 floor that pdf.js 6's legacy build no
 * longer includes. They live in a separate module loaded by the entry points below, so the
 * upstream files keep npm's exact bytes and their hashes stay verifiable.
 */
const COMPAT = `// pdf.js 6's legacy build targets Chrome 125. The extension still supports Chrome 116,
// and these two APIs arrived later. Keep the shims small and idempotent.
if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value() {
      let resolve;
      let reject;
      const promise = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      return { promise, resolve, reject };
    },
  });
}

if (typeof URL.parse !== 'function') {
  Object.defineProperty(URL, 'parse', {
    configurable: true,
    writable: true,
    value(url, base) {
      try {
        return base === undefined ? new URL(url) : new URL(url, base);
      } catch {
        return null;
      }
    },
  });
}
`;

/**
 * The modules the reader actually imports. The library entry re-exports pdf.js unchanged; the
 * worker entry evaluates the shims before pdf.worker installs its message listener.
 */
const ENTRIES = [
  ['build/pdfjs-compat.mjs', COMPAT],
  ['build/pdf.entry.mjs', "import './pdfjs-compat.mjs';\nexport * from './pdf.min.mjs';\n"],
  ['build/pdf.worker.entry.mjs', "import './pdfjs-compat.mjs';\nimport './pdf.worker.min.mjs';\n"],
];

/** Licence texts that travel with the library. */
const LICENSES = [
  ['LICENSE', 'LICENSE-pdfjs.txt'],
  ['cmaps/LICENSE', 'LICENSE-cmaps.txt'],
  ['standard_fonts/LICENSE_FOXIT', 'LICENSE-foxit.txt'],
  ['standard_fonts/LICENSE_LIBERATION', 'LICENSE-liberation.txt'],
  ['wasm/LICENSE_JBIG2', 'LICENSE-jbig2.txt'],
  ['wasm/LICENSE_OPENJPEG', 'LICENSE-openjpeg.txt'],
  ['wasm/LICENSE_PDFJS_JBIG2', 'LICENSE-pdfjs-jbig2.txt'],
  ['wasm/LICENSE_PDFJS_OPENJPEG', 'LICENSE-pdfjs-openjpeg.txt'],
  ['wasm/LICENSE_PDFJS_QCMS', 'LICENSE-pdfjs-qcms.txt'],
  ['wasm/LICENSE_PDFJS_QUICKJS', 'LICENSE-pdfjs-quickjs.txt'],
  ['wasm/LICENSE_QCMS', 'LICENSE-qcms.txt'],
  ['wasm/LICENSE_QUICKJS', 'LICENSE-quickjs.txt'],
  ['iccs/LICENSE', 'LICENSE-iccs.txt'],
];

/** Directories copied whole: CMaps, standard fonts, wasm decoders, and the CMYK ICC profile. */
const DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

async function hash(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function walk(directory, base = directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path, base)));
      continue;
    }
    if (entry.name.startsWith('LICENSE')) continue;
    found.push(relative(base, path).replaceAll('\\', '/'));
  }
  return found;
}

const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version;

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const copied = [];

for (const [from, file] of FILES) {
  const to = join(target, file);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(join(source, from), to);
  copied.push(file);
}

for (const [file, content] of ENTRIES) {
  const to = join(target, file);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, content);
  copied.push(file);
}

for (const [from, to] of LICENSES) {
  const destination = join(target, to);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(source, from), destination);
  copied.push(to);
}

for (const directory of DIRECTORIES) {
  for (const file of await walk(join(source, directory))) {
    const to = join(target, directory, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(source, directory, file), to);
    copied.push(`${directory}/${file}`);
  }
}

const files = {};
let bytes = 0;
for (const file of copied.sort()) {
  const path = join(target, file);
  const size = (await stat(path)).size;
  bytes += size;
  files[file] = { bytes: size, sha256: await hash(path) };
}

await writeFile(
  join(target, 'pdfjs-build.json'),
  `${JSON.stringify({ version, source: `pdfjs-dist@${version}/legacy`, files }, null, 2)}\n`,
);

console.log(
  `pdfjs ${version}: ${String(copied.length)} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB`,
);
