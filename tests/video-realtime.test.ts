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

  it('retires a pending tail when a replacement keeps the same tail text', async () => {
    document.body.innerHTML = youtubeMarkup('regressionstalecontext', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const requests: Array<{ text: string; context: string; signal: AbortSignal }> = [];
    let alphaBetaCompleted = 0;
    let releaseAlphaBeta!: () => void;
    const alphaBetaGate = new Promise<void>((resolve) => {
      releaseAlphaBeta = resolve;
    });
    let markAlphaBetaStarted!: () => void;
    const alphaBetaStarted = new Promise<void>((resolve) => {
      markAlphaBetaStarted = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        const context = options.context ?? '';
        requests.push({ text, context, signal: options.signal });
        if (text === 'Beta' && context === 'Alpha.') {
          markAlphaBetaStarted();
          await alphaBetaGate;
        }
        for (const segment of segments) {
          const contextMarker = segment.text === 'Beta' ? ` [${context}]` : '';
          yield {
            id: segment.id,
            final: fakeTranslateText(`${segment.text}${contextMarker}`, options.tgt),
            engine: 'plamo',
          };
        }
        if (text === 'Beta' && context === 'Alpha.') alphaBetaCompleted += 1;
      },
    };
    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () => '',
      now: () => 0,
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    try {
      segment.textContent = 'Alpha. Beta';
      await alphaBetaStarted;
      const alphaBeta = requests.find(
        (request) => request.text === 'Beta' && request.context === 'Alpha.',
      );

      // The tail is still "Beta", so tailChanged is false even though the line and
      // its context change. The old request must keep serving committed Beta only.
      segment.textContent = 'Gamma. Beta';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      const gammaBetaTranslation = fakeTranslateText('Beta [Gamma.]', 'ja');
      await vi.waitFor(() => {
        expect(
          requests.some((request) => request.text === 'Beta' && request.context === 'Gamma.'),
        ).toBe(true);
        expect(host.getAttribute('data-sakutto-caption')).toBe(gammaBetaTranslation);
      });
      expect(alphaBeta?.signal.aborted).toBe(false);
      expect(
        requests.filter((request) => request.text === 'Beta' && request.context === 'Alpha.'),
      ).toHaveLength(1);

      releaseAlphaBeta();
      await vi.waitFor(() => {
        expect(alphaBetaCompleted).toBe(1);
      });
      await sleep(0);
      expect(host.getAttribute('data-sakutto-caption')).toBe(gammaBetaTranslation);
      expect(
        requests.filter((request) => request.text === 'Beta' && request.context === 'Alpha.'),
      ).toHaveLength(1);
    } finally {
      releaseAlphaBeta();
      session.stop();
    }
  });

  it('cancels a delayed tail when the caption disappears', async () => {
    document.body.innerHTML = youtubeMarkup('stabilityvanish01', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        markStarted?.();
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
    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    segment.textContent = 'The station opens at dawn';
    await started;
    // Let the pending tail request exist, then remove the source line and let the
    // empty-observation path cancel it before the engine is released.
    segment.textContent = '';
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    window.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await sleep(250);
    release?.();
    await sleep(150);
    expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
    expect(host.hasAttribute('data-sakutto-original')).toBe(false);
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

  it('reschedules an identical live tail after a transient empty DOM poll', async () => {
    document.body.innerHTML = youtubeMarkup('regressionvanishsame', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let calls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls += 1;
        if (calls === 1) {
          markStarted();
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
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
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    segment.textContent = 'The station opens';
    await started;
    segment.textContent = '';
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await sleep(250);
    segment.textContent = 'The station opens';
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await vi.waitFor(() => {
      expect(calls).toBe(2);
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens', 'ja'),
      );
    });
    session.stop();
  });

  it('starts a new tail while its committed shared request is still pending', async () => {
    document.body.innerHTML = youtubeMarkup('regressionsharedtail', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const requests: Array<{ text: string; signal: AbortSignal }> = [];
    let betaCompleted = 0;
    let releaseBeta!: () => void;
    const betaGate = new Promise<void>((resolve) => {
      releaseBeta = resolve;
    });
    let markBetaStarted!: () => void;
    const betaStarted = new Promise<void>((resolve) => {
      markBetaStarted = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        requests.push({ text, signal: options.signal });
        if (text === 'Beta') {
          markBetaStarted();
          await betaGate;
        }
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: fakeTranslateText(segment.text, options.tgt),
            engine: 'plamo',
          };
        }
        if (text === 'Beta') betaCompleted += 1;
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
    try {
      segment.textContent = 'Alpha. Beta';
      await betaStarted;
      await sleep(800);
      segment.textContent = 'Alpha. Beta Gamma';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));

      await vi.waitFor(() => {
        expect(requests.some((request) => request.text === 'Gamma')).toBe(true);
      });
      expect(betaCompleted).toBe(0);
      expect(requests.find((request) => request.text === 'Beta')?.signal.aborted).toBe(false);
      expect(requests.filter((request) => request.text === 'Beta')).toHaveLength(1);
    } finally {
      releaseBeta();
      session.stop();
    }
  });

  it('preserves promoted tail work through an empty poll and restores its translation', async () => {
    document.body.innerHTML = youtubeMarkup('regressionvanishcommit', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls += 1;
        if (calls === 1) {
          firstSignal = options.signal;
          markStarted();
          await gate;
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
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    try {
      segment.textContent = 'Yes';
      await started;
      // The unchanged visible tail crosses the 650 ms idle boundary and is committed.
      await sleep(800);
      segment.textContent = '';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      await sleep(100);
      segment.textContent = 'Yes';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      await sleep(150);
      expect(firstSignal?.aborted).toBe(false);
      expect(calls).toBe(1);

      segment.textContent = 'Next line';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      release();
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-caption')).toBe(
          fakeTranslateText('Next line', 'ja'),
        );
        expect(host.getAttribute('data-sakutto-history')).toBe(fakeTranslateText('Yes', 'ja'));
      });
    } finally {
      release();
      session.stop();
    }
  });

  it('shows the original for a failed committed segment between successful lines', async () => {
    document.body.innerHTML = youtubeMarkup('regressioncommittedfail', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        if (text === 'Beta line.') return;
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
    segment.textContent = 'Alpha line.';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('Alpha line.', 'ja'),
      );
    });
    segment.textContent = 'Beta line.';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe('Beta line.');
    });
    segment.textContent = 'Charlie tail';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('Charlie tail', 'ja'),
      );
      expect(host.getAttribute('data-sakutto-history')).toBe('Beta line.');
    });
    session.stop();
  });

  it('keeps growing native text visible after mutable tail translation failures', async () => {
    document.body.innerHTML = youtubeMarkup('regressiontailfailure', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const requests: string[] = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        requests.push(text);
        if (text.includes('Beta')) return;
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
    segment.textContent = 'Alpha.';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Alpha.', 'ja'));
    });

    segment.textContent = 'Alpha. Beta';
    await vi.waitFor(() => {
      expect(requests).toContain('Beta');
      expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
    });
    segment.textContent = 'Alpha. Beta Gamma Delta Echo Foxtrot';
    await vi.waitFor(() => {
      expect(requests).toContain('Beta Gamma Delta Echo Foxtrot');
    });
    await sleep(250);
    const displayed = host.getAttribute('data-sakutto-caption');
    expect(displayed).not.toBe(fakeTranslateText('Alpha.', 'ja'));
    expect([null, 'Beta Gamma Delta Echo Foxtrot']).toContain(displayed);
    if (displayed === null) {
      expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('waiting');
    }
    session.stop();
  });

  it('fills every committed entry when consecutive source texts are identical', async () => {
    document.body.innerHTML = youtubeMarkup('regressionduplicateyes', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        calls += 1;
        if (calls === 1) {
          markStarted();
          await gate;
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
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    try {
      segment.textContent = 'Yes';
      await started;
      await sleep(800);
      segment.textContent = 'Yes Yes';
      await sleep(800);
      await vi.waitFor(() => {
        expect(calls).toBe(2);
      });
      release();
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Yes', 'ja'));
        expect(host.getAttribute('data-sakutto-history')).toBe(fakeTranslateText('Yes', 'ja'));
      });
    } finally {
      release();
      session.stop();
    }
  });

  it('aborts stale committed requests instead of building an unbounded live backlog', async () => {
    document.body.innerHTML = youtubeMarkup('regressioncommittedcap', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const active = new Set<string>();
    const aborted = new Set<string>();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        active.add(text);
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              active.delete(text);
              aborted.add(text);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
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
    segment.textContent = 'Line 0';
    await started;
    for (let index = 1; index <= 10; index += 1) {
      segment.textContent = `Line ${index}`;
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      await sleep(20);
    }
    await sleep(100);
    expect(active.size).toBeLessThanOrEqual(3);
    expect(aborted.has('Line 0')).toBe(true);
    expect(aborted.size).toBeGreaterThanOrEqual(5);
    session.stop();
  });

  it('updates the bilingual original when a refinement keeps the same translation', async () => {
    document.body.innerHTML = youtubeMarkup('regressionsamejarefine', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const requests: string[] = [];
    const engine: PageEngine = {
      async *translate(segments) {
        const text = segments[0]?.text ?? '';
        requests.push(text);
        for (const segment of segments) {
          yield { id: segment.id, final: '同じ訳', engine: 'plamo' };
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
    segment.textContent = 'Hello';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-original')).toBe('Hello');
      expect(host.getAttribute('data-sakutto-caption')).toBe('同じ訳');
    });

    segment.textContent = 'Hello world';
    await vi.waitFor(() => {
      expect(requests).toContain('Hello world');
      expect(host.getAttribute('data-sakutto-original')).toBe('Hello world');
      expect(host.getAttribute('data-sakutto-caption')).toBe('同じ訳');
    });
    session.stop();
  });

  it('keeps a repeated committed shared request alive through an empty DOM poll', async () => {
    document.body.innerHTML = youtubeMarkup('regressionrepeatedvanish', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const requests: Array<{ context: string; signal: AbortSignal }> = [];
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        requests.push({ context: options.context ?? '', signal: options.signal });
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
    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: captionPreferences(),
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    try {
      segment.textContent = 'Yes';
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await sleep(800);
      segment.textContent = 'Yes Yes';
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      await sleep(800);
      segment.textContent = 'Yes Yes Yes';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      await sleep(150);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.context).toBe('Yes');

      segment.textContent = '';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      await sleep(100);
      expect(requests[1]?.signal.aborted).toBe(false);
      segment.textContent = 'Yes Yes Yes';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      releaseAll();
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Yes', 'ja'));
        expect(host.getAttribute('data-sakutto-history')).toBe(fakeTranslateText('Yes', 'ja'));
      });
      expect(requests).toHaveLength(2);
    } finally {
      releaseAll();
      session.stop();
    }
  });

  it('does not reset for equal fresh glossaries but restarts for actual edits', async () => {
    document.body.innerHTML = youtubeMarkup('regressionglossaryequals', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const requests: string[] = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        requests.push(segments[0]?.text ?? '');
        const target = options.glossary?.[0]?.target ?? 'none';
        for (const segment of segments) {
          yield { id: segment.id, final: `${target}:${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const glossary = [{ source: 'Hello', target: 'こんにちは' }];
    const session = new VideoCaptionSession(document, {
      engine,
      labels,
      preferences: { ...captionPreferences(), glossary },
      readTrack: async () => '',
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    segment.textContent = 'Hello';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe('こんにちは:Hello');
    });
    expect(requests).toEqual(['Hello']);

    session.setPreferences({
      ...captionPreferences(),
      glossary: [{ source: 'Hello', target: 'こんにちは' }],
    });
    await sleep(200);
    expect(requests).toEqual(['Hello']);
    expect(host.getAttribute('data-sakutto-caption')).toBe('こんにちは:Hello');

    session.setPreferences({
      ...captionPreferences(),
      glossary: [{ source: 'Hello', target: 'やあ' }],
    });
    await vi.waitFor(() => {
      expect(requests).toEqual(['Hello', 'Hello']);
      expect(host.getAttribute('data-sakutto-caption')).toBe('やあ:Hello');
    });
    session.stop();
  });

  it('restarts a static live tail with new formality before it can freeze', async () => {
    document.body.innerHTML = youtubeMarkup('regressionformalitytail', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const requests: Array<{ text: string; form: string }> = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        requests.push({ text, form: options.form });
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: `${options.form}:${segment.text}`,
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
    segment.textContent = 'Static tail';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-caption')).toBe('polite:Static tail');
    });

    session.setPreferences({ ...captionPreferences(), form: 'plain' });
    await vi.waitFor(() => {
      expect(
        requests.some((request) => request.text === 'Static tail' && request.form === 'plain'),
      ).toBe(true);
      expect(host.getAttribute('data-sakutto-caption')).toBe('plain:Static tail');
    });
    await sleep(800);
    expect(host.getAttribute('data-sakutto-caption')).toBe('plain:Static tail');
    session.stop();
  });

  it('invalidates a queued tail refinement when the caption vanishes', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = youtubeMarkup('regressionqueuedpaint', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let now = 0;
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        if (text === 'Alpha.' || text === 'The station.') {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
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
      readTrack: async () => '',
      now: () => now,
    });
    try {
      session.start();
      await vi.advanceTimersByTimeAsync(0);
      const host = document.querySelector('sakutto-captions') as HTMLElement;
      const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
      segment.textContent = 'Alpha. The';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      now = 120;
      await vi.advanceTimersByTimeAsync(120);
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('The', 'ja'));

      // Commit a still-untranslated middle segment and translate the new tail soon
      // enough that its same-line repaint is deferred by the 200 ms refinement cap.
      now = 130;
      segment.textContent = 'Alpha. The station. Next';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      now = 250;
      await vi.advanceTimersByTimeAsync(120);
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('The', 'ja'));

      now = 260;
      segment.textContent = '';
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      expect(host.getAttribute('data-sakutto-caption')).not.toBe(fakeTranslateText('Next', 'ja'));
    } finally {
      session.stop();
      vi.useRealTimers();
    }
  });
});
