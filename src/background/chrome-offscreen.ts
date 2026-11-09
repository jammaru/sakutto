import { browser } from 'wxt/browser';
import {
  WEBGPU_DEBUG_STORAGE_KEY,
  isWebGpuDebugProfile,
  offscreenDocumentMatches,
  offscreenDocumentUrl,
} from '@/shared/gpu-diagnostic';
import type { OffscreenDocumentApi } from './offscreen-lifecycle';

export const ENGINE_PAGE = 'offscreen.html';

export function createChromeOffscreenApi(): OffscreenDocumentApi {
  return {
    hasDocument: async () => {
      const pageUrl = browser.runtime.getURL(`/${ENGINE_PAGE}`);
      const contexts = await browser.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      return contexts.some((context) => {
        const url = 'documentUrl' in context ? String(context.documentUrl ?? '') : '';
        return offscreenDocumentMatches(url, pageUrl);
      });
    },
    createDocument: async () => {
      const stored = await browser.storage.local.get(WEBGPU_DEBUG_STORAGE_KEY);
      const profile = stored[WEBGPU_DEBUG_STORAGE_KEY];
      await browser.offscreen.createDocument({
        url: offscreenDocumentUrl(ENGINE_PAGE, isWebGpuDebugProfile(profile) ? profile : 'off'),
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
