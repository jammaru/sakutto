import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildVodCues,
  joinVodWords,
  numericLexemes,
  numericLexemesEqual,
  parseVodJson3Timeline,
  type VodWord,
} from '@/captions/vod-json3';

function event(start: number, duration: number, words: Array<[string, number]>) {
  return {
    tStartMs: start,
    dDurationMs: duration,
    segs: words.map(([utf8, tOffsetMs]) => ({ utf8, tOffsetMs })),
  };
}

describe('VOD json3 timed words', () => {
  it('derives absolute word offsets and final ends from event timing', () => {
    const timeline = parseVodJson3Timeline({
      events: [
        event(1_000, 1_500, [
          ['Hello', 100],
          ['world.', 600],
        ]),
      ],
    });
    expect(timeline?.words).toMatchObject([
      { text: 'Hello', startMs: 1_100, endMs: 1_600, timing: 'offset' },
      { text: 'world.', startMs: 1_600, endMs: 2_500, timing: 'offset' },
    ]);
    expect(timeline?.cues[0]).toMatchObject({ startMs: 1_100, endMs: 2_500, text: 'Hello world.' });
    expect(timeline?.sourceCoverage.complete).toBe(true);
  });

  it('deduplicates rolling windows by absolute time and text', () => {
    const timeline = parseVodJson3Timeline({
      events: [
        event(1_000, 2_000, [
          ['Hi', 0],
          ['everyone', 400],
        ]),
        event(1_000, 2_400, [
          ['Hi', 0],
          ['everyone', 400],
          ['I am', 900],
        ]),
        event(1_000, 3_000, [
          ['Hi', 0],
          ['everyone', 400],
          ['I am', 900],
          ['Lydia.', 1_500],
        ]),
      ],
    });
    expect(timeline?.words.map((word) => word.text)).toEqual(['Hi', 'everyone', 'I am', 'Lydia.']);
    expect(timeline?.cues.map((cue) => cue.text)).toEqual(['Hi everyone I am Lydia.']);
    expect(timeline?.sourceCoverage).toMatchObject({
      acceptedTokens: 9,
      repeatedTokens: 5,
      emittedTokens: 4,
      complete: true,
    });
  });

  it('keeps repeated words at distinct source times', () => {
    const timeline = parseVodJson3Timeline({
      events: [
        event(0, 2_000, [
          ['very', 0],
          ['very', 800],
        ]),
      ],
    });
    expect(timeline?.words.map((word) => word.text)).toEqual(['very', 'very']);
  });

  it('uses punctuation and real inter-word pauses without splitting decimals', () => {
    const timeline = parseVodJson3Timeline({
      events: [
        event(0, 2_000, [
          ['Opus', 0],
          ['5', 300],
          ['.5', 400],
          ['rocks.', 700],
        ]),
        event(3_000, 1_000, [['Next.', 0]]),
      ],
    });
    expect(timeline?.cues.map((cue) => cue.text)).toEqual(['Opus 5.5 rocks.', 'Next.']);
    expect(timeline?.cues[0]).toMatchObject({ startMs: 0, endMs: 2_000 });
  });

  it('falls back to event timing for malformed offsets but rejects offset-less timelines', () => {
    const mixed = parseVodJson3Timeline({
      events: [
        {
          tStartMs: 100,
          dDurationMs: 900,
          segs: [
            { utf8: 'one', tOffsetMs: 0 },
            { utf8: 'two', tOffsetMs: 'bad' },
          ],
        },
      ],
    });
    expect(mixed?.words[1]).toMatchObject({ startMs: 100, endMs: 1_000, timing: 'event' });
    expect(
      parseVodJson3Timeline({
        events: [{ tStartMs: 0, dDurationMs: 500, segs: [{ utf8: 'legacy' }] }],
      }),
    ).toBeNull();
  });

  it('does not leak invalid intervals', () => {
    const timeline = parseVodJson3Timeline({
      events: [
        { tStartMs: -1, dDurationMs: 100, segs: [{ utf8: 'bad', tOffsetMs: 0 }] },
        { tStartMs: 0, dDurationMs: 0, segs: [{ utf8: 'bad', tOffsetMs: 0 }] },
        event(0, 1_000, [['good', 0]]),
      ],
    });
    expect(timeline?.words).toHaveLength(1);
    expect(timeline?.words.every((word) => word.endMs > word.startMs)).toBe(true);
  });
});

describe('whole-token VOD cues', () => {
  const word = (text: string, startMs: number, endMs = startMs + 300): VodWord => ({
    text,
    startMs,
    endMs,
    eventIndex: 0,
    segmentIndex: 0,
    timing: 'offset',
  });

  it('caps long text only between tokens and never clamps the source tail', () => {
    const words = Array.from({ length: 12 }, (_, index) =>
      word('elongated', index * 700, index * 700 + 500),
    );
    const cues = buildVodCues(words);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.flatMap((cue) => cue.text.split(' '))).toHaveLength(12);
    expect(cues.at(-1)?.endMs).toBe(words.at(-1)?.endMs);
  });

  it('keeps indivisible long CJK and alphanumeric tokens intact', () => {
    const long = 'supercalifragilisticexpialidocious'.repeat(4);
    const cues = buildVodCues([
      word(long, 0, 8_000),
      word('あいうえおかきくけこ'.repeat(8), 8_100, 9_000),
    ]);
    expect(cues.map((cue) => cue.text)).toEqual([long, 'あいうえおかきくけこ'.repeat(8)]);
  });

  it('joins punctuation and decimal fragments without spaces', () => {
    expect(joinVodWords('Opus 5', '.5')).toBe('Opus 5.5');
    expect(joinVodWords('Hello', '.')).toBe('Hello.');
  });
});

describe('sanitized public-style VOD fixture', () => {
  it('matches the independently reviewed source and timing oracle', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../e2e/fixtures/youtube-vod-json3-en.json', import.meta.url), 'utf8'),
    ) as unknown;
    const expected = JSON.parse(
      readFileSync(new URL('../e2e/fixtures/youtube-vod-json3-en.expected.json', import.meta.url), 'utf8'),
    ) as { cues: Array<{ source: string; startMs: number; endMs: number; numericLexemes: string[] }> };
    const timeline = parseVodJson3Timeline(raw, 'en', true);
    expect(timeline?.sourceCoverage.complete).toBe(true);
    expect(timeline?.sourceCoverage.offsetTokens).toBeGreaterThan(0);
    expect(timeline?.cues.map((cue) => ({
      source: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      numericLexemes: cue.numericLexemes,
    }))).toEqual(expected.cues.map(({ source, startMs, endMs, numericLexemes }) => ({
      source,
      startMs,
      endMs,
      numericLexemes,
    })));
  });
});

describe('caption numeric lexemes', () => {
  it('scans integers decimals grouped values and versions without sentence periods', () => {
    expect(numericLexemes('Opus 5.5, 1,234.50, v1.2.3, and 45.')).toEqual([
      '5.5',
      '1,234.50',
      '1.2.3',
      '45',
    ]);
  });
  it('rejects missing duplicated reordered and altered numeric output', () => {
    expect(numericLexemesEqual('5.5 then 5.2', '5.5 then 5.2')).toBe(true);
    for (const output of ['55 then 5.2', '5.5', '5.2 then 5.5', '5.5 then 5.2 then 4.5']) {
      expect(numericLexemesEqual('5.5 then 5.2', output)).toBe(false);
    }
  });
});
