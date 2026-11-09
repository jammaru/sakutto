import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, getModel } from '@/engine/model/catalog';
import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@/shared/locales';
import { PLAMO_OFFICIAL_LINKS, PROJECT_LINKS } from '@/shared/plamo-license';
import { formatByteSize } from '@/ui/format';

interface MessageEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string }>;
}

type Messages = Record<string, MessageEntry>;

function readMessages(locale: string): Messages {
  const url = new URL(`../public/_locales/${locale}/messages.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Messages;
}

/**
 * Every catalog Chrome will be handed. Read from the directory rather than from a list, so a
 * new `public/_locales/<lang>` shows up here whether or not anyone remembered to register it.
 */
function catalogNames(): string[] {
  return readdirSync(new URL('../public/_locales', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

function messageTokens(message: string): string[] {
  return [...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)]
    .map((match) => match[1]?.toLowerCase())
    .filter((name): name is string => name !== undefined);
}

const catalogs = catalogNames();
const en = readMessages(DEFAULT_UI_LOCALE);

describe('locale catalogs', () => {
  it('registers every catalog directory in UI_LOCALES, and no others', () => {
    expect(catalogs).toEqual([...UI_LOCALES].sort());
  });

  it.each(catalogs)('%s defines the same non-empty keys as English', (locale) => {
    const messages = readMessages(locale);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());

    for (const [key, entry] of Object.entries(messages)) {
      expect(entry.message.trim(), `${locale} ${key}`).not.toBe('');
    }
  });

  it.each(catalogs)('%s uses the same placeholders as English', (locale) => {
    const messages = readMessages(locale);
    for (const key of Object.keys(en)) {
      expect(placeholderNames(messages[key]), `${locale} ${key}`).toEqual(
        placeholderNames(en[key]),
      );
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
  it.each(catalogs)('%s declares every placeholder its message interpolates', (locale) => {
    const messages = readMessages(locale);
    for (const [key, entry] of Object.entries(messages)) {
      const used = messageTokens(entry.message);
      const declared = placeholderNames(entry).map((name) => name.toLowerCase());
      for (const name of used) {
        expect(declared, `${locale} ${key} uses $${name}$`).toContain(name);
      }
      for (const name of declared) {
        expect(used, `${locale} ${key} declares ${name}`).toContain(name);
      }
    }
  });

  /**
   * A catalog that copies a `$TOKEN$` from English into the text by hand, without the
   * `placeholders` block, is caught above. This catches the other half: an English sentence
   * that kept a token the translation dropped, which would show a raw `$COUNT$` to the reader.
   */
  it.each(catalogs)('%s keeps the placeholder tokens English uses', (locale) => {
    const messages = readMessages(locale);
    for (const key of Object.keys(en)) {
      const expected = [...new Set(messageTokens(en[key]?.message ?? ''))].sort();
      const actual = [...new Set(messageTokens(messages[key]?.message ?? ''))].sort();
      expect(actual, `${locale} ${key}`).toEqual(expected);
    }
  });

  it('defines every key used by the UI', () => {
    const used = usedMessageKeys();
    for (const locale of catalogs) {
      const messages = readMessages(locale);
      for (const key of used) {
        expect(messages, `${locale} ${key}`).toHaveProperty(key);
      }
    }
  });
});

describe('locale messages', () => {
  const ja = readMessages('ja');

  it('uses the product names from the specification', () => {
    expect(en.extensionName?.message).toBe('Sakutto - Local AI translation');
    expect(ja.extensionName?.message).toBe('Sakutto - ローカルAI翻訳');
    expect(en.extensionShortName?.message).toBe('Sakutto');
    expect(ja.extensionShortName?.message).toBe('Sakutto');
  });

  /**
   * The name is also the store listing, and the store rejects a listing whose name is not the
   * manifest name. Every catalog therefore has to keep the brand word first and its own
   * product name short enough for a 75-character store title.
   */
  it.each(catalogs)('%s keeps a store-length name that starts with the brand', (locale) => {
    const messages = readMessages(locale);
    expect(messages.extensionName?.message.startsWith('Sakutto'), locale).toBe(true);
    expect(messages.extensionName?.message.length, locale).toBeLessThanOrEqual(75);
    expect(messages.extensionShortName?.message, locale).toBe('Sakutto');
  });

  it('keeps the store name and description inside the manifest limits', () => {
    for (const locale of catalogs) {
      const messages = readMessages(locale);
      expect(messages.extensionName?.message.length, locale).toBeLessThanOrEqual(75);
      expect(messages.extensionShortName?.message.length, locale).toBeLessThanOrEqual(12);
      expect(messages.extensionDescription?.message.length, locale).toBeLessThanOrEqual(132);
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

  it('keeps Firefox-facing copy free of Chrome-only claims', () => {
    const firefoxKeys = [
      'paceHelpFirefox',
      'privacyDestinationsFirefox',
      'onboardingBridgeNoteFirefox',
      'shortcutHelpFirefox',
      'shortcutFallbackNoteFirefox',
    ];
    for (const key of firefoxKeys) {
      expect(en[key]?.message, key).not.toMatch(/Chrome/i);
      expect(ja[key]?.message, key).not.toMatch(/Chrome|Google/);
    }
  });

  it('describes the button as an agreement and uses the pinned model size', () => {
    // The consent sentence binds to the button rather than a vague "starting means…". Both
    // locales name the same control, so the sentence has to quote the label verbatim.
    for (const [locale, messages] of [
      ['en', en],
      ['ja', ja],
    ] as const) {
      const start = messages.onboardingStart?.message ?? '';
      const consent = messages.onboardingConsentSentence?.message ?? '';
      const notice = messages.onboardingStartNotice?.message ?? '';
      expect(consent, locale).toContain(start);
      expect(consent, locale).toContain('PLaMo Community License');
      expect(notice, locale).toContain(start);
    }
    expect(en.onboardingStart?.message).toBe('Agree to the license and start');
    expect(ja.onboardingStart?.message).toBe('ライセンスに同意して開始');
    expect(en).not.toHaveProperty('consentCheckbox');
    expect(ja).not.toHaveProperty('consentCheckbox');

    expect(en.onboardingHttpError?.message).toContain('HTTP');
    expect(ja.onboardingHttpError?.message).toContain('HTTP');
  });

  /**
   * The model size and its byte count are facts from the catalog. A translation that restates
   * the size by hand drifts the moment the default model changes, so each catalog carries the
   * same number the English one builds. The unit is matched loosely: a translation writes it as
   * `MB`, `Mo` or `МБ`, and every one of those is the same fact.
   */
  it.each(catalogs)('%s states the pinned model size', (locale) => {
    const label = formatByteSize(getModel(DEFAULT_MODEL_ID).size);
    const number = label.replace(/\s*[A-Za-zА-Яа-я]+\s*$/u, '');
    expect(number, locale).not.toBe('');
    expect(readMessages(locale).onboardingModelNote?.message, locale).toContain(number);
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
    // Nothing in any locale claims a guardian was asked or an age was checked.
    for (const locale of catalogs) {
      for (const entry of Object.values(readMessages(locale))) {
        expect(entry.message, locale).not.toMatch(/guardian verified|保護者の同意を確認しました/);
        expect(entry.message, locale).not.toMatch(/guardian:\s*true/);
      }
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
        /(inside|within) a company|organi[sz]ation|企業内|組織/i,
      );
      expect(messages.onboardingCommercialRegistration?.message).toMatch(/PFN/);
      expect(messages.onboardingCommercialRevenue?.message).toMatch(/1 billion|10億/);

      expect(messages.onboardingCommercialUnmetHeading?.message).toMatch(/not met|満たさない/);
      expect(messages.onboardingCommercialUnmetBody?.message).toMatch(
        /separate license|別途ライセンス|commercial license|商業用ライセンス/,
      );

      // The heading names the terms of use, not just "commercial use".
      expect(messages.onboardingCommercialHeading?.message).toMatch(/terms|利用条件/i);
    }
  });

  /**
   * Every catalog has to keep the two facts a reader needs before agreeing: that commercial use
   * has conditions, and where PFN's registration form is. A translation that softens either one
   * would be a licence summary that misstates the licence.
   *
   * The revenue cap is checked as "the number one is still there" rather than by matching a
   * word. Every language spells the unit differently (`billion`, `Milliarde`, `億`, `tỷ`,
   * `억`, `พันล้าน`), and a regex listing them rejects correct translations instead of
   * protecting the fact. What matters is that the cap was not dropped or rounded away.
   */
  it.each(catalogs)('%s keeps PFN, the revenue cap, and the registration link', (locale) => {
    const messages = readMessages(locale);
    expect(messages.onboardingCommercialRegistration?.message, locale).toMatch(/PFN/);
    expect(messages.onboardingCommercialRevenue?.message, locale).toMatch(/\b1\b|\b10\b/u);
    expect(messages.plamoRegistrationLink?.message, locale).toContain('PFN');
    expect(messages.unofficialNotice?.message, locale).toMatch(/Preferred Networks/);
    expect(messages.unofficialNotice?.message, locale).toContain('PLaMo');
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

  /**
   * The privacy policy and the source repository are the extension's own pages, so both
   * screens that already link outward point at the same two URLs.
   */
  it('links the privacy policy and the source from both pages', () => {
    for (const file of [
      '../src/entrypoints/onboarding/App.svelte',
      '../src/entrypoints/options/App.svelte',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toContain('PROJECT_LINKS');
      expect(source, file).toContain('projectLinks.privacy');
      expect(source, file).toContain('projectLinks.source');
    }
    expect(en.privacyPolicyLink?.message).toBeTruthy();
    expect(ja.sourceCodeLink?.message).toBeTruthy();
    expect(PROJECT_LINKS.privacy).toMatch(/^https:\/\//);
    expect(PROJECT_LINKS.source).toMatch(/^https:\/\/github\.com\//);
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
    for (const locale of catalogs) {
      for (const entry of Object.values(readMessages(locale))) {
        expect(entry.message, locale).not.toMatch(/PDF|Word file|PowerPoint|辞書/iu);
      }
    }
  });

  it('has no copy left for a try control during the download', () => {
    // The control is not rendered at all until the model is ready, so its label is gone
    // from both locales rather than sitting unused.
    expect(en).not.toHaveProperty('onboardingTryNow');
    expect(ja).not.toHaveProperty('onboardingTryNow');
  });
});
