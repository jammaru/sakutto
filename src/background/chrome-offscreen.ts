import { browser } from 'wxt/browser';
import type { OffscreenDocumentApi } from './offscreen-lifecycle';

export const ENGINE_PAGE = 'offscreen.html';

export function createChromeOffscreenApi(): OffscreenDocumentApi {
  return {
    hasDocument: async () => {
      const contexts = await browser.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [browser.runtime.getURL(`/${ENGINE_PAGE}`)],
      });
      return contexts.length > 0;
    },
    createDocument: async () => {
      await browser.offscreen.createDocument({
        url: ENGINE_PAGE,
        reasons: [browser.offscreen.Reason.WORKERS],
        justification:
          'Runs the translation runtime in a document whose workers stay alive independently of the toolbar UI.',
      });
    },
    closeDocument: async () => {
      await browser.offscreen.closeDocument();
    },
  };
}
