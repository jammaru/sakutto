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

const JA_TIMEDTEXT = {
  events: [
    {
      tStartMs: 0,
      dDurationMs: 4000,
      segs: [{ utf8: '駅は夜明けに開きます。' }],
    },
  ],
};

describe('video caption session', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-sakutto-captions');
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

  it('hides the original line when display switches to replace', async () => {
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
        <div class="html5-video-container">
          <video id="player" class="html5-main-video"></video>
        </div>
        <div class="ytp-chrome-bottom"></div>
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
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-show-original'),
      ).toBe('1');
    });
    expect(document.querySelector('sakutto-captions')?.parentElement?.id).toBe('movie_player');
    session.setPreferences({
      enabled: true,
      targetLanguage: 'ja',
      form: 'polite',
      display: 'replace',
      tier: 'g',
    });
    expect(
      document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-show-original'),
    ).toBe('0');
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

  it('picks up an inline X play event without a DOM mutation or fullscreen', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing">
          <track kind="subtitles" src="https://video.twimg.com/subtitles/fixture.vtt" srclang="en" />
        </video>
      </div>
    `;
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    const media = { paused: true };
    stubMedia(playing, { paused: true, width: 320, height: 180, currentTime: 0.4 });
    Object.defineProperty(playing, 'paused', { configurable: true, get: () => media.paused });

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
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(doc.querySelector('sakutto-captions')?.hasAttribute('data-sakutto-caption')).toBeFalsy();

    media.paused = false;
    (playing as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('play', { bubbles: true }),
    );
    (view as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('play', { bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });
    const hide = doc.querySelector('style[data-sakutto="captions"]')?.textContent ?? '';
    expect(hide).toContain('video::cue');
    expect(hide).toContain('videoPlayer');
    session.stop();
    view.close();
  });

  it('applies caption size immediately and hides native X captions', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing">
          <track kind="subtitles" src="https://video.twimg.com/subtitles/fixture.vtt" srclang="en" />
        </video>
        <div class="native-caption" aria-live="polite" style="position:absolute;text-shadow:0 0 2px #000">
          The station opens at dawn.
        </div>
      </div>
    `;
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
        size: 80,
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
    const host = doc.querySelector('sakutto-captions') as unknown as HTMLElement;
    const atDefault = host.style.getPropertyValue('--sakutto-caption-size');
    session.setPreferences({
      enabled: true,
      targetLanguage: 'ja',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
      size: 150,
    });
    await vi.waitFor(() => {
      expect(host.style.getPropertyValue('--sakutto-caption-size')).not.toBe(atDefault);
    });
    const hide = doc.querySelector('style[data-sakutto="captions"]')?.textContent ?? '';
    expect(hide).toContain('::cue');
    expect(hide).toContain('[data-sakutto-native-caption]');
    session.stop();
    view.close();
  });

  it('translates a generic HTML5 player that is not YouTube or X', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://videos.example.com/watch' });
    const doc = view.document;
    doc.body.innerHTML = `
      <video id="player">
        <track kind="subtitles" src="/captions.vtt" srclang="en" />
      </video>
    `;
    const player = doc.querySelector('#player') as unknown as HTMLVideoElement;
    stubMedia(player, { paused: false, width: 640, height: 360, currentTime: 0.4 });
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

  it('clears the overlay when YouTube navigates to a video with no captions', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://www.youtube.com/watch?v=videoA00001' });
    const doc = view.document;
    doc.body.innerHTML = youtubeWatchMarkup('videoA00001', true);
    const video = doc.querySelector('video') as unknown as HTMLVideoElement;
    stubMedia(video, { paused: false, width: 640, height: 360, currentTime: 0.4 });

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
      readTrack: async () => JSON.stringify(TIMEDTEXT),
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });

    view.history.pushState({}, '', 'https://www.youtube.com/watch?v=videoB00002');
    doc.body.innerHTML = youtubeWatchMarkup('videoB00002', false);
    stubMedia(doc.querySelector('video') as unknown as HTMLVideoElement, {
      paused: false,
      width: 640,
      height: 360,
      currentTime: 0.4,
    });
    doc.dispatchEvent(new view.Event('yt-navigate-finish'));
    await vi.waitFor(() => {
      const host = doc.querySelector('sakutto-captions');
      expect(host?.hasAttribute('data-sakutto-caption')).toBeFalsy();
      expect(host?.hasAttribute('data-sakutto-original')).toBeFalsy();
      expect(host?.hasAttribute('hidden') || host == null).toBeTruthy();
    });
    session.stop();
    view.close();
  });

  it('clears captions when the YouTube watch id changes without a navigate event', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://www.youtube.com/watch?v=videoA00001' });
    const doc = view.document;
    doc.body.innerHTML = youtubeWatchMarkup('videoA00001', true);
    const video = doc.querySelector('video') as unknown as HTMLVideoElement;
    stubMedia(video, { paused: false, width: 640, height: 360, currentTime: 0.4 });

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
      readTrack: async () => JSON.stringify(TIMEDTEXT),
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });

    view.history.pushState({}, '', 'https://www.youtube.com/watch?v=videoB00002');
    const script = doc.querySelector('script');
    if (script) {
      script.textContent = `var ytInitialPlayerResponse = {
        "videoDetails": { "videoId": "videoB00002" }
      };`;
    }
    (video as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('timeupdate'),
    );
    await vi.waitFor(() => {
      const host = doc.querySelector('sakutto-captions');
      expect(host?.hasAttribute('data-sakutto-caption')).toBeFalsy();
      expect(host?.hasAttribute('data-sakutto-original')).toBeFalsy();
    });
    session.stop();
    view.close();
  });

  it('does not paint the previous YouTube cues after navigating to another captioned video', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://www.youtube.com/watch?v=videoA00001' });
    const doc = view.document;
    doc.body.innerHTML = youtubeWatchMarkup('videoA00001', true);
    stubMedia(doc.querySelector('video') as unknown as HTMLVideoElement, {
      paused: false,
      width: 640,
      height: 360,
      currentTime: 0.4,
    });

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
      readTrack: async (url) => {
        if (url.includes('videoB')) {
          return JSON.stringify({
            events: [
              {
                tStartMs: 0,
                dDurationMs: 4000,
                segs: [{ utf8: 'Tickets are sold at the north window.' }],
              },
            ],
          });
        }
        return JSON.stringify(TIMEDTEXT);
      },
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });

    view.history.pushState({}, '', 'https://www.youtube.com/watch?v=videoB00002');
    doc.body.innerHTML = youtubeWatchMarkup('videoB00002', true);
    stubMedia(doc.querySelector('video') as unknown as HTMLVideoElement, {
      paused: false,
      width: 640,
      height: 360,
      currentTime: 0.4,
    });
    doc.dispatchEvent(new view.Event('yt-navigate-finish'));
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'Tickets are sold at the north window.',
      );
    });
    expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).not.toBe(
      'The station opens at dawn.',
    );
    session.stop();
    view.close();
  });

  it('drops an in-flight translation from the previous X video', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="first">
          <track kind="subtitles" src="https://video.twimg.com/subtitles/a.vtt" srclang="en" />
        </video>
      </div>
    `;
    const first = doc.querySelector('#first') as unknown as HTMLVideoElement;
    const media = { paused: false };
    stubMedia(first, { paused: false, width: 320, height: 180, currentTime: 0.4 });
    Object.defineProperty(first, 'paused', { configurable: true, get: () => media.paused });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new VideoCaptionSession(doc as unknown as Document, {
      engine: delayedEngine(gate),
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async (url) =>
        url.includes('a.vtt')
          ? `WEBVTT

00:00:00.000 --> 00:00:02.000
The station opens at dawn.
`
          : '',
    });
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 40));

    media.paused = true;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="second"></video>
      </div>
    `;
    const second = doc.querySelector('#second') as unknown as HTMLVideoElement;
    stubMedia(second, { paused: false, width: 320, height: 180, currentTime: 0.4 });
    (second as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('play', { bubbles: true }),
    );
    release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const host = doc.querySelector('sakutto-captions');
    expect(host?.getAttribute('data-sakutto-original')).not.toBe('The station opens at dawn.');
    expect(host?.hasAttribute('data-sakutto-caption')).toBeFalsy();
    session.stop();
    view.close();
  });

  it('clears the overlay when a generic player src changes to a file without tracks', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://videos.example.com/watch' });
    const doc = view.document;
    doc.body.innerHTML = `
      <video id="player" src="https://videos.example.com/a.mp4">
        <track kind="subtitles" src="/captions.vtt" srclang="en" />
      </video>
    `;
    const player = doc.querySelector('#player') as unknown as HTMLVideoElement;
    stubMedia(player, { paused: false, width: 640, height: 360, currentTime: 0.4 });
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
      readTrack: async (url) =>
        url.includes('captions.vtt')
          ? `WEBVTT

00:00:00.000 --> 00:00:02.000
The station opens at dawn.
`
          : '',
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });

    player.removeAttribute('src');
    player.src = 'https://videos.example.com/b.mp4';
    player.querySelector('track')?.remove();
    (player as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('emptied'),
    );
    (player as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('loadstart'),
    );
    await vi.waitFor(() => {
      const host = doc.querySelector('sakutto-captions');
      expect(host?.hasAttribute('data-sakutto-caption')).toBeFalsy();
      expect(host?.hasAttribute('data-sakutto-original')).toBeFalsy();
    });
    session.stop();
    view.close();
  });

  it('leaves native YouTube captions in place when the source is already the target language', async () => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container">
          <span class="ytp-caption-segment">駅は夜明けに開きます。</span>
        </div>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "captions": {
            "playerCaptionsTracklistRenderer": {
              "captionTracks": [{
                "baseUrl": "/youtube-timedtext.json",
                "languageCode": "ja",
                "name": { "simpleText": "Japanese" }
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
        return JSON.stringify(JA_TIMEDTEXT);
      },
    });
    session.start();
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('native');
    });
    expect(
      document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption'),
    ).toBeNull();
    expect(document.querySelector('style[data-sakutto="captions"]')).toBeNull();
    expect(document.querySelector('.ytp-caption-segment')?.textContent).toBe(
      '駅は夜明けに開きます。',
    );
    expect(fetches).toBe(0);
    session.stop();
  });

  it('still hides native captions and strips auto-translate when the source is English', async () => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container">
          <div class="caption-window" lang="en">
            <span class="ytp-caption-segment">The station opens at dawn.</span>
          </div>
          <div class="caption-window" lang="ja">
            <span class="ytp-caption-segment">駅は夜明けに開きます。</span>
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
      readTrack: async () => JSON.stringify(TIMEDTEXT),
    });
    session.start();
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
    });
    expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('overlay');
    expect(document.querySelector('style[data-sakutto="captions"]')).not.toBeNull();
    expect(
      document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
    ).not.toMatch(/駅は夜明け/);
    session.stop();
  });

  it('falls back to native captions when the target language is switched to the source', async () => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container">
          <span class="ytp-caption-segment">The station opens at dawn.</span>
        </div>
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
    expect(document.querySelector('style[data-sakutto="captions"]')).not.toBeNull();
    session.setPreferences({
      enabled: true,
      targetLanguage: 'en',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
    });
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('native');
    });
    expect(
      document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption'),
    ).toBeNull();
    expect(document.querySelector('style[data-sakutto="captions"]')).toBeNull();
    session.stop();
  });

  it('retranslates from the playhead into the new target and drops the old language', async () => {
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
    session.setPreferences({
      enabled: true,
      targetLanguage: 'zh-hans',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
    });
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'zh-hans'),
      );
    });
    const caption = document
      .querySelector('sakutto-captions')
      ?.getAttribute('data-sakutto-caption');
    expect(caption).not.toMatch(/§ja§/);
    expect(caption).toContain('§zh-hans§');
    session.stop();
  });

  it('ignores an in-flight translation after the target language changes', async () => {
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
      readTrack: async () => JSON.stringify(TIMEDTEXT),
    });
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    session.setPreferences({
      enabled: true,
      targetLanguage: 'zh-hans',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
    });
    release?.();
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'zh-hans'),
      );
    });
    expect(
      document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption'),
    ).not.toMatch(/§ja§/);
    session.stop();
  });
});

function youtubeWatchMarkup(videoId: string, captions: boolean): string {
  const tracks = captions
    ? `"captions": { "playerCaptionsTracklistRenderer": { "captionTracks": [{
        "baseUrl": "/youtube-timedtext.json?v=${videoId}",
        "languageCode": "en",
        "name": { "simpleText": "English" }
      }] } }`
    : '"captions": { "playerCaptionsTracklistRenderer": { "captionTracks": [] } }';
  return `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "videoDetails": { "videoId": "${videoId}" },
          ${tracks}
        };
      </script>
    `;
}

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
