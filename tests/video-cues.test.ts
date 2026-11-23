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
  ASR_PHRASE_MERGE_MAX_MS,
  buildSentenceUnitsFromTrack,
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

describe('timedtext sentence units', () => {
  it('dedupes rolling repeated prefixes and keeps the full time span', () => {
    const json3 = {
      events: [
        { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'my' }] },
        { tStartMs: 400, dDurationMs: 1200, segs: [{ utf8: 'my hands' }] },
        { tStartMs: 800, dDurationMs: 1600, segs: [{ utf8: 'my hands are' }] },
        { tStartMs: 1400, dDurationMs: 1400, segs: [{ utf8: 'hands are cold.' }] },
      ],
    };
    const units = buildSentenceUnitsFromTrack(parseTimedtextJson3(json3, 'en'), json3);
    expect(units.map((cue) => cue.text)).toEqual(['my hands are cold.']);
    expect(units[0]).toMatchObject({ startMs: 0, endMs: 2800, language: 'en' });
  });

  it('handles fragmented slop/gold rolling windows and a pause', () => {
    const json3 = {
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'this ' }, { utf8: 'slop' }] },
        { tStartMs: 500, dDurationMs: 1700, segs: [{ utf8: 'this slop sells' }] },
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'slop sells, but' }] },
        { tStartMs: 1800, dDurationMs: 1800, segs: [{ utf8: 'but the gold' }] },
        { tStartMs: 2600, dDurationMs: 1800, segs: [{ utf8: 'the gold is real.' }] },
        { tStartMs: 5200, dDurationMs: 700, segs: [{ utf8: 'and' }] },
        { tStartMs: 6000, dDurationMs: 1000, segs: [{ utf8: 'and it shines.' }] },
      ],
    };
    const units = buildSentenceUnitsFromTrack([], json3);
    expect(units.map((cue) => cue.text)).toEqual([
      'this slop sells, but the gold is real.',
      'and it shines.',
    ]);
    expect(units[0]).toMatchObject({ startMs: 0, endMs: 4400 });
    expect(units[1]).toMatchObject({ startMs: 5200, endMs: 7000 });
  });

  it('merges manual fragments and tiny unfinished units at build time', () => {
    const units = buildSentenceUnitsFromTrack([
      { id: 'a', startMs: 0, endMs: 900, text: 'The north window', language: 'en' },
      { id: 'b', startMs: 900, endMs: 1800, text: 'sells tickets,', language: 'en' },
      { id: 'c', startMs: 1800, endMs: 2800, text: 'and opens at dawn.', language: 'en' },
      { id: 'd', startMs: 3600, endMs: 4000, text: 'Well', language: 'en' },
      { id: 'e', startMs: 4800, endMs: 6000, text: 'we should go.', language: 'en' },
    ]);
    expect(units.map((cue) => cue.text)).toEqual([
      'The north window sells tickets, and opens at dawn.',
      'Well we should go.',
    ]);
    expect(units[0]).toMatchObject({ startMs: 0, endMs: 2800 });
    expect(units[1]).toMatchObject({ startMs: 3600, endMs: 6000 });
  });

  it('dedupes Japanese rolling windows without inserting spaces', () => {
    const json3 = {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: '駅は' }] },
        { tStartMs: 400, dDurationMs: 2000, segs: [{ utf8: '駅は夜明けに' }] },
        { tStartMs: 800, dDurationMs: 2000, segs: [{ utf8: '夜明けに開きます。' }] },
        { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: '赤い' }] },
        { tStartMs: 4500, dDurationMs: 1100, segs: [{ utf8: '赤い列車が' }] },
        { tStartMs: 5000, dDurationMs: 1500, segs: [{ utf8: '列車が来ます。' }] },
      ],
    };
    const units = buildSentenceUnitsFromTrack([], json3);
    expect(units.map((cue) => cue.text)).toEqual(['駅は夜明けに開きます。', '赤い列車が来ます。']);
    expect(units[0]).toMatchObject({ startMs: 0, endMs: 2800 });
    expect(units[1]).toMatchObject({ startMs: 4000, endMs: 6500 });
  });

  it('splits long units at clauses and caps continuous speech near seven seconds', () => {
    const long = buildSentenceUnitsFromTrack([
      {
        id: 'long',
        startMs: 0,
        endMs: 8000,
        text: 'The first clause explains the station and its early trains, while the second clause explains where passengers buy their tickets.',
        language: 'en',
      },
    ]);
    expect(long.length).toBeGreaterThan(1);
    expect(long[0]?.text.endsWith(',')).toBe(true);
    expect(long[0]?.startMs).toBe(0);
    expect(long.at(-1)?.endMs).toBe(8000);

    const continuous = buildSentenceUnitsFromTrack(
      Array.from({ length: 16 }, (_, index) => ({
        id: String(index),
        startMs: index * 500,
        endMs: index * 500 + 500,
        text: `word${index}`,
        language: 'en',
      })),
    );
    expect(continuous.length).toBeGreaterThan(1);
    expect(continuous.every((cue) => cue.endMs - cue.startMs <= 7000)).toBe(true);
    expect(continuous.every((cue) => cue.text.length <= 84)).toBe(true);
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
    expect(guard.allow(key, 999)).toBe(false);
    expect(guard.allow(key, 1_000)).toBe(true);
    guard.begin(key);
    guard.fail(key, 1_000);
    expect(guard.allow(key, 4_999)).toBe(false);
    expect(guard.allow(key, 5_000)).toBe(true);
    guard.begin(key);
    guard.fail(key, 5_000);
    expect(guard.allow(key, 60_000)).toBe(false);
    expect(TIMEDTEXT_MAX_ATTEMPTS).toBe(3);
  });
});
