import { describe, expect, it } from 'vitest';
import { mergeGlossary, parseGlossary, serializeGlossary } from '@/shared/glossary';

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
});
