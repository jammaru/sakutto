import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { amoMetadataProblems } from '../scripts/amo-metadata';

const metadata = JSON.parse(
  readFileSync(new URL('../amo-metadata.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

function withMeta(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...metadata, ...overrides };
}

describe('AMO v5 metadata shape', () => {
  it('matches the listed create payload web-ext posts unchanged', () => {
    expect(amoMetadataProblems(metadata)).toEqual([]);
    expect(metadata).not.toHaveProperty('license');
    expect(metadata.version).toEqual({ license: 'MIT' });
    expect(metadata.categories).toEqual({ firefox: ['privacy-security'] });
    expect(metadata.default_locale).toBe('en-US');
    for (const field of ['name', 'summary', 'description', 'homepage'] as const) {
      const value = metadata[field] as Record<string, string>;
      expect(Object.keys(value).sort()).toEqual(['en-US', 'ja']);
    }
  });

  it('rejects the fields AMO listed create would 400 on next', () => {
    expect(amoMetadataProblems(withMeta({ license: 'MIT' }))).toContain(
      'license belongs under version.license, not at the top level',
    );
    expect(amoMetadataProblems(withMeta({ categories: ['privacy-security'] }))).toContain(
      'categories must be {"firefox": ["privacy-security"]}, not a slug list',
    );
    expect(amoMetadataProblems(withMeta({ version: {} }))).toContain('version.license must be MIT');
    expect(
      amoMetadataProblems(
        withMeta({ version: { license: 'MIT', custom_license: { name: 'MIT' } } }),
      ),
    ).toContain('version cannot set both license and custom_license');
    expect(amoMetadataProblems(withMeta({ default_locale: 'en' }))).toContain(
      'default_locale must be en-US',
    );
    expect(
      amoMetadataProblems(
        withMeta({
          name: { en: 'Sakutto - Local AI translation', ja: 'Sakutto - ローカルAI翻訳' },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'name must include en-US',
        'name locale en is not an AMO locale code',
      ]),
    );
    expect(amoMetadataProblems(withMeta({ experimental: true }))).toContain(
      'experimental is not an AMO add-on field',
    );
  });
});
