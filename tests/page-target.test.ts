import { describe, expect, it } from 'vitest';
import { preferencesFor } from '@/dom/session';
import type { SiteRule } from '@/dom/sites';
import { DEFAULT_SETTINGS } from '@/shared/settings';

const host = 'news.example';

function rule(overrides: Partial<SiteRule> = {}): SiteRule {
  return { host, auto: 'ask', ...overrides };
}

describe('page target from settings and site rules', () => {
  it('uses the global target when the site has not stored a language', () => {
    const prefs = preferencesFor({ ...DEFAULT_SETTINGS, targetLanguage: 'ja' }, rule(), host);
    expect(prefs.targetLanguage).toBe('ja');
    expect(prefs.targetExplicit).toBe(true);
  });

  it('does not treat a Japanese page as a reason to switch an unset site off Japanese', () => {
    const prefs = preferencesFor({ ...DEFAULT_SETTINGS, targetLanguage: 'ja' }, rule(), host);
    expect(prefs.targetLanguage).toBe('ja');
  });

  it('uses a site language only when that site actually stored one', () => {
    const prefs = preferencesFor(
      { ...DEFAULT_SETTINGS, targetLanguage: 'ja' },
      rule({ targetLanguage: 'en' }),
      host,
    );
    expect(prefs.targetLanguage).toBe('en');
    expect(prefs.targetExplicit).toBe(true);
  });
});
