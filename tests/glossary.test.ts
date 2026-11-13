import { describe, expect, it } from 'vitest';
import {
  MAX_GLOSSARY_ENTRIES,
  MAX_GLOSSARY_TEXT,
  glossaryEquals,
  mergeGlossary,
  normalizeGlossary,
  parseGlossary,
  serializeGlossary,
} from '@/shared/glossary';

function numberedEntries(count: number, prefix = 'term'): { source: string; target: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    source: `${prefix}-${String(index)}`,
    target: `訳-${String(index)}`,
  }));
}

describe('glossary csv', () => {
  it('round-trips quoted commas and ignores the header', () => {
    const csv = 'source,target\n"Sign, in","ログイン"\nCancel,キャンセル\n';
    const entries = parseGlossary(csv);

    expect(entries).toEqual([
      { source: 'Sign, in', target: 'ログイン' },
      { source: 'Cancel', target: 'キャンセル' },
    ]);
    expect(parseGlossary(serializeGlossary(entries))).toEqual(entries);
  });

  it('treats two glossaries with the same pairs as equal', () => {
    const left = [
      { source: 'Sign in', target: 'ログイン' },
      { source: 'Save', target: '保存' },
    ];
    expect(glossaryEquals(left, [...left])).toBe(true);
    expect(glossaryEquals(left, [{ source: 'Sign in', target: 'ログイン' }])).toBe(false);
    expect(glossaryEquals(undefined, [])).toBe(true);
  });

  it('lets a site entry replace the global source', () => {
    expect(
      mergeGlossary(
        [
          { source: 'Sign in', target: 'ログイン' },
          { source: 'Save', target: '保存' },
        ],
        [{ source: 'Sign in', target: 'サインイン' }],
      ),
    ).toEqual([
      { source: 'Sign in', target: 'サインイン' },
      { source: 'Save', target: '保存' },
    ]);
  });

  it('keeps a glossary large enough to feel unlimited and drops only the next row', () => {
    const kept = numberedEntries(MAX_GLOSSARY_ENTRIES);
    const extra = { source: 'overflow', target: 'あふれ' };
    const csv = serializeGlossary([...kept, extra]);

    expect(parseGlossary(csv)).toEqual(kept);
    expect(normalizeGlossary([...kept, extra])).toEqual(kept);
    expect(normalizeGlossary(kept)).toHaveLength(MAX_GLOSSARY_ENTRIES);
  });

  it('does not drop a previously stored 1000-entry glossary', () => {
    const stored = numberedEntries(1000);
    expect(normalizeGlossary(stored)).toEqual(stored);
    expect(parseGlossary(serializeGlossary(stored))).toEqual(stored);
  });

  it('keeps a merged global and site list that is larger than one stored glossary', () => {
    const global = numberedEntries(MAX_GLOSSARY_ENTRIES, 'g');
    const site = numberedEntries(MAX_GLOSSARY_ENTRIES, 's');
    const merged = mergeGlossary(global, site);
    expect(merged).toHaveLength(MAX_GLOSSARY_ENTRIES * 2);
    expect(merged[0]).toEqual({ source: 'g-0', target: '訳-0' });
    expect(merged[MAX_GLOSSARY_ENTRIES]).toEqual({ source: 's-0', target: '訳-0' });
  });

  it('skips rows whose source or target is longer than the per-cell bound', () => {
    const tooLong = 'x'.repeat(MAX_GLOSSARY_TEXT + 1);
    expect(
      parseGlossary(`source,target\n${tooLong},ok\nSign in,ログイン\nok,${tooLong}\n`),
    ).toEqual([{ source: 'Sign in', target: 'ログイン' }]);
    expect(
      normalizeGlossary([
        { source: tooLong, target: 'ok' },
        { source: 'Sign in', target: 'ログイン' },
      ]),
    ).toEqual([{ source: 'Sign in', target: 'ログイン' }]);
  });
});
