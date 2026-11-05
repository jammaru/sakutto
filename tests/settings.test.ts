import { describe, expect, it } from 'vitest';
import { displayLanguage, resolveTargetLanguage } from '@/shared/languages';
import {
  DEFAULT_SETTINGS,
  PLAMO_LICENSE_VERSION,
  SETTINGS_SCHEMA_VERSION,
  createDefaultSettings,
  normalizeSettings,
  type Settings,
} from '@/shared/settings';

function stored(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    targetLanguage: 'en',
    form: 'polite',
    display: 'replace',
    consent: null,
    highQualityDismissed: false,
    glossary: [],
    idleMinutes: 5,
    tier: 'auto',
    pace: 'quality',
    ...overrides,
  };
}

describe('settings defaults', () => {
  it('uses the UI language with polite form and replacement display', () => {
    expect(createDefaultSettings('fr-FR')).toEqual(stored({ targetLanguage: 'fr' }));
    expect(DEFAULT_SETTINGS.targetLanguage).toBe('en');
  });

  it('falls back to English when the UI language is not supported', () => {
    expect(createDefaultSettings('cs-CZ').targetLanguage).toBe('en');
    expect(createDefaultSettings('pt-BR').targetLanguage).toBe('en');
    expect(createDefaultSettings('').targetLanguage).toBe('en');
    expect(resolveTargetLanguage('not-a-language')).toBe('en');
  });

  it('maps Chinese UI languages to the supported scripts', () => {
    expect(resolveTargetLanguage('zh-CN')).toBe('zh-hans');
    expect(resolveTargetLanguage('zh-TW')).toBe('zh-hant');
    expect(resolveTargetLanguage('zh-HK')).toBe('zh-hant');
    expect(resolveTargetLanguage('zh-Hant-HK')).toBe('zh-hant');
  });

  it('falls back to the raw tag when a page language cannot be displayed', () => {
    expect(displayLanguage('en', 'ja')).toBe('英語');
    expect(displayLanguage('not-a-language', 'en')).toBe('not-a-language');
    expect(displayLanguage('', 'en')).toBe('');
  });

  it('keeps valid stored values and repairs invalid ones', () => {
    expect(
      normalizeSettings(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          targetLanguage: 'ko',
          form: 'plain',
          display: 'bilingual',
        },
        'en-US',
      ),
    ).toEqual(
      stored({
        targetLanguage: 'ko',
        form: 'plain',
        display: 'bilingual',
      }),
    );

    expect(
      normalizeSettings(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          targetLanguage: 'xx',
          form: 'verbose',
          display: 'side-by-side',
        },
        'en-US',
      ),
    ).toEqual(stored());
  });

  it('ignores stored values written by another schema version', () => {
    expect(
      normalizeSettings(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION + 1,
          targetLanguage: 'ko',
          form: 'plain',
          display: 'bilingual',
        },
        'ja-JP',
      ),
    ).toEqual(createDefaultSettings('ja-JP'));

    expect(normalizeSettings({ targetLanguage: 'ko' }, 'ja-JP').targetLanguage).toBe('ja');
  });

  it('drops consent that does not name the bundled license text', () => {
    expect(
      normalizeSettings(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          consent: {
            license: 'plamo-community',
            acceptedAt: '2026-11-05T00:00:00.000Z',
            guardian: true,
          },
        },
        'ja',
      ).consent,
    ).toBeNull();
  });

  it('keeps a Chrome-only target and a recorded license consent', () => {
    const acceptedAt = '2026-11-05T00:00:00.000Z';
    expect(
      normalizeSettings(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          targetLanguage: 'pt',
          consent: {
            license: 'plamo-community',
            version: PLAMO_LICENSE_VERSION,
            acceptedAt,
            guardian: true,
          },
          glossary: [{ source: 'Sign in', target: 'ログイン' }],
          idleMinutes: 0,
          tier: 'c4',
          highQualityDismissed: true,
        },
        'en-US',
      ),
    ).toEqual(
      stored({
        targetLanguage: 'pt',
        consent: {
          license: 'plamo-community',
          version: PLAMO_LICENSE_VERSION,
          acceptedAt,
          guardian: true,
        },
        glossary: [{ source: 'Sign in', target: 'ログイン' }],
        idleMinutes: 0,
        tier: 'c4',
        highQualityDismissed: true,
      }),
    );
  });
});
