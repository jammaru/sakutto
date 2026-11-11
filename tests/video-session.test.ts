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
    session.stop();
  });
});
