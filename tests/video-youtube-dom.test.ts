// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readYoutubeCaptionDom } from '@/captions/youtube';

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
});
