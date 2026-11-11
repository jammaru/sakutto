// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageEngine } from '@/dom/session';
import { fakeTranslateText } from '@/dom/fake-engine';
import { VideoCaptionSession } from '@/captions/session';

const labels = {
  label: 'Translated captions',
  pending: 'Translating caption…',
  showOriginal: 'Show original caption',
  hideOriginal: 'Hide original caption',
};

const engine: PageEngine = {
  async *translate(segments, options) {
    for (const segment of segments) {
      yield {
        id: segment.id,
        final: fakeTranslateText(segment.text, options.tgt),
        engine: 'plamo',
      };
    }
  },
};

const TIMEDTEXT = {
  events: [
    {
      tStartMs: 0,
      dDurationMs: 4000,
      segs: [{ utf8: 'The station opens at dawn.' }],
    },
  ],
};

describe('video caption session', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('prefetches a YouTube-style timedtext track and paints the overlay', async () => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "captions": {
            "playerCaptionsTracklistRenderer": {
              "captionTracks": [{
                "baseUrl": "/youtube-timedtext.json",
                "languageCode": "en",
                "name": { "simpleText": "English" }
              }]
            }
          }
        };
      </script>
    `;
    const video = document.querySelector('video');
    if (video) video.currentTime = 0.4;

    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => JSON.stringify(TIMEDTEXT),
    });
    session.start();
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
    });
    expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
      'The station opens at dawn.',
    );
    session.setPreferences({
      enabled: false,
      targetLanguage: 'ja',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
    });
    expect(document.querySelector('sakutto-captions')).toBeNull();
    session.stop();
  });

  it('shows the live original immediately and replaces it with the translation', async () => {
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player ytp-live">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container">
          <span class="ytp-caption-segment">The station opens at dawn.</span>
        </div>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "videoDetails": { "videoId": "fixturelive01", "isLive": true }
        };
      </script>
    `;
    const video = document.querySelector('video');
    if (video) video.currentTime = 0.4;

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new VideoCaptionSession(document, {
      engine: delayedEngine(gate),
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => '',
    });
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const pendingHost = document.querySelector('sakutto-captions');
    expect(pendingHost?.getAttribute('data-sakutto-caption')).not.toBe(
      'The station opens at dawn.',
    );
    expect(pendingHost?.textContent ?? '').not.toContain('Translating');
    release?.();
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe('The station opens at dawn.');
    });
    session.stop();
  });

  it('does not refetch empty timedtext on DOM mutations', async () => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container">
          <span class="ytp-caption-segment">The station opens at dawn.</span>
        </div>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "videoDetails": { "defaultAudioLanguage": "en" },
          "captions": {
            "playerCaptionsTracklistRenderer": {
              "captionTracks": [{
                "baseUrl": "/youtube-timedtext.json",
                "languageCode": "en",
                "name": { "simpleText": "English" }
              }]
            }
          }
        };
      </script>
    `;
    const video = document.querySelector('video');
    if (video) video.currentTime = 0.4;
    let fetches = 0;
    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => {
        fetches += 1;
        return '';
      },
    });
    session.start();
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe('The station opens at dawn.');
    });
    const segment = document.querySelector('.ytp-caption-segment');
    for (let index = 0; index < 40; index += 1) {
      if (segment) segment.textContent = `The station opens at dawn. ${String(index)}`;
      document.body.append(document.createElement('div'));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetches).toBeLessThanOrEqual(3);
    // json3 then vtt on the first empty attempt; mutations must not add more.
    expect(fetches).toBe(2);
    session.stop();
  });

  it('translates a synthetic X VTT on the playing video only', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <video id="idle"></video>
      <video id="playing">
        <track kind="subtitles" src="https://video.twimg.com/subtitles/fixture.vtt" srclang="en" />
      </video>
    `;
    const idle = doc.querySelector('#idle') as unknown as HTMLVideoElement;
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    stubMedia(idle, { paused: true, width: 800, height: 450 });
    stubMedia(playing, { paused: false, width: 320, height: 180, currentTime: 0.4 });

    const session = new VideoCaptionSession(doc as unknown as Document, {
      engine,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => `WEBVTT

00:00:00.000 --> 00:00:02.000
The station opens at dawn.
`,
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });
    session.stop();
    view.close();
  });

  it('paints an X VTT whose cues start one hour in', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <video id="playing">
        <track kind="subtitles" src="https://video.twimg.com/subtitles/fixture.vtt" srclang="en" />
      </video>
    `;
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    stubMedia(playing, { paused: false, width: 320, height: 180, currentTime: 2, duration: 86.7 });

    const session = new VideoCaptionSession(doc as unknown as Document, {
      engine,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => `WEBVTT

01:00:01.583 --> 01:00:04.000
The station opens at dawn.
`,
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });
    session.stop();
    view.close();
  });

  it('ignores a YouTube auto-translate window so Japanese cannot leak into the source', async () => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container">
          <div class="caption-window" lang="en">
            <span class="ytp-caption-segment">the north window sells tickets that do not require a reservation.</span>
          </div>
          <div class="caption-window" lang="ja">
            <span class="ytp-caption-segment">北側窓口では予約不要の切符を売っています。</span>
          </div>
        </div>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "videoDetails": { "defaultAudioLanguage": "en" },
          "captions": {
            "playerCaptionsTracklistRenderer": {
              "captionTracks": [{
                "baseUrl": "/youtube-timedtext.json",
                "languageCode": "en",
                "name": { "simpleText": "English" }
              }]
            }
          }
        };
      </script>
    `;
    const video = document.querySelector('video');
    if (video) video.currentTime = 0.4;
    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => '',
    });
    session.start();
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe('the north window sells tickets that do not require a reservation.');
    });
    const original = document
      .querySelector('sakutto-captions')
      ?.getAttribute('data-sakutto-original');
    expect(original).not.toMatch(/北側|切符|予約/);
    expect(
      document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption'),
    ).not.toMatch(/北側窓口では/);

    const english = document.querySelector('.caption-window[lang="en"] .ytp-caption-segment');
    if (english) {
      english.textContent = 'a red train waits at platform two.';
    }
    await vi.waitFor(
      () => {
        const next = document
          .querySelector('sakutto-captions')
          ?.getAttribute('data-sakutto-original');
        expect(next).toBe('a red train waits at platform two.');
      },
      { timeout: 3_000 },
    );
    expect(
      document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
    ).not.toMatch(/北側|切符|予約/);
    session.stop();
  });

  it('paints nothing when the playing X video has no captions', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = '<video id="playing"></video>';
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    stubMedia(playing, { paused: false, width: 320, height: 180, currentTime: 0.4 });

    const session = new VideoCaptionSession(doc as unknown as Document, {
      engine,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => {
        throw new Error('no captions should be fetched');
      },
    });
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const host = doc.querySelector('sakutto-captions');
    expect(host?.hasAttribute('data-sakutto-caption')).toBeFalsy();
    expect(host?.hasAttribute('hidden')).toBe(true);
    session.stop();
    view.close();
  });
});

function delayedEngine(gate: Promise<void>): PageEngine {
  return {
    async *translate(segments, options) {
      await gate;
      for (const segment of segments) {
        yield {
          id: segment.id,
          final: fakeTranslateText(segment.text, options.tgt),
          engine: 'plamo',
        };
      }
    },
  };
}

function stubMedia(
  video: HTMLVideoElement,
  options: {
    paused: boolean;
    width: number;
    height: number;
    currentTime?: number;
    duration?: number;
  },
): void {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => options.paused });
  Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(video, 'muted', { configurable: true, get: () => true });
  Object.defineProperty(video, 'volume', { configurable: true, get: () => 1 });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => options.currentTime ?? 0,
    set: () => undefined,
  });
  Object.defineProperty(video, 'duration', {
    configurable: true,
    get: () => options.duration ?? 10,
  });
  video.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: options.width,
      bottom: options.height,
      width: options.width,
      height: options.height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}
