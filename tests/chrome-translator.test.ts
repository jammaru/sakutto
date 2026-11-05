import { describe, expect, it } from 'vitest';
import {
  ChromeTranslatorEngine,
  type DetectedLanguage,
  type LanguageDetectorConstructor,
  type LanguageDetectorInstance,
  type TranslatorAvailability,
  type TranslatorConstructor,
  type TranslatorInstance,
} from '@/engine/chrome/translator';
import type { TranslateOptions } from '@/engine/types';
import { collectChunks } from './support/fakes';

function options(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    tgt: 'ja',
    form: 'polite',
    priority: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Fixture {
  translator: TranslatorConstructor<TranslatorInstance>;
  instance: TranslatorInstance;
  availability: Map<string, TranslatorAvailability>;
  created: Array<{ sourceLanguage: string; targetLanguage: string }>;
  activity: { active: number; peak: number };
}

function fixture(): Fixture {
  const availability = new Map<string, TranslatorAvailability>();
  const created: Array<{ sourceLanguage: string; targetLanguage: string }> = [];
  const activity = { active: 0, peak: 0 };

  const instance: TranslatorInstance = {
    translate: async (text) => `[${text}]`,
    translateStreaming: (text) =>
      new ReadableStream<unknown>({
        async start(controller) {
          activity.active += 1;
          activity.peak = Math.max(activity.peak, activity.active);
          controller.enqueue(`<${text.slice(0, 1)}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue('>');
          controller.close();
          activity.active -= 1;
        },
      }),
  };

  const translator: TranslatorConstructor<TranslatorInstance> = {
    availability: async ({ sourceLanguage, targetLanguage }) =>
      availability.get(`${sourceLanguage}|${targetLanguage}`) ?? 'unavailable',
    create: async ({ sourceLanguage, targetLanguage }) => {
      created.push({ sourceLanguage, targetLanguage });
      availability.set(`${sourceLanguage}|${targetLanguage}`, 'available');
      return instance;
    },
  };

  return { translator, instance, availability, created, activity };
}

describe('ChromeTranslatorEngine', () => {
  it('reports unavailable without the built-in API', async () => {
    const engine = new ChromeTranslatorEngine({ translator: null, languageDetector: null });

    expect(engine.available).toBe(false);
    await expect(engine.availability('en', 'ja')).resolves.toBe('unavailable');
    await expect(
      collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options())),
    ).rejects.toMatchObject({ code: 'chrome-unavailable' });
  });

  it('streams a translation through a ready language pack', async () => {
    const { translator, activity } = fixture();
    activity.active = 0;
    translator.availability = async () => 'available';
    const engine = new ChromeTranslatorEngine({ translator });

    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options({ src: 'en' })),
    );

    expect(chunks.filter((chunk) => chunk.textDelta !== undefined)).toEqual([
      { id: 'a', textDelta: '<H', engine: 'chrome' },
      { id: 'a', textDelta: '>', engine: 'chrome' },
    ]);
    expect(chunks.at(-1)).toEqual({ id: 'a', final: '<H>', engine: 'chrome' });
  });

  it('falls back to the one-shot translate call without streaming support', async () => {
    const { translator, instance } = fixture();
    translator.availability = async () => 'available';
    delete instance.translateStreaming;
    const engine = new ChromeTranslatorEngine({ translator });

    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options({ src: 'en' })),
    );

    expect(chunks).toEqual([{ id: 'a', final: '[Hello.]', engine: 'chrome' }]);
  });

  it('requires an installed language pack before translating', async () => {
    const { translator, availability } = fixture();
    translator.availability = async ({ sourceLanguage, targetLanguage }) =>
      availability.get(`${sourceLanguage}|${targetLanguage}`) ?? 'downloadable';
    const engine = new ChromeTranslatorEngine({ translator });

    await expect(
      collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options({ src: 'en' }))),
    ).rejects.toMatchObject({ code: 'chrome-not-ready' });
  });

  it('accepts regional language tags', async () => {
    const { translator } = fixture();
    translator.availability = async ({ sourceLanguage, targetLanguage }) =>
      sourceLanguage === 'en' && targetLanguage === 'ja' ? 'available' : 'unavailable';
    const engine = new ChromeTranslatorEngine({ translator });

    await expect(engine.availability('en-US', 'ja-JP')).resolves.toBe('available');

    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options({ src: 'en-US', tgt: 'ja-JP' })),
    );
    expect(chunks.at(-1)).toEqual({ id: 'a', final: '<H>', engine: 'chrome' });
  });

  it('rejects a language pair the built-in translator does not support', async () => {
    const { translator } = fixture();
    const engine = new ChromeTranslatorEngine({ translator });

    await expect(
      collectChunks(
        engine.translate([{ id: 'a', text: 'Hello.' }], options({ src: 'en', tgt: 'ceb' })),
      ),
    ).rejects.toMatchObject({ code: 'unsupported-language' });
  });

  it('detects the source language when it is not supplied', async () => {
    const { translator } = fixture();
    translator.availability = async ({ sourceLanguage, targetLanguage }) =>
      sourceLanguage === 'en' && targetLanguage === 'ja' ? 'available' : 'unavailable';

    const detected: DetectedLanguage[] = [{ detectedLanguage: 'en', confidence: 0.92 }];
    const detector: LanguageDetectorInstance = { detect: async () => detected };
    const languageDetector: LanguageDetectorConstructor = {
      availability: async () => 'available',
      create: async () => detector,
    };

    const engine = new ChromeTranslatorEngine({ translator, languageDetector });
    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(await engine.detect('Hello.')).toBe('en');
    expect(chunks.at(-1)?.final).toBe('<H>');
  });

  it('returns the original text when source and target match', async () => {
    const { translator, created } = fixture();
    const engine = new ChromeTranslatorEngine({ translator });

    const chunks = await collectChunks(
      engine.translate([{ id: 'a', text: 'こんにちは。' }], options({ src: 'ja', tgt: 'ja' })),
    );

    expect(chunks).toEqual([{ id: 'a', final: 'こんにちは。', engine: 'chrome' }]);
    expect(created).toHaveLength(0);
  });

  it('serializes concurrent translations because the API is sequential', async () => {
    const { translator, activity } = fixture();
    translator.availability = async () => 'available';
    const engine = new ChromeTranslatorEngine({ translator });

    await Promise.all([
      collectChunks(engine.translate([{ id: 'a', text: 'Alpha' }], options({ src: 'en' }))),
      collectChunks(engine.translate([{ id: 'b', text: 'Beta' }], options({ src: 'en' }))),
    ]);

    expect(activity.peak).toBe(1);
  });
});
