// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readGenericCaptionDom } from '@/captions/generic';

describe('generic caption DOM', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('returns one caption-like node and never joins a neighbour', () => {
    document.body.innerHTML = `
      <video></video>
      <div class="captions">The north window sells tickets.</div>
      <div class="subtitles">a red train waits at platform two.</div>
    `;
    expect(readGenericCaptionDom(document)).toBe('The north window sells tickets.');
  });

  it('drops target-language text so Japanese cannot leak into the source', () => {
    document.body.innerHTML = `
      <div class="caption">北側窓口では予約不要の切符を売っています。</div>
      <div class="captions">The north window sells tickets.</div>
    `;
    expect(readGenericCaptionDom(document, { targetLanguage: 'ja' })).toBe(
      'The north window sells tickets.',
    );
    expect(readGenericCaptionDom(document, { targetLanguage: 'ja' })).not.toMatch(/北側|切符|予約/);
  });

  it('ignores the overlay host and player controls', () => {
    document.body.innerHTML = `
      <sakutto-captions class="caption">駅は夜明けに開きます。</sakutto-captions>
      <button class="subtitle">CC</button>
      <div class="captions">The station opens at dawn.</div>
    `;
    expect(readGenericCaptionDom(document, { targetLanguage: 'ja' })).toBe(
      'The station opens at dawn.',
    );
  });
});
