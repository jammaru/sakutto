import { defineContentScript } from 'wxt/utils/define-content-script';
import { installEarlyMailBannerPresses } from '@/dom/mail-banner-press';
import { MAIL_HOST_PATTERNS } from '@/shared/manifest';

/**
 * Runs before OWA's own scripts and installs only the press bridge. The controller in the
 * idle mail content script registers its hook once settings and labels are ready.
 */
export default defineContentScript({
  matches: [...MAIL_HOST_PATTERNS],
  runAt: 'document_start',
  main() {
    installEarlyMailBannerPresses(window);
  },
});
