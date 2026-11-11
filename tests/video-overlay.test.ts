// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  CaptionOverlay,
  captionChromeInset,
  CAPTION_FONT_MIN_PX,
  captionOverlayFontPx,
  pickCaptionLayoutRect,
  captionOverlayRoot,
  CAPTION_ORIGINAL_TOGGLE,
  X_CAPTION_CHROME_FALLBACK_PX,
} from '@/captions/overlay';

function revealToggle(root: ParentNode = document.body): void {
  const target = root instanceof Element ? root : document.body;
  target.dispatchEvent(new Event('pointermove', { bubbles: true, composed: true }));
}

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

  it('stays hidden until a translation exists, then shows both bilingual lines', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: null,
      display: 'bilingual',
      pending: true,
    });

    const host = document.querySelector('sakutto-captions') as HTMLElement | null;
    const shadow = overlay.shadow();
    expect(shadow).not.toBeNull();
    const original = shadow?.querySelector('.original') as HTMLElement | null;
    const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
    expect(host?.hidden).toBe(true);
    expect(original?.hidden).toBe(true);
    expect(original?.textContent).toBe('');
    expect(translated?.hidden).toBe(true);
    expect(translated?.textContent).toBe('');
    expect(host?.hasAttribute('data-sakutto-caption')).toBe(false);

    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    expect(host?.hidden).toBe(false);
    expect(original?.textContent).toBe('The station opens at dawn.');
    expect(translated?.textContent).toBe('駅は夜明けに開きます。');
    expect(host?.getAttribute('data-sakutto-caption')).toBe('駅は夜明けに開きます。');
    expect(host?.getAttribute('data-sakutto-original')).toBe('The station opens at dawn.');
    overlay.detach();
  });

  it('does not paint an empty original-only box in replace mode', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'Tickets are sold at the north window.',
      translation: null,
      display: 'replace',
      pending: false,
    });
    const host = document.querySelector('sakutto-captions') as HTMLElement | null;
    const shadow = overlay.shadow();
    const original = shadow?.querySelector('.original') as HTMLElement | null;
    const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
    expect(host?.hidden).toBe(true);
    expect(original?.hidden).toBe(true);
    expect(translated?.hidden).toBe(true);
    expect(translated?.textContent).toBe('');
    overlay.detach();
  });

  it('hides empty caption lines so they cannot paint as black bars', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'replace',
      pending: false,
    });
    const shadow = overlay.shadow();
    const original = shadow?.querySelector('.original') as HTMLElement | null;
    const translated = shadow?.querySelector('.line:not(.original)') as HTMLElement | null;
    expect(original?.hidden).toBe(true);
    expect(original?.textContent).toBe('');
    expect(translated?.hidden).toBe(false);
    overlay.hide();
    expect(original?.hidden).toBe(true);
    expect(translated?.hidden).toBe(true);
    expect((document.querySelector('sakutto-captions') as HTMLElement | null)?.hidden).toBe(true);
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
    expect(button?.parentElement).toBe(document.body);
    expect(button).not.toBe(host);
    expect((button as HTMLButtonElement).hidden).toBe(true);
    revealToggle();
    expect((button as HTMLButtonElement).hidden).toBe(false);
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
    revealToggle();
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
        <div id="movie_player"><video></video></div>
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

  it('keeps the X overlay inside videoPlayer even when that player is fullscreened', () => {
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
    expect((captionOverlayRoot(document, video) as HTMLElement).getAttribute('data-testid')).toBe(
      'videoPlayer',
    );
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
    expect(captionChromeInset(root)).toBe(X_CAPTION_CHROME_FALLBACK_PX);
  });

  it('mounts absolutely inside an overflow-hidden transformed X player', () => {
    document.body.innerHTML = `
      <div data-testid="videoPlayer" style="position: relative; overflow: hidden; transform: translateZ(0); width: 640px; height: 360px">
        <div style="overflow: hidden; transform: scale(1)">
          <video></video>
        </div>
        <div data-sakutto="x-controls" style="position: absolute; bottom: 0; height: 64px">
          <button type="button">Play</button>
        </div>
      </div>
    `;
    const video = document.querySelector('video') as HTMLVideoElement;
    const root = captionOverlayRoot(document, video);
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(root);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    overlay.place({ left: 0, top: 0, width: 640, height: 360 }, 28, captionChromeInset(root));
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    expect(host.parentElement).toBe(root);
    expect(host.style.position).toBe('absolute');
    expect(host.style.top).toBe('auto');
    expect(host.style.transform).toBe('translateX(-50%)');
    expect(Number.parseFloat(host.style.bottom)).toBeGreaterThanOrEqual(
      X_CAPTION_CHROME_FALLBACK_PX,
    );
    const wrap = overlay.shadow()?.querySelector('.wrap');
    expect(wrap?.querySelector('slot')).toBeNull();
    const toggle = document.querySelector(
      `[data-sakutto="${CAPTION_ORIGINAL_TOGGLE}"]`,
    ) as HTMLButtonElement;
    expect(toggle.parentElement).toBe(root);
    expect(toggle.hidden).toBe(true);
    revealToggle(root);
    expect(toggle.hidden).toBe(false);
    expect(toggle.style.right).toBe('8px');
    expect(Number.parseFloat(toggle.style.bottom)).toBeGreaterThanOrEqual(
      X_CAPTION_CHROME_FALLBACK_PX,
    );
    overlay.detach();
  });

  it('ignores mid-player buttons when measuring X chrome so captions stay at the bottom', () => {
    document.body.innerHTML = `
      <div data-testid="videoPlayer" style="position: relative; width: 640px; height: 360px">
        <video></video>
        <button type="button" style="position: absolute; left: 8px; top: 160px; width: 32px; height: 32px">Mute</button>
        <div data-sakutto="x-controls" style="position: absolute; bottom: 0; height: 48px">
          <button type="button">Play</button>
        </div>
      </div>
    `;
    const root = document.querySelector('[data-testid="videoPlayer"]') as HTMLElement;
    root.getBoundingClientRect = () =>
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
    const mute = root.querySelector('button') as HTMLElement;
    mute.getBoundingClientRect = () =>
      ({
        x: 8,
        y: 160,
        left: 8,
        top: 160,
        right: 40,
        bottom: 192,
        width: 32,
        height: 32,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const play = root.querySelector('[data-sakutto="x-controls"] button') as HTMLElement;
    play.getBoundingClientRect = () =>
      ({
        x: 8,
        y: 312,
        left: 8,
        top: 312,
        right: 48,
        bottom: 344,
        width: 40,
        height: 32,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const inset = captionChromeInset(root);
    expect(inset).toBeLessThan(120);
    expect(inset).toBeGreaterThanOrEqual(X_CAPTION_CHROME_FALLBACK_PX);
  });

  it('keeps the original-toggle off when the setting disables it', () => {
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(document.body);
    overlay.setToggleEnabled(false);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'bilingual',
      pending: false,
    });
    revealToggle();
    const button = document.querySelector(
      `[data-sakutto="${CAPTION_ORIGINAL_TOGGLE}"]`,
    ) as HTMLButtonElement;
    expect(button.hidden).toBe(true);
    overlay.detach();
  });

  it('attaches to the X player inside an expanded media dialog', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <div data-testid="videoPlayer"><video></video></div>
      </div>
    `;
    const video = document.querySelector('video') as HTMLVideoElement;
    expect((captionOverlayRoot(document, video) as HTMLElement).getAttribute('data-testid')).toBe(
      'videoPlayer',
    );
  });

  it('scales caption type with player height and the size setting', () => {
    const smaller = captionOverlayFontPx(400, undefined, 80);
    const larger = captionOverlayFontPx(400, undefined, 150);
    expect(smaller).toBeLessThan(captionOverlayFontPx(400, undefined, 100));
    expect(larger).toBeGreaterThan(smaller);
    expect(captionOverlayFontPx(900)).toBeGreaterThan(captionOverlayFontPx(180));
  });

  it('does not shrink type from a 0 or collapsed player rect', () => {
    const settled = captionOverlayFontPx(540);
    expect(captionOverlayFontPx(0)).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
    expect(captionOverlayFontPx(40)).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
    expect(captionOverlayFontPx(0)).toBe(captionOverlayFontPx(40));
    expect(settled).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
    expect(captionOverlayFontPx(0)).toBeLessThanOrEqual(settled);
  });

  it('ignores a tiny native font-size that is smaller than the player-based size', () => {
    const fromPlayer = captionOverlayFontPx(540);
    expect(captionOverlayFontPx(540, 14)).toBe(fromPlayer);
    expect(captionOverlayFontPx(540, 14)).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
  });

  it('reuses the last laid-out player box when the video collapses mid-transition', () => {
    const good = { left: 0, top: 0, width: 960, height: 540 };
    const collapsed = { left: 0, top: 0, width: 0, height: 0 };
    const tiny = { left: 10, top: 20, width: 80, height: 45 };
    expect(pickCaptionLayoutRect(collapsed, tiny, good)).toEqual(good);
    expect(pickCaptionLayoutRect(good, good, collapsed).height).toBe(540);
    const first = pickCaptionLayoutRect(collapsed, null);
    expect(first.height).toBe(0);
    expect(captionOverlayFontPx(first.height)).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
  });
});
