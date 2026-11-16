import type { GlossaryEntry } from '@/engine/types';
import { isRecord } from './object';

/**
 * Ceiling for one stored glossary (settings, or one site rule) and for CSV import.
 *
 * 5000 is large enough to feel unlimited in ordinary use. It is not a product-plan
 * quota: chrome.storage.local already has `unlimitedStorage`, and the translation
 * prompt only includes terms that appear in the current segment. The number exists
 * so a huge CSV cannot freeze the options page or grow the settings JSON without
 * bound. Existing glossaries below this ceiling keep every row.
 */
export const MAX_GLOSSARY_ENTRIES = 5000;

/**
 * Offscreen translate messages may carry a merged global+site glossary, so the
 * protocol bound is two stored lists. Prompt packing still filters to terms that
 * appear in the segment; this bound only rejects oversized messages.
 */
export const MAX_GLOSSARY_MESSAGE_ENTRIES = MAX_GLOSSARY_ENTRIES * 2;

export const MAX_GLOSSARY_TEXT = 4096;

export function normalizeGlossary(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: GlossaryEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.source !== 'string' || typeof entry.target !== 'string') continue;
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (
      !source ||
      !target ||
      source.length > MAX_GLOSSARY_TEXT ||
      target.length > MAX_GLOSSARY_TEXT
    ) {
      continue;
    }
    entries.push({ source, target });
    if (entries.length >= MAX_GLOSSARY_ENTRIES) break;
  }
  return entries;
}

/** Site entries win when the source text is the same. */
export function mergeGlossary(
  globalEntries: readonly GlossaryEntry[],
  siteEntries: readonly GlossaryEntry[] | undefined,
): GlossaryEntry[] {
  const merged = new Map<string, string>();
  for (const entry of globalEntries) merged.set(entry.source, entry.target);
  for (const entry of siteEntries ?? []) merged.set(entry.source, entry.target);
  return [...merged].map(([source, target]) => ({ source, target }));
}

export function parseGlossary(csv: string): GlossaryEntry[] {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ''));
  const entries: GlossaryEntry[] = [];

  for (const row of rows) {
    const source = row[0]?.trim() ?? '';
    const target = row[1]?.trim() ?? '';
    if (!source || !target) continue;
    if (
      entries.length === 0 &&
      source.toLowerCase() === 'source' &&
      target.toLowerCase() === 'target'
    ) {
      continue;
    }
    if (source.length > MAX_GLOSSARY_TEXT || target.length > MAX_GLOSSARY_TEXT) continue;
    entries.push({ source, target });
    if (entries.length >= MAX_GLOSSARY_ENTRIES) break;
  }

  return entries;
}

/** A stable fingerprint of glossary contents, so two equal lists compare as equal. */
export function glossaryKey(glossary: readonly GlossaryEntry[] | undefined): string {
  return (glossary ?? []).map((entry) => `${entry.source}\u0000${entry.target}`).join('\u0001');
}

/** True when two glossaries contain the same pairs in the same order. */
export function glossaryEquals(
  left: readonly GlossaryEntry[] | undefined,
  right: readonly GlossaryEntry[] | undefined,
): boolean {
  return glossaryKey(left) === glossaryKey(right);
}

export function serializeGlossary(entries: readonly GlossaryEntry[]): string {
  const lines = ['source,target'];
  for (const entry of entries) lines.push(`${csvCell(entry.source)},${csvCell(entry.target)}`);
  return lines.join('\n');
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char ?? '';
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cell += char ?? '';
  }

  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);
  return rows;
}
