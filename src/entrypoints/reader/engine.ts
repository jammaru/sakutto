import { fakeTranslate } from '@/dom/fake-engine';
import type { PdfEngine } from '@/pdf/session';
import { translateViaBackground } from '@/shared/translation-client';

/**
 * The engine the PDF reader uses. Same choice as a page and the typed box: the packaged build
 * talks to the offscreen PLaMo host, and the e2e build swaps in the deterministic stub.
 */
export const readerEngine: PdfEngine = {
  translate: __SAKUTTO_FAKE_ENGINE__ ? fakeTranslate : translateViaBackground,
};
