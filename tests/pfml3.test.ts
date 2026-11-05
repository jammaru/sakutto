import { describe, expect, it } from 'vitest';
import {
  buildTranslationPrompt,
  cleanModelOutput,
  sanitizeGlossary,
  TRANSLATION_STOP_TOKENS,
} from '@/engine/prompt/pfml3';
import { EngineError } from '@/engine/errors';

const BASIC_EN = (text: string): string =>
  `<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>${text}` +
  `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>`;

describe('PFML3 prompt', () => {
  it('builds the basic translation prompt without a BOS token', () => {
    const prompt = buildTranslationPrompt({
      text: '会議は来週の月曜日に変更されました。',
      tgt: 'en',
    });

    expect(prompt).toBe(BASIC_EN('会議は来週の月曜日に変更されました。'));
    expect(prompt.startsWith('<|plamo:bos|>')).toBe(false);
  });

  it('adds the polite form only for Japanese targets', () => {
    expect(
      buildTranslationPrompt({ text: 'This system is convenient.', tgt: 'ja', form: 'polite' }),
    ).toBe(
      '<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>This system is convenient.' +
        '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>',
    );

    expect(() =>
      buildTranslationPrompt({ text: 'This system is convenient.', tgt: 'en', form: 'polite' }),
    ).toThrow(EngineError);
  });

  it('orders context before glossary and source language inside input', () => {
    const prompt = buildTranslationPrompt({
      text: 'Ownerでフィルタリングできます。',
      tgt: 'en',
      src: 'ja',
      context: 'プロジェクト管理ツールのヘルプページです。',
      glossary: [{ source: 'オーナー', target: 'assignee' }],
    });

    expect(prompt).toBe(
      '<|plamo:tag|>dataset<|plamo:msg|>translation' +
        '<|plamo:tag|>context<|plamo:msg|>プロジェクト管理ツールのヘルプページです。' +
        '<|plamo:tag|>glossary<|plamo:index|>オーナー<|plamo:item|>assignee' +
        '<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>Ownerでフィルタリングできます。' +
        '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
    );
  });

  it('normalizes case and underscores in language codes', () => {
    expect(buildTranslationPrompt({ text: 'Hello.', tgt: 'ZH_HANS' })).toContain(
      '<|plamo:key|>lang<|plamo:val|>zh-hans',
    );
  });

  it('rejects empty text, invalid languages and reserved tokens', () => {
    expect(() => buildTranslationPrompt({ text: '   ', tgt: 'en' })).toThrow(EngineError);
    expect(() => buildTranslationPrompt({ text: 'Hello.', tgt: 'english' })).toThrow(EngineError);
    expect(() => buildTranslationPrompt({ text: 'Hello.', tgt: 'zh-CN' })).toThrow(EngineError);

    expect(() => buildTranslationPrompt({ text: 'Hello <|plamo:tag|> world', tgt: 'en' })).toThrow(
      EngineError,
    );

    expect(() =>
      buildTranslationPrompt({
        text: 'Hello.',
        tgt: 'en',
        glossary: [{ source: 'Hi <|plamo:tag|>', target: 'やあ' }],
      }),
    ).toThrow(EngineError);
  });

  it('drops blank and reserved glossary rows', () => {
    expect(
      sanitizeGlossary([
        { source: ' Runner ', target: ' ランナー機能 ' },
        { source: '   ', target: 'x' },
        { source: 'x', target: 'y<|plamo:tag|>' },
      ]),
    ).toEqual([{ source: 'Runner', target: 'ランナー機能' }]);
  });

  it('keeps the last target for a repeated glossary source', () => {
    expect(
      sanitizeGlossary([
        { source: 'Runner', target: '旧訳' },
        { source: 'Runner', target: '新訳' },
        { source: 'Owner', target: 'オーナー' },
      ]),
    ).toEqual([
      { source: 'Runner', target: '新訳' },
      { source: 'Owner', target: 'オーナー' },
    ]);
  });

  it('uses the documented stop tokens', () => {
    expect(TRANSLATION_STOP_TOKENS).toEqual(['<|plamo:tag|>', '<|plamo:bos|>']);
  });

  it('strips stop tokens from generated text', () => {
    expect(cleanModelOutput(' こんにちは <|plamo:tag|>')).toBe('こんにちは');
    expect(cleanModelOutput('Hello<|plamo:bos|>')).toBe('Hello');
  });
});
