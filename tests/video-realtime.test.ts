// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageEngine } from '@/dom/session';
import { fakeTranslateText } from '@/dom/fake-engine';
import { VideoCaptionSession } from '@/captions/session';
import { readYoutubeCaptionDom } from '@/captions/youtube';

const labels = {
  label: 'Translated captions',
  pending: 'Translating caption…',
  showOriginal: 'Show original caption',
  hideOriginal: 'Hide original caption',
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

function mountLive(id: string, engine: PageEngine) {
  document.body.innerHTML = youtubeMarkup(id, true);
  const video = document.querySelector('video') as HTMLVideoElement;
  stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
  const session = new VideoCaptionSession(document, {
    engine,
    labels,
    preferences: captionPreferences(),
    readTrack: async () => '',
  });
  session.start();
  return {
    session,
    video,
    host: document.querySelector('sakutto-captions') as HTMLElement,
    segment: document.querySelector('.ytp-caption-segment') as HTMLElement,
  };
}

describe('two-line realtime captions', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('shows each committed original only with its own translation', async () => {
    const engine: PageEngine = {
      async *translate(segments) {
        await new Promise(() => undefined);
        for (const segment of segments) {
          yield { id: segment.id, final: '訳', engine: 'plamo' };
        }
      },
    };
    const { session, host, segment } = mountLive('twolinepending', engine);
    segment.textContent = 'Hello';
    await sleep(150);
    expect(host.hasAttribute('data-sakutto-original')).toBe(false);
    segment.textContent = 'Hello.';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-original')).toBe('Hello.');
    });
    expect(host.hasAttribute('data-sakutto-caption')).toBe(false);

    segment.textContent = 'Goodbye.';
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-original')).toBe('Goodbye.');
    });
    expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
    expect(host.hasAttribute('data-sakutto-history')).toBe(false);
    session.stop();
  });

  it('keeps the previous translation visible while the exact growth is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments) {
        const text = segments[0]?.text ?? '';
        if (text === 'Hello world.') await gate;
        for (const segment of segments) {
          yield { id: segment.id, final: '同じ訳', engine: 'plamo' };
        }
      },
    };
    const { session, host, segment } = mountLive('twolinegrowing', engine);
    try {
      segment.textContent = 'Hello.';
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-caption')).toBe('同じ訳');
      });

      segment.textContent = 'Hello world';
      await sleep(150);
      expect(host.getAttribute('data-sakutto-original')).toBe('Hello.');
      expect(host.getAttribute('data-sakutto-caption')).toBe('同じ訳');
      segment.textContent = 'Hello world.';
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-original')).toBe('Hello world.');
      });
      expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
      release();
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-original')).toBe('Hello world.');
        expect(host.getAttribute('data-sakutto-caption')).toBe('同じ訳');
      });
    } finally {
      release();
      session.stop();
    }
  });

  it('builds full utterances with context and keeps the committed translation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: Array<{ text: string; context: string }> = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        requests.push({ text, context: options.context ?? '' });
        if (text === 'A red' || text === 'A red train waits.') await gate;
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: fakeTranslateText(segment.text, options.tgt),
            engine: 'plamo',
          };
        }
      },
    };
    const { session, host, segment } = mountLive('twolineutterance', engine);
    try {
      segment.textContent = 'The station';
      await sleep(150);
      segment.textContent = 'opens at';
      await sleep(150);
      segment.textContent = 'dawn.';
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-original')).toBe('The station opens at dawn.');
        expect(host.getAttribute('data-sakutto-caption')).toBe(
          fakeTranslateText('The station opens at dawn.', 'ja'),
        );
      });

      segment.textContent = 'A red';
      await sleep(150);
      expect(host.getAttribute('data-sakutto-original')).toBe('The station opens at dawn.');
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
      segment.textContent = 'train waits.';
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-original')).toBe('A red train waits.');
      });
      expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
      release();
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-caption')).toBe(
          fakeTranslateText('A red train waits.', 'ja'),
        );
      });
      expect(
        requests.some(
          (request) =>
            request.text === 'A red train waits.' &&
            request.context === 'The station opens at dawn.',
        ),
      ).toBe(true);
      expect(
        requests.filter((request) => request.text === 'The station opens at dawn.'),
      ).toHaveLength(1);
      expect(requests.filter((request) => request.text === 'A red train waits.')).toHaveLength(1);
    } finally {
      release();
      session.stop();
    }
  });

  it('cancels stale jobs and displays only the latest original and translation', async () => {
    const requests: Array<{ text: string; signal: AbortSignal }> = [];
    const gates = new Map<string, Promise<void>>();
    const releases = new Map<string, () => void>();
    for (const text of ['Hello.', 'Hello world.', 'Goodbye.']) {
      let release!: () => void;
      gates.set(
        text,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      releases.set(text, release);
    }
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        requests.push({ text, signal: options.signal });
        await gates.get(text);
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: fakeTranslateText(segment.text, options.tgt),
            engine: 'plamo',
          };
        }
      },
    };
    const { session, host, segment } = mountLive('twolinelatest', engine);
    try {
      segment.textContent = 'Hello.';
      await vi.waitFor(() => expect(requests.map((request) => request.text)).toContain('Hello.'));
      segment.textContent = 'Hello world.';
      await vi.waitFor(() =>
        expect(requests.map((request) => request.text)).toContain('Hello world.'),
      );
      segment.textContent = 'Goodbye.';
      await vi.waitFor(() => expect(requests.map((request) => request.text)).toContain('Goodbye.'));
      expect(requests.find((request) => request.text === 'Hello.')?.signal.aborted).toBe(true);
      expect(requests.find((request) => request.text === 'Hello world.')?.signal.aborted).toBe(
        true,
      );

      releases.get('Goodbye.')?.();
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-original')).toBe('Goodbye.');
        expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Goodbye.', 'ja'));
      });
      releases.get('Hello.')?.();
      releases.get('Hello world.')?.();
      await sleep(50);
      expect(host.getAttribute('data-sakutto-original')).toBe('Goodbye.');
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Goodbye.', 'ja'));
    } finally {
      for (const release of releases.values()) release();
      session.stop();
    }
  });

  it('translates completed units without displaying growing fragments', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const engine: PageEngine = {
      async *translate(segments) {
        requests.push(segments[0]?.text ?? '');
        for (const segment of segments) {
          yield { id: segment.id, final: '訳', engine: 'plamo' };
        }
      },
    };
    const { session, segment } = mountLive('twolinedebounce', engine);
    try {
      segment.textContent = 'Hello';
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).not.toContain('Hello');

      segment.textContent = 'Hello world';
      await vi.advanceTimersByTimeAsync(100);
      expect(requests).not.toContain('Hello world');
      await vi.advanceTimersByTimeAsync(900);
      expect(requests).toContain('Hello world');

      segment.textContent = 'Goodbye.';
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toContain('Goodbye.');
    } finally {
      session.stop();
      vi.useRealTimers();
    }
  });

  it('shows only the active roll-up fragment without older text', async () => {
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
    const { session, host, segment } = mountLive('twolinedupe', engine);
    segment.textContent = 'Hello';
    await vi.waitFor(() => {
      expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
        'Hello',
      );
    });
    const second = segment.cloneNode(true) as HTMLElement;
    second.textContent = 'A red train waits.';
    document.querySelector('.ytp-caption-window-container')?.append(second);
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-original')).toBe('A red train waits.');
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('A red train waits.', 'ja'),
      );
    });
    expect(host.getAttribute('data-sakutto-original')).not.toContain('Hello');
    expect(host.hasAttribute('data-sakutto-history')).toBe(false);
    expect(host.hasAttribute('data-sakutto-history-lines')).toBe(false);
    session.stop();
  });

  it('keeps punctuated roll-up history out of the current caption', async () => {
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
    const { session, host, segment } = mountLive('twolinerollupcomplete', engine);
    segment.textContent = 'The station opens';
    await vi.waitFor(() => {
      expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
        'The station opens',
      );
    });
    const second = segment.cloneNode(true) as HTMLElement;
    second.textContent = 'A red train waits.';
    document.querySelector('.ytp-caption-window-container')?.append(second);

    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-original')).toBe('A red train waits.');
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('A red train waits.', 'ja'),
      );
    });
    expect(host.getAttribute('data-sakutto-original')).not.toContain('The station opens');
    session.stop();
  });

  it('joins simultaneous pop-on segments into one current caption', async () => {
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
    const { session, host, segment } = mountLive('twolinepopon', engine);
    segment.textContent = 'The station opens';
    const second = segment.cloneNode(true) as HTMLElement;
    second.textContent = 'at dawn.';
    document.querySelector('.ytp-caption-window-container')?.append(second);

    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-original')).toBe('The station opens at dawn.');
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn.', 'ja'),
      );
    });
    expect(host.getAttribute('data-sakutto-original')).not.toBe('at dawn.');
    session.stop();
  });

  it('joins unpunctuated simultaneous pop-on segments', async () => {
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
    const { session, host, segment } = mountLive('twolinepoponplain', engine);
    segment.textContent = 'The station opens';
    const second = segment.cloneNode(true) as HTMLElement;
    second.textContent = 'at dawn';
    document.querySelector('.ytp-caption-window-container')?.append(second);
    await sleep(1_000);
    await vi.waitFor(() => {
      expect(host.getAttribute('data-sakutto-original')).toBe('The station opens at dawn');
      expect(host.getAttribute('data-sakutto-caption')).toBe(
        fakeTranslateText('The station opens at dawn', 'ja'),
      );
    });
    session.stop();
  });

  it('reuses the cache when the same caption returns', async () => {
    const requests: string[] = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        requests.push(segments[0]?.text ?? '');
        for (const segment of segments) {
          yield {
            id: segment.id,
            final: fakeTranslateText(segment.text, options.tgt),
            engine: 'plamo',
          };
        }
      },
    };
    const { session, host, segment } = mountLive('twolinecache', engine);
    segment.textContent = 'Hello';
    await sleep(1_000);
    await vi.waitFor(() =>
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Hello', 'ja')),
    );
    segment.textContent = 'Goodbye.';
    await vi.waitFor(() =>
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Goodbye.', 'ja')),
    );
    segment.textContent = 'Hello';
    await sleep(1_000);
    await vi.waitFor(() =>
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Hello', 'ja')),
    );
    expect(requests.filter((text) => text === 'Hello')).toHaveLength(1);
    session.stop();
  });

  it('restarts a static tail with new formality before it can settle', async () => {
    const requests: Array<{ text: string; form: string }> = [];
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        requests.push({ text, form: options.form });
        for (const segment of segments) {
          yield { id: segment.id, final: `${options.form}:${segment.text}`, engine: 'plamo' };
        }
      },
    };
    const { session, host, segment } = mountLive('twolineformality', engine);
    segment.textContent = 'Static tail';
    await sleep(1_000);
    await vi.waitFor(() =>
      expect(host.getAttribute('data-sakutto-caption')).toBe('polite:Static tail'),
    );
    session.setPreferences({ ...captionPreferences(), form: 'plain' });
    await sleep(1_000);
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

  it('does not reset for equal fresh glossaries but restarts for actual edits', async () => {
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
    const { session, host, segment } = mountLive('twolineglossary', engine);
    segment.textContent = 'Hello';
    session.setPreferences({
      ...captionPreferences(),
      glossary: [{ source: 'Hello', target: 'こんにちは' }],
    });
    await sleep(1_000);
    await vi.waitFor(() =>
      expect(host.getAttribute('data-sakutto-caption')).toBe('こんにちは:Hello'),
    );
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
    await sleep(1_000);
    await vi.waitFor(() => {
      expect(requests).toEqual(['Hello', 'Hello']);
      expect(host.getAttribute('data-sakutto-caption')).toBe('やあ:Hello');
    });
    session.stop();
  });

  it('falls back to native captions after a mutable-tail translation failure', async () => {
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
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
    const { session, host, segment } = mountLive('twolinefailure', engine);
    segment.textContent = 'Alpha.';
    await vi.waitFor(() =>
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('Alpha.', 'ja')),
    );
    segment.textContent = 'Alpha. Beta';
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute('data-sakutto-captions')).toBe('waiting');
    });
    expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
    session.stop();
  });

  it('does not duplicate non-live ASR source in both rows while translation is pending', async () => {
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
        <video id="player" class="html5-main-video"></video>
        <div class="ytp-caption-window-container" lang="en">
          <span class="ytp-caption-segment"></span>
        </div>
      </div>
      <script>
        var ytInitialPlayerResponse = {
          "videoDetails": { "videoId": "vodasrpending", "defaultAudioLanguage": "en" },
          "captions": {
            "playerCaptionsTracklistRenderer": {
              "captionTracks": [{
                "baseUrl": "/youtube-timedtext-en-asr.json?lang=en&kind=asr",
                "languageCode": "en",
                "kind": "asr",
                "name": { "simpleText": "English (auto-generated)" }
              }]
            }
          }
        };
      </script>`;
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    const engine: PageEngine = {
      async *translate() {
        await new Promise(() => undefined);
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
      segment.textContent = 'The station opens at dawn.';
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-original')).toBe('The station opens at dawn.');
      });
      expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
      const overlay = (
        session as unknown as { overlay: import('@/captions/overlay').CaptionOverlay }
      ).overlay;
      const shadow = overlay.shadow();
      const original = shadow?.querySelector('.original') as HTMLElement | null;
      const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
      expect(original?.textContent).toBe('The station opens at dawn.');
      expect(translated?.textContent).toBe(labels.pending);
      expect(translated?.textContent).not.toBe('The station opens at dawn.');
    } finally {
      session.stop();
    }
  });

  it('does not let an older timed cue overwrite a newer DOM live caption', async () => {
    document.body.innerHTML = youtubeMarkup('twolineownership', true);
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
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
        const text = segments[0]?.text ?? '';
        if (text === 'Timed cue') {
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
      readTrack: async () =>
        JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Timed cue' }] }],
        }),
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const segment = document.querySelector('.ytp-caption-segment') as HTMLElement;
    try {
      await started;
      segment.textContent = 'DOM live';
      await sleep(1_000);
      await vi.waitFor(() =>
        expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('DOM live', 'ja')),
      );
      release();
      await sleep(100);
      expect(host.getAttribute('data-sakutto-caption')).toBe(fakeTranslateText('DOM live', 'ja'));
    } finally {
      release();
      session.stop();
    }
  });
});

describe('pre-timed caption scheduling', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('warms the first caption before it appears', async () => {
    document.body.innerHTML = youtubeMarkup('twolineprefetch');
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.2, duration: 30 });
    let completed = 0;
    const engine: PageEngine = {
      async *translate(segments, options) {
        await sleep(150);
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
            { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'The station opens at dawn.' }] },
            { tStartMs: 3500, dDurationMs: 2000, segs: [{ utf8: 'A red train waits.' }] },
          ],
        }),
    });
    session.start();
    await vi.waitFor(() => expect(completed).toBeGreaterThan(0));
    video.currentTime = 1.6;
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe('The station opens at dawn.');
    });
    session.stop();
  });

  it('cancels the previous cue when playback moves on', async () => {
    document.body.innerHTML = youtubeMarkup('twolinevodcancel');
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let firstAborted = false;
    let firstStarted = false;
    const started = new Promise<void>((resolve) => {
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
            const timer = setTimeout(resolve, 2000);
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
            { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'The station opens at dawn.' }] },
            { tStartMs: 4000, dDurationMs: 4000, segs: [{ utf8: 'A red train waits.' }] },
          ],
        }),
    });
    session.start();
    await started;
    video.currentTime = 4.5;
    video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original'),
      ).toBe('A red train waits.');
    });
    expect(firstAborted).toBe(true);
    session.stop();
  });

  it('shows the new VOD original with only its own pending translation', async () => {
    document.body.innerHTML = youtubeMarkup('twolinevodpending');
    const video = document.querySelector('video') as HTMLVideoElement;
    stubMedia(video, { paused: false, currentTime: 0.4, duration: 30 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine: PageEngine = {
      async *translate(segments, options) {
        const text = segments[0]?.text ?? '';
        if (text === 'A red train waits.') await gate;
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
            { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'The station opens at dawn.' }] },
            { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: 'A red train waits.' }] },
          ],
        }),
    });
    session.start();
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    try {
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-caption')).toBe(
          fakeTranslateText('The station opens at dawn.', 'ja'),
        );
      });
      video.currentTime = 1.2;
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-original')).toBe('A red train waits.');
      });
      expect(host.hasAttribute('data-sakutto-caption')).toBe(false);
      expect(host.getAttribute('data-sakutto-pending')).toBe('1');
      release();
      await vi.waitFor(() => {
        expect(host.getAttribute('data-sakutto-caption')).toBe(
          fakeTranslateText('A red train waits.', 'ja'),
        );
      });
    } finally {
      release();
      session.stop();
    }
  });

  it('drops a held line after a seek behind it', async () => {
    document.body.innerHTML = youtubeMarkup('twolinevodseek');
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
            { tStartMs: 8000, dDurationMs: 3000, segs: [{ utf8: 'A red train waits.' }] },
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
        fakeTranslateText('A red train waits.', 'ja'),
      );
    });
    video.currentTime = 3.5;
    window.dispatchEvent(new Event('seeking', { bubbles: true }));
    window.dispatchEvent(new Event('seeked', { bubbles: true }));
    await vi.waitFor(() => {
      expect(
        document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption'),
      ).not.toBe(fakeTranslateText('A red train waits.', 'ja'));
    });
    session.stop();
  });
});
