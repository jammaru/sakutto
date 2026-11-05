import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(root, 'public', 'licenses');

await mkdir(outputDirectory, { recursive: true });

for (const name of ['LICENSE', 'NOTICE']) {
  await copyFile(join(root, name), join(outputDirectory, `${name}.txt`));
}

for (const name of [
  'llama.cpp-LICENSE.txt',
  'wllama-LICENSE.txt',
  'emscripten-LICENSE.txt',
  'dawn-LICENSE.txt',
  'PLaMo-Community-License-en.txt',
  'PLaMo-Community-License-ja.txt',
  'svelte-LICENSE.txt',
]) {
  await copyFile(join(root, 'licenses', name), join(outputDirectory, name));
}
