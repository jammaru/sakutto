import { describe, expect, it } from 'vitest';
import {
  cleanAsrCaptionText,
  cleanCaptionForMode,
  cleanCaptionSource,
  cleanCaptionText,
  cleanHumanCaptionText,
  collapseCaptionStutter,
  isBareSoundWord,
  isSoundTagOnly,
  stripCaptionMarkers,
  stripCaptionSoundTags,
} from '@/captions/text-cleanup';

describe('caption marker cleanup (ASR only)', () => {
  it('strips segment sentinels from the exact maintainer examples', () => {
    expect(stripCaptionMarkers('S1 同僚。ED')).toBe('同僚。');
    expect(stripCaptionMarkers('E 常駐ボット。E')).toBe('常駐ボット。');
    expect(stripCaptionMarkers('T 常駐ボット。E')).toBe('常駐ボット。');
    expect(stripCaptionMarkers('E 私の見方では、早いうちに S')).toBe('私の見方では、早いうちに');
    expect(stripCaptionMarkers('NC 責任の大部分を担うこと RS')).toBe('責任の大部分を担うこと');
  });

  it('handles variants without losing punctuation or normal English', () => {
    expect(stripCaptionMarkers('S2 テスト、再度。ED')).toBe('テスト、再度。');
    expect(stripCaptionMarkers('S1同僚。ED')).toBe('同僚。');
    expect(stripCaptionMarkers('  RS  駅に着きました。S3  ')).toBe('駅に着きました。');
    expect(stripCaptionMarkers('The station opens at dawn.')).toBe('The station opens at dawn.');
    expect(stripCaptionMarkers('E.T. waits at the station.')).toBe('E.T. waits at the station.');
  });

  it('never leaves markers in fully cleaned ASR text', () => {
    for (const value of [
      'S1 同僚。ED',
      'E 常駐ボット。E',
      'NC 責任の大部分を担うこと RS',
      'S1 We should keep the codebase in a in a. ED',
    ]) {
      const cleaned = cleanAsrCaptionText(value);
      expect(cleaned).not.toMatch(/\b(?:S\d+|ED|NC|RS)\b/u);
      expect(cleaned).not.toMatch(/(?:^|\s)[ETS](?:\s|$)/u);
    }
  });
});

describe('human captions are never aggressively cleaned', () => {
  it.each([
    'We moved to NC last year.',
    'My ED appointment is at three.',
    'T Shirts are on sale.',
    'S is for Sunshine.',
    'It is in the key of E',
    'これは T シャツです。',
    'S サイズのシャツです。',
    'He had had enough.',
    'We need very very quiet.',
    'music',
    '音楽',
    'Silence.',
    '[Music]',
  ])('preserves %s verbatim on the human path', (input) => {
    expect(cleanHumanCaptionText(input)).toBe(input);
    expect(cleanCaptionForMode(input, false)).toBe(input);
  });

  it('preserves the review-table words even under general cleanup', () => {
    for (const input of [
      'We moved to NC last year.',
      'My ED appointment is at three.',
      'T Shirts are on sale.',
      'S is for Sunshine.',
      'It is in the key of E',
      'これは T シャツです。',
      'S サイズのシャツです。',
      'He had had enough.',
      'We need very very quiet.',
      'music',
      '音楽',
      'Silence.',
    ]) {
      expect(cleanCaptionText(input)).toBe(input);
    }
  });

  it('does not treat human words as ASR sentinels either', () => {
    for (const input of [
      'We moved to NC last year.',
      'My ED appointment is at three.',
      'T Shirts are on sale.',
      'S is for Sunshine.',
      'It is in the key of E',
      'これは T シャツです。',
      'S サイズのシャツです。',
    ]) {
      expect(stripCaptionMarkers(input)).toBe(input);
    }
  });

  it('keeps legitimate repetition in human captions', () => {
    expect(collapseCaptionStutter('He had had enough.')).toBe('He had had enough.');
    expect(collapseCaptionStutter('We need very very quiet.')).toBe('We need very very quiet.');
    expect(cleanHumanCaptionText('He had had enough.')).toBe('He had had enough.');
  });
});

describe('caption stutter cleanup (ASR only)', () => {
  it('collapses the reported stutter before translation', () => {
    expect(collapseCaptionStutter('in a in a')).toBe('in a');
    expect(collapseCaptionStutter('We should keep the codebase in a in a.')).toBe(
      'We should keep the codebase in a.',
    );
    expect(collapseCaptionStutter('a in a in a')).toBe('a in a');
    expect(collapseCaptionStutter('the codebase')).toBe('the codebase');
  });

  it('leaves stutter fragments out of clean ASR source text', () => {
    expect(cleanCaptionSource('S1 in a in a [Music]', true)).toBe('in a');
    expect(cleanAsrCaptionText('コードベースをa in a in aで保持')).toBe(
      'コードベースをa in aで保持',
    );
  });
});

describe('caption sound tags', () => {
  it.each([
    '[Music]',
    '[音楽]',
    '[Applause]',
    '[Laughter]',
    '♪',
    '(music)',
    '[Music] ♪',
    '(背景音)',
  ])('drops pure sound tag %s without a model call', (value) => {
    expect(isSoundTagOnly(value)).toBe(true);
    expect(cleanCaptionSource(value)).toBe('');
    expect(cleanCaptionSource(value, true)).toBe('');
  });

  it('does not classify bare sound words as tags', () => {
    for (const value of ['Music', 'music', 'applause', '音楽', 'Silence.', 'music ']) {
      expect(isSoundTagOnly(value)).toBe(false);
    }
  });

  it('classifies bare sound words only for the ASR drop policy', () => {
    expect(isBareSoundWord('music')).toBe(true);
    expect(isBareSoundWord('音楽')).toBe(true);
    expect(isBareSoundWord('Silence.')).toBe(false);
    expect(cleanCaptionSource('music')).toBe('music');
    expect(cleanCaptionSource('music', true)).toBe('');
    expect(cleanCaptionSource('Silence.', true)).toBe('Silence.');
  });

  it('keeps a lyric line wrapped in notes', () => {
    expect(isSoundTagOnly('♪ lyric line ♪')).toBe(false);
    expect(stripCaptionSoundTags('♪ lyric line ♪')).toBe('lyric line');
    expect(cleanCaptionSource('♪ lyric line ♪', true)).toBe('lyric line');
  });

  it('does not treat ordinary captions as tags', () => {
    expect(isSoundTagOnly('The station opens at dawn.')).toBe(false);
    expect(cleanCaptionSource('[Music] The station opens.', true)).toBe('The station opens.');
  });
});

describe('cleanup is idempotent and key-stable', () => {
  it.each([
    '♪ E T Shirts are on sale. ♪',
    'E E a',
    'S1 同僚。ED',
    'E We should keep the codebase in a in a',
    'NC Most of the blame falls on us',
    '[Music] The station opens at dawn.',
    '♪ lyric line ♪',
  ])('normalises %s exactly once', (input) => {
    const once = cleanAsrCaptionText(input);
    expect(cleanAsrCaptionText(once)).toBe(once);
    const source = cleanCaptionSource(input, true);
    expect(cleanCaptionSource(source, true)).toBe(source);
  });

  it('converges on one source for the cache-key reproducer', () => {
    const raw = '♪ E T Shirts are on sale. ♪';
    expect(cleanCaptionSource(raw, true)).toBe('T Shirts are on sale.');
    expect(cleanAsrCaptionText('T Shirts are on sale.')).toBe('T Shirts are on sale.');
    expect(cleanCaptionSource('E E a', true)).toBe('a');
  });
});
