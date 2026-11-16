import { defineContentScript } from 'wxt/utils/define-content-script';
import { installEarlyMailBannerPresses } from '@/dom/mail-banner-press';

/**
 * Runs before OWA's own scripts and installs only the press bridge. Registered together with
 * the idle mail bundle, at runtime, after the reader grants the mail origin.
 */
export default defineContentScript({
  registration: 'runtime',
  runAt: 'document_start',
  main() {
    installEarlyMailBannerPresses(window);
  },
});
