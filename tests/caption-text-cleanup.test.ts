import { describe, expect, it } from 'vitest';
import {
  cleanCaptionSource,
  cleanCaptionText,
  collapseCaptionStutter,
  isSoundTagOnly,
  stripCaptionMarkers,
  stripCaptionSoundTags,
} from '@/captions/text-cleanup';

describe('caption marker cleanup', () => {
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

  it('never leaves markers in fully cleaned caption text', () => {
    for (const value of [
      'S1 同僚。ED',
      'E 常駐ボット。E',
      'NC 責任の大部分を担うこと RS',
      'S1 We should keep the codebase in a in a. ED',
    ]) {
      const cleaned = cleanCaptionText(value);
      expect(cleaned).not.toMatch(/\b(?:S\d+|ED|NC|RS)\b/u);
      expect(cleaned).not.toMatch(/(?:^|\s)[ETS](?:\s|$)/u);
    }
  });
});

describe('caption stutter cleanup', () => {
  it('collapses the reported stutter before translation', () => {
    expect(collapseCaptionStutter('in a in a')).toBe('in a');
    expect(collapseCaptionStutter('We should keep the codebase in a in a.')).toBe(
      'We should keep the codebase in a.',
    );
    expect(collapseCaptionStutter('a in a in a')).toBe('a in a');
    expect(collapseCaptionStutter('the codebase')).toBe('the codebase');
  });

  it('leaves stutter fragments out of clean source text', () => {
    expect(cleanCaptionSource('S1 in a in a [Music]')).toBe('in a');
    expect(cleanCaptionText('コードベースをa in a in aで保持')).toBe('コードベースをa in aで保持');
  });
});

describe('caption sound tags', () => {
  it.each(['[Music]', '[音楽]', '[Applause]', '[Laughter]', '♪', '(music)', '[Music] ♪'])(
    'drops pure sound tag %s without a model call',
    (value) => {
      expect(isSoundTagOnly(value)).toBe(true);
      expect(cleanCaptionSource(value)).toBe('');
    },
  );

  it('keeps a lyric line wrapped in notes', () => {
    expect(isSoundTagOnly('♪ lyric line ♪')).toBe(false);
    expect(stripCaptionSoundTags('♪ lyric line ♪')).toBe('lyric line');
    expect(cleanCaptionSource('♪ lyric line ♪')).toBe('lyric line');
  });

  it('does not treat ordinary captions as tags', () => {
    expect(isSoundTagOnly('The station opens at dawn.')).toBe(false);
    expect(cleanCaptionSource('[Music] The station opens.')).toBe('The station opens.');
  });
});
