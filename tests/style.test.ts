import { describe, expect, it } from 'vitest';
import { buildTranslationPrompt } from '@/engine/prompt/pfml3';
import {
  DEFAULT_TRANSLATION_STYLE,
  TRANSLATION_STYLES,
  resolvePromptContext,
  situationForStyle,
  stylesForTarget,
} from '@/engine/prompt/style';
import type { Formality, TranslationStyle } from '@/engine/types';

const EN_SOURCE = 'The meeting has been moved to Monday 12 May 2025.';
const JA_SOURCE = '会議は2025年5月12日の月曜日に変更されました。';

function prompt(input: {
  text: string;
  tgt: string;
  src?: string;
  form?: Formality;
  style?: TranslationStyle;
  glossary?: readonly { source: string; target: string }[];
  context?: string;
}): string {
  const context = resolvePromptContext(input);
  return buildTranslationPrompt({
    text: input.text,
    tgt: input.tgt,
    ...(input.src !== undefined ? { src: input.src } : {}),
    ...(input.tgt === 'ja' && input.form !== undefined ? { form: input.form } : {}),
    ...(input.glossary ? { glossary: input.glossary } : {}),
    ...(context ? { context } : {}),
  });
}

describe('translation styles', () => {
  it('offers the issue lists only for Japanese and English targets', () => {
    expect(stylesForTarget('ja')).toEqual(TRANSLATION_STYLES);
    expect(stylesForTarget('en')).toEqual(TRANSLATION_STYLES);
    expect(stylesForTarget('ko')).toEqual([]);
    expect(stylesForTarget('zh-hans')).toEqual([]);
    expect(stylesForTarget('pt')).toEqual([]);
  });

  it('keeps Neutral byte-identical to the previous default prompts', () => {
    expect(prompt({ text: EN_SOURCE, tgt: 'ja', form: 'polite', style: 'neutral' })).toBe(
      '<|plamo:tag|>dataset<|plamo:msg|>translation' +
        `<|plamo:tag|>input<|plamo:msg|>${EN_SOURCE}` +
        '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>',
    );

    expect(prompt({ text: JA_SOURCE, tgt: 'en', style: DEFAULT_TRANSLATION_STYLE })).toBe(
      '<|plamo:tag|>dataset<|plamo:msg|>translation' +
        `<|plamo:tag|>input<|plamo:msg|>${JA_SOURCE}` +
        '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
    );

    expect(prompt({ text: EN_SOURCE, tgt: 'ja', form: 'polite', style: 'neutral' })).toBe(
      prompt({ text: EN_SOURCE, tgt: 'ja', form: 'polite' }),
    );
    expect(prompt({ text: JA_SOURCE, tgt: 'en', style: 'neutral' })).toBe(
      prompt({ text: JA_SOURCE, tgt: 'en' }),
    );
  });

  it('does not invent form values or write style into the source text', () => {
    for (const style of TRANSLATION_STYLES) {
      const ja = prompt({ text: EN_SOURCE, tgt: 'ja', form: 'plain', style });
      expect(ja).toContain('<|plamo:key|>form<|plamo:val|>plain');
      expect(ja).not.toMatch(/form<\|plamo:val\|>(?!plain|polite)/);
      expect(ja).toContain(`<|plamo:msg|>${EN_SOURCE}<|plamo:tag|>output`);

      const en = prompt({ text: JA_SOURCE, tgt: 'en', style });
      expect(en).not.toContain('form<|plamo:val|>');
      expect(en).toContain(`<|plamo:msg|>${JA_SOURCE}<|plamo:tag|>output`);
    }
  });

  it.each(TRANSLATION_STYLES.filter((style) => style !== 'neutral'))(
    'puts a situation sentence in context for %s, not an instruction',
    (style) => {
      const ja = prompt({ text: EN_SOURCE, tgt: 'ja', src: 'en', form: 'polite', style });
      const en = prompt({ text: JA_SOURCE, tgt: 'en', src: 'ja', style });
      const jaSituation = situationForStyle(style, 'ja', 'en');
      const enSituation = situationForStyle(style, 'en', 'ja');

      expect(jaSituation).toBeTruthy();
      expect(enSituation).toBeTruthy();
      expect(jaSituation).not.toMatch(/translate|do not|してください|訳して/i);
      expect(enSituation).not.toMatch(/translate|do not|してください|訳して/i);

      expect(ja).toContain(`<|plamo:tag|>context<|plamo:msg|>${jaSituation}<|plamo:tag|>input`);
      expect(en).toContain(`<|plamo:tag|>context<|plamo:msg|>${enSituation}<|plamo:tag|>input`);
    },
  );

  it('keeps form and style independent on a Japanese target', () => {
    const politeFormal = prompt({
      text: EN_SOURCE,
      tgt: 'ja',
      src: 'en',
      form: 'polite',
      style: 'formal',
    });
    const plainFormal = prompt({
      text: EN_SOURCE,
      tgt: 'ja',
      src: 'en',
      form: 'plain',
      style: 'formal',
    });

    expect(politeFormal).toContain('form<|plamo:val|>polite');
    expect(plainFormal).toContain('form<|plamo:val|>plain');
    expect(politeFormal).toContain('This is an official document.');
    expect(plainFormal).toContain('This is an official document.');
    expect(politeFormal.replace('form<|plamo:val|>polite', 'form<|plamo:val|>plain')).toBe(
      plainFormal,
    );
  });

  it('uses the source language for the situation when the source is ja or en', () => {
    expect(situationForStyle('business', 'ja', 'en')).toBe('This is a business document.');
    expect(situationForStyle('business', 'en', 'ja')).toBe('ビジネス文書です。');
    expect(situationForStyle('business', 'ja')).toBe('ビジネス文書です。');
    expect(situationForStyle('business', 'ko', 'en')).toBeUndefined();
    expect(situationForStyle('neutral', 'ja', 'en')).toBeUndefined();
  });

  it('prepends the situation to surrounding context and still orders context before glossary', () => {
    const built = prompt({
      text: 'Ownerでフィルタリングできます。',
      tgt: 'en',
      src: 'ja',
      style: 'business',
      context: 'プロジェクト管理ツールのヘルプページです。',
      glossary: [{ source: 'オーナー', target: 'assignee' }],
    });

    expect(built).toBe(
      '<|plamo:tag|>dataset<|plamo:msg|>translation' +
        '<|plamo:tag|>context<|plamo:msg|>ビジネス文書です。\nプロジェクト管理ツールのヘルプページです。' +
        '<|plamo:tag|>glossary<|plamo:index|>オーナー<|plamo:item|>assignee' +
        '<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>Ownerでフィルタリングできます。' +
        '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
    );
  });
});
