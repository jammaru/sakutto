// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CaptionOverlay,
  captionChromeInset,
  CAPTION_DRAG_HOLD_MS,
  CAPTION_FONT_MIN_PX,
  CAPTION_POSITION_MARGIN_PX,
  captionOverlayFontPx,
  clampCaptionOverlayPercent,
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
    vi.useRealTimers();
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

  it('lets the size slider shrink below the YouTube-normal floor', () => {
    const atDefault = captionOverlayFontPx(540, undefined, 80);
    const atMin = captionOverlayFontPx(540, undefined, 50);
    const atMax = captionOverlayFontPx(540, undefined, 150);
    const previewDefault = captionOverlayFontPx(220, undefined, 80);
    const previewMin = captionOverlayFontPx(220, undefined, 50);
    expect(atDefault).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
    expect(previewDefault).toBeGreaterThanOrEqual(CAPTION_FONT_MIN_PX);
    expect(atMin).toBeLessThan(CAPTION_FONT_MIN_PX);
    expect(previewMin).toBeLessThan(previewDefault);
    expect(previewMin).toBeLessThan(CAPTION_FONT_MIN_PX);
    expect(atMin).toBeLessThan(atDefault);
    expect(atMax).toBeGreaterThan(atDefault);
    expect(atMax - atMin).toBeGreaterThan(12);
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

  it('clamps a dragged overlay above the control bar and inside the player', () => {
    const player = { width: 640, height: 360 };
    const overlay = { width: 200, height: 48 };
    const chrome = 72;
    const high = clampCaptionOverlayPercent(50, 0, overlay, player, chrome);
    const low = clampCaptionOverlayPercent(50, 100, overlay, player, chrome);
    const left = clampCaptionOverlayPercent(0, 40, overlay, player, chrome);
    const right = clampCaptionOverlayPercent(100, 40, overlay, player, chrome);
    expect(high.y).toBeGreaterThan(0);
    expect(low.y).toBeLessThan(100);
    const maxBottom = 360 - chrome - CAPTION_POSITION_MARGIN_PX;
    expect((low.y / 100) * 360 + overlay.height / 2).toBeLessThanOrEqual(maxBottom + 0.6);
    expect(left.x).toBeGreaterThan(0);
    expect(right.x).toBeLessThan(100);
    expect(left.x).toBeLessThan(right.x);
  });

  it('swallows a caption press so the player cannot start hold-to-2x, and short-clicks play/pause', () => {
    const { overlay, host, player } = mountDraggableOverlay();
    const video = player.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => video.dataset.paused === '1',
    });
    video.dataset.paused = '0';
    video.pause = () => {
      video.dataset.paused = '1';
    };
    video.play = async () => {
      video.dataset.paused = '0';
    };
    video.playbackRate = 1;
    let playerDown = 0;
    let playerClick = 0;
    let twoXArmed = false;
    player.addEventListener(
      'pointerdown',
      () => {
        playerDown += 1;
        twoXArmed = true;
        video.playbackRate = 2;
      },
      true,
    );
    player.addEventListener(
      'mousedown',
      () => {
        playerDown += 1;
      },
      true,
    );
    player.addEventListener(
      'click',
      () => {
        playerClick += 1;
      },
      true,
    );
    let clicks = 0;
    overlay.setOnShortClick(() => {
      clicks += 1;
      video.pause();
    });

    dispatchPointer(player, 'pointerdown', 320, 310);
    player.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 320,
        clientY: 310,
        button: 0,
      }),
    );
    expect(playerDown).toBe(0);
    expect(twoXArmed).toBe(false);
    expect(video.playbackRate).toBe(1);
    dispatchPointer(player, 'pointerup', 320, 310);
    player.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 320,
        clientY: 310,
      }),
    );
    expect(clicks).toBe(1);
    expect(video.dataset.paused).toBe('1');
    expect(playerClick).toBe(0);
    expect(host.style.pointerEvents).toBe('none');
    expect(host.hasAttribute('data-sakutto-dragging')).toBe(false);
    overlay.detach();
  });

  it('does not change playbackRate or toggle play during a caption hold-and-drag', () => {
    vi.useFakeTimers();
    const { overlay, host, player } = mountDraggableOverlay();
    const video = player.querySelector('video') as HTMLVideoElement;
    video.playbackRate = 1;
    let clicks = 0;
    overlay.setOnShortClick(() => {
      clicks += 1;
    });
    let playerDown = 0;
    player.addEventListener(
      'pointerdown',
      () => {
        playerDown += 1;
        video.playbackRate = 2;
      },
      true,
    );
    dispatchPointer(player, 'pointerdown', 320, 310);
    vi.advanceTimersByTime(CAPTION_DRAG_HOLD_MS);
    expect(host.getAttribute('data-sakutto-dragging')).toBe('1');
    expect(playerDown).toBe(0);
    expect(video.playbackRate).toBe(1);
    dispatchPointer(player, 'pointerup', 320, 310);
    expect(clicks).toBe(0);
    expect(video.playbackRate).toBe(1);
    overlay.detach();
    vi.useRealTimers();
  });

  it('swallows contextmenu on the caption box', () => {
    const { overlay, player } = mountDraggableOverlay();
    let menus = 0;
    player.addEventListener(
      'contextmenu',
      () => {
        menus += 1;
      },
      true,
    );
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      composed: true,
      cancelable: true,
      clientX: 320,
      clientY: 310,
    });
    player.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(menus).toBe(0);
    overlay.detach();
  });

  it('picks up the caption after a press-and-hold, then stores a percent position', () => {
    vi.useFakeTimers();
    const { overlay, host, player, lines } = mountDraggableOverlay();
    const dropped: Array<{ x: number; y: number }> = [];
    overlay.setOnPositionChange((point) => {
      dropped.push(point);
    });
    dispatchPointer(player, 'pointerdown', 320, 310);
    vi.advanceTimersByTime(CAPTION_DRAG_HOLD_MS);
    expect(host.getAttribute('data-sakutto-dragging')).toBe('1');
    stubRect(host, { left: 220, top: 80, width: 200, height: 48 });
    stubRect(lines.translated, { left: 220, top: 96, width: 200, height: 32 });
    dispatchPointer(player, 'pointermove', 320, 104);
    dispatchPointer(player, 'pointerup', 320, 104);
    expect(host.hasAttribute('data-sakutto-dragging')).toBe(false);
    expect(host.style.transform).toBe('translate(-50%, -50%)');
    expect(host.style.top).not.toBe('auto');
    expect(dropped.length).toBe(1);
    expect(dropped[0]?.x).toBeGreaterThan(40);
    expect(dropped[0]?.x).toBeLessThan(60);
    expect(dropped[0]?.y).toBeLessThan(50);
    let swallowed = 0;
    player.addEventListener(
      'click',
      () => {
        swallowed += 1;
      },
      true,
    );
    document.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 320,
        clientY: 104,
      }),
    );
    expect(swallowed).toBe(0);
    overlay.place({ left: 0, top: 0, width: 1280, height: 720 }, 28, 72, dropped[0]);
    expect(host.style.left).toBe(`${String(dropped[0]?.x)}%`);
    expect(host.style.top).toBe(`${String(dropped[0]?.y)}%`);
    overlay.setPosition(null);
    overlay.place({ left: 0, top: 0, width: 1280, height: 720 }, 28, 72, null);
    expect(host.style.left).toBe('50%');
    expect(host.style.top).toBe('auto');
    expect(host.style.transform).toBe('translateX(-50%)');
    overlay.detach();
    vi.useRealTimers();
  });

  it('cancels pickup if the pointer moves before the hold, and ignores the original-toggle', () => {
    vi.useFakeTimers();
    const { overlay, host, player } = mountDraggableOverlay();
    dispatchPointer(player, 'pointerdown', 320, 310);
    dispatchPointer(player, 'pointermove', 320, 330);
    vi.advanceTimersByTime(CAPTION_DRAG_HOLD_MS);
    expect(host.hasAttribute('data-sakutto-dragging')).toBe(false);
    expect(host.style.transform).toBe('translateX(-50%)');
    overlay.detach();
    vi.useRealTimers();
  });

  it('picks up an X caption with a touch pointer', () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div data-testid="videoPlayer" style="position: relative; width: 640px; height: 360px">
        <video></video>
      </div>
    `;
    const player = document.querySelector('[data-testid="videoPlayer"]') as HTMLElement;
    stubRect(player, { left: 0, top: 0, width: 640, height: 360 });
    const overlay = new CaptionOverlay(document, labels);
    overlay.attach(player);
    overlay.show({
      original: 'The station opens at dawn.',
      translation: '駅は夜明けに開きます。',
      display: 'replace',
      pending: false,
    });
    overlay.place({ left: 0, top: 0, width: 640, height: 360 }, 28, X_CAPTION_CHROME_FALLBACK_PX);
    const host = document.querySelector('sakutto-captions') as HTMLElement;
    const wrap = overlay.shadow()?.querySelector('.wrap') as HTMLElement;
    const translated = overlay.shadow()?.querySelector('.line:not(.original)') as HTMLElement;
    stubRect(host, { left: 220, top: 250, width: 200, height: 40 });
    stubRect(wrap, { left: 220, top: 250, width: 200, height: 40 });
    stubRect(translated, { left: 220, top: 250, width: 200, height: 40 });
    dispatchPointer(player, 'pointerdown', 320, 270, { pointerType: 'touch' });
    vi.advanceTimersByTime(CAPTION_DRAG_HOLD_MS);
    expect(host.getAttribute('data-sakutto-dragging')).toBe('1');
    overlay.detach();
    vi.useRealTimers();
  });
});

function fakeRect(box: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    x: box.left,
    y: box.top,
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

function stubRect(
  element: Element,
  box: { left: number; top: number; width: number; height: number },
): void {
  element.getBoundingClientRect = () => fakeRect(box);
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  extra: PointerEventInit = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      pointerType: 'mouse',
      ...extra,
    }),
  );
}

function mountDraggableOverlay(): {
  overlay: CaptionOverlay;
  host: HTMLElement;
  player: HTMLElement;
  lines: { original: HTMLElement; translated: HTMLElement };
} {
  document.body.innerHTML = `
    <div id="movie_player" class="html5-video-player" style="position: relative; width: 640px; height: 360px">
      <video></video>
      <div class="ytp-chrome-bottom"></div>
    </div>
  `;
  const player = document.getElementById('movie_player') as HTMLElement;
  stubRect(player, { left: 0, top: 0, width: 640, height: 360 });
  const overlay = new CaptionOverlay(document, labels);
  overlay.attach(player);
  overlay.show({
    original: 'The station opens at dawn.',
    translation: '駅は夜明けに開きます。',
    display: 'bilingual',
    pending: false,
  });
  overlay.place({ left: 0, top: 0, width: 640, height: 360 }, 28, 72);
  const host = document.querySelector('sakutto-captions') as HTMLElement;
  const wrap = overlay.shadow()?.querySelector('.wrap') as HTMLElement;
  const original = overlay.shadow()?.querySelector('.original') as HTMLElement;
  const translated = overlay.shadow()?.querySelector('.line:not(.original)') as HTMLElement;
  stubRect(host, { left: 220, top: 276, width: 200, height: 48 });
  stubRect(wrap, { left: 220, top: 276, width: 200, height: 48 });
  stubRect(original, { left: 240, top: 276, width: 160, height: 16 });
  stubRect(translated, { left: 220, top: 296, width: 200, height: 28 });
  Object.defineProperty(host, 'offsetWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(host, 'offsetHeight', { configurable: true, get: () => 48 });
  return { overlay, host, player, lines: { original, translated } };
}
