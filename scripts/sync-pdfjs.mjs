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
 * Files the reader loads directly. The minified builds are used, and the source maps are
 * skipped: a map is not loaded at runtime and the release package refuses them.
 */
const FILES = ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs'];

/** Licence texts that travel with the library. */
const LICENSES = [
  ['LICENSE', 'LICENSE-pdfjs.txt'],
  ['cmaps/LICENSE', 'LICENSE-cmaps.txt'],
  ['standard_fonts/LICENSE_FOXIT', 'LICENSE-foxit.txt'],
  ['standard_fonts/LICENSE_LIBERATION', 'LICENSE-liberation.txt'],
];

/** Directories copied whole. CMaps are what a PDF with a CJK font declares. */
const DIRECTORIES = ['cmaps', 'standard_fonts'];

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

for (const file of FILES) {
  const to = join(target, file);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(join(source, file), to);
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
  `${JSON.stringify({ version, source: `pdfjs-dist@${version}`, files }, null, 2)}\n`,
);

console.log(
  `pdfjs ${version}: ${String(copied.length)} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB`,
);
