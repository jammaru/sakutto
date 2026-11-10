import { fakeTranslate } from '@/dom/fake-engine';
import type { PageEngine } from '@/dom/session';
import { loadSettings } from '@/shared/storage';
import { translateViaBackground } from '@/shared/translation-client';

/**
 * The engine a typed request uses. Same choice as a page: the packaged build talks to the
 * offscreen PLaMo host, and the e2e build swaps in the deterministic stub. The typed box has
 * no page to translate, so it is never routed to Chrome's built-in translator — see
 * `typedReadiness` in `src/shared/typed-translation.ts` for why.
 *
 * A fake-engine build still talks to the background when Settings points at a local server,
 * so an e2e mock `/v1/completions` can be the translator.
 */
export const typedEngine: PageEngine = {
  async *translate(segments, options) {
    if (__SAKUTTO_FAKE_ENGINE__) {
      const settings = await loadSettings();
      if (settings.engineSource !== 'local-server') {
        yield* fakeTranslate(segments, options);
        return;
      }
    }
    yield* translateViaBackground(segments, options);
  },
};
