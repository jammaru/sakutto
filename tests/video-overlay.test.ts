// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  CaptionOverlay,
  captionChromeInset,
  captionOverlayFontPx,
  captionOverlayRoot,
  CAPTION_ORIGINAL_TOGGLE,
} from '@/captions/overlay';

const labels = {
  label: 'Translated captions',
  pending: 'Translating caption…',
  showOriginal: 'Show original caption',
  hideOriginal: 'Hide original caption',
};

describe('caption overlay', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('shows the original while a translation is pending, then both lines in bilingual mode', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: null,
      display: 'bilingual',
      pending: true,
    });

    const shadow = overlay.shadow();
    expect(shadow).not.toBeNull();
    const original = shadow?.querySelector('.original') as HTMLElement | null;
    const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
    expect(original?.hidden).toBe(false);
    expect(original?.textContent).toBe('The station opens at dawn.');
    // Pending must not paint the status sentence over the video.
    expect(translated?.textContent).not.toBe('Translating caption…');
    expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-pending')).toBe(
      '1',
    );

    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    expect(original?.textContent).toBe('The station opens at dawn.');
    expect(translated?.textContent).toBe('駅は夜明けに開きます。');
    expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-caption')).toBe(
      '駅は夜明けに開きます。',
    );
    expect(document.querySelector('sakutto-captions')?.getAttribute('data-sakutto-original')).toBe(
      'The station opens at dawn.',
    );
    overlay.detach();
  });

  it('keeps the original when replace mode has no translation yet', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'Tickets are sold at the north window.',
      translation: null,
      display: 'replace',
      pending: false,
    });
    const shadow = overlay.shadow();
    const original = shadow?.querySelector('.original') as HTMLElement | null;
    const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
    expect(original?.hidden).toBe(true);
    expect(translated?.hidden).toBe(false);
    expect(translated?.textContent).toBe('Tickets are sold at the north window.');
    overlay.detach();
  });

  it('puts the original-caption toggle in the light DOM and toggles on click', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    const host = document.querySelector('sakutto-captions');
    const button = document.querySelector(`[data-sakutto="${CAPTION_ORIGINAL_TOGGLE}"]`);
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.parentElement).toBe(host);
    expect(host?.getAttribute('data-sakutto-show-original')).toBe('1');
    expect((button as HTMLButtonElement).textContent).toBe('Hide original caption');

    let toggled = 0;
    overlay.setOnDisplayToggle(() => {
      toggled += 1;
    });
    (button as HTMLButtonElement).click();
    expect(toggled).toBe(1);
    overlay.detach();
  });

  it('toggles once for a full pointerdown/mouseup/click gesture and not on down or up', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    const button = document.querySelector(
      `[data-sakutto="${CAPTION_ORIGINAL_TOGGLE}"]`,
    ) as HTMLButtonElement;
    let toggled = 0;
    overlay.setOnDisplayToggle(() => {
      toggled += 1;
    });
    let parentSaw = 0;
    document.body.addEventListener(
      'click',
      () => {
        parentSaw += 1;
      },
      true,
    );

    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
      button.dispatchEvent(
        new MouseEvent(type, { bubbles: true, composed: true, cancelable: true }),
      );
    }
    expect(toggled).toBe(0);
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }),
    );
    expect(toggled).toBe(1);
    expect(parentSaw).toBe(0);
    overlay.detach();
  });

  it('attaches to #movie_player instead of the inner video container', () => {
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
        <div class="html5-video-container"><video></video></div>
        <div class="ytp-chrome-bottom"></div>
      </div>
    `;
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(captionOverlayRoot(document, video as HTMLVideoElement).id).toBe('movie_player');
  });

  it('reparents into the fullscreen element in every player mode', () => {
    document.body.innerHTML = `
      <div id="fs">
        <div data-testid="videoPlayer"><video></video></div>
      </div>
    `;
    const fullscreen = document.getElementById('fs');
    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreen,
    });
    expect(captionOverlayRoot(document, video)).toBe(fullscreen);
  });

  it('attaches to the X player and lifts the overlay above the chrome', () => {
    document.body.innerHTML = `
      <div data-testid="videoPlayer">
        <video></video>
      </div>
    `;
    const video = document.querySelector('video') as HTMLVideoElement;
    const root = captionOverlayRoot(document, video);
    expect((root as HTMLElement).getAttribute('data-testid')).toBe('videoPlayer');
    expect(captionChromeInset(root)).toBe(52);
  });

  it('scales caption type with player height and the size setting', () => {
    const smaller = captionOverlayFontPx(400, undefined, 80);
    const larger = captionOverlayFontPx(400, undefined, 150);
    expect(smaller).toBeLessThan(captionOverlayFontPx(400, undefined, 100));
    expect(larger).toBeGreaterThan(smaller);
    expect(captionOverlayFontPx(900)).toBeGreaterThan(captionOverlayFontPx(180));
  });
});
