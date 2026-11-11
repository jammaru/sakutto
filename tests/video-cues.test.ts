import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cueAtTime,
  cuesInWindow,
  LiveCaptionBuffer,
  LIVE_CAPTION_MAX_WAIT_MS,
  mergeWordCues,
  parseTimedtextJson3,
  parseWebVtt,
} from '@/captions/cues';
import {
  captionTracksFromPlayerResponse,
  parsePlayerResponseScript,
  isYouTubeLivePlayer,
  selectCaptionTrack,
  selectLiveCaptionTrack,
  withTimedtextFormat,
  youtubeVideoId,
} from '@/captions/youtube';
import { resolveCaptionFetchUrl } from '@/captions/timedtext';
import { captionOverlayBox } from '@/captions/overlay';
import { CAPTION_LIVE_PRIORITY, CAPTION_PREFETCH_PRIORITY } from '@/captions/engine';
import { pickCaptionTrack, revealTrackCues } from '@/captions/html5';
import { resolveSameOriginCaptionUrl } from '@/captions/timedtext';

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
    expect(withTimedtextFormat('/youtube-timedtext.json', 'json3')).toBe(
      '/youtube-timedtext.json?fmt=json3',
    );
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

describe('caption overlay placement and priority', () => {
  it('sits above the bottom edge of the video', () => {
    const box = captionOverlayBox({ left: 100, top: 40, width: 640, height: 360 });
    expect(box.left).toBe(420);
    expect(box.top).toBe(40 + 360 - 14);
    expect(box.width).toBeGreaterThan(160);
    expect(box.width).toBeLessThanOrEqual(640);
  });

  it('keeps live captions ahead of page prose and prefetch behind nearby prose', () => {
    expect(CAPTION_LIVE_PRIORITY).toBeGreaterThan(0);
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
  });
});
