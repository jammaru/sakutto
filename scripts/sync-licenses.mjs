import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(root, 'public', 'licenses');

await mkdir(outputDirectory, { recursive: true });

/**
 * Files copied from `licenses/` into the packaged extension, minus `LICENSE` and `NOTICE`.
 * Kept in step with `LICENSE_FILE_COPIES` in `scripts/license-copies.ts`, which the tests
 * import; this script stays plain JavaScript so a build never needs a type-stripping step.
 */
const LICENSE_FILE_COPIES = [
  'llama.cpp-LICENSE.txt',
  'wllama-LICENSE.txt',
  'emscripten-LICENSE.txt',
  'dawn-LICENSE.txt',
  'PLaMo-Community-License-en.txt',
  'PLaMo-Community-License-ja.txt',
  'svelte-LICENSE.txt',
];

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Every packaged text gets a UTF-8 BOM. Chrome serves a packaged `.txt` as `text/plain`
 * with no charset, decodes it as windows-1252, and the Japanese license then reads as
 * mojibake. The BOM is the in-band charset declaration for plain text and the decoder
 * strips it, so the wording is unchanged.
 */
function withUtf8Bom(contents) {
  if (contents.subarray(0, 3).equals(UTF8_BOM)) return contents;
  return Buffer.concat([UTF8_BOM, contents]);
}

async function copyWithBom(source, target) {
  await writeFile(target, withUtf8Bom(await readFile(source)));
}

for (const name of ['LICENSE', 'NOTICE']) {
  await copyWithBom(join(root, name), join(outputDirectory, `${name}.txt`));
}

for (const name of LICENSE_FILE_COPIES) {
  await copyWithBom(join(root, 'licenses', name), join(outputDirectory, name));
}
