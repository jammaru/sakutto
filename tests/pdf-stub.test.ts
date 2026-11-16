import { describe, expect, it } from 'vitest';
import { isNotation, stubExpand } from '@/pdf/stub';

describe('stubExpand', () => {
  it('copies notation through and expands prose', () => {
    expect(isNotation('0.5')).toBe(true);
    expect(isNotation('<i0>')).toBe(true);
    expect(stubExpand('0.5')).toBe('0.5');
    expect(stubExpand('<i0>')).toBe('<i0>');
    const expanded = stubExpand('The collector walks the document rather than selecting tags.');
    expect(expanded.length).toBeGreaterThan(8);
    expect(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(expanded)).toBe(true);
  });

  it('keeps placeholders in place so an inline formula can be restored', () => {
    const expanded = stubExpand('with query <i0> and key <i1>');
    expect(expanded).toContain('<i0>');
    expect(expanded).toContain('<i1>');
  });
});
