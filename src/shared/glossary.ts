import type { GlossaryEntry } from '@/engine/types';
import { isRecord } from './object';

const MAX_ENTRIES = 1000;
const MAX_TEXT = 4096;

export function normalizeGlossary(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: GlossaryEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.source !== 'string' || typeof entry.target !== 'string') continue;
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (!source || !target || source.length > MAX_TEXT || target.length > MAX_TEXT) continue;
    entries.push({ source, target });
    if (entries.length >= MAX_ENTRIES) break;
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
    entries.push({ source, target });
    if (entries.length >= MAX_ENTRIES) break;
  }

  return entries;
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
