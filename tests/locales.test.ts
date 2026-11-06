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

  /**
   * Chrome refuses to install the whole extension when a message interpolates a `$NAME$`
   * that the entry does not declare: `Failed to load extension … Variable $LANGUAGES$ used
   * but not defined`. Nothing in the unit suite noticed, because the pages are rendered from
   * the JSON rather than by Chrome, so one missing `placeholders` block made every installed
   * build fail to load at all. Every token in the text must be declared, and every declared
   * placeholder must be used.
   */
  it('declares every placeholder its message interpolates', () => {
    for (const [locale, messages] of [
      ['en', en],
      ['ja', ja],
    ] as const) {
      for (const [key, entry] of Object.entries(messages)) {
        const used = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((match) =>
          match[1]?.toLowerCase(),
        );
        const declared = placeholderNames(entry).map((name) => name.toLowerCase());
        for (const name of used) {
          expect(declared, `${locale} ${key} uses $${name}$`).toContain(name);
        }
        for (const name of declared) {
          expect(used, `${locale} ${key} declares ${name}`).toContain(name);
        }
      }
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

  it('describes the button as an agreement and uses the pinned model size', () => {
    // The consent sentence binds to the button rather than a vague "starting means…".
    expect(en.onboardingConsentSentence?.message).toBe(
      'Pressing "Agree to the license and start" means you agree to the PLaMo Community License.',
    );
    expect(ja.onboardingConsentSentence?.message).toBe(
      '「ライセンスに同意して開始」を押すと、PLaMo Community Licenseに同意したことになります。',
    );
    expect(en.onboardingStartNotice?.message).toContain('Agree to the license and start');
    expect(ja.onboardingStartNotice?.message).toContain('ライセンスに同意して開始');
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

  /**
   * A reviewer read the age line as the extension vouching for parental consent. The line
   * states the requirement only; the build never claims to verify age or contact a guardian,
   * and it no longer says "this extension does not check your age" either, because the
   * requirement itself is what the reader needs.
   */
  it('states the age requirement without claiming to verify it', () => {
    expect(ja.onboardingAgeNotice?.message).toBe(
      '18歳未満など、単独で契約できる年齢に達していない場合は、親権者等の同意が必要です。',
    );
    for (const messages of [en, ja]) {
      const copy = messages.onboardingAgeNotice?.message ?? '';
      expect(copy).toMatch(/guardian|親権者/);
      expect(copy).not.toMatch(/does not check your age|年齢の確認や保護者への確認は行いません/);
    }
    // Nothing in the user-facing copy claims a guardian was asked or an age was checked.
    for (const entry of Object.values({ ...en, ...ja })) {
      expect(entry.message).not.toMatch(/guardian verified|保護者の同意を確認しました/);
      expect(entry.message).not.toMatch(/guardian:\s*true/);
    }
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
   * The three-part rewrite has to keep the registration form, the revenue cap, and the need
   * for a separate license when the conditions stop being met.
   */
  it('summarizes the commercial conditions from Article 3 in three parts', () => {
    for (const messages of [en, ja]) {
      expect(messages.onboardingPersonalHeading?.message).toMatch(/Personal|個人/);
      expect(messages.onboardingPersonalBody?.message).toMatch(/registration|登録/);
      expect(messages.onboardingPersonalBody?.message).toMatch(
        /no .*registration|なし|不要|not needed|needs no/i,
      );

      expect(messages.onboardingCommercialHeading2?.message).toMatch(/Work|commercial|仕事|商業/i);
      expect(messages.onboardingCommercialBody?.message).toMatch(
        /inside a company|organi[sz]ation|企業内|組織/i,
      );
      expect(messages.onboardingCommercialRegistration?.message).toMatch(/PFN/);
      expect(messages.onboardingCommercialRevenue?.message).toMatch(/1 billion|10億/);

      expect(messages.onboardingCommercialUnmetHeading?.message).toMatch(/not met|満たさない/);
      expect(messages.onboardingCommercialUnmetBody?.message).toMatch(
        /separate license|別途ライセンス|commercial license|商業用ライセンス/,
      );

      // The heading names the terms of use, not just "commercial use".
      expect(messages.onboardingCommercialHeading?.message).toMatch(/terms|利用条件/);
    }
  });

  /**
   * The terms are stated once, in the three-part panel, on both pages that show them. A
   * fourth prose summary of the same conditions was the wall of text this change removes.
   */
  it('does not repeat a fourth prose summary of the commercial terms', () => {
    expect(en).not.toHaveProperty('licensesCommercialNote');
    expect(ja).not.toHaveProperty('licensesCommercialNote');
    expect(en).not.toHaveProperty('onboardingCommercialConditions');
    expect(ja).not.toHaveProperty('onboardingCommercialConditions');
  });

  it('keeps the first screen to the official Japanese license and the registration form', () => {
    const onboarding = readFileSync(
      new URL('../src/entrypoints/onboarding/App.svelte', import.meta.url),
      'utf8',
    );
    // Featured links: the official Japanese text and PFN's form.
    expect(onboarding).toContain('officialLinks.licenseJa');
    expect(onboarding).toContain('officialLinks.registration');
    // The rest are folded into a details block so the first screen is not a wall of links.
    expect(onboarding).toContain('onboardingOtherLicenses');
    expect(onboarding).toMatch(/<details[\s\S]*officialLinks\.licenseEn[\s\S]*<\/details>/u);
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

  /**
   * The typed box is a side-by-side comparison, so its copy has to describe two panes and
   * stay in Sakutto's voice. A heading that reads the same in any translation product, or a
   * promise of extra furniture this build does not have, is the thing to catch.
   */
  it('describes the typed box as a comparison in its own words', () => {
    expect(en.typedSourceLanguageLabel?.message).toBe('Translate from');
    expect(ja.typedSourceLanguageLabel?.message).toBe('訳元の言語');
    for (const messages of [en, ja]) {
      expect(messages.typedDetectSource?.message).toBeTruthy();
      expect(messages.typedResultEmpty?.message).not.toMatch(/^The translation appears here\.$/);
    }
    // Nothing promises a document importer or a dictionary.
    for (const entry of Object.values({ ...en, ...ja })) {
      expect(entry.message).not.toMatch(/PDF|Word file|PowerPoint|辞書/iu);
    }
  });

  it('has no copy left for a try control during the download', () => {
    // The control is not rendered at all until the model is ready, so its label is gone
    // from both locales rather than sitting unused.
    expect(en).not.toHaveProperty('onboardingTryNow');
    expect(ja).not.toHaveProperty('onboardingTryNow');
  });
});
