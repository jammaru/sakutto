// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { pickCaptionTrack } from '@/captions/html5';
import {
  playerResponseForPage,
  playerResponseFromDocument,
  captionSourceIsTargetLanguage,
  peekYoutubeCaptionDom,
  readYoutubeCaptionDom,
  videoIdFromPlayerResponse,
} from '@/captions/youtube';
import { pickXSubtitleRendition } from '@/captions/x';

describe('YouTube caption DOM source', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('reads the spoken-language window and ignores auto-translate plus overlay nodes', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <div class="caption-window" lang="en">
          <span class="ytp-caption-segment">the north window sells tickets.</span>
        </div>
        <div class="caption-window" lang="ja">
          <span class="ytp-caption-segment">北側窓口では切符を売っています。</span>
        </div>
      </div>
      <sakutto-captions>
        <span class="ytp-caption-segment">北側窓口では切符を売っています。</span>
      </sakutto-captions>
    `;
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'the north window sells tickets.',
    );
  });

  it('strips a Japanese tail glued onto one English segment', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <span class="ytp-caption-segment">the north window sells tickets, 北側窓口では切符を売っています</span>
      </div>
    `;
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja' })).toBe(
      'the north window sells tickets,',
    );
  });

  it('joins simultaneous pop-on fragments already present on first observation', () => {
    document.body.innerHTML =
      '<div class="ytp-caption-window-container caption-window" lang="en"><span class="ytp-caption-segment">The station opens</span><span class="ytp-caption-segment">at dawn</span></div>';
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'The station opens at dawn',
    );
  });

  it('keeps both pop-on lines when YouTube replaces the segment nodes', () => {
    document.body.innerHTML =
      '<div class="ytp-caption-window-container caption-window" lang="en"><span class="ytp-caption-segment">The station opens</span><span class="ytp-caption-segment">at dawn</span></div>';
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'The station opens at dawn',
    );

    const window = document.querySelector('.caption-window') as HTMLElement;
    const replaceSegments = (lines: readonly string[]): void => {
      const segments = lines.map((line) => {
        const segment = document.createElement('span');
        segment.className = 'ytp-caption-segment';
        segment.textContent = line;
        return segment;
      });
      window.replaceChildren(...segments);
    };

    // A re-rendered cue with the same text must not silently drop its first line.
    replaceSegments(['The station opens', 'at dawn']);
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'The station opens at dawn',
    );

    // Nor may the next pop-on cue, whose every segment node is replaced.
    replaceSegments(['A red train waits', 'on platform two']);
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'A red train waits on platform two',
    );
  });

  it('selects only the appended current fragment for punctuated roll-up', () => {
    document.body.innerHTML =
      '<div class="ytp-caption-window-container caption-window" lang="en"><span class="ytp-caption-segment"></span></div>';
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      '',
    );
    const first = document.querySelector('.ytp-caption-segment') as HTMLElement;
    first.textContent = 'The station opens';
    const second = document.createElement('span');
    second.className = 'ytp-caption-segment';
    second.textContent = 'A red train waits.';
    document.querySelector('.caption-window')?.append(second);

    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'A red train waits.',
    );
  });

  it('keeps only the current fragment when roll-up scrolls its completed line off', () => {
    document.body.innerHTML =
      '<div class="ytp-caption-window-container caption-window" lang="en"><span class="ytp-caption-segment">The station opens</span><span class="ytp-caption-segment">A red train waits.</span></div>';
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'The station opens A red train waits.',
    );
    const window = document.querySelector('.caption-window') as HTMLElement;
    const kept = window.querySelectorAll('.ytp-caption-segment')[1] as HTMLElement;
    const next = document.createElement('span');
    next.className = 'ytp-caption-segment';
    next.textContent = 'and departs.';
    window.replaceChildren(kept, next);
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja', spokenLanguage: 'en' })).toBe(
      'and departs.',
    );
  });

  it('peeks raw native text without treating a known English track as Japanese', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <div class="caption-window" lang="en">
          <span class="ytp-caption-segment">the north window sells tickets.</span>
        </div>
        <div class="caption-window" lang="ja">
          <span class="ytp-caption-segment">北側窓口では切符を売っています。</span>
        </div>
      </div>
    `;
    expect(peekYoutubeCaptionDom(document)).toContain('the north window sells tickets.');
    expect(peekYoutubeCaptionDom(document)).toContain('北側窓口では切符を売っています。');
    expect(captionSourceIsTargetLanguage('en', peekYoutubeCaptionDom(document), 'ja')).toBe(false);
  });

  it('ignores a player response that belongs to a different watch URL', async () => {
    const { Window } = await import('happy-dom');
    const view = new Window({ url: 'https://www.youtube.com/watch?v=videoB00002' });
    const doc = view.document;
    doc.body.innerHTML = `
      <script>
        var ytInitialPlayerResponse = {
          "videoDetails": { "videoId": "videoA00001" },
          "captions": { "playerCaptionsTracklistRenderer": { "captionTracks": [{
            "baseUrl": "/old.json", "languageCode": "en", "name": { "simpleText": "English" }
          }] } }
        };
      </script>
    `;
    expect(playerResponseFromDocument(doc as unknown as Document)).toBeNull();
    expect(
      playerResponseForPage(doc as unknown as Document, {
        videoDetails: { videoId: 'videoA00001' },
      }),
    ).toBeNull();
    expect(videoIdFromPlayerResponse({ videoDetails: { videoId: 'videoB00002' } })).toBe(
      'videoB00002',
    );
    view.close();
  });
});

describe('Easy Japanese caption sources', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('reads a Japanese-only caption window instead of dropping it', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <div class="caption-window" lang="ja">
          <span class="ytp-caption-segment">北側窓口では切符を売っています。</span>
        </div>
      </div>
    `;
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja-easy' })).toBe(
      '北側窓口では切符を売っています。',
    );
  });

  it('prefers the Japanese window over an English auto-translate window', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <div class="caption-window" lang="ja">
          <span class="ytp-caption-segment">北側窓口では切符を売っています。</span>
        </div>
        <div class="caption-window" lang="en">
          <span class="ytp-caption-segment">Tickets are sold at the north window.</span>
        </div>
      </div>
    `;
    expect(readYoutubeCaptionDom(document, { targetLanguage: 'ja-easy' })).toBe(
      '北側窓口では切符を売っています。',
    );
  });

  it('keeps a Japanese HTML5 track instead of treating it as the target', () => {
    const tracks = [
      { kind: 'subtitles', language: 'ja', mode: 'disabled' },
      { kind: 'subtitles', language: 'en', mode: 'disabled' },
    ] as TextTrack[];
    expect(pickCaptionTrack(tracks, 'ja-easy')?.language).toBe('ja');
  });

  it('keeps a default Japanese X subtitle rendition for Easy Japanese', () => {
    const renditions = [
      {
        uri: 'https://video.twimg.com/subtitles/ja.vtt',
        language: 'ja',
        isDefault: true,
      },
      {
        uri: 'https://video.twimg.com/subtitles/en.vtt',
        language: 'en',
        isDefault: false,
      },
    ];
    expect(pickXSubtitleRendition(renditions, 'ja-easy')?.language).toBe('ja');
  });
});
