import { describe, expect, it } from 'vitest';
import {
  assessTranslation,
  parsePlaceholders,
  serializePlaceholders,
  stripPlaceholderTokens,
  visibleTranslation,
} from '@/dom/placeholders';

const allowed = new Set(['i1', 'i2']);

describe('placeholder markup', () => {
  it('round-trips nested inline tags', () => {
    const source = 'See <i1>the <i2>docs</i2></i1> today';
    const parsed = parsePlaceholders(source, allowed);

    expect(parsed).not.toBeNull();
    expect(serializePlaceholders(parsed ?? [])).toBe(source);
    expect(visibleTranslation(source)).toBe('See the docs today');
  });

  it('keeps literal angle brackets that are not placeholders', () => {
    const parsed = parsePlaceholders('a < b and <i1>link</i1>', allowed);

    expect(parsed).toEqual([
      { type: 'text', value: 'a < b and ' },
      { type: 'tag', id: 'i1', children: [{ type: 'text', value: 'link' }] },
    ]);
  });

  it('rejects an unbalanced or mismatched tree', () => {
    expect(parsePlaceholders('<i1>open', allowed)).toBeNull();
    expect(parsePlaceholders('<i1>one</i2>', allowed)).toBeNull();
    expect(parsePlaceholders('</i1>', allowed)).toBeNull();
  });

  it('decodes entities inside text runs', () => {
    expect(parsePlaceholders('Tom &amp; Jerry', allowed)).toEqual([
      { type: 'text', value: 'Tom & Jerry' },
    ]);
  });

  it('accepts each allowed tag once and rejects a broken token', () => {
    expect(assessTranslation('<i2>b</i2> and <i1>a</i1>', allowed).ok).toBe(true);
    expect(assessTranslation('<i1>a</i1><i1>b</i1>', allowed).ok).toBe(false);
    expect(assessTranslation('<i1>only</i1>', allowed).ok).toBe(false);

    const broken = assessTranslation('Osaka <i1 city', allowed);
    expect(broken.ok).toBe(false);
    expect(broken.plain).toBe('Osaka city');
    expect(broken.plain).not.toContain('<i');
  });

  it('strips truncated placeholders without eating a comparison', () => {
    expect(stripPlaceholderTokens('a < b and <i1')).toBe('a < b and ');
    expect(visibleTranslation('Keep <i1>link</i1> and <i2')).toBe('Keep link and ');
  });
});
