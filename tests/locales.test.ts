import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, getModel } from '@/engine/model/catalog';
import { PLAMO_OFFICIAL_LINKS } from '@/shared/plamo-license';
import { formatByteSize } from '@/ui/format';

interface MessageEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string }>;
}

function readMessages(locale: string): Record<string, MessageEntry> {
  const url = new URL(`../public/_locales/${locale}/messages.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, MessageEntry>;
}

function usedMessageKeys(): Set<string> {
  const keys = new Set<string>();
  const files = readdirSync(new URL('../src', import.meta.url), {
    recursive: true,
    encoding: 'utf8',
  });

  for (const file of files) {
    if (!/\.(ts|svelte)$/.test(file)) continue;
    const source = readFileSync(
      new URL(`../src/${file.replaceAll('\\', '/')}`, import.meta.url),
      'utf8',
    );
    for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }

  return keys;
}

function placeholderNames(entry: MessageEntry | undefined): string[] {
  return Object.keys(entry?.placeholders ?? {}).sort();
}

describe('locale messages', () => {
  const en = readMessages('en');
  const ja = readMessages('ja');

  it('defines the same non-empty keys in English and Japanese', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());

    for (const [key, entry] of Object.entries({ ...en, ...ja })) {
      expect(entry.message.trim(), key).not.toBe('');
    }
  });

  it('uses matching placeholders in both locales', () => {
    for (const key of Object.keys(en)) {
      expect(placeholderNames(ja[key]), key).toEqual(placeholderNames(en[key]));
    }
  });

  it('defines every key used by the UI', () => {
    for (const key of usedMessageKeys()) {
      expect(en, key).toHaveProperty(key);
      expect(ja, key).toHaveProperty(key);
    }
  });

  it('uses the product names from the specification', () => {
    expect(en.extensionName?.message).toBe('Sakutto');
    expect(ja.extensionName?.message).toBe('Sakutto');
    expect(en.extensionShortName?.message).toBe('Sakutto');
    expect(ja.extensionShortName?.message).toBe('Sakutto');
  });

  it('keeps the store name and description inside the manifest limits', () => {
    for (const messages of [en, ja]) {
      expect(messages.extensionName?.message.length).toBeLessThanOrEqual(75);
      expect(messages.extensionShortName?.message.length).toBeLessThanOrEqual(12);
      expect(messages.extensionDescription?.message.length).toBeLessThanOrEqual(132);
    }
    expect(en.extensionDescription?.message).not.toMatch(/\b(fast|fastest)\b/i);
    expect(en.privacyBody?.message).not.toMatch(/never leaves/i);
    expect(ja.privacyBody?.message).not.toContain('端末の外');
    expect(en.licenseModelNote?.message).not.toMatch(/on first use/i);
    expect(ja.licenseModelNote?.message).not.toContain('初回に');
  });

  /**
   * A Chrome built-in translation is only ever the page's real engine for a pair PLaMo
   * cannot translate. Copy that offers it as something a reader can get *while the model
   * loads*, or as a faster stand-in for a slow PC, describes a feature that is gone.
   */
  it('does not promise a built-in translation as a stand-in for a supported pair', () => {
    const standIn = [
      'onboardingUseNow',
      'onboardingWhileDownloading',
      'onboardingBridgeNote',
      'slowDeviceHint',
    ];
    const enStandIn =
      /before the model finishes|built-in translation stays visible|built-in translator is used while|may be faster/i;
    const jaStandIn =
      /モデルの完了を待たず|ダウンロード中も Chrome|準備中も Chrome|の方が速いことが/;

    for (const key of standIn) {
      expect(en[key]?.message, key).not.toMatch(enStandIn);
      expect(ja[key]?.message, key).not.toMatch(jaStandIn);
    }
  });

  it('describes starting as agreement to the whole license and uses the pinned model size', () => {
    expect(en.onboardingStartNotice?.message).toBe(
      "Starting means you agree to the whole PLaMo Community License. You must be 18 or older, or have a parent or guardian's consent (Article 2). This extension does not check your age or ask a guardian to confirm.",
    );
    expect(ja.onboardingStartNotice?.message).toBe(
      '開始すると、PLaMo Community License の全文に同意したものとみなされます。18歳以上であるか、保護者の同意が必要です（第2条）。この拡張機能は、年齢の確認や保護者への確認は行いません。',
    );
    expect(en).not.toHaveProperty('consentCheckbox');
    expect(ja).not.toHaveProperty('consentCheckbox');

    expect(en.onboardingStart?.message).toBe('Agree to the license and start');
    expect(ja.onboardingStart?.message).toBe('ライセンスに同意して開始');

    const label = formatByteSize(getModel(DEFAULT_MODEL_ID).size);
    expect(en.onboardingModelNote?.message).toContain(label);
    expect(ja.onboardingModelNote?.message).toContain(label);
    expect(en.onboardingHttpError?.message).toContain('HTTP');
    expect(ja.onboardingHttpError?.message).toContain('HTTP');
  });

  it('does not describe the whole agreement as Article 2', () => {
    for (const messages of [en, ja]) {
      expect(messages.onboardingStartNotice?.message).not.toMatch(
        /（第2条）に同意|Article 2\)\.?$/,
      );
      expect(messages.onboardingStartNotice?.message).not.toMatch(/License（第2条）/);
    }
    expect(en.onboardingStartNotice?.message).not.toContain('License (Article 2)');
  });

  /**
   * Article 3 of the PLaMo Community License is the only source for the commercial summary.
   * These strings have to keep the registration form, the revenue cap, and the need for a
   * separate license when the conditions stop being met.
   */
  it('summarizes the commercial conditions from Article 3', () => {
    for (const messages of [en, ja]) {
      expect(messages.onboardingCommercialPrivate?.message).toMatch(/no registration|登録が不要/);
      expect(messages.onboardingCommercialConditions?.message).toMatch(
        /official form|公式フォーム/,
      );
      expect(messages.onboardingCommercialConditions?.message).toMatch(/1 billion yen|10億円/);
      expect(messages.onboardingCommercialScope?.message).toMatch(
        /for-profit|organizational|organization|営利|組織/,
      );
      expect(messages.onboardingCommercialChange?.message).toMatch(
        /commercial license|商業用ライセンス/,
      );
      expect(messages.licensesCommercialNote?.message).toMatch(/1 billion yen|10億円/);
      // The model's license is summarized, not presented as a condition on this MIT code.
      expect(messages.onboardingCommercialScope?.message).toMatch(/PLaMo|モデル/);
    }
  });

  /**
   * The extra links must point at pages the bundled license text already names, so the notice
   * cannot drift into citing a form or page that PFN does not publish.
   */
  it('only links to pages named in the bundled license', () => {
    const bundled = ['ja', 'en']
      .map((locale) =>
        readFileSync(
          new URL(`../licenses/PLaMo-Community-License-${locale}.txt`, import.meta.url),
          'utf8',
        ),
      )
      .join('\n');

    expect(bundled).toContain(PLAMO_OFFICIAL_LINKS.registration);
    expect(bundled).toContain(PLAMO_OFFICIAL_LINKS.licenseJa);
    expect(bundled).toContain(PLAMO_OFFICIAL_LINKS.licenseEn);
  });

  it('offers the registration form next to the consent control', () => {
    for (const file of [
      '../src/entrypoints/onboarding/App.svelte',
      '../src/entrypoints/options/App.svelte',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toContain('PLAMO_OFFICIAL_LINKS');
      expect(source, file).toContain('officialLinks.registration');
    }
  });
});
