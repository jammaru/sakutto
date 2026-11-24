import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the pinned Japanese font used by PDF export into `public/vendor/fonts/`.
 *
 * The font is SIL Open Font License 1.1 and its text is packaged through
 * `scripts/sync-licenses.mjs`. Nothing is fetched here: the bytes come from the checked-in
 * `vendor/fonts/` copy, so a build (and the export itself) needs no network access.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor', 'fonts', 'MPLUS1p-Regular.ttf');
const targetDirectory = join(root, 'public', 'vendor', 'fonts');
const target = join(targetDirectory, 'MPLUS1p-Regular.ttf');

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);

const bytes = await readFile(source);
const info = await stat(source);
await writeFile(
  join(targetDirectory, 'font-build.json'),
  `${JSON.stringify(
    {
      source: 'google/fonts@main ofl/mplus1p/MPLUS1p-Regular.ttf',
      license: 'SIL Open Font License 1.1',
      bytes: info.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    null,
    2,
  )}\n`,
);

console.log(`export font: ${String(info.size)} bytes`);
