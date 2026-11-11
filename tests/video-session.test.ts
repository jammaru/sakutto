// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageEngine } from '@/dom/session';
import { fakeTranslateText } from '@/dom/fake-engine';
import { VideoCaptionSession } from '@/captions/session';
import { CAPTION_FONT_MIN_PX } from '@/captions/overlay';
import {
  CAPTION_LIVE_PRIORITY,
  CAPTION_PLAYHEAD_PRIORITY,
  CAPTION_PREFETCH_PRIORITY,
} from '@/captions/engine';

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

  it('places the overlay from a stored per-site percent and returns to default when cleared', async () => {
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
    const player = document.getElementById('movie_player') as HTMLElement;
    const video = document.querySelector('video') as HTMLVideoElement;
    video.currentTime = 0.4;
    const box = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 640,
      bottom: 360,
      width: 640,
      height: 360,
      toJSON() {
        return {};
      },
    } as DOMRect;
    player.getBoundingClientRect = () => box;
    video.getBoundingClientRect = () => box;
    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
        position: { x: 28, y: 36 },
      },
      readTrack: async () => JSON.stringify(TIMEDTEXT),
    });
    session.start();
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
    });
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    expect(host.style.left).toBe('28%');
    expect(host.style.top).toBe('36%');
    expect(host.style.transform).toBe('translate(-50%, -50%)');
    session.setPreferences({
      enabled: true,
      targetLanguage: 'ja',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
      position: null,
    });
    expect(host.style.left).toBe('50%');
    expect(host.style.top).toBe('auto');
    expect(host.style.transform).toBe('translateX(-50%)');
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
    expect(document.querySelector('style[data-sakutto="captions"]')).toBeNull();
    expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('waiting');
    expect(document.querySelector('.ytp-caption-segment')?.textContent).toBe(
      'The station opens at dawn.',
    );
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
    const atDefault = Number.parseFloat(host.style.getPropertyValue('--sakutto-caption-size'));
    session.setPreferences({
      enabled: true,
      targetLanguage: 'ja',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
      size: 150,
    });
    await vi.waitFor(() => {
      expect(
        Number.parseFloat(host.style.getPropertyValue('--sakutto-caption-size')),
      ).toBeGreaterThan(atDefault);
    });
    session.setPreferences({
      enabled: true,
      targetLanguage: 'ja',
      form: 'polite',
      display: 'bilingual',
      tier: 'g',
      size: 50,
    });
    await vi.waitFor(() => {
      expect(Number.parseFloat(host.style.getPropertyValue('--sakutto-caption-size'))).toBeLessThan(
        atDefault,
      );
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

  it('keeps native captions visible until the first translated overlay line', async () => {
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
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('waiting');
    });
    expect(document.querySelector('sakutto-captions')?.hasAttribute('data-sakutto-caption')).toBe(
      false,
    );
    expect(document.querySelector('style[data-sakutto="captions"]')).toBeNull();
    expect(document.querySelector('.ytp-caption-segment')?.textContent).toBe(
      'The station opens at dawn.',
    );
    release?.();
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
    });
    expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('overlay');
    expect(document.querySelector('style[data-sakutto="captions"]')).not.toBeNull();
    session.stop();
  });

  it('translates the playhead cue before nearby or prefetch lines', async () => {
    const events: Array<{ tStartMs: number; dDurationMs: number; segs: Array<{ utf8: string }> }> =
      [];
    const lines = [
      'The station opens at dawn.',
      'A red train waits at platform two.',
      'Tickets are sold at the north window.',
      'The clock above the gate reads noon.',
      'Passengers wait on the second platform.',
    ];
    for (const [index, text] of lines.entries()) {
      events.push({ tStartMs: index * 2000, dDurationMs: 2000, segs: [{ utf8: text }] });
    }
    document.body.innerHTML = `
      <div id="movie_player">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container">
          <span class="ytp-caption-segment">${lines[0]}</span>
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
    const started: Array<{ text: string; priority: number; at: number }> = [];
    const origin = Date.now();
    let chain = Promise.resolve();
    const serial: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        const run = chain.then(async () => {
          started.push({ text, priority: options.priority, at: Date.now() - origin });
          await new Promise((resolve) => setTimeout(resolve, 40));
        });
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        await run;
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: fakeTranslateText(segment.text, options.tgt),
            engine: 'plamo',
          };
        }
      },
    };
    const session = new VideoCaptionSession(document, {
      engine: serial,
      labels,
      preferences: {
        enabled: true,
        targetLanguage: 'ja',
        form: 'polite',
        display: 'bilingual',
        tier: 'g',
      },
      readTrack: async () => JSON.stringify({ events }),
    });
    session.start();
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe(lines[0]);
    });
    const firstTranslatedAt = Date.now() - origin;
    expect(started[0]?.text).toBe(lines[0]);
    expect(started[0]?.priority).toBe(CAPTION_PLAYHEAD_PRIORITY);
    expect(started.filter((entry) => entry.text === lines[0])).toHaveLength(1);
    await vi.waitFor(() => {
      expect(
        started.some(
          (entry) => entry.text === lines[1] && entry.priority === CAPTION_LIVE_PRIORITY,
        ),
      ).toBe(true);
      expect(started.some((entry) => entry.priority === CAPTION_PREFETCH_PRIORITY)).toBe(true);
    });
    expect(
      started.findIndex((entry) => entry.priority === CAPTION_PREFETCH_PRIORITY),
    ).toBeGreaterThan(0);
    expect(firstTranslatedAt).toBeLessThan(400);
    session.stop();
  });

  it('keeps overlay type at YouTube size when the video rect collapses', async () => {
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
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
    if (!video) throw new Error('video');
    const box = { width: 960, height: 540 };
    stubMedia(video, { paused: false, width: box.width, height: box.height, currentTime: 0.4 });
    video.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: box.width,
        bottom: box.height,
        width: box.width,
        height: box.height,
        toJSON() {
          return {};
        },
      }) as DOMRect;
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
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const settled = Number.parseFloat(host.style.getPropertyValue('--sakutto-caption-size'));
    expect(settled).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
    box.width = 0;
    box.height = 0;
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await vi.waitFor(() => {
      const next = Number.parseFloat(host.style.getPropertyValue('--sakutto-caption-size'));
      expect(next).toBe(settled);
    });
    expect(
      Number.parseFloat(host.style.getPropertyValue('--sakutto-caption-size')),
    ).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
    session.stop();
  });

  it('loads X captions from an HLS subtitle playlist without a track element', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer" style="overflow: hidden; transform: translateZ(0)">
        <video id="playing">
          <source src="https://video.twimg.com/amplify_video/1/pl/playlist.m3u8" />
        </video>
      </div>
    `;
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    stubMedia(playing, { paused: false, width: 640, height: 360, currentTime: 0.4 });
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
        if (url.endsWith('playlist.m3u8')) {
          return `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"
video.m3u8
`;
        }
        if (url.endsWith('en.m3u8')) {
          return `#EXTM3U
#EXTINF:10,
https://video.twimg.com/subtitles/en.vtt
`;
        }
        if (url.endsWith('en.vtt')) {
          return `WEBVTT

00:00:00.000 --> 00:00:02.000
The station opens at dawn.
`;
        }
        return '';
      },
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });
    const host = doc.querySelector('sakutto-captions') as unknown as HTMLElement;
    expect(host.parentElement?.getAttribute('data-testid')).toBe('videoPlayer');
    expect(host.style.position).toBe('absolute');
    session.stop();
    view.close();
  });

  it('does not disable an X textTrack and does not stamp native caption nodes', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing">
          <track kind="subtitles" src="https://video.twimg.com/subtitles/fixture.vtt" srclang="en" default />
        </video>
        <div class="native-caption" aria-live="polite" data-sakutto="x-native">The station opens at dawn.</div>
      </div>
    `;
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    stubMedia(playing, { paused: false, width: 320, height: 180, currentTime: 0.4 });
    const track = playing.textTracks[0];
    if (track) track.mode = 'showing';
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
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toMatch(
        /§ja§The station opens at dawn/,
      );
    });
    expect(playing.textTracks[0]?.mode).toBe('showing');
    expect(
      doc.querySelector('[data-sakutto="x-native"]')?.getAttribute('data-sakutto-native-caption'),
    ).toBeNull();
    session.stop();
    view.close();
  });

  it('on X seek aborts in-flight work, keeps cache, and shows native until the new playhead cue is ready', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing">
          <track kind="subtitles" src="https://video.twimg.com/subtitles/fixture.vtt" srclang="en" />
        </video>
        <div class="native-caption" aria-live="polite">native line</div>
      </div>
    `;
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    const media = { paused: false, currentTime: 0.4 };
    stubMedia(playing, { paused: false, width: 320, height: 180, currentTime: 0.4 });
    Object.defineProperty(playing, 'currentTime', {
      configurable: true,
      get: () => media.currentTime,
      set: (value: number) => {
        media.currentTime = value;
      },
    });
    let delayMs = 120;
    const paced: PageEngine = {
      async *translate(segments, options) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: fakeTranslateText(segment.text, options.tgt),
            engine: 'plamo',
          };
        }
      },
    };
    const session = new VideoCaptionSession(doc as unknown as Document, {
      engine: paced,
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

00:00:03.000 --> 00:00:06.000
A red train waits at platform two.
`,
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });
    media.currentTime = 3.2;
    delayMs = 200;
    (view as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('seeked', { bubbles: true }),
    );
    (view as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('seeked', { bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(doc.documentElement.getAttribute('data-sakutto-captions')).toBe('waiting');
    });
    expect(doc.querySelector('style[data-sakutto="captions"]')).toBeNull();
    await vi.waitFor(
      () => {
        expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
          'A red train waits at platform two.',
        );
      },
      { timeout: 3_000 },
    );
    expect(doc.documentElement.getAttribute('data-sakutto-captions')).toBe('overlay');
    session.stop();
    view.close();
  });

  it('starts X translation from the native DOM line when the timeline is empty', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing"></video>
        <div class="native-caption" aria-live="polite" style="position:absolute;color:#fff;text-shadow:0 0 2px #000">
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
      },
      readTrack: async () => {
        throw new Error('twimg cors');
      },
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });
    expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toMatch(
      /§ja§The station opens at dawn/,
    );
    session.stop();
    view.close();
  });

  it('does not passthrough an empty ja-language X track when the native line is English', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing">
          <track kind="subtitles" srclang="ja" src="https://video.twimg.com/subtitles/fixture.vtt" />
        </video>
        <div class="native-caption" aria-live="polite">The station opens at dawn.</div>
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
      },
      readTrack: async () => {
        throw new Error('twimg cors');
      },
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toMatch(
        /§ja§The station opens at dawn/,
      );
    });
    expect(doc.documentElement.getAttribute('data-sakutto-captions')).not.toBe('native');
    session.stop();
    view.close();
  });

  it('re-syncs X translation from the native line after seek when cues miss the playhead', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://x.com/i/status/1' });
    const doc = view.document;
    doc.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video id="playing"></video>
        <div class="native-caption" aria-live="polite">The station opens at dawn.</div>
      </div>
    `;
    const playing = doc.querySelector('#playing') as unknown as HTMLVideoElement;
    const native = doc.querySelector('.native-caption') as unknown as HTMLElement;
    const media = { paused: false, currentTime: 0.4 };
    stubMedia(playing, { paused: false, width: 320, height: 180, currentTime: 0.4 });
    Object.defineProperty(playing, 'currentTime', {
      configurable: true,
      get: () => media.currentTime,
      set: (value: number) => {
        media.currentTime = value;
      },
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
      readTrack: async () => {
        throw new Error('twimg cors');
      },
    });
    session.start();
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'The station opens at dawn.',
      );
    });
    media.currentTime = 4;
    native.textContent = 'A red train waits at platform two.';
    (view as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new view.Event('seeked', { bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
        'A red train waits at platform two.',
      );
    });
    expect(doc.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toMatch(
      /§ja§A red train waits at platform two/,
    );
    session.stop();
    view.close();
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
    set: (value: number) => {
      options.currentTime = value;
    },
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
