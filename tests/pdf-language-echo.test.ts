import { describe, expect, it } from 'vitest';
import {
  translationEchoesSource,
  translationStaysInSourceLanguage,
} from '@/pdf/language';

describe('translationEchoesSource', () => {
  it('rejects unchanged English when the target is Japanese', () => {
    const source =
      'Therefore it is essential to evaluate the detector with multiple configurations.';
    expect(translationEchoesSource(source, source, 'ja')).toBe(true);
    expect(
      translationEchoesSource(
        source,
        'したがって、評価器を複数の設定で評価することが不可欠です。',
        'ja',
      ),
    ).toBe(false);
  });

  it('allows intentional same-language for an English target', () => {
    const source = 'The queue grows while the reader scrolls.';
    expect(translationEchoesSource(source, source, 'en')).toBe(true);
    expect(translationEchoesSource(source, 'The queue grows while the reader scrolls.', 'en')).toBe(
      true,
    );
  });

  it('does not exempt the bench fake prefix outside the fake-engine build', () => {
    expect(__SAKUTTO_FAKE_ENGINE__).toBe(false);
    const source =
      'Therefore it is essential to evaluate the detector with multiple configurations.';
    expect(translationEchoesSource(source, `§ja§${source}`, 'ja')).toBe(true);
  });

  it('does not call ten correct German translations echoes of an English source', () => {
    const source = 'The detector compares each configuration on the same stream of tokens.';
    const translations = [
      'Der Detektor vergleicht jede Konfiguration auf demselben Tokenstrom.',
      'Der Prüfer vergleicht jede Einstellung auf derselben Tokenfolge.',
      'Das Verfahren bewertet jede Konfiguration auf dem gleichen Datenstrom.',
      'Die Erkennung vergleicht alle Einstellungen mit derselben Eingabe.',
      'Der Test vergleicht jede Variante auf demselben Ablauf von Tokens.',
      'Die Auswertung prüft jede Konfiguration auf der gleichen Tokenfolge.',
      'Das System vergleicht jede Einstellung anhand desselben Tokenstroms.',
      'Der Vergleich bewertet jede Konfiguration auf demselben Eingabestrom.',
      'Die Methode prüft jede Konfiguration mit derselben Folge von Tokens.',
      'Der Detektor bewertet alle Einstellungen auf dem gleichen Tokenstrom.',
    ];
    expect(translations).toHaveLength(10);
    expect(
      translations.filter((translation) =>
        translationEchoesSource(source, translation, 'de'),
      ),
    ).toHaveLength(0);
    for (const translation of translations) {
      expect(translationStaysInSourceLanguage(source, translation, 'de')).toBe(false);
    }
  });

  it('still rejects an exact source echo for a Latin-script target', () => {
    const source = 'The detector compares each configuration on the same stream of tokens.';
    expect(translationEchoesSource(source, source, 'de')).toBe(true);
    expect(translationStaysInSourceLanguage(source, source, 'de')).toBe(true);
    expect(
      translationStaysInSourceLanguage(source, `${source} and then some extra words`, 'de'),
    ).toBe(true);
  });

  it('does not call a short label, row, header or notation an echo', () => {
    for (const source of ['Data quality', '48', '1.9 s', 'INTRODUCTION', 'α = β']) {
      expect(translationEchoesSource(source, source, 'ja'), source).toBe(false);
    }
  });
});
