import { defineContentScript } from 'wxt/utils/define-content-script';
import { contentMain } from '@/content/main';
import { MAIL_HOST_PATTERNS } from '@/shared/manifest';

/**
 * Mail hosts need the banner before the user has opened the popup, which is the only
 * gesture that grants `activeTab`. This static registration covers those hosts; the
 * general content script stays runtime-registered so other sites are unchanged.
 */
export default defineContentScript({
  matches: [...MAIL_HOST_PATTERNS],
  runAt: 'document_idle',
  main: contentMain,
});
