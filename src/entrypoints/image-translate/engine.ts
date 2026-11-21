import { fakeTranslate } from '@/dom/fake-engine';
import { translateViaBackground } from '@/shared/translation-client';

/**
 * The same engine choice the page, typed box and PDF reader use: the packaged build talks to
 * the offscreen PLaMo host, while the fake-engine build adds the deterministic language marker.
 */
export const imageTranslateEngine = __SAKUTTO_FAKE_ENGINE__
  ? fakeTranslate
  : translateViaBackground;
