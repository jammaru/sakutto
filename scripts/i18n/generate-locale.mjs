/**
 * Drafts `public/_locales/<catalog>/messages.json` by running the English strings through a
 * local PLaMo 3 Translate server. See `docs/TRANSLATING.md` for why the model the extension
 * ships is the right one for this job.
 *
 *   node scripts/i18n/generate-locale.mjs ko ko
 *   node scripts/i18n/generate-locale.mjs zh_TW zh-hant
 *
 * The first argument is the catalog directory Chrome will read. The second is the target
 * language as PLaMo names it, which is not always the same string: the catalog is `zh_TW` and
 * the model calls that `zh-hant`.
 *
 * This only writes the file. Review it before committing — machine output still needs a reader
 * for tone, and `scripts/i18n/check-locales.mjs` only checks structure, not wording.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GLOSSARY, translate } from './plamo.mjs';

const [catalog, target] = process.argv.slice(2);
if (!catalog || !target) {
  console.error('usage: node scripts/i18n/generate-locale.mjs <catalog> <plamo-language>');
  process.exit(1);
}

const BASE_DIR = new URL('../../public/_locales/', import.meta.url);
const source = JSON.parse(readFileSync(new URL('en/messages.json', BASE_DIR), 'utf8'));

const out = {};
const keys = Object.keys(source);
let index = 0;

for (const key of keys) {
  const entry = source[key];
  const message = await translate({
    text: entry.message,
    tgt: target,
    src: 'en',
    glossary: GLOSSARY,
  });

  index += 1;
  process.stdout.write(`\r${catalog} ${String(index)}/${String(keys.length)}`);

  const next = { message };
  if (entry.description) next.description = entry.description;
  if (entry.placeholders) next.placeholders = entry.placeholders;
  out[key] = next;
}
process.stdout.write('\n');

writeFileSync(
  new URL(`${catalog}/messages.json`, BASE_DIR),
  `${JSON.stringify(out, null, 2)}\n`,
  'utf8',
);
console.log(`wrote public/_locales/${catalog}/messages.json`);
console.log('Review the wording before committing. Run: pnpm run i18n:check');
