import { describe, expect, it } from 'vitest';
import { grantOriginsFor, isSiteHost, siteAccessOrigins } from '@/dom/sites';

describe('site access origins', () => {
  it('asks for both schemes on the open host', () => {
    expect(siteAccessOrigins('https://example.com/wiki/A')).toEqual([
      'https://example.com/*',
      'http://example.com/*',
    ]);
  });

  it('rejects hosts that could widen a permission', () => {
    expect(isSiteHost('..')).toBe(false);
    expect(isSiteHost('.example.com')).toBe(false);
    expect(isSiteHost('example.com.')).toBe(false);
    expect(isSiteHost('*')).toBe(false);
    expect(isSiteHost('example.com/path')).toBe(false);
    expect(isSiteHost('localhost')).toBe(true);
    expect(isSiteHost('xn--fsq.xn--0zwm56d')).toBe(true);
  });

  it('ignores a grant for a different tab', () => {
    expect(grantOriginsFor('https://other.test/a', 'example.com')).toBeNull();
    expect(grantOriginsFor(undefined, 'example.com')).toBeNull();
    expect(grantOriginsFor('https://example.com/a', 'example.com')).toEqual([
      'https://example.com/*',
      'http://example.com/*',
    ]);
  });
});
