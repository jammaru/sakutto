// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageEngine } from '@/dom/session';
import { fakeTranslateText } from '@/dom/fake-engine';
import { CAPTION_HOLD_MAX_MS, VideoCaptionSession } from '@/captions/session';

const labels = {
  label: 'Translated captions',
  pending: 'Translating caption…',
  showOriginal: 'Show original caption',
  hideOriginal: 'Hide original caption',
  braveShields: 'Brave Shields blocked caption data. Turn Shields off for this video and reload.',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stubMedia(
  video: HTMLVideoElement,
  options: { paused: boolean; currentTime: number; duration?: number },
): void {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => options.paused });
  Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(video, 'muted', { configurable: true, get: () => true });
  Object.defineProperty(video, 'volume', { configurable: true, get: () => 1 });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => options.currentTime,
    set: (value: number) => {
      options.currentTime = value;
    },
  });
  Object.defineProperty(video, 'duration', {
    configurable: true,
    get: () => options.duration ?? 30,
  });
  video.getBoundingClientRect = () =>
    ({
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
    }) as DOMRect;
}

function captionPreferences() {
  return {
    enabled: true,
    targetLanguage: 'ja',
    form: 'polite' as const,
    display: 'bilingual' as const,
    tier: 'g' as const,
  };
}

function youtubeMarkup(videoId: string, live = false): string {
  return `
      <div id="movie_player" class="html5-video-player${live ? ' ytp-live' : ''}">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container" lang="en">
          <span class="ytp-caption-segment"></span>
        </div>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "videoDetails": { "videoId": "${videoId}"${live ? ', "isLive": true' : ''} },
          "captions": { "playerCaptionsTracklistRenderer": { "captionTracks": [{
            "baseUrl": "/${videoId}.json",
            "languageCode": "en",
            "name": { "simpleText": "English" }
          }] } }
        };
      </script>`;
}

describe('real-time caption translation', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('warms the first caption before it appears', async () => {
    document.body.innerHTML = youtubeMarkup('realtimeprefetch01');
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.2, duration: 30 });
    const origin = performance.now();
    const requests: Array<{ at: number; text: string }> = [];
    let completed = 0;
    const engine: PageEngine = {
      async *translate(segments, options) {
        requests.push({
          at: Math.round(performance.now() - origin),
          text: segments[0]?.text ?? '',
        });
        await sleep(250);
        completed += 1;
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
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () =>
        JSON.stringify({
          events: [
            {
              tStartMs: 1500,
              dDurationMs: 2000,
              segs: [{ utf8: 'The station opens at dawn.' }],
            },
            {
              tStartMs: 3500,
              dDurationMs: 2000,
              segs: [{ utf8: 'A red train waits at platform two.' }],
            },
          ],
        }),
    });
    session.start();
    // The playhead is still before the first cue. It must already be translated.
    await vi.waitFor(() => {
      expect(completed).toBeGreaterThan(0);
    });
    expect(requests[0]?.text).toBe('The station opens at dawn.');

    const cueStartedAt = performance.now();
    video.currentTime = 1.6;
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    window.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe('The station opens at dawn.');
    });
    const latencyMs = Math.round(performance.now() - cueStartedAt);
    // Baseline probe on the old pipeline: 264 ms and zero requests before the cue.
    expect(latencyMs).toBeLessThan(200);
    session.stop();
  });

  it('translates the visible rolling line before it finishes', async () => {
    document.body.innerHTML = youtubeMarkup('realtimelive01', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const origin = performance.now();
    const requests: Array<{ at: number; text: string }> = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        requests.push({
          at: Math.round(performance.now() - origin),
          text: segments[0]?.text ?? '',
        });
        await sleep(150);
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
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () => '',
    });
    session.start();
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    const parts = [
      'The',
      'The station',
      'The station opens',
      'The station opens at',
      'The station opens at dawn',
    ];
    segment.textContent = 'The';
    for (let index = 1; index < parts.length; index += 1) {
      await sleep(150);
      segment.textContent = parts[index] ?? '';
    }
    const full = fakeTranslateText('The station opens at dawn', 'ja');
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        full,
      );
    });
    // Baseline probe on the old pipeline: first request at 1606 ms, only after the
    // sentence ended and the 900 ms idle debounce expired. The new pipeline asks
    // for a partial line while it is still growing and refines it in place.
    expect(requests[0]?.at).toBeLessThan(900);
    expect(requests[0]?.text).not.toBe('The station opens at dawn');
    expect(requests.some((request) => request.text === 'The station opens at dawn')).toBe(true);
    session.stop();
  });

  it('cancels the previous cue when playback moves on', async () => {
    document.body.innerHTML = youtubeMarkup('realtimestale01');
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let firstAborted = false;
    let firstStarted = false;
    const startGate = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!firstStarted) return;
        clearInterval(timer);
        resolve();
      }, 5);
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        if (text === 'The station opens at dawn.') {
          firstStarted = true;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 2_000);
            options.signal.addEventListener(
              'abort',
              () => {
                firstAborted = true;
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        }
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
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () =>
        JSON.stringify({
          events: [
            {
              tStartMs: 0,
              dDurationMs: 4000,
              segs: [{ utf8: 'The station opens at dawn.' }],
            },
            {
              tStartMs: 4000,
              dDurationMs: 4000,
              segs: [{ utf8: 'A red train waits at platform two.' }],
            },
          ],
        }),
    });
    session.start();
    await startGate;
    video.currentTime = 4.5;
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    window.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe('A red train waits at platform two.');
    });
    expect(firstAborted).toBe(true);
    session.stop();
  });

  it('drops a held line after a seek behind it', async () => {
    document.body.innerHTML = youtubeMarkup('realtimeseek01');
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const session = new VideoCaptionSession(document, {
      engine: {
        async *translate(segments, options) {
          for (const segment of segments) {
            yield {
              id: segment.id,
              final: fakeTranslateText(segment.text, options.tgt),
              engine: 'plamo',
            };
          }
        },
      },
      labels,
      preferences: captionPreferences(),
      readTrack: async () =>
        JSON.stringify({
          events: [
            { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'The station opens at dawn.' }] },
            {
              tStartMs: 8000,
              dDurationMs: 3000,
              segs: [{ utf8: 'A red train waits at platform two.' }],
            },
          ],
        }),
    });
    session.start();
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
    });
    video.currentTime = 8.4;
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('A red train waits at platform two.', 'ja'),
      );
    });
    video.currentTime = 3.5;
    window.dispatchEvent(new Event('seeking', { bubbles: true }));
    window.dispatchEvent(new Event('seeked', { bubbles: true }));
    await vi.waitFor(() => {
      const caption = document
        .querySelector('sakutto-captions')
        ?.getAttribute('data-sakutto-caption');
      expect(caption).not.toBe(fakeTranslateText('A red train waits at platform two.', 'ja'));
    });
    // The finished first line is still inside the short gap-hold, but the later line
    // must never remain after seeking back before the second cue.
    expect(CAPTION_HOLD_MAX_MS).toBeLessThan(4_000);
    session.stop();
  });

  it('freezes a committed translation and rolls it above the next line', async () => {
    document.body.innerHTML = youtubeMarkup('stabilityfreeze01', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const calls: string[] = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls.push(segments[0]?.text ?? '');
        await sleep(15);
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
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    const shown: string[] = [];
    const observer = new MutationObserver(() => {
      const caption = host.getAttribute('data-sakutto-caption');
      if (caption) shown.push(caption);
    });
    observer.observe(host, { attributes: true, attributeFilter: ['data-sakutto-caption'] });

    const firstSource = 'The station opens at dawn.';
    const first = fakeTranslateText(firstSource, 'ja');
    segment.textContent = firstSource;
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe(first);
    });

    const secondSource = 'A red train waits at platform two.';
    const second = fakeTranslateText(secondSource, 'ja');
    segment.textContent = secondSource;
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe(second);
      expect(host.getAttribute('data-sakutto-history')).toBe(first);
    });
    // The committed source is asked exactly once and its JA never changes after commit.
    expect(calls.filter((text) => text === firstSource)).toHaveLength(1);
    expect(shown.filter((caption) => caption === first)).toHaveLength(1);
    observer.disconnect();
    session.stop();
  });

  it('bounds tail rewrites for a continuously growing live line', async () => {
    document.body.innerHTML = youtubeMarkup('stabilitybounded01', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const words = 'the station opens at dawn and a red train waits here'.split(' ');
    const calls: string[] = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls.push(segments[0]?.text ?? '');
        await sleep(15);
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
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    let changes = 0;
    let last = '';
    const observer = new MutationObserver(() => {
      const caption = host.getAttribute('data-sakutto-caption') ?? '';
      if (caption && caption !== last) {
        last = caption;
        changes += 1;
      }
    });
    observer.observe(host, { attributes: true, attributeFilter: ['data-sakutto-caption'] });
    let text = '';
    for (const [index, word] of words.entries()) {
      text = index === 0 ? word : `${text} ${word}`;
      segment.textContent = text;
      await sleep(250);
    }
    await sleep(900);
    // Twelve words would create twelve rewrites on the old path. Segments and the
    // stable/rate-limited tail keep this to a handful.
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(changes).toBeLessThanOrEqual(7);
    expect(changes).toBeLessThan(words.length / 2);
    observer.disconnect();
    session.stop();
  });
});
