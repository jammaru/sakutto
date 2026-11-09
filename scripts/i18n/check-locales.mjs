/**
 * A fast structural check for every catalog, for the loop while you are translating.
 *
 *   node scripts/i18n/check-locales.mjs
 *
 * `pnpm test` runs the same checks and more (brand names, licence facts, placeholders declared
 * and used). This exists because the unit suite boots Vitest, and iterating on one message is
 * easier with a script that finishes immediately.
 */
import { readFileSync, readdirSync } from 'node:fs';

const BASE_DIR = new URL('../../public/_locales/', import.meta.url);

function read(locale) {
  return JSON.parse(readFileSync(new URL(`${locale}/messages.json`, BASE_DIR), 'utf8'));
}

function tokens(message) {
  return [...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)]
    .map((match) => match[1].toLowerCase())
    .sort();
}

const en = read('en');
const enKeys = Object.keys(en).sort();
const catalogs = readdirSync(BASE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let failed = false;

for (const locale of catalogs) {
  let messages;
  try {
    messages = read(locale);
  } catch (error) {
    console.log(`${locale}: cannot parse messages.json — ${error.message}`);
    failed = true;
    continue;
  }

  const keys = Object.keys(messages).sort();
  const missing = enKeys.filter((key) => messages[key] === undefined);
  const extra = keys.filter((key) => en[key] === undefined);
  const empty = keys.filter((key) => (messages[key]?.message ?? '').trim().length === 0);
  const tokenDiffs = enKeys.filter(
    (key) =>
      messages[key] !== undefined &&
      JSON.stringify(tokens(en[key].message)) !== JSON.stringify(tokens(messages[key].message)),
  );
  const undeclared = keys.filter((key) => {
    const declared = Object.keys(messages[key]?.placeholders ?? {}).map((name) =>
      name.toLowerCase(),
    );
    return tokens(messages[key]?.message ?? '').some((name) => !declared.includes(name));
  });

  const problems = [];
  if (missing.length > 0)
    problems.push(`missing ${String(missing.length)}: ${missing.slice(0, 8).join(', ')}`);
  if (extra.length > 0) problems.push(`extra: ${extra.join(', ')}`);
  if (empty.length > 0) problems.push(`empty: ${empty.join(', ')}`);
  if (tokenDiffs.length > 0) problems.push(`token diff: ${tokenDiffs.slice(0, 8).join(', ')}`);
  if (undeclared.length > 0)
    problems.push(`undeclared token: ${undeclared.slice(0, 8).join(', ')}`);

  if (problems.length > 0) {
    failed = true;
    console.log(`${locale}: ${problems.join(' | ')}`);
  } else {
    console.log(`${locale}: ok (${String(keys.length)} keys)`);
  }
}

process.exitCode = failed ? 1 : 0;
