import { fakeTranslate } from '@/dom/fake-engine';
import type { PageEngine } from '@/dom/session';
import { translateViaBackground } from '@/shared/translation-client';

/**
 * The engine a typed request uses. Same choice as a page: the packaged build talks to the
 * offscreen PLaMo host, and the e2e build swaps in the deterministic stub. The typed box has
 * no page to translate, so it is never routed to Chrome's built-in translator — see
 * `typedReadiness` in `src/shared/typed-translation.ts` for why.
 */
export const typedEngine: PageEngine = {
  translate: __SAKUTTO_FAKE_ENGINE__ ? fakeTranslate : translateViaBackground,
};
