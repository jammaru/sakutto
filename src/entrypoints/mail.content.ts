import { defineContentScript } from 'wxt/utils/define-content-script';
import { contentMain } from '@/content/main';

/**
 * Gmail/Outlook banner. The background registers this bundle at runtime only for mail origins
 * the reader has granted, so a fresh install does not ask for mail host access.
 */
export default defineContentScript({
  registration: 'runtime',
  runAt: 'document_idle',
  main: contentMain,
});
