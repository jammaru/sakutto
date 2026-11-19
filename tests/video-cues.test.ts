// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alignCaptionCuesToMedia,
  collapseGrowingCaptionCues,
  cueAtTime,
  cuesFromPlayhead,
  cuesInWindow,
  finalizeCaptionCues,
  joinCaptionFragments,
  LiveCaptionBuffer,
  LIVE_CAPTION_MAX_WAIT_MS,
  LIVE_SEGMENT_GAP_MS,
  LiveCaptionStream,
  ASR_PHRASE_MERGE_MAX_MS,
  mergeSentenceCues,
  mergeWordCues,
  parseTimedtextJson3,
  parseWebVtt,
  WEBVTT_HOUR_OFFSET_MS,
} from '@/captions/cues';
import {
  captionTracksFromPlayerResponse,
  parsePlayerResponseScript,
  isYouTubeLivePlayer,
  selectCaptionTrack,
  captionLanguagePrefix,
  captionSourceIsTargetLanguage,
  captionTextIsTargetLanguage,
  selectLiveCaptionTrack,
  spokenLanguageFromPlayerResponse,
  stripTargetLanguageFromCaption,
  withTimedtextFormat,
  youtubeVideoId,
} from '@/captions/youtube';
import { captionOverlayBox, captionOverlayFontPx } from '@/captions/overlay';
import {
  CAPTION_LIVE_PRIORITY,
  CAPTION_PLAYHEAD_PRIORITY,
  CAPTION_PREFETCH_PRIORITY,
} from '@/captions/engine';
import { pickCaptionTrack, revealTrackCues } from '@/captions/html5';
import {
  resolveCaptionFetchUrl,
  resolveSameOriginCaptionUrl,
  TimedtextFetchGuard,
  TIMEDTEXT_MAX_ATTEMPTS,
} from '@/captions/timedtext';

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
The station opens at dawn.

00:00:02.000 --> 00:00:04.500
A red train waits at platform two.

NOTE skip this

00:00:04.500 --> 00:00:07.000
Tickets are sold at the north window.
`;

describe('WebVTT parser', () => {
  it('shifts a 1-hour HLS offset onto the media timeline', () => {
    const vtt = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:324000000

01:00:01.583 --> 01:00:04.000
The station opens at dawn.
`;
    const cues = parseWebVtt(vtt, 'en');
    expect(cues).toHaveLength(1);
    expect(cues[0]?.startMs).toBe(1_583);
    expect(cues[0]?.endMs).toBe(4_000);
    expect(cues[0]?.text).toBe('The station opens at dawn.');
  });

  it('aligns cues that start past the media duration without a timestamp map', () => {
    const cues = parseWebVtt(`WEBVTT

01:00:01.583 --> 01:00:04.000
The station opens at dawn.
`);
    expect(cues[0]?.startMs).toBe(1_583);
    const aligned = alignCaptionCuesToMedia(cues, 86_700);
    expect(aligned[0]?.startMs).toBe(1_583);
    expect(WEBVTT_HOUR_OFFSET_MS).toBe(3_600_000);
  });

  it('reads cue times and text from a synthetic track', () => {
    const cues = parseWebVtt(VTT, 'en');
    expect(cues).toHaveLength(3);
    expect(cues[0]).toMatchObject({
      startMs: 0,
      endMs: 2000,
      text: 'The station opens at dawn.',
      language: 'en',
    });
    expect(cues[1]?.text).toBe('A red train waits at platform two.');
    expect(cueAtTime(cues, 2500)?.text).toBe('A red train waits at platform two.');
    expect(cueAtTime(cues, 7000)).toBeNull();
    expect(cuesInWindow(cues, 1500, 5000).map((cue) => cue.text)).toEqual([
      'The station opens at dawn.',
      'A red train waits at platform two.',
      'Tickets are sold at the north window.',
    ]);
  });
});

describe('YouTube json3 timedtext', () => {
  it('joins segments and skips timing-only events', () => {
    const cues = parseTimedtextJson3({
      events: [
        { tStartMs: 0, dDurationMs: 200 },
        {
          tStartMs: 1000,
          dDurationMs: 2500,
          segs: [{ utf8: 'Hello ' }, { utf8: 'from the station.' }],
        },
      ],
    });
    expect(cues).toEqual([
      expect.objectContaining({
        startMs: 1000,
        endMs: 3500,
        text: 'Hello from the station.',
      }),
    ]);
  });
});

describe('word-cue merging', () => {
  it('waits for a sentence boundary instead of translating one word at a time', () => {
    const merged = mergeWordCues([
      { id: 'a', startMs: 0, endMs: 400, text: 'The' },
      { id: 'b', startMs: 400, endMs: 800, text: 'train' },
      { id: 'c', startMs: 800, endMs: 1400, text: 'left.' },
      { id: 'd', startMs: 2200, endMs: 2800, text: 'Later' },
    ]);
    expect(merged.map((cue) => cue.text)).toEqual(['The train left.', 'Later']);
    expect(merged[0]?.endMs).toBe(1400);
  });

  it('does not glue two finished captions into a misleading sentence', () => {
    const merged = mergeWordCues([
      { id: 'a', startMs: 0, endMs: 2000, text: 'The station opens at dawn.' },
      { id: 'b', startMs: 2100, endMs: 4200, text: 'A red train waits at platform two.' },
    ]);
    expect(merged.map((cue) => cue.text)).toEqual([
      'The station opens at dawn.',
      'A red train waits at platform two.',
    ]);
  });
});

describe('sentence-cue merging', () => {
  it('joins mid-sentence VOD fragments and translates the sentence once across their span', () => {
    const merged = mergeSentenceCues([
      {
        id: 'a',
        startMs: 0,
        endMs: 1800,
        text: 'the north window sells tickets that do not',
      },
      {
        id: 'b',
        startMs: 1800,
        endMs: 3600,
        text: 'require a reservation for the red train.',
      },
      { id: 'c', startMs: 3700, endMs: 5000, text: 'After dawn it' },
      { id: 'd', startMs: 5000, endMs: 7200, text: 'opens again.' },
    ]);
    expect(merged.map((cue) => cue.text)).toEqual([
      'the north window sells tickets that do not require a reservation for the red train.',
      'After dawn it opens again.',
    ]);
    expect(merged[0]).toMatchObject({ startMs: 0, endMs: 3600 });
    expect(merged[1]).toMatchObject({ startMs: 3700, endMs: 7200 });
  });

  it('splits a cue that already contains a sentence end plus leftover words', () => {
    const merged = mergeSentenceCues([
      { id: 'a', startMs: 0, endMs: 2000, text: 'only the beginning. With' },
      { id: 'b', startMs: 2000, endMs: 4200, text: 'the first train leaving.' },
    ]);
    expect(merged.map((cue) => cue.text)).toEqual([
      'only the beginning.',
      'With the first train leaving.',
    ]);
  });

  it('keeps creator-track cue text as-is and only sentence-merges ASR', () => {
    const fragments = [
      {
        id: 'a',
        startMs: 0,
        endMs: 1800,
        text: 'the north window sells tickets that do not',
      },
      {
        id: 'b',
        startMs: 1800,
        endMs: 3600,
        text: 'require a reservation for the red train.',
      },
    ];
    expect(finalizeCaptionCues(fragments).map((cue) => cue.text)).toEqual([
      'the north window sells tickets that do not',
      'require a reservation for the red train.',
    ]);
    expect(finalizeCaptionCues(fragments, undefined, { asr: true }).map((cue) => cue.text)).toEqual(
      ['the north window sells tickets that do not require a reservation for the red train.'],
    );
  });

  it('collapses growing Japanese ASR windows and joins CJK without spaces', () => {
    expect(joinCaptionFragments('駅は', '夜明けに')).toBe('駅は夜明けに');
    const growing = collapseGrowingCaptionCues([
      { id: 'a', startMs: 0, endMs: 2500, text: '駅は', language: 'ja' },
      { id: 'b', startMs: 400, endMs: 2500, text: '駅は夜明けに', language: 'ja' },
      { id: 'c', startMs: 800, endMs: 2500, text: '駅は夜明けに開きます', language: 'ja' },
    ]);
    expect(growing).toEqual([
      expect.objectContaining({
        startMs: 0,
        endMs: 2500,
        text: '駅は夜明けに開きます',
      }),
    ]);
    const asr = finalizeCaptionCues(
      [
        { id: 'a', startMs: 0, endMs: 2500, text: '駅は', language: 'ja' },
        { id: 'b', startMs: 400, endMs: 2500, text: '駅は夜明けに', language: 'ja' },
        { id: 'c', startMs: 800, endMs: 2500, text: '駅は夜明けに開きます', language: 'ja' },
        {
          id: 'd',
          startMs: 4200,
          endMs: 6700,
          text: '赤い列車が2番線で待っています',
          language: 'ja',
        },
      ],
      undefined,
      { asr: true },
    );
    expect(asr.map((cue) => cue.text)).toEqual([
      '駅は夜明けに開きます',
      '赤い列車が2番線で待っています',
    ]);
    // A 1.7s silence is longer than the ASR gap-fill, so the finished line ends here
    // instead of stretching to the next phrase.
    expect(asr[0]?.endMs).toBe(2500);
    expect(cueAtTime(asr, 2000)?.text).toBe('駅は夜明けに開きます');
    expect(cueAtTime(asr, 3000)).toBeNull();
    expect(asr.every((cue) => cue.text.trim().length > 0)).toBe(true);
    expect(asr.every((cue) => cue.text.length < 80)).toBe(true);
  });

  it('caps Japanese ASR sentence merges so they stay translatable', () => {
    const cues = Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`,
      startMs: index * 2000,
      endMs: index * 2000 + 1800,
      text: 'あいうえおかきくけこ'.repeat(3),
      language: 'ja',
    }));
    const asr = finalizeCaptionCues(cues, undefined, { asr: true });
    expect(asr.length).toBeGreaterThan(1);
    expect(asr.every((cue) => cue.text.trim().length > 0)).toBe(true);
    expect(asr.every((cue) => cue.text.length <= 80)).toBe(true);
    expect(asr.every((cue) => cue.endMs - cue.startMs <= 6_000)).toBe(true);
  });

  it('keeps continuous auto-caption phrases short enough to translate while speaking', () => {
    const cues = Array.from({ length: 30 }, (_, index) => ({
      id: `c${String(index)}`,
      startMs: index * 500,
      endMs: index * 500 + 500,
      text: `word${String(index)}`,
      language: 'en',
    }));
    const asr = finalizeCaptionCues(cues, undefined, { asr: true });
    expect(asr.length).toBeGreaterThan(1);
    expect(asr.every((cue) => cue.endMs - cue.startMs <= ASR_PHRASE_MERGE_MAX_MS)).toBe(true);
    expect(asr.every((cue) => cue.text.length <= 120)).toBe(true);
    expect(asr.map((cue) => cue.text).join(' ')).toContain('word0');
    expect(asr.map((cue) => cue.text).join(' ')).toContain('word29');
  });

  it('returns the playhead cue then the next few in order', () => {
    const cues = [
      { id: 'a', startMs: 0, endMs: 2000, text: 'one' },
      { id: 'b', startMs: 2000, endMs: 4000, text: 'two' },
      { id: 'c', startMs: 4000, endMs: 6000, text: 'three' },
      { id: 'd', startMs: 6000, endMs: 8000, text: 'four' },
    ];
    expect(cuesFromPlayhead(cues, 2500, 3).map((cue) => cue.text)).toEqual([
      'two',
      'three',
      'four',
    ]);
    expect(cuesFromPlayhead(cues, 0, 1).map((cue) => cue.text)).toEqual(['one']);
  });
});

describe('live caption buffer', () => {
  it('commits a growing auto-caption when the line finishes or sits still', () => {
    const buffer = new LiveCaptionBuffer();
    expect(buffer.update('The train', 0)).toEqual([]);
    expect(buffer.update('The train left', 200)).toEqual([]);
    expect(buffer.update('The train left.', 400)).toEqual(['The train left.']);
    expect(buffer.peek()).toBe('');

    expect(buffer.update('Tickets at the window', 500)).toEqual([]);
    expect(buffer.update('Tickets at the window', 500 + LIVE_CAPTION_MAX_WAIT_MS)).toEqual([
      'Tickets at the window',
    ]);
  });

  it('keeps one line id while text grows and changes it after a jump', () => {
    const buffer = new LiveCaptionBuffer();
    buffer.update('The', 0);
    const first = buffer.lineKey();
    buffer.update('The station', 100);
    expect(buffer.lineKey()).toBe(first);
    buffer.update('A red train', 200);
    expect(buffer.lineKey()).not.toBe(first);
    const second = buffer.lineKey();
    buffer.reset();
    expect(buffer.lineKey()).not.toBe(second);
  });

  it('emits the previous line when the on-screen caption jumps', () => {
    const buffer = new LiveCaptionBuffer();
    expect(buffer.update('The station opens', 0)).toEqual([]);
    expect(buffer.update('A red train waits', 300)).toEqual(['The station opens']);
    expect(buffer.peek()).toBe('A red train waits');
  });
});

describe('live caption stream', () => {
  it('commits a finished clause and keeps only the remainder as tail', () => {
    const stream = new LiveCaptionStream();
    const first = stream.update('The station opens at dawn.', 0);
    expect(first.committed.map((segment) => segment.text)).toEqual(['The station opens at dawn.']);
    expect(first.tail).toBe('');
    const next = stream.update('The station opens at dawn. A red', 1_000);
    expect(next.committed).toEqual([]);
    expect(next.tail).toBe('A red');
  });

  it('continues the mutable tail when a rolling window removes its committed prefix', () => {
    const stream = new LiveCaptionStream();
    const first = stream.update('The station opens at dawn. A red', 0);
    const committedSource = first.committed[0];
    expect(committedSource?.text).toBe('The station opens at dawn.');

    const next = stream.update('A red train waits', 500);
    expect(next.committed).toEqual([]);
    expect(next.tail).toBe('A red train waits');
    expect(next.lineChanged).toBe(false);
    expect(next.lineKey).toBe(first.lineKey);
    expect(committedSource?.text).toBe('The station opens at dawn.');

    const finished = stream.update('A red train waits.', 1_000);
    expect(finished.committed.map((segment) => segment.text)).toEqual(['A red train waits.']);
  });

  it('remaps committed text as a rolling window shrinks and extends', () => {
    const stream = new LiveCaptionStream();
    stream.update('The station opens at dawn. A red train', 0);

    const shrunk = stream.update('A red', 100);
    expect(shrunk.committed).toEqual([]);
    expect(shrunk.tail).toBe('A red');
    expect(stream.update('A red train waits', 200).tail).toBe('A red train waits');

    const retained = new LiveCaptionStream();
    retained.update('The station opens at dawn. A red', 0);
    const shifted = retained.update('at dawn. A red train', 300);
    expect(shifted.committed).toEqual([]);
    expect(shifted.tail).toBe('A red train');
    expect(
      retained.update('at dawn. A red train.', 400).committed.map((segment) => segment.text),
    ).toEqual(['A red train.']);

    const prefixShrink = new LiveCaptionStream();
    prefixShrink.update('The station opens at dawn. A red', 0);
    expect(prefixShrink.update('The station', 100).committed).toEqual([]);
    const regrown = prefixShrink.update('The station opens at dawn. A red train', 200);
    expect(regrown.committed).toEqual([]);
    expect(regrown.tail).toBe('A red train');

    const mutableShrink = new LiveCaptionStream();
    mutableShrink.update('The station opens at dawn. A red train', 0);
    const truncated = mutableShrink.update('red train waits', 300);
    expect(truncated.committed).toEqual([]);
    expect(truncated.tail).toBe('red train waits');
    expect(truncated.lineChanged).toBe(false);

    const alteredRegrowth = new LiveCaptionStream();
    alteredRegrowth.update('The station opens at dawn. A red', 0);
    alteredRegrowth.update('The station', 100);
    const altered = alteredRegrowth.update('The station closes at noon. A red', 200);
    expect(altered.committed.map((segment) => segment.text)).toEqual(['closes at noon.']);
    expect(altered.tail).toBe('A red');

    const cjk = new LiveCaptionStream();
    cjk.update('前文。あ', 0);
    const cjkRolling = cjk.update('あいう', 100);
    expect(cjkRolling.committed).toEqual([]);
    expect(cjkRolling.tail).toBe('あいう');
    expect(cjkRolling.lineChanged).toBe(false);
  });

  it('preserves the frozen suffix when rolling after a prefix shrink', () => {
    const stream = new LiveCaptionStream();
    stream.update('The station opens at dawn. A red', 0);
    stream.update('The station', 100);

    const regrown = stream.update('station opens at dawn. A red train', 200);
    expect(regrown.committed).toEqual([]);
    expect(regrown.tail).toBe('A red train');
    expect(regrown.lineChanged).toBe(false);
  });

  it('validates one- and two-character Latin overlaps against a saved frozen prefix', () => {
    for (const discard of [false, true]) {
      for (const removed of [1, 2]) {
        const stream = new LiveCaptionStream();
        stream.update('The station opens at dawn. A red', 0);
        if (discard) stream.discardTail(50);
        stream.update('The', 100);

        const regrown = stream.update(`The station opens at dawn. A red train`.slice(removed), 200);
        expect(regrown.committed).toEqual([]);
        expect(regrown.tail).toBe('A red train');
        expect(regrown.lineChanged).toBe(false);
      }
    }
  });

  it('preserves a frozen suffix through right-truncated rolling windows', () => {
    for (const discard of [false, true]) {
      const stream = new LiveCaptionStream();
      stream.update('The station opens at dawn.', 0);
      if (discard) stream.discardTail(50);
      expect(stream.update('daw', 100).committed).toEqual([]);
      expect(stream.update('dawn', 200).committed).toEqual([]);

      const regrown = stream.update('dawn. A red', 300);
      expect(regrown.committed).toEqual([]);
      expect(regrown.tail).toBe('A red');
      expect(regrown.lineChanged).toBe(false);
    }
  });

  it('authenticates repeated-character short overlaps against the frozen boundary', () => {
    for (const discard of [false, true]) {
      const stream = new LiveCaptionStream();
      stream.update('The station opens at dawn. A red', 0);
      if (discard) stream.discardTail(10);
      stream.update('The station open', 20);
      stream.update('t', 40);

      const regrown = stream.update('tion opens at dawn. A red train', 60);
      expect(regrown.committed).toEqual([]);
      expect(regrown.tail).toBe('A red train');
      expect(regrown.lineChanged).toBe(false);
    }
  });

  it('retains ambiguous direct boundaries until regrowth authenticates them', () => {
    const stream = new LiveCaptionStream();
    stream.update('The station opens at dawn.', 0);
    stream.update('n', 10);

    const regrown = stream.update('n opens at dawn.', 20);
    expect(regrown.committed).toEqual([]);
    expect(regrown.tail).toBe('');
    expect(regrown.lineChanged).toBe(false);
  });

  it('keeps periodic Latin and CJK suffixes frozen without reviving characters', () => {
    const cjk = new LiveCaptionStream();
    cjk.update('まああ', 0);
    cjk.update('まああ', 700);
    const rolled = cjk.update('ああです', 800);
    expect(rolled.committed).toEqual([]);
    expect(rolled.tail).toBe('です');
    const finished = cjk.update('ああです。', 900);
    expect(finished.committed.map((segment) => segment.text)).toEqual(['です。']);
    expect(finished.tail).toBe('');

    const latin = new LiveCaptionStream();
    latin.update('baaa', 0);
    latin.update('baaa', 700);
    const periodic = latin.update('aaX', 800);
    expect(periodic.committed).toEqual([]);
    expect(periodic.tail).toBe('X');
    expect(periodic.lineChanged).toBe(false);
  });

  it('keeps longer Latin candidates viable during periodic regrowth', () => {
    const stream = new LiveCaptionStream();
    stream.update('baaa', 0);
    stream.update('baaa', 700);
    for (const [index, visible] of ['a', 'aa', 'aaa'].entries()) {
      const update = stream.update(visible, 710 + index * 10);
      expect(update.committed).toEqual([]);
      expect(update.tail).toBe('');
      expect(update.lineChanged).toBe(false);
    }

    const punctuated = new LiveCaptionStream();
    punctuated.update('baaa', 0);
    punctuated.update('baaa', 700);
    punctuated.update('a', 710);
    punctuated.update('aa', 720);
    expect(punctuated.update('aaa.', 730).committed.map((segment) => segment.text)).toEqual(['.']);
  });

  it('keeps longer CJK candidates viable during periodic regrowth', () => {
    const stream = new LiveCaptionStream();
    stream.update('まああ', 0);
    stream.update('まああ', 700);
    for (const [index, visible] of ['あ', 'ああ', 'あああ'].entries()) {
      const update = stream.update(visible, 710 + index * 10);
      expect(update.committed).toEqual([]);
      // Only two あ were frozen in まああ; the third is genuinely new text.
      expect(update.tail).toBe(index === 2 ? 'あ' : '');
      expect(update.lineChanged).toBe(false);
    }

    const punctuated = new LiveCaptionStream();
    punctuated.update('まああ', 0);
    punctuated.update('まああ', 700);
    punctuated.update('あ', 710);
    punctuated.update('ああ', 720);
    expect(punctuated.update('あああ。', 730).committed.map((segment) => segment.text)).toEqual([
      'あ。',
    ]);
  });

  it('does not resolve a natural repeated word before the longer phrase completes', () => {
    const stream = new LiveCaptionStream();
    stream.update('This is', 0);
    stream.update('This is', 700);
    for (const [index, visible] of ['i', 'is', 'is is'].entries()) {
      const update = stream.update(visible, 710 + index * 10);
      expect(update.committed).toEqual([]);
      expect(update.tail).toBe('');
      expect(update.lineChanged).toBe(false);
    }
    expect(stream.update('is is.', 740).committed.map((segment) => segment.text)).toEqual(['.']);
  });

  it('uses only the authenticated boundary after periodic text diverges', () => {
    const stream = new LiveCaptionStream();
    stream.update('ababa', 0);
    stream.update('ababa', 700);
    expect(stream.update('ba', 710).tail).toBe('');
    expect(stream.update('bab', 720).tail).toBe('');

    const diverged = stream.update('babX.', 730);
    expect(diverged.committed.map((segment) => segment.text)).toEqual(['X.']);
    expect(diverged.tail).toBe('');
    expect(diverged.lineChanged).toBe(false);
  });

  it('seeds every repeated frozen-prefix occurrence on direct shrink', () => {
    for (const { source, shrunk, regrown, punctuation } of [
      { source: 'no no', shrunk: 'no', regrown: 'no.', punctuation: '.' },
      { source: 'ああ', shrunk: 'あ', regrown: 'あ。', punctuation: '。' },
    ]) {
      const stream = new LiveCaptionStream();
      stream.update(source, 0);
      stream.update(source, 700);
      expect(stream.update(shrunk, 710).committed).toEqual([]);

      const update = stream.update(regrown, 720);
      expect(update.committed.map((segment) => segment.text)).toEqual([punctuation]);
      expect(update.tail).toBe('');
      expect(update.lineChanged).toBe(false);
    }
  });

  it('retains every compatible long rolling overlap for later authentication', () => {
    const stream = new LiveCaptionStream();
    stream.update('go very go very go very', 0);
    stream.update('go very go very go very', 700);
    const rolled = stream.update('very go very', 710);
    expect(rolled.committed).toEqual([]);
    expect(rolled.tail).toBe('');

    const grown = stream.update('very go very fast', 720);
    expect(grown.committed).toEqual([]);
    expect(grown.tail).toBe('fast');
    const finished = stream.update('very go very fast.', 730);
    expect(finished.committed.map((segment) => segment.text)).toEqual(['fast.']);
    expect(finished.tail).toBe('');
  });

  it('never reopens a directly truncated frozen prefix on divergent regrowth', () => {
    for (const { source, shrunk, regrown, punctuation } of [
      { source: 'hello', shrunk: 'he', regrown: 'he.', punctuation: '.' },
      { source: 'あいう', shrunk: 'あい', regrown: 'あい。', punctuation: '。' },
      { source: 'aab', shrunk: 'aa', regrown: 'aa.', punctuation: '.' },
    ]) {
      const stream = new LiveCaptionStream();
      stream.update(source, 0);
      stream.update(source, 700);
      expect(stream.update(shrunk, 710).committed).toEqual([]);

      const update = stream.update(regrown, 720);
      expect(update.committed.map((segment) => segment.text)).toEqual([punctuation]);
      expect(update.tail).toBe('');
      expect(update.lineChanged).toBe(false);
    }
  });

  it('keeps frozen source closed across deterministic rolling-window fuzz sequences', () => {
    const sources = [
      'hello',
      'aab',
      'no no',
      'baaa',
      'This is',
      'go very go very',
      'あいう',
      'まああ',
    ];
    for (const source of sources) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const random = deterministicRandom(seed);
        const suffix = /[\u3040-\u30ff]/u.test(source) ? '。' : 'Z.';
        const full = `${source}${suffix}`;
        const stream = new LiveCaptionStream();
        stream.update(source, 0);
        stream.update(source, 700);
        let start = 0;
        let end = source.length;
        let now = 710;
        const operations: string[] = [];
        for (let step = 0; step < 32; step += 1) {
          const operation = Math.floor(random() * 3);
          if (operation === 0 && end > start + 1) {
            end = Math.max(start + 1, end - 1 - Math.floor(random() * 3));
          } else if (operation === 1 && start < full.length - 1) {
            start = Math.min(full.length - 1, start + 1 + Math.floor(random() * 3));
            end = Math.max(start + 1, end);
          } else {
            end = Math.min(full.length, end + 1 + Math.floor(random() * 4));
          }
          const visible = full.slice(start, end);
          operations.push(visible);
          now += 5;
          const update = stream.update(visible, now);
          // With no remaining overlap, a short window is a genuine replacement
          // rather than an authenticated continuation of this rolling sequence.
          if (update.lineChanged) break;
          for (const segment of update.committed) {
            expect(
              source.includes(segment.text),
              `${source} seed=${String(seed)} operations=${operations.join(' -> ')} emitted=${segment.text}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('recovers direct one- and two-character Latin frozen suffixes', () => {
    for (const visible of ['n.', '.']) {
      const stream = new LiveCaptionStream();
      stream.update('The station opens at dawn.', 0);
      const rolled = stream.update(visible, 100);
      expect(rolled.committed).toEqual([]);
      expect(rolled.tail).toBe('');
      expect(rolled.lineChanged).toBe(false);
    }
  });

  it('restores the pre-discard tail after repeated empty-DOM discards', () => {
    const stream = new LiveCaptionStream();
    stream.update('The station opens', 0);
    stream.discardTail(100);
    expect(stream.tail()).toBe('');
    stream.discardTail(150);
    expect(stream.tail()).toBe('');

    const restored = stream.update('The station opens', 200);
    expect(restored.committed).toEqual([]);
    expect(restored.tail).toBe('The station opens');
    expect(restored.tailChanged).toBe(true);
    expect(restored.lineChanged).toBe(false);

    const extended = new LiveCaptionStream();
    extended.update('The station opens', 0);
    extended.discardTail(100);
    extended.discardTail(150);
    expect(extended.update('The station opens at dawn', 200).tail).toBe(
      'The station opens at dawn',
    );
  });

  it('preserves the frozen suffix through empty-DOM truncated reappearance', () => {
    const stream = new LiveCaptionStream();
    stream.update('The station opens at dawn. A red', 0);
    stream.discardTail(100);
    stream.update('The station', 200);

    const regrown = stream.update('The station opens at dawn. A red train', 300);
    expect(regrown.committed).toEqual([]);
    expect(regrown.tail).toBe('A red train');
    expect(regrown.lineChanged).toBe(false);
  });

  it('does not revive a discarded tail on a different line or duplicate committed text', () => {
    const rolling = new LiveCaptionStream();
    rolling.update('The station opens at dawn. A red', 0);
    rolling.discardTail(100);
    rolling.discardTail(150);
    const restored = rolling.update('A red train waits', 200);
    expect(restored.committed).toEqual([]);
    expect(restored.tail).toBe('A red train waits');
    expect(restored.tailChanged).toBe(true);

    const replaced = new LiveCaptionStream();
    replaced.update('The station opens at dawn. A red', 0);
    replaced.discardTail(100);
    replaced.discardTail(150);
    const replacement = replaced.update('Tickets are sold at the window', 200);
    expect(replacement.committed).toEqual([]);
    expect(replacement.tail).toBe('Tickets are sold at the window');
    expect(replacement.lineChanged).toBe(true);
  });

  it('keeps a punctuation run with its preceding segment', () => {
    const stream = new LiveCaptionStream();
    const update = stream.update('Wait... Next', 0);
    expect(update.committed.map((segment) => segment.text)).toEqual(['Wait...']);
    expect(update.tail).toBe('Next');

    const mixed = new LiveCaptionStream().update('Really?! Next', 0);
    expect(mixed.committed.map((segment) => segment.text)).toEqual(['Really?!']);
    expect(mixed.tail).toBe('Next');
  });

  it('commits the previous line when the player replaces it', () => {
    const stream = new LiveCaptionStream();
    stream.update('The station opens', 0);
    const update = stream.update('A red train waits', 500);
    expect(update.lineChanged).toBe(true);
    expect(update.committed.map((segment) => segment.text)).toEqual(['The station opens']);
    expect(update.tail).toBe('A red train waits');

    const suffixOverlap = new LiveCaptionStream();
    suffixOverlap.update('Hello world', 0);
    const replacement = suffixOverlap.update('dog', 100);
    expect(replacement.lineChanged).toBe(true);
    expect(replacement.committed.map((segment) => segment.text)).toEqual(['Hello world']);
    expect(replacement.tail).toBe('dog');

    const committedOverlap = new LiveCaptionStream();
    committedOverlap.update('The station opens at dawn. A red', 0);
    const committedReplacement = committedOverlap.update('dog barks', 100);
    expect(committedReplacement.lineChanged).toBe(true);
    expect(committedReplacement.committed.map((segment) => segment.text)).toEqual(['A red']);
    expect(committedReplacement.tail).toBe('dog barks');
  });

  it('closes an unpunctuated tail after a short ASR gap without re-emitting it', () => {
    const stream = new LiveCaptionStream();
    stream.update('the train waits', 0);
    expect(stream.update('the train waits', 100).committed).toEqual([]);
    const closed = stream.update('the train waits', LIVE_SEGMENT_GAP_MS + 1);
    expect(closed.committed.map((segment) => segment.text)).toEqual(['the train waits']);
    expect(closed.tail).toBe('');
    expect(stream.update('the train waits', LIVE_SEGMENT_GAP_MS + 500).committed).toEqual([]);
  });
});

describe('YouTube player response', () => {
  it('reads caption tracks and prefers a manual track that is not the target', () => {
    const parsed = parsePlayerResponseScript(`
      var ytInitialPlayerResponse = {
        "captions": {
          "playerCaptionsTracklistRenderer": {
            "captionTracks": [
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=fixture&lang=ja&fmt=srv3",
                "languageCode": "ja",
                "kind": "asr",
                "name": { "simpleText": "Japanese (auto-generated)" },
                "vssId": "a.ja"
              },
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=fixture&lang=en",
                "languageCode": "en",
                "name": { "simpleText": "English" },
                "vssId": ".en"
              }
            ]
          }
        }
      };
    `);
    const tracks = captionTracksFromPlayerResponse(parsed);
    expect(tracks).toHaveLength(2);
    expect(selectCaptionTrack(tracks, 'ja')).toMatchObject({
      languageCode: 'en',
      asr: false,
    });
    expect(withTimedtextFormat(tracks[1]?.baseUrl ?? '', 'json3')).toContain('fmt=json3');
    expect(withTimedtextFormat(tracks[0]?.baseUrl ?? '', 'json3')).not.toContain('fmt=srv3');
    expect(
      withTimedtextFormat(
        'https://www.youtube.com/api/timedtext?v=fixture&lang=ja&kind=asr&tlang=en',
        'json3',
      ),
    ).not.toContain('tlang=');
    expect(captionLanguagePrefix('a.ja')).toBe('ja');
    expect(captionLanguagePrefix('.ja')).toBe('ja');
    expect(selectCaptionTrack(tracks, 'en', 'ja')).toMatchObject({
      languageCode: 'ja',
      asr: true,
      vssId: 'a.ja',
    });
    expect(
      selectCaptionTrack(
        [
          ...tracks,
          {
            baseUrl: '/ja-manual',
            languageCode: 'ja',
            name: 'Japanese',
            asr: false,
            vssId: '.ja',
          },
        ],
        'en',
        'ja',
      ),
    ).toMatchObject({ languageCode: 'ja', asr: false });
    expect(withTimedtextFormat('/youtube-timedtext.json', 'json3')).toBe(
      '/youtube-timedtext.json?fmt=json3',
    );
  });

  it('prefers the spoken language and English, never the first translated track', () => {
    const parsed = parsePlayerResponseScript(`
      var ytInitialPlayerResponse = {
        "videoDetails": { "defaultAudioLanguage": "en" },
        "captions": {
          "playerCaptionsTracklistRenderer": {
            "captionTracks": [
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=fixture&lang=af",
                "languageCode": "af",
                "name": { "simpleText": "Afrikaans" },
                "vssId": ".af"
              },
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=fixture&lang=de",
                "languageCode": "de",
                "name": { "simpleText": "German" },
                "vssId": ".de"
              },
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=fixture&lang=en",
                "languageCode": "en",
                "name": { "simpleText": "English" },
                "vssId": ".en"
              },
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=fixture&lang=en&kind=asr",
                "languageCode": "en",
                "kind": "asr",
                "name": { "simpleText": "English (auto)" },
                "vssId": "a.en"
              }
            ],
            "audioTracks": [{ "audioTrackId": "en.0", "defaultCaptionTrackIndex": 2 }],
            "defaultAudioTrackIndex": 0
          }
        }
      };
    `);
    const tracks = captionTracksFromPlayerResponse(parsed);
    expect(spokenLanguageFromPlayerResponse(parsed)).toBe('en');
    expect(
      selectCaptionTrack(tracks, 'ja', spokenLanguageFromPlayerResponse(parsed)),
    ).toMatchObject({
      languageCode: 'en',
      asr: false,
    });
    expect(selectCaptionTrack(tracks, 'ja')).toMatchObject({ languageCode: 'en', asr: false });
    expect(selectCaptionTrack(tracks, 'ja')?.languageCode).not.toBe('af');
    expect(
      selectCaptionTrack(
        [
          {
            baseUrl: '/asr',
            languageCode: 'en',
            name: 'English (auto)',
            asr: true,
            vssId: 'a.en',
          },
          {
            baseUrl: '/manual',
            languageCode: 'en',
            name: 'English',
            asr: false,
            vssId: '.en',
          },
        ],
        'ja',
        'en',
      ),
    ).toMatchObject({ baseUrl: '/manual', asr: false });
  });

  it('parses the e2e YouTube fixture as quoted JSON, the way the watch page ships it', () => {
    const html = readFileSync(
      join(import.meta.dirname, '../e2e/fixtures/youtube-captions.html'),
      'utf8',
    );
    const parsed = parsePlayerResponseScript(html);
    expect(captionTracksFromPlayerResponse(parsed)).toEqual([
      expect.objectContaining({
        baseUrl: '/youtube-timedtext.json',
        languageCode: 'ja',
        asr: false,
      }),
    ]);
  });

  it('reads a watch URL video id', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk');
    expect(youtubeVideoId('https://youtu.be/abcdefghijk')).toBe('abcdefghijk');
    expect(youtubeVideoId('https://www.youtube.com/embed/abcdefghijk')).toBe('abcdefghijk');
    expect(youtubeVideoId('https://www.youtube.com/live/abcdefghijk')).toBe('abcdefghijk');
  });

  it('detects a live player and prefers the ASR track', () => {
    expect(
      isYouTubeLivePlayer({
        videoDetails: { isLive: true },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
      }),
    ).toBe(true);
    const tracks = captionTracksFromPlayerResponse({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=live&lang=en',
              languageCode: 'en',
              name: { simpleText: 'English' },
              vssId: '.en',
            },
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=live&lang=ja&kind=asr',
              languageCode: 'ja',
              kind: 'asr',
              name: { simpleText: 'Japanese (auto)' },
              vssId: 'a.ja',
            },
          ],
        },
      },
    });
    expect(selectLiveCaptionTrack(tracks, 'en')).toMatchObject({
      languageCode: 'ja',
      asr: true,
    });
  });
});

describe('target-language caption filter', () => {
  it('cuts Japanese glued onto an English source line', () => {
    expect(
      stripTargetLanguageFromCaption(
        'the north window sells tickets, 北側窓口では予約不要の切符を売っています',
        'ja',
      ),
    ).toBe('the north window sells tickets,');
  });

  it('rejects a Japanese-only caption when the target is Japanese', () => {
    expect(captionTextIsTargetLanguage('北側窓口では予約不要の切符を売っています。', 'ja')).toBe(
      true,
    );
    expect(stripTargetLanguageFromCaption('北側窓口では予約不要の切符を売っています。', 'ja')).toBe(
      '',
    );
  });

  it('keeps English when the target is Japanese', () => {
    expect(captionTextIsTargetLanguage('a red train waits at platform two.', 'ja')).toBe(false);
    expect(stripTargetLanguageFromCaption('a red train waits at platform two.', 'ja')).toBe(
      'a red train waits at platform two.',
    );
  });

  it('keeps Japanese captions when the target is Easy Japanese', () => {
    const japanese = '北側窓口では予約不要の切符を売っています。';
    expect(captionTextIsTargetLanguage(japanese, 'ja-easy')).toBe(false);
    expect(stripTargetLanguageFromCaption(japanese, 'ja-easy')).toBe(japanese);
    expect(captionSourceIsTargetLanguage('ja', japanese, 'ja-easy')).toBe(false);
  });

  it('does not strip Japanese when the target is English', () => {
    expect(stripTargetLanguageFromCaption('北側窓口では予約不要の切符を売っています。', 'en')).toBe(
      '北側窓口では予約不要の切符を売っています。',
    );
    expect(captionSourceIsTargetLanguage('a.ja', undefined, 'en')).toBe(false);
    expect(captionSourceIsTargetLanguage('ja', '駅は夜明けに開きます。', 'en')).toBe(false);
  });

  it('treats a known source language as the target only when prefixes match', () => {
    expect(captionSourceIsTargetLanguage('ja', '駅は夜明けに開きます。', 'ja')).toBe(true);
    expect(captionSourceIsTargetLanguage('a.ja', undefined, 'ja')).toBe(true);
    expect(captionSourceIsTargetLanguage('ja-JP', undefined, 'ja')).toBe(true);
    expect(
      captionSourceIsTargetLanguage('en', '北側窓口では予約不要の切符を売っています。', 'ja'),
    ).toBe(false);
    expect(captionSourceIsTargetLanguage(undefined, '駅は夜明けに開きます。', 'ja')).toBe(true);
    expect(
      captionSourceIsTargetLanguage(undefined, 'a red train waits at platform two.', 'ja'),
    ).toBe(false);
  });
});

describe('caption overlay placement and priority', () => {
  it('sits above the bottom edge of the video', () => {
    const box = captionOverlayBox({ left: 100, top: 40, width: 640, height: 360 });
    expect(box.left).toBe(420);
    expect(box.top).toBe(40 + 360 - 18);
    expect(box.width).toBeGreaterThan(160);
    expect(box.width).toBeLessThanOrEqual(640);
  });

  it('lifts further when YouTube chrome height is passed in', () => {
    const box = captionOverlayBox({ left: 0, top: 0, width: 640, height: 360 }, 72);
    expect(box.top).toBe(360 - 72);
  });

  it('tracks a wide player instead of capping at 720px', () => {
    const box = captionOverlayBox({ left: 0, top: 0, width: 1280, height: 720 });
    expect(box.width).toBeGreaterThan(720);
    expect(box.width).toBeCloseTo(1280 * 0.94);
    expect(captionOverlayFontPx(720)).toBeGreaterThanOrEqual(22);
    expect(captionOverlayFontPx(360, 32, 100)).toBe(32);
    expect(captionOverlayFontPx(360, 32)).toBeLessThan(32);
  });

  it('keeps live captions ahead of page prose and prefetch behind nearby prose', () => {
    expect(CAPTION_PLAYHEAD_PRIORITY).toBeGreaterThan(0);
    expect(CAPTION_PLAYHEAD_PRIORITY).toBeLessThan(CAPTION_LIVE_PRIORITY);
    expect(CAPTION_LIVE_PRIORITY).toBeLessThan(10);
    expect(CAPTION_PREFETCH_PRIORITY).toBeGreaterThan(22);
    expect(CAPTION_PREFETCH_PRIORITY).toBeLessThan(34);
  });
});

describe('HTML5 caption tracks', () => {
  it('hides a showing track so the browser does not paint a second overlay', () => {
    const track = { kind: 'subtitles', language: 'ja', mode: 'showing' as TextTrackMode };
    expect(revealTrackCues(track as TextTrack)).toBe('showing');
    expect(track.mode).toBe('hidden');
  });

  it('prefers a track that is not already the target language', () => {
    const tracks = [
      { kind: 'subtitles', language: 'en', mode: 'disabled' },
      { kind: 'subtitles', language: 'ja', mode: 'disabled' },
    ] as TextTrack[];
    expect(pickCaptionTrack(tracks, 'en')?.language).toBe('ja');
  });

  it('only resolves caption URLs that share the watch tab origin', () => {
    const page = 'https://www.youtube.com/watch?v=abcdefghijk';
    expect(resolveSameOriginCaptionUrl(page, '/api/timedtext?v=abcdefghijk')).toBe(
      'https://www.youtube.com/api/timedtext?v=abcdefghijk',
    );
    expect(resolveSameOriginCaptionUrl(page, 'https://evil.example/steal')).toBeNull();
    expect(resolveSameOriginCaptionUrl(page, 'javascript:alert(1)')).toBeNull();
  });

  it('allows a twimg VTT URL only from an X watch tab', () => {
    const twimg = 'https://video.twimg.com/subtitles/fixture.vtt';
    expect(resolveCaptionFetchUrl('https://x.com/i/status/1', twimg)).toBe(twimg);
    expect(resolveCaptionFetchUrl('https://www.youtube.com/watch?v=abcdefghijk', twimg)).toBeNull();
    const hls = 'https://video.twimg.com/amplify_video/1/pl/en.m3u8';
    expect(resolveCaptionFetchUrl('https://x.com/i/status/1', hls)).toBe(hls);
    expect(
      resolveCaptionFetchUrl(
        'https://x.com/i/status/1',
        'https://video.twimg.com/ext_tw_video/1.mp4',
      ),
    ).toBeNull();
  });
});

describe('timedtext fetch guard', () => {
  it('allows at most three attempts per video+track with backoff between them', () => {
    const guard = new TimedtextFetchGuard();
    const key = 'yt:fixture:/timedtext';
    expect(guard.allow(key, 0)).toBe(true);
    expect(guard.begin(key)).toBe(true);
    expect(guard.allow(key, 0)).toBe(false);
    guard.fail(key, 0);
    expect(guard.allow(key, 0)).toBe(false);
    expect(guard.exhausted(key)).toBe(false);
    expect(guard.allow(key, 999)).toBe(false);
    expect(guard.allow(key, 1_000)).toBe(true);
    guard.begin(key);
    guard.fail(key, 1_000);
    expect(guard.allow(key, 4_999)).toBe(false);
    expect(guard.allow(key, 5_000)).toBe(true);
    guard.begin(key);
    guard.fail(key, 5_000);
    expect(guard.allow(key, 60_000)).toBe(false);
    expect(guard.exhausted(key)).toBe(true);
    expect(TIMEDTEXT_MAX_ATTEMPTS).toBe(3);
  });
});
